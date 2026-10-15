import { readFileSync } from 'node:fs';

import { ArmedState, SignInRequiredError } from './ecobee.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// HomeKit SecuritySystemCurrentState / TargetState values.
const Hk = {
  STAY: 0,
  AWAY: 1,
  NIGHT: 2,
  DISARMED: 3,
  TRIGGERED: 4,
};

const HK_NAMES = ['Armed Stay', 'Armed Away', 'Armed Night', 'Disarmed', 'Alarm triggered'];

// ecobee has no Night mode; with `offerNight`, Night arms Stay.
const TO_ECOBEE = {
  [Hk.STAY]: ArmedState.STAY,
  [Hk.AWAY]: ArmedState.AWAY,
  [Hk.NIGHT]: ArmedState.STAY,
  [Hk.DISARMED]: ArmedState.DISARMED,
};

const FROM_ECOBEE = {
  [ArmedState.STAY]: Hk.STAY,
  [ArmedState.AWAY]: Hk.AWAY,
  [ArmedState.DISARMED]: Hk.DISARMED,
};

// Incident statuses that mean the alarm is over. Anything else counts as open.
const CLOSED_INCIDENT = /RESOLV|CLOS|CANCEL|DISMISS|END|FALSE|COMPLETE|EXPIRE/i;

// Entry delay (seconds) to assume when ecobee's settings don't say.
const DEFAULT_ENTRY_DELAY = 30;

const MAX_BACKOFF = 5 * 60 * 1000;
const FAULT_AFTER = 3;

export class SecuritySystem {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('homebridge').PlatformAccessory} options.accessory
   * @param {import('./ecobee.js').EcobeeCloud} options.cloud
   * @param {object} options.home first GraphQL home object
   * @param {number} options.pollInterval seconds
   * @param {object} options.store persisted plugin state (`hold` and `night` live here)
   * @param {() => void} options.save persist `store`
   * @param {boolean} [options.offerNight] offer HomeKit's Night, which arms ecobee's Stay
   * @param {boolean} [options.alarmAfterEntryDelay] show Alarm triggered only once an intrusion
   *   incident has outlasted the entry delay, instead of as soon as ecobee opens it
   * @param {boolean} [options.smokeSensor] add a Smoke Sensor that shows ecobee's smoke-alarm incidents
   */
  constructor({ api, log, accessory, cloud, home, pollInterval, store, save, offerNight = false, alarmAfterEntryDelay = false, smokeSensor = true }) {
    this.api = api;
    this.store = store;
    this.save = save;
    this.queue = Promise.resolve();
    this.log = log;
    this.accessory = accessory;
    this.cloud = cloud;
    this.homeId = home.id;
    this.pollInterval = pollInterval * 1000;
    this.failures = 0;
    this.commandAt = 0;
    this.stopped = false;
    this.offerNight = offerNight;
    this.alarmAfterEntryDelay = alarmAfterEntryDelay;
    this.incidents = [];
    this.firstSeen = new Map();

    const { Service, Characteristic } = api.hap;
    this.C = Characteristic;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
      .setCharacteristic(Characteristic.Model, 'Smart Security')
      .setCharacteristic(Characteristic.SerialNumber, home.id)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);

    this.service = accessory.getService(Service.SecuritySystem)
      ?? accessory.addService(Service.SecuritySystem, accessory.displayName);
    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .setProps({ validValues: offerNight ? [Hk.STAY, Hk.AWAY, Hk.NIGHT, Hk.DISARMED, Hk.TRIGGERED] : [Hk.STAY, Hk.AWAY, Hk.DISARMED, Hk.TRIGGERED] });
    this.service.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({ validValues: offerNight ? [Hk.STAY, Hk.AWAY, Hk.NIGHT, Hk.DISARMED] : [Hk.STAY, Hk.AWAY, Hk.DISARMED] })
      .onSet(value => this.setTarget(value));
    if (!this.service.testCharacteristic(Characteristic.StatusFault)) {
      this.service.addCharacteristic(Characteristic.StatusFault);
    }

    // Smoke Sensor on the same accessory, for automations on ecobee's smoke-alarm detection.
    const smoke = accessory.getService(Service.SmokeSensor);
    if (smokeSensor) {
      this.smoke = smoke ?? accessory.addService(Service.SmokeSensor, 'Smoke Alarm');
      if (!this.smoke.testCharacteristic(Characteristic.StatusFault)) {
        this.smoke.addCharacteristic(Characteristic.StatusFault);
      }
    } else if (smoke) {
      accessory.removeService(smoke);
    }

    this.apply(home);
  }

  start() {
    this.schedule(this.pollInterval);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.alarmTimer);
  }

  schedule(delay) {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), delay);
  }

  async poll() {
    const startedAt = Date.now();
    let next = this.pollInterval;
    try {
      const homes = await this.cloud.getHomes();
      const home = homes.find(h => h.id === this.homeId);
      if (!home) {
        throw new Error('the home is no longer on this ecobee account');
      }
      // A command that finished while this poll was running is newer than what we just read.
      if (startedAt >= this.commandAt) {
        this.apply(home);
      }
      if (this.failures >= FAULT_AFTER) {
        this.log.info('ecobee is reachable again.');
      }
      this.failures = 0;
      this.setFault(false);
      const until = Date.parse(home.monitoring?.delayedArmedState?.delayedUntil ?? '');
      if (until > Date.now()) {
        // Catch the end of an exit delay promptly.
        next = Math.min(next, until - Date.now() + 1500);
      }
    } catch (error) {
      this.failures += 1;
      if (error instanceof SignInRequiredError) {
        this.setFault(true);
        this.log.error(`${error.message}. Sign in again: run bin/ecobee-login.js (see the plugin README), `
          + 'paste the new refresh token into the plugin settings and restart the bridge.');
        return;
      }
      next = Math.min(this.pollInterval * 2 ** this.failures, MAX_BACKOFF);
      if (this.failures === FAULT_AFTER) {
        this.setFault(true);
      }
      const say = this.failures >= FAULT_AFTER ? 'warn' : 'debug';
      this.log[say](`Could not read the security state (${error.message}); retrying in ${Math.round(next / 1000)} s.`);
    }
    this.schedule(next);
  }

  setFault(on) {
    const { StatusFault } = this.C;
    const value = on ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT;
    this.service.updateCharacteristic(StatusFault, value);
    this.smoke?.updateCharacteristic(StatusFault, value);
  }

  /** Apply a GraphQL home (or just its monitoring object) to HomeKit. */
  apply(home) {
    const monitoring = home.monitoring ?? {};
    if (monitoring.homeMonitoringSettings) {
      this.settings = monitoring.homeMonitoringSettings;
    }
    if (monitoring.incidents) {
      this.noteIncidents(monitoring.incidents);
    }
    if (monitoring.armedState) {
      this.monitoring = monitoring;
    }
    if (!this.monitoring) {
      return;
    }

    let armed = FROM_ECOBEE[this.monitoring.armedState] ?? Hk.DISARMED;
    const desired = this.monitoring.delayedArmedState?.desiredArmedState;
    let target = desired ? (FROM_ECOBEE[desired] ?? armed) : armed;
    // Stay that was armed as Night shows as Night until the state moves on.
    if (this.store.night && (!this.offerNight || target !== Hk.STAY)) {
      delete this.store.night;
      this.save();
    }
    if (this.store.night) {
      target = Hk.NIGHT;
      armed = armed === Hk.STAY ? Hk.NIGHT : armed;
    }
    const current = this.alarmSounding() ? Hk.TRIGGERED : armed;

    const { SecuritySystemCurrentState, SecuritySystemTargetState } = this.C;
    const before = this.current;
    if (before !== current || this.target !== target) {
      const pending = target !== armed ? ` (arming ${HK_NAMES[target]} until ${this.monitoring.delayedArmedState?.delayedUntil})` : '';
      this.log.info(`Security system: ${HK_NAMES[current]}${pending}`);
    }
    this.current = current;
    this.target = target;
    if (this.store.hold && (target !== Hk.STAY || this.incidents.length)) {
      this.log.info(`Security system changed to ${HK_NAMES[this.incidents.length ? Hk.TRIGGERED : target]} during the `
        + `${this.store.hold.by} hold; it won't be put back to Away.`);
      this.dropHold();
    }
    this.service.updateCharacteristic(SecuritySystemTargetState, target);
    this.service.updateCharacteristic(SecuritySystemCurrentState, current);
    if (this.smoke) {
      const { SmokeDetected } = this.C;
      const smoke = this.incidents.some(i => i.detectedSmokeAlarm);
      this.smoke.updateCharacteristic(SmokeDetected, smoke ? SmokeDetected.SMOKE_DETECTED : SmokeDetected.SMOKE_NOT_DETECTED);
    }
  }

  noteIncidents(incidents) {
    this.incidents = incidents.filter(i => !CLOSED_INCIDENT.test(i.status ?? ''));
    const summary = JSON.stringify(incidents);
    if (summary !== this.incidentSummary) {
      if (incidents.length || this.incidentSummary !== undefined) {
        this.log.info(`Incidents: ${incidents.length ? summary : 'none'}`);
      }
      this.incidentSummary = summary;
    }
    // ecobee's incidents carry no time we read, so the entry delay counts from when we first saw one.
    const now = Date.now();
    const ids = new Set(this.incidents.map(i => i.id));
    this.incidents.forEach(i => this.firstSeen.has(i.id) || this.firstSeen.set(i.id, now));
    [...this.firstSeen.keys()].filter(id => !ids.has(id)).forEach(id => this.firstSeen.delete(id));
  }

  /**
   * Whether HomeKit should show Alarm triggered. By default any open incident counts (ecobee opens
   * one as soon as a door opens while armed). With `alarmAfterEntryDelay` an intrusion only counts
   * once it has outlasted the entry delay without a disarm; smoke counts at once.
   */
  alarmSounding() {
    clearTimeout(this.alarmTimer);
    if (!this.alarmAfterEntryDelay) {
      return this.incidents.length > 0;
    }
    const now = Date.now();
    const delay = this.entryDelay() * 1000;
    let wait = Infinity;
    for (const incident of this.incidents) {
      const due = (incident.detectedSmokeAlarm ? 0 : this.firstSeen.get(incident.id) + delay) - now;
      if (due <= 0) {
        return true;
      }
      wait = Math.min(wait, due);
    }
    if (wait < Infinity && !this.stopped) {
      // Re-check when the entry delay runs out, without waiting for the next poll.
      this.alarmTimer = setTimeout(() => this.apply({}), wait + 100);
    }
    return false;
  }

  entryDelay() {
    const settings = this.settings?.armedStateSettings;
    const state = this.monitoring?.armedState;
    if (state === ArmedState.AWAY) {
      return settings?.armedAway?.entryDelayDuration ?? DEFAULT_ENTRY_DELAY;
    }
    if (state === ArmedState.STAY) {
      return settings?.armedStay?.entryDelayDuration ?? DEFAULT_ENTRY_DELAY;
    }
    return 0;
  }

  exitDelay(value) {
    const settings = this.settings?.armedStateSettings;
    if (value === Hk.AWAY) {
      return settings?.armedAway?.exitDelayDuration ?? 60;
    }
    if (value === Hk.STAY || value === Hk.NIGHT) {
      return settings?.armedStay?.exitDelayDuration ?? 0;
    }
    return 0;
  }

  async setTarget(value) {
    if (TO_ECOBEE[value] === undefined || (value === Hk.NIGHT && !this.offerNight)) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    if (this.store.hold) {
      this.log.info(`Home app changed the security system during the ${this.store.hold.by} hold; it won't be put back to Away.`);
      this.dropHold();
    }
    try {
      await this.serial(() => this.arm(value, 'Home app'));
    } catch (error) {
      // Put the Home app's target back to what ecobee really has.
      setTimeout(() => this.service.updateCharacteristic(this.C.SecuritySystemTargetState, this.target ?? Hk.DISARMED), 500);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Run hold/release/Home app commands one at a time. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async arm(value, source) {
    const armedState = TO_ECOBEE[value];
    const delay = this.exitDelay(value);
    const mode = { [Hk.STAY]: 'Stay', [Hk.AWAY]: 'Away', [Hk.NIGHT]: 'Night (ecobee Stay)' }[value];
    this.log.info(`${source}: ${value === Hk.DISARMED ? 'disarm' : `arm ${mode}`}`
      + (delay ? ` (exit delay ${delay} s)` : ''));
    try {
      const monitoring = await this.cloud.setArmedState(this.homeId, armedState, delay);
      this.commandAt = Date.now();
      if ((value === Hk.NIGHT) !== Boolean(this.store.night)) {
        if (value === Hk.NIGHT) {
          this.store.night = true;
        } else {
          delete this.store.night;
        }
        this.save();
      }
      if (monitoring) {
        this.apply({ monitoring });
      }
      this.schedule(2000);
    } catch (error) {
      this.log.error(`Could not change the security system: ${error.message}`);
      this.schedule(2000);
      throw error;
    }
  }

  dropHold() {
    delete this.store.hold;
    this.save();
  }

  /**
   * Another plugin (the robot vacuum) is about to move around the house. If the system is
   * armed Away (or arming Away), switch it to Stay and remember to put it back. Returns
   * `{ ok, held, state }`: `ok` false means it isn't safe to start (an alarm incident is open,
   * or the state isn't known yet).
   */
  hold(by) {
    return this.serial(async () => {
      if (!this.monitoring || this.failures >= FAULT_AFTER) {
        return { ok: false, held: false, state: 'unknown', reason: 'the security state is unknown' };
      }
      if (this.incidents.length) {
        return { ok: false, held: false, state: HK_NAMES[this.current], reason: 'an alarm incident is open' };
      }
      if (this.store.hold) {
        return { ok: true, held: true, state: HK_NAMES[this.target] };
      }
      if (this.target !== Hk.AWAY) {
        return { ok: true, held: false, state: HK_NAMES[this.target] };
      }
      await this.arm(Hk.STAY, `${by} hold`);
      this.store.hold = { by, since: new Date().toISOString() };
      this.save();
      return { ok: true, held: true, state: HK_NAMES[this.target] };
    });
  }

  /** The vacuum is back: put the system back to Away if we moved it and nobody has changed it since. */
  release(by) {
    return this.serial(async () => {
      if (!this.store.hold) {
        return { released: false, state: HK_NAMES[this.target] };
      }
      if (this.target !== Hk.STAY || this.incidents.length) {
        this.log.info(`${by} is done, but the security system is ${HK_NAMES[this.current]}; leaving it.`);
        this.dropHold();
        return { released: false, state: HK_NAMES[this.target] };
      }
      // Drop the hold first so apply() doesn't take our own Away for someone else's change.
      const hold = this.store.hold;
      this.dropHold();
      try {
        await this.arm(Hk.AWAY, `${by} done`);
      } catch (error) {
        this.store.hold = hold;
        this.save();
        throw error;
      }
      return { released: true, state: HK_NAMES[this.target] };
    });
  }
}
