import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { EcobeeCloud, SignInRequiredError, smartOccupancyOf } from './ecobee.js';
import { startControlServer } from './control.js';
import { AirQualitySensors } from './airquality.js';
import { VacationSwitch } from './vacation.js';
import { KeypadLocks } from './keypad.js';
import { SecuritySystem } from './security.js';
import { DoorbellCamera, checkFfmpeg } from './camera/camera.js';
import { DoorbellSession } from './camera/session.js';
import { BridgedSensors, HAP_BRIDGED } from './camera/bridged.js';
import { DoorbellHapLink } from './camera/hap-link.js';
import { readPairing } from './camera/hap-pairing.js';
import { VERSION } from './version.js';

export const PLUGIN_NAME = 'homebridge-ecobee-security';
export const PLATFORM_NAME = 'EcobeeSecurityPlatform';

const RETRY_START = 60 * 1000;
const AIR_QUALITY_RETRY = 10 * 60 * 1000;
const AIR_QUALITY = 'airQuality';
const SMOKE = 'smoke';
const VACATION = 'vacation';
const ARM_NOW = 'armAwayNow';
const OCCUPANCY = 'occupancy';
const DOORBELL_MODEL = 'ASTERIA';
const CAMERA_RETRY = 10 * 60 * 1000;

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
      clearTimeout(this.cameraRetry);
      this.cameras?.forEach(camera => camera.stop());
      this.hapLink?.stop();
      this.bridgedSensors?.stop();
      this.control?.close();
      this.system?.stop();
      this.airQuality?.stop();
      this.vacation?.stop();
      clearTimeout(this.thermostatTimer);
      clearTimeout(this.occupancyRevert);
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
    const stale = this.cached.filter(a => a.UUID !== uuid && a.context.kind !== AIR_QUALITY && a.context.kind !== VACATION && a.context.kind !== HAP_BRIDGED
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
    this.startVacation(home.id);
    this.startThermostatTick(home.id);
    this.startKeypad();
    this.startCameras(home.id);
  }

  /**
   * A HomeKit camera (live view) for each ecobee doorbell camera (`doorbellCamera`). Each is its own
   * external accessory with its own setup code, as HomeKit cameras shouldn't sit behind a bridge.
   * Without a pairing with the doorbell's own HomeKit server it is a plain camera, "<name> Camera"; with
   * one (the doorbell link, paired in the settings) it is a video doorbell named like the camera, with
   * the ring and a motion sensor, and the sensors the doorbell bridges are published here too. Which of
   * the two the camera is gets decided at start-up (pairing or unpairing needs a bridge restart for that);
   * the link and the bridged sensors follow the pairing file while running. Failures here never affect
   * the security system.
   */
  /** Remember (for the settings page) whether the account has an ecobee doorbell. */
  noteDoorbell(found) {
    const hasDoorbell = found.length > 0;
    const name = found[0]?.name;
    if (this.store.hasDoorbell !== hasDoorbell || this.store.doorbellName !== name) {
      this.store.hasDoorbell = hasDoorbell;
      this.store.doorbellName = name;
      this.save();
    }
  }

  async startCameras(homeId) {
    const bridged = this.cached.filter(a => a.context.kind === HAP_BRIDGED);
    if (this.config.doorbellCamera !== true) {
      if (bridged.length) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, bridged);
      }
      // Camera off: a light, one-time lookup so the settings page knows whether to offer the card.
      if (!this.doorbellChecked) {
        this.doorbellChecked = true;
        try {
          this.noteDoorbell((await this.cloud.getCameras(homeId)).filter(c => c.model === DOORBELL_MODEL));
        } catch {
          // Unknown stays unknown; the card is shown.
        }
      }
      return;
    }
    if (this.cameras) {
      return;
    }
    const ffmpegPath = this.config.ffmpegPath?.trim()
      || (existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
    const check = await checkFfmpeg(ffmpegPath);
    if (!check.ok) {
      this.log.error(`Doorbell camera: ${check.reason}. The camera needs an ffmpeg with libfdk_aac and libx264 `
        + '(the Homebridge Raspberry Pi image has one at /usr/local/bin/ffmpeg); set "ffmpegPath" in the plugin settings. Not publishing it.');
      return;
    }
    let found;
    try {
      found = (await this.cloud.getCameras(homeId)).filter(c => c.model === DOORBELL_MODEL);
    } catch (error) {
      this.log.warn(`Could not look up the doorbell camera (${error.message}); trying again in 10 minutes.`);
      this.cameraRetry = setTimeout(() => this.startCameras(homeId), CAMERA_RETRY);
      return;
    }
    this.noteDoorbell(found);
    if (!found.length) {
      this.log.warn('Doorbell camera is on, but this home has no ecobee Smart Doorbell Camera.');
      return;
    }
    this.cameras = [];

    // The doorbell link (the first doorbell camera's own HomeKit server), if it has been paired.
    const pairingPath = join(this.api.user.storagePath(), 'ecobee-security', 'doorbell-pairing.json');
    const paired = Boolean(readPairing(pairingPath));
    const linkName = found[0].name;
    this.hapLink = new DoorbellHapLink({ pairingPath, log: this.log, name: linkName });
    this.hapLink.on('state', (state) => {
      this.store.doorbellLink = { state, at: new Date().toISOString() };
      this.save();
    });
    this.bridgedSensors = new BridgedSensors({
      api: this.api, log: this.log, link: this.hapLink, pluginName: PLUGIN_NAME, platformName: PLATFORM_NAME,
      cached: bridged, version: VERSION,
    });
    if (!paired) {
      this.bridgedSensors.removeAll();
    }
    this.hapLink.start();

    for (const [index, camera] of found.entries()) {
      const doorbell = paired && index === 0;
      // A doorbell is a new accessory (its own pairing in the Home app); the plain camera keeps its old identity.
      const name = doorbell ? camera.name : `${camera.name} Camera`;
      const uuid = this.api.hap.uuid.generate(doorbell ? `ecobee-security:doorbell:${camera.id}` : `ecobee-security:camera:${camera.id}`);
      const category = doorbell ? this.api.hap.Categories.VIDEO_DOORBELL : this.api.hap.Categories.CAMERA;
      const accessory = new this.api.platformAccessory(name, uuid, category);
      const session = new DoorbellSession({ cloud: this.cloud, cameraId: camera.id, name, log: this.log });
      this.cameras.push(new DoorbellCamera({
        api: this.api,
        log: this.log,
        accessory,
        session,
        ffmpegPath,
        camera: { ...camera, name },
        version: VERSION,
        cloudDown: () => this.system?.cloudDown === true,
        link: doorbell ? this.hapLink : undefined,
        cloud: this.cloud,
        homeId,
        motionGrace: Math.min(120, Math.max(6, Number(this.config.motionGrace) || 15)) * 1000,
        capturePath: this.config.debugRecordings === true ? join(this.api.user.storagePath(), 'ecobee-security', 'recordings') : undefined,
      }));
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
      this.log.info(`"${name}" is published as its own HomeKit ${doorbell ? 'video doorbell' : 'camera'}. If it isn't in the Home app yet, `
        + 'add it with the setup code shown above.');
      this.cameras.at(-1).start();
    }
    this.hapLink.on('unpaired', () => {
      if (paired) {
        this.log.info('The doorbell link was removed. Restart the bridge to publish the camera without it.');
      }
    });
    let told = false;
    this.hapLink.on('state', (state) => {
      if (state === 'up' && !paired && !told) {
        told = true;
        this.log.info('The doorbell link is paired. Restart the bridge to publish the camera as a video doorbell with the ring.');
      }
    });
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
   * the store (on until told otherwise); starting up does nothing. The accessory also has an
   * occupancy sensor that follows the switch (Occupied while it is on), for "occupancy detected /
   * not detected" automation triggers and the room status.
   */
  setupOccupancy(uuid, homeId) {
    const { Service, Characteristic } = this.api.hap;
    // Fixed name (renamed in the Home app); an `occupancyName` from an older config is still honoured.
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
      .onSet(on => this.occupancyFromSwitch(Boolean(on)));
    this.occupancySensor = accessory.getService(Service.OccupancySensor)
      ?? accessory.addService(Service.OccupancySensor, name);
    this.occupancySensor.setCharacteristic(Characteristic.Name, name);
    this.occupancySensor.getCharacteristic(Characteristic.OccupancyDetected)
      .onGet(() => (this.store.occupied !== false
        ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED));
    // The sensor is the primary service, so the Home app shows it as the tile (person icon, like
    // homebridge-dummy's switch + sensor) and opens the switch. The switch is set non-primary
    // explicitly to clear the flag cached by earlier test builds.
    this.occupancy.setPrimaryService(false);
    this.occupancySensor.setPrimaryService(true);
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
  setOccupied(occupied, source, { arm = true } = {}) {
    if (occupied === (this.store.occupied !== false)) {
      return;
    }
    this.store.occupied = occupied;
    this.save();
    this.occupancy?.updateCharacteristic(this.api.hap.Characteristic.On, occupied);
    const { OccupancyDetected } = this.api.hap.Characteristic;
    this.occupancySensor?.updateCharacteristic(OccupancyDetected,
      occupied ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.log.info(`${source}: ${occupied ? 'someone is home' : 'nobody is home'}.`);
    // Not awaited: Home app automations don't wait on the cloud, and a failure doesn't change the
    // fact that was reported (the system logs it).
    if (arm) {
      this.system.occupancyChanged(occupied, source).catch(() => {});
    }
  }

  /** The switch was set from the Home app. With ecobee as the source it mirrors ecobee, so it springs back. */
  occupancyFromSwitch(on) {
    if (this.config.occupancySource !== 'ecobee') {
      this.setOccupied(on, 'Home Occupied');
      return;
    }
    if (!this.toldOccupancy) {
      this.toldOccupancy = true;
      this.log.info('Home Occupied follows ecobee\'s Smart Home & Away, so a change from the Home app is undone. '
        + 'Set "Home Occupied source" to Home app automations to set it yourself.');
    }
    clearTimeout(this.occupancyRevert);
    this.occupancyRevert = setTimeout(() => {
      this.occupancy?.updateCharacteristic(this.api.hap.Characteristic.On, this.store.occupied !== false);
    }, 1000);
  }

  /**
   * One 60-second tick for everything that reads the thermostats' REST data: one read, handed to the
   * event log (always, to see Smart Away's shape), the vacation switch and, with `occupancySource: "ecobee"` set by hand, the Home Occupied mirror.
   */
  startThermostatTick(homeId) {
    const mirror = this.config.occupancySwitch === true && this.config.occupancySource === 'ecobee';
    if (this.thermostatTimer) {
      return;
    }
    const tick = async () => {
      let list;
      let error;
      try {
        list = await this.cloud.getThermostats(homeId, 0);
      } catch (e) {
        error = e;
      }
      if (list) {
        this.logEventChanges(list);
      } else {
        this.log.debug(`Could not read the ecobee thermostats (${error.message}).`);
      }
      this.vacation?.handle(list, error);
      if (mirror) {
        this.mirrorOccupancy(list, error);
      }
      this.thermostatTimer = setTimeout(tick, 60 * 1000);
    };
    this.thermostatTimer = setTimeout(tick, 0);
  }

  /**
   * Home Occupied from ecobee's Smart Home & Away: mirrored on the switch and sensor, never arms or
   * disarms anything. Unknown keeps the last state.
   */
  mirrorOccupancy(list, error) {
    if (error) {
      this.log.debug(`Could not read ecobee Smart Home & Away (${error.message}); keeping the last state.`);
      return;
    }
    const home = smartOccupancyOf(list);
    if (home === undefined) {
      this.log.debug('ecobee Smart Home & Away: no state (off, or a vacation is running); keeping the last one.');
    } else {
      this.setOccupied(home, 'ecobee Smart Home & Away', { arm: false });
    }
  }

  /** Logs the thermostats' event types and `autoAway` setting when they change. */
  logEventChanges(list) {
    const seen = this.eventsSeen ??= { events: undefined, autoAway: undefined };
    const events = list.map(t => `${t.name ?? 'thermostat'}: ${(t.events ?? []).map(e => `${e.type} "${e.name}" ${e.running ? 'running' : 'not running'}`
      + `${e.startDate ? ` ${e.startDate} ${e.startTime ?? ''}`.trimEnd() : ''}${e.endDate ? ` to ${e.endDate} ${e.endTime ?? ''}`.trimEnd() : ''}`).join(', ') || 'no events'}`).join('; ');
    const autoAway = list.map(t => `${t.name ?? 'thermostat'}=${t.settings?.autoAway}`).join(', ');
    if (events !== seen.events) {
      seen.events = events;
      this.log.info(`ecobee events now: ${events}.`);
    }
    if (autoAway !== seen.autoAway) {
      seen.autoAway = autoAway;
      this.log.info(`ecobee settings.autoAway now: ${autoAway}.`);
    }
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

  /** The Vacation Mode switch (follows ecobee's vacation event); failures here never affect the security system. */
  startVacation(homeId) {
    const cached = this.cached.filter(a => a.context.kind === VACATION);
    if (this.vacation) {
      return;
    }
    if (this.config.vacationSwitch !== true) {
      if (cached.length) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, cached);
      }
      return;
    }
    this.vacation = new VacationSwitch({
      api: this.api,
      log: this.log,
      cloud: this.cloud,
      homeId,
      // Fixed name (renamed in the Home app; another plugin finds the switch by "Vacation Mode"); a
      // `vacationSwitchName` from an older config is still honoured.
      name: this.config.vacationSwitchName?.trim() || 'Vacation Mode',
      cached,
      version: VERSION,
      cloudDown: () => this.system?.cloudDown === true,
      create: (uuid, name) => {
        const accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.kind = VACATION;
        return accessory;
      },
      register: accessories => this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories),
      update: accessories => this.api.updatePlatformAccessories(accessories),
      unregister: accessories => this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories),
    });
    this.vacation.start();
  }
}
