import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EcobeeCloud, SignInRequiredError } from './ecobee.js';
import { startControlServer } from './control.js';
import { AirQualitySensors } from './airquality.js';
import { SecuritySystem } from './security.js';
import { VERSION } from './version.js';

export const PLUGIN_NAME = 'homebridge-ecobee-security';
export const PLATFORM_NAME = 'EcobeeSecurityPlatform';

const RETRY_START = 60 * 1000;
const AIR_QUALITY_RETRY = 10 * 60 * 1000;
const AIR_QUALITY = 'airQuality';
const SMOKE = 'smoke';

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
        path: join(dir, 'control.sock'), log, getSystem: () => this.system, enabled: this.config.allowHolds === true,
      });
      this.launch();
    });
    api.on('shutdown', () => {
      clearTimeout(this.retryTimer);
      clearTimeout(this.airQualityRetry);
      this.control?.close();
      this.system?.stop();
      this.airQuality?.stop();
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
    const stale = this.cached.filter(a => a.UUID !== uuid && a.context.kind !== AIR_QUALITY && !(wantSmoke && a.UUID === smokeUuid));
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
      pollInterval: Math.max(5, Number(this.config.pollInterval) || 10),
      store: this.store,
      save: () => this.save(),
      offerNight: this.config.offerNight === true,
      alarmAfterEntryDelay: this.config.alarmTrigger === 'entryDelay',
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
    this.system.start();
    const m = home.monitoring;
    this.log.info(`Connected to "${home.name}" (${m.armedState}; professional monitoring `
      + `${m.homeMonitoringSettings?.isProfessionalMonitoringEnabled ? 'on' : 'off'}).`);
    if (this.store.hold && this.config.allowHolds !== true) {
      this.log.info(`Security holds are off; dropping the hold for ${this.system.holders().join(' and ')} without re-arming Away.`);
      this.system.dropHold();
    } else if (this.store.hold) {
      this.log.info(`Still holding Stay for ${this.system.holders().join(' and ')} (since ${this.store.hold.since}).`);
    }
    this.startAirQuality(home.id);
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
