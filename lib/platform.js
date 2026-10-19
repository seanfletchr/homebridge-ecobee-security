import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EcobeeCloud, SignInRequiredError } from './ecobee.js';
import { startControlServer } from './control.js';
import { AirQualitySensors } from './airquality.js';
import { KeypadLocks } from './keypad.js';
import { SecuritySystem } from './security.js';
import { VERSION } from './version.js';

export const PLUGIN_NAME = 'homebridge-ecobee-security';
export const PLATFORM_NAME = 'EcobeeSecurityPlatform';

const RETRY_START = 60 * 1000;
const AIR_QUALITY_RETRY = 10 * 60 * 1000;
const AIR_QUALITY = 'airQuality';
const SMOKE = 'smoke';
const ARM_NOW = 'armAwayNow';
const OCCUPANCY = 'occupancy';

export class EcobeeSecurityPlatform {
  /**
   * @param {import('homebridge').Logging} log
   * @param {import('homebridge').PlatformConfig} config
   * @param {import('homebridge').API} api
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.cached = [];

    const dir = join(api.user.storagePath(), 'ecobee-security');
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      log.error(`Could not create ${dir}: ${error.message}`);
    }
    this.storePath = join(dir, 'state.json');
    this.store = this.load();

    // A refresh token newly pasted into the settings wins over the one we've been keeping.
    const configured = this.config.refreshToken?.trim();
    if (configured && configured !== this.store.configuredToken) {
      this.store.refreshToken = configured;
      this.store.configuredToken = configured;
      this.save();
    }

    if (!this.store.refreshToken) {
      log.error('No ecobee refresh token. Sign in with bin/ecobee-login.js (see the plugin README), '
        + 'paste the refresh token into the plugin settings and restart the bridge.');
      return;
    }

    this.cloud = new EcobeeCloud({
      refreshToken: this.store.refreshToken,
      onRefreshToken: (token) => {
        this.store.refreshToken = token;
        this.save();
      },
      log,
    });

    api.on('didFinishLaunching', () => {
      this.control = startControlServer({
        path: join(dir, 'control.sock'),
        log,
        getSystem: () => this.system,
        isAllowed: key => this.holdAllowed(key),
        noteRequest: request => this.noteHoldRequest(request),
      });
      this.launch();
    });
    api.on('shutdown', () => {
      clearTimeout(this.retryTimer);
      clearTimeout(this.airQualityRetry);
      this.control?.close();
      this.system?.stop();
      this.airQuality?.stop();
      this.keypad?.stop();
    });
  }

  /** @param {import('homebridge').PlatformAccessory} accessory */
  configureAccessory(accessory) {
    this.cached.push(accessory);
  }

  load() {
    try {
      return JSON.parse(readFileSync(this.storePath, 'utf8'));
    } catch {
      return {};
    }
  }

  save() {
    try {
      writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
      chmodSync(this.storePath, 0o600);
    } catch (error) {
      this.log.warn(`Could not save plugin state: ${error.message}`);
    }
  }

  async launch(retryIn = RETRY_START) {
    try {
      await this.setup();
    } catch (error) {
      if (error instanceof SignInRequiredError) {
        this.log.error(`${error.message}. Sign in again with bin/ecobee-login.js (see the plugin README), `
          + 'paste the new refresh token into the plugin settings and restart the bridge.');
        return;
      }
      this.log.warn(`Startup failed (${error.message}); retrying in ${retryIn / 1000} s.`);
      this.retryTimer = setTimeout(() => this.launch(Math.min(retryIn * 2, 30 * 60 * 1000)), retryIn);
    }
  }

  async setup() {
    const homes = await this.cloud.getHomes();
    // For the settings page's home list (it only offers a choice when there's more than one).
    this.store.homes = homes.map(h => ({ id: h.id, name: h.name, security: Boolean(h.monitoring) }));
    this.save();
    const wanted = this.config.homeId?.trim();
    const home = wanted
      ? homes.find(h => h.id === wanted)
      : homes.find(h => h.capabilities?.includes('HOME_MONITORING') && h.monitoring) ?? homes.find(h => h.monitoring);
    if (!home) {
      this.log.error(wanted
        ? `No home with id ${wanted} on this ecobee account. Homes: ${homes.map(h => `${h.name} (${h.id})`).join(', ')}`
        : 'No home with Smart Security on this ecobee account.');
      return;
    }
    if (!wanted && homes.length > 1) {
      this.log.warn(`Several homes on this account; using "${home.name}". Set "homeId" in the plugin settings to pick another: `
        + homes.map(h => `${h.name} (${h.id})`).join(', '));
    }

    const uuid = this.api.hap.uuid.generate(`ecobee-security:${home.id}`);
    const smokeUuid = this.api.hap.uuid.generate(`ecobee-security:smoke:${home.id}`);
    const wantSmoke = this.config.smokeSensor !== false;
    const armNowUuid = this.api.hap.uuid.generate(`ecobee-security:arm-away-now:${home.id}`);
    const wantArmNow = this.config.allowHolds === true && this.config.armAwayNowSwitch === true;
    const occupancyUuid = this.api.hap.uuid.generate(`ecobee-security:occupancy:${home.id}`);
    const wantOccupancy = this.config.occupancySwitch === true;
    const stale = this.cached.filter(a => a.UUID !== uuid && a.context.kind !== AIR_QUALITY
      && !(wantSmoke && a.UUID === smokeUuid) && !(wantArmNow && a.UUID === armNowUuid)
      && !(wantOccupancy && a.UUID === occupancyUuid));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
    let accessory = this.cached.find(a => a.UUID === uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(this.config.name || 'Security System', uuid);
    }
    let smokeAccessory = wantSmoke ? this.cached.find(a => a.UUID === smokeUuid) : undefined;
    const smokeIsNew = wantSmoke && !smokeAccessory;
    if (smokeIsNew) {
      smokeAccessory = new this.api.platformAccessory('Smoke Alarm', smokeUuid);
      smokeAccessory.context.kind = SMOKE;
    }

    this.system = new SecuritySystem({
      api: this.api,
      log: this.log,
      accessory,
      cloud: this.cloud,
      home,
      // The ecobee app reads the security state about every 10 s; polling faster would stand out.
      pollInterval: 10,
      store: this.store,
      save: () => this.save(),
      offerNight: this.config.offerNight === true,
      alarmAfterEntryDelay: this.config.alarmTrigger === 'entryDelay',
      returnWait: this.config.taskWaitSeconds ?? 120,
      smokeAccessory,
    });
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    if (smokeIsNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [smokeAccessory]);
    } else if (smokeAccessory) {
      this.api.updatePlatformAccessories([smokeAccessory]);
    }
    if (wantArmNow) {
      this.setupArmNow(armNowUuid, home.id);
    }
    if (wantOccupancy) {
      this.setupOccupancy(occupancyUuid, home.id);
    } else if (this.store.occupied !== undefined) {
      // Not kept while the switch is off: it would be stale when the switch comes back.
      delete this.store.occupied;
      this.save();
    }
    this.system.start();
    const m = home.monitoring;
    this.log.info(`Connected to "${home.name}" (${m.armedState}; professional monitoring `
      + `${m.homeMonitoringSettings?.isProfessionalMonitoringEnabled ? 'on' : 'off'}).`);
    if (this.store.out && this.config.allowHolds !== true) {
      delete this.store.out;
      this.save();
    }
    if (this.store.hold && this.config.allowHolds !== true) {
      this.log.info(`Security holds are off; dropping the hold for ${this.system.holders().join(' and ')} without re-arming Away`
        + (this.store.hold.away ? ' (the Home app\'s Away request is dropped too; arm Away again if you still want it).' : '.'));
      this.system.dropHold();
    } else if (this.store.hold) {
      this.log.info(`Still holding Stay for ${this.system.holders().join(' and ')} (since ${this.store.hold.since})`
        + (this.store.hold.away ? '; the Home app asked for Away, which follows the release.' : '.'));
    }
    this.startAirQuality(home.id);
    this.startKeypad();
  }

  /**
   * Disarm when a lock on another bridge is unlocked with its keypad (`keypadDisarm`), for the locks
   * ticked in `keypadLocks` (no list: every lock). The locks found go into state.json for the
   * settings page.
   */
  startKeypad() {
    if (this.config.keypadDisarm !== true) {
      return;
    }
    const allowed = this.config.keypadLocks;
    this.keypad = new KeypadLocks({
      configPath: this.api.user.configPath(),
      ownPlatform: PLATFORM_NAME,
      log: this.log,
      onKeypadUnlock: ({ key, name }) => {
        if (Array.isArray(allowed) && !allowed.includes(key)) {
          this.log.info(`"${name}" was unlocked with its keypad; it isn't ticked in the settings, so the security system is left as it is.`);
          return;
        }
        this.system.keypadDisarm(`"${name}"`).catch(() => {});
      },
      onLocks: locks => {
        this.store.keypadLocks = locks;
        this.save();
      },
    });
    this.keypad.start();
  }

  /**
   * The Arm Away Now switch (its own accessory, so the Home app doesn't fold it into the security
   * tile): sends robots that are out back to their base (or stops them) and arms Away now, then turns itself off. Away from the
   * security tile waits for robots instead, because HomeKit can't tell who asked.
   */
  setupArmNow(uuid, homeId) {
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    let accessory = this.cached.find(a => a.UUID === uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory('Arm Away Now', uuid);
      accessory.context.kind = ARM_NOW;
    }
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
      .setCharacteristic(Characteristic.Model, 'Smart Security: Arm Away Now')
      .setCharacteristic(Characteristic.SerialNumber, `${homeId}-arm-away-now`)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    const sw = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, accessory.displayName);
    const off = () => setTimeout(() => sw.updateCharacteristic(Characteristic.On, false), 1000);
    sw.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (on) => {
        if (!on) {
          return;
        }
        try {
          await this.system.armAwayNow();
        } catch {
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
          off();
        }
      });
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  /**
   * The Home Occupied switch (its own accessory): the Home app's people-arrive and people-leave
   * automations can set an ordinary switch without the confirmation prompt they need for a security
   * system. Off (nobody home) arms Away like the tile does; on (someone home) disarms Away only. It
   * is the user's presence signal, so it never follows the security system. The state is kept in
   * the store (on until told otherwise); starting up does nothing.
   */
  setupOccupancy(uuid, homeId) {
    const { Service, Characteristic } = this.api.hap;
    const name = this.config.occupancyName?.trim() || 'Home Occupied';
    let accessory = this.cached.find(a => a.UUID === uuid);
    const isNew = !accessory;
    if (isNew) {
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.kind = OCCUPANCY;
    }
    accessory.displayName = name;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
      .setCharacteristic(Characteristic.Model, 'Smart Security: Home Occupied')
      .setCharacteristic(Characteristic.SerialNumber, `${homeId}-occupancy`)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    this.occupancy = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, name);
    this.occupancy.setCharacteristic(Characteristic.Name, name);
    this.occupancy.getCharacteristic(Characteristic.On)
      .onGet(() => this.store.occupied !== false)
      .onSet(on => this.setOccupied(Boolean(on), 'Home Occupied'));
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  /**
   * Someone is home or nobody is. Only a real change does anything. `source` is who says so: the
   * switch today; another source (say, ecobee's own location sensing) would call this too and the
   * switch follows it.
   */
  setOccupied(occupied, source) {
    if (occupied === (this.store.occupied !== false)) {
      return;
    }
    this.store.occupied = occupied;
    this.save();
    this.occupancy?.updateCharacteristic(this.api.hap.Characteristic.On, occupied);
    this.log.info(`${source}: ${occupied ? 'someone is home' : 'nobody is home'}.`);
    // Not awaited: Home app automations don't wait on the cloud, and a failure doesn't change the
    // fact that was reported (the system logs it).
    this.system.occupancyChanged(occupied, source).catch(() => {});
  }

  /**
   * May this plugin (or, if it doesn't say, this name) ask for a hold? `true`, `'off'` (holds are off),
   * or `'not allowed'`. Without a `holdPlugins` list (settings from before it), every plugin may.
   */
  holdAllowed(key) {
    if (this.config.allowHolds !== true) {
      return 'off';
    }
    const list = this.config.holdPlugins;
    return !Array.isArray(list) || list.includes(key) ? true : 'not allowed';
  }

  /** Remember who asked, for the settings page's list of plugins. */
  noteHoldRequest({ key, plugin, by }) {
    const requesters = this.store.holdRequesters ??= {};
    const entry = requesters[key] ??= { names: [] };
    if (plugin) {
      entry.plugin = plugin;
    }
    if (!entry.names.includes(by)) {
      entry.names = [...entry.names, by].slice(-10);
    }
    entry.lastAsked = new Date().toISOString();
    this.save();
  }

  /** Air quality sensors for thermostats that have them; failures here never affect the security system. */
  async startAirQuality(homeId) {
    const cached = this.cached.filter(a => a.context.kind === AIR_QUALITY);
    if (this.config.airQuality === false) {
      if (cached.length) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, cached);
      }
      return;
    }
    const sensors = new AirQualitySensors({
      api: this.api,
      log: this.log,
      cloud: this.cloud,
      homeId,
      cached,
      co2Alert: Math.max(400, Number(this.config.co2Alert) || 1000),
      version: VERSION,
      create: (uuid, name) => {
        const accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.kind = AIR_QUALITY;
        return accessory;
      },
      register: accessories => this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories),
      update: accessories => this.api.updatePlatformAccessories(accessories),
      unregister: accessories => this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories),
    });
    try {
      await sensors.start();
      this.airQuality = sensors;
    } catch (error) {
      sensors.stop();
      this.log.warn(`Could not set up air quality (${error.message}); trying again in 10 minutes.`);
      this.airQualityRetry = setTimeout(() => this.startAirQuality(homeId), AIR_QUALITY_RETRY);
    }
  }
}
