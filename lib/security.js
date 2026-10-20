import { ArmedState, SignInRequiredError } from './ecobee.js';
import { sendHalt } from './halt.js';
import { VERSION } from './version.js';

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
// Robots back (or stopped) before an extended exit delay ends: arm this long after, at the earliest.
const ARM_AFTER_RETURN = 10 * 1000;
// Exit delay (s) for putting Away back after a hold; ecobee needs an exit-delay end in the future (0 lands in the past).
const RELEASE_EXIT_DELAY = 3;
const FAULT_AFTER = 3;
// Every thermostat unreachable for this long (ms): the security system counts as offline.
const OFFLINE_AFTER = 60 * 1000;

export class SecuritySystem {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('homebridge').PlatformAccessory} options.accessory
   * @param {import('./ecobee.js').EcobeeCloud} options.cloud
   * @param {object} options.home first GraphQL home object
   * @param {number} options.pollInterval seconds
   * @param {object} options.store persisted plugin state (`hold`, `out` and `night` live here)
   * @param {() => void} options.save persist `store`
   * @param {boolean} [options.offerNight] offer HomeKit's Night, which arms ecobee's Stay
   * @param {boolean} [options.alarmAfterEntryDelay] show Alarm triggered only once an intrusion
   *   incident has outlasted the entry delay, instead of as soon as ecobee opens it
   * @param {import('homebridge').PlatformAccessory} [options.smokeAccessory] separate accessory for a Smoke
   *   Sensor that shows ecobee's smoke-alarm incidents (none: no smoke sensor)
   */
  constructor({ api, log, accessory, cloud, home, pollInterval, store, save, offerNight = false, alarmAfterEntryDelay = false,
    returnWait = 120, smokeAccessory }) {
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
    // The tiles show No Response instead of the last state when either holds: the plugin can't reach
    // ecobee (or is signed out), or ecobee's cloud can't reach the thermostats Smart Security runs on.
    this.cloudDown = false;
    this.thermostatsDown = false;
    this.outSince = undefined;
    this.outKey = '';
    this.commandAt = 0;
    this.stopped = false;
    this.offerNight = offerNight;
    this.alarmAfterEntryDelay = alarmAfterEntryDelay;
    // Extra exit-delay time for robots heading back to their base when Away is armed (ms).
    this.returnWait = Math.max(0, returnWait) * 1000;
    this.openIncidents = [];
    this.firstSeen = new Map();

    const { Service, Characteristic } = api.hap;
    this.C = Characteristic;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
      .setCharacteristic(Characteristic.Model, 'Smart Security')
      .setCharacteristic(Characteristic.SerialNumber, home.id)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);

    // HomeKit keeps a control's list of modes from when it was first published, so turning Night
    // on or off only reaches the Home app as a new service (subtype 'night' or none). The old one
    // is removed, which means scenes and automations that used it have to be set up again.
    const subtype = offerNight ? 'night' : undefined;
    const stale = accessory.services.filter(s => s.UUID === Service.SecuritySystem.UUID && s.subtype !== subtype);
    if (stale.length) {
      stale.forEach(s => accessory.removeService(s));
      log.warn(`"Enable Night" was turned ${offerNight ? 'on' : 'off'}, so the security system was recreated in HomeKit `
        + 'to show it. Set up again any Home app scenes and automations that use it.');
    }
    this.service = accessory.services.find(s => s.UUID === Service.SecuritySystem.UUID)
      ?? accessory.addService(Service.SecuritySystem, accessory.displayName, subtype);
    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .setProps({ validValues: offerNight ? [Hk.STAY, Hk.AWAY, Hk.NIGHT, Hk.DISARMED, Hk.TRIGGERED] : [Hk.STAY, Hk.AWAY, Hk.DISARMED, Hk.TRIGGERED] })
      .onGet(() => this.read(this.current, Characteristic.SecuritySystemCurrentState));
    this.service.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({ validValues: offerNight ? [Hk.STAY, Hk.AWAY, Hk.NIGHT, Hk.DISARMED] : [Hk.STAY, Hk.AWAY, Hk.DISARMED] })
      .onGet(() => this.read(this.shownTarget, Characteristic.SecuritySystemTargetState))
      .onSet(value => this.setTarget(value));
    if (!this.service.testCharacteristic(Characteristic.StatusFault)) {
      this.service.addCharacteristic(Characteristic.StatusFault);
    }

    // Smoke Sensor for ecobee's smoke-alarm detection, on its own accessory: on the security
    // accessory the Home app merges it into the security tile. (0.4.0 test builds put it there.)
    const merged = accessory.getService(Service.SmokeSensor);
    if (merged) {
      accessory.removeService(merged);
    }
    if (smokeAccessory) {
      smokeAccessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
        .setCharacteristic(Characteristic.Model, 'Smart Security smoke detection')
        .setCharacteristic(Characteristic.SerialNumber, `${home.id}-smoke`)
        .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
      this.smoke = smokeAccessory.getService(Service.SmokeSensor)
        ?? smokeAccessory.addService(Service.SmokeSensor, smokeAccessory.displayName);
      this.smoke.getCharacteristic(Characteristic.SmokeDetected)
        .onGet(() => this.read(this.smokeShown, Characteristic.SmokeDetected, this.smoke));
      if (!this.smoke.testCharacteristic(Characteristic.StatusFault)) {
        this.smoke.addCharacteristic(Characteristic.StatusFault);
      }
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
      const wasOffline = this.offline;
      this.reachable();
      this.noteThermostats(home.devices?.thermostats);
      // A command that finished while this poll was running is newer than what we just read.
      if (startedAt >= this.commandAt) {
        this.apply(home);
      } else if (wasOffline && !this.offline) {
        this.apply({});
      }
      const until = Date.parse(home.monitoring?.delayedArmedState?.delayedUntil ?? '');
      if (until > Date.now()) {
        // Catch the end of an exit delay promptly.
        next = Math.min(next, until - Date.now() + 1500);
      }
    } catch (error) {
      this.failures += 1;
      if (error instanceof SignInRequiredError) {
        this.setOffline();
        this.log.error(`${error.message}. Sign in again: run bin/ecobee-login.js (see the plugin README), `
          + 'paste the new refresh token into the plugin settings and restart the bridge.');
        return;
      }
      next = Math.min(this.pollInterval * 2 ** this.failures, MAX_BACKOFF);
      if (this.failures === FAULT_AFTER) {
        this.setOffline();
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

  /** Offline for either reason; the tiles show No Response. */
  get offline() {
    return this.cloudDown || this.thermostatsDown;
  }

  /** The plugin can't reach ecobee: the tiles show No Response. The fault stays set for as long. */
  setOffline() {
    const wasOffline = this.offline;
    this.cloudDown = true;
    this.setFault(true);
    if (!wasOffline) {
      this.pushNoResponse();
    }
  }

  /** A read or command got through: ecobee is reachable (apply() then puts the real state back on the tiles). */
  reachable() {
    if (this.cloudDown) {
      this.log.info('ecobee is reachable again.');
    }
    this.cloudDown = false;
    this.failures = 0;
    this.setFault(this.offline);
  }

  /** Pushed at once, so the tile changes without waiting for the Home app to read it. */
  pushNoResponse() {
    const { SecuritySystemCurrentState, SecuritySystemTargetState, SmokeDetected } = this.C;
    this.service.updateCharacteristic(SecuritySystemCurrentState, this.noResponse());
    this.service.updateCharacteristic(SecuritySystemTargetState, this.noResponse());
    this.smoke?.updateCharacteristic(SmokeDetected, this.noResponse());
  }

  /**
   * ecobee's view of the thermostats (their `connected` flags). The system counts as offline once
   * every thermostat that reports a flag has been unreachable for OFFLINE_AFTER, without a break; a
   * single thermostat dropping out for a moment is normal (debug log only). Back as soon as one is
   * connected. Without the data (ecobee rejected the fields), there is no check. The next apply()
   * puts the real state back on the tiles.
   */
  noteThermostats(thermostats = []) {
    const known = thermostats.filter(t => typeof t.legacyRuntime?.connected === 'boolean');
    const out = known.filter(t => !t.legacyRuntime.connected).map(t => t.name ?? t.id);
    const key = out.join(', ');
    if (key !== this.outKey) {
      this.outKey = key;
      this.log.debug(out.length ? `ecobee can't reach: ${key}.` : 'ecobee reaches all thermostats.');
    }
    if (!known.length || out.length < known.length) {
      this.outSince = undefined;
      if (this.thermostatsDown) {
        this.thermostatsDown = false;
        this.log.info('Smart Security is back online.');
        this.setFault(this.offline);
      }
      return;
    }
    this.outSince ??= Date.now();
    if (!this.thermostatsDown && Date.now() - this.outSince >= OFFLINE_AFTER) {
      const wasOffline = this.offline;
      this.thermostatsDown = true;
      this.log.warn(`Smart Security is offline: ecobee can't reach the thermostats (${key}).`);
      this.setFault(true);
      if (!wasOffline) {
        this.pushNoResponse();
      }
    }
  }

  noResponse() {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** A Home app read: the last known value, or No Response while ecobee can't be reached. */
  read(value, characteristic, service = this.service) {
    if (this.offline) {
      throw this.noResponse();
    }
    return value ?? service.getCharacteristic(characteristic).value;
  }

  /** What the Home app shows as the target, unless ecobee can't be reached. */
  showTarget(value) {
    this.shownTarget = value;
    if (!this.offline) {
      this.service.updateCharacteristic(this.C.SecuritySystemTargetState, value);
    }
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
        + `${this.holders().join(' and ')} hold; it won't be put back to Away.`);
      this.dropHold();
    }
    // Armed Away some other way (the ecobee app, the keypad, Arm Away Now) with robots out: send them
    // back before the exit delay ends (a keypad's is only seen once armed: stop them now).
    if (target === Hk.AWAY && this.outNames().length) {
      const until = Date.parse(this.monitoring.delayedArmedState?.delayedUntil ?? '');
      const why = `The security system ${until > Date.now() ? 'is arming' : 'was armed'} Away`;
      this.serial(() => this.haltRobots(why, until > Date.now() ? until : undefined)).catch(() => {});
    }
    // Waiting for robots on their way back: over once Away is armed or no longer asked for.
    if (this.store.returning && (target !== Hk.AWAY || armed === Hk.AWAY)) {
      delete this.store.returning;
      this.save();
    }
    // Away asked for in the Home app during a hold waits for the release: show it as arming Away.
    this.shownTarget = this.store.hold?.away ? Hk.AWAY : target;
    if (this.smoke) {
      const { SmokeDetected } = this.C;
      const smoke = this.incidents.some(i => i.detectedSmokeAlarm);
      this.smokeShown = smoke ? SmokeDetected.SMOKE_DETECTED : SmokeDetected.SMOKE_NOT_DETECTED;
    }
    // Pushed whether it changed or not, so the tiles come back from No Response. Not while offline:
    // an alarm timer or a late command must not hide it.
    if (this.offline) {
      return;
    }
    this.service.updateCharacteristic(SecuritySystemTargetState, this.shownTarget);
    this.service.updateCharacteristic(SecuritySystemCurrentState, current);
    this.smoke?.updateCharacteristic(this.C.SmokeDetected, this.smokeShown);
  }

  /**
   * Open incidents that are alarms: smoke always, intrusions only while armed. ecobee also opens an
   * intrusion incident for a camera activity alert while the system is off; that isn't an alarm.
   */
  get incidents() {
    const armed = [ArmedState.STAY, ArmedState.AWAY].includes(this.monitoring?.armedState);
    return this.openIncidents.filter(i => i.detectedSmokeAlarm || armed);
  }

  noteIncidents(incidents) {
    this.openIncidents = incidents.filter(i => !CLOSED_INCIDENT.test(i.status ?? ''));
    const summary = JSON.stringify(incidents);
    if (summary !== this.incidentSummary) {
      if (incidents.length || this.incidentSummary !== undefined) {
        this.log.info(`Incidents: ${incidents.length ? summary : 'none'}`);
      }
      this.incidentSummary = summary;
    }
    // ecobee's incidents carry no time we read, so the entry delay counts from when we first saw one.
    const now = Date.now();
    const ids = new Set(this.openIncidents.map(i => i.id));
    this.openIncidents.forEach(i => this.firstSeen.has(i.id) || this.firstSeen.set(i.id, now));
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

  /** @param {string} [source] who asked, for the log (the Home Occupied switch asks too) */
  async setTarget(value, source = 'Home app') {
    if (TO_ECOBEE[value] === undefined || (value === Hk.NIGHT && !this.offerNight)) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    // HomeKit can't say who asked (requests come through the home hub), so Away always waits for
    // robots that are out; the Arm Away Now switch is the way to stop them and arm now.
    if (value === Hk.AWAY && this.outNames().length && await this.serial(() => this.deferAway(source))) {
      return;
    }
    if (this.store.hold) {
      this.log.info(`${source} changed the security system during the ${this.holders().join(' and ')} hold; it won't be put back to Away.`);
      this.dropHold();
    }
    try {
      await this.serial(() => this.arm(value, source));
    } catch (error) {
      // Put the Home app's target back to what ecobee really has.
      setTimeout(() => this.showTarget(this.target ?? Hk.DISARMED), 500);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }


  /**
   * Away from the Home app while robots are out (say, a scene run from far away while one cleans):
   * the release arms Away anyway, so keep (or start) the hold and let it; Stay meanwhile. Returns
   * true if Away now waits.
   */
  async deferAway(source = 'Home app') {
    const out = this.outNames();
    if (!out.length || this.incidents.length || (this.store.hold && this.target !== Hk.STAY)) {
      return false;
    }
    if (!this.store.hold) {
      // The robots started while the system wasn't Away, so nothing holds Stay for them yet.
      if (this.target !== Hk.STAY || this.store.night) {
        await this.arm(Hk.STAY, `${out.join(' and ')} out`);
      }
      this.store.hold = { by: out, since: new Date().toISOString() };
    }
    this.store.hold = { ...this.store.hold, away: true };
    this.save();
    this.log.info(`${source}: arm Away — waiting until ${this.holders().join(' and ')} ${this.holders().length > 1 ? 'are' : 'is'} done (security hold). `
      + 'Use the Arm Away Now switch to stop and arm now.');
    this.showTarget(Hk.AWAY);
    return true;
  }

  /**
   * The Arm Away Now switch: drop the hold and arm Away (normal exit delay); apply() then sends
   * robots that are out back to their base (or stops them), as for Away from the ecobee app.
   */
  armAwayNow() {
    return this.serial(async () => {
      if (this.store.hold) {
        this.dropHold();
      }
      await this.arm(Hk.AWAY, 'Arm Away Now');
    });
  }


  /**
   * A door was unlocked with its keypad: disarm, like Nest Guard with a Nest × Yale lock. Retried
   * once, since a missed disarm means an alarm.
   */
  keypadDisarm(lock) {
    return this.serial(async () => {
      if (this.store.hold) {
        this.log.info(`${lock} was unlocked during the ${this.holders().join(' and ')} hold; it won't be put back to Away.`);
        this.dropHold();
      }
      // Only disarm what's armed: a disarm sent while ecobee is already off isn't a no-op for ecobee
      // (camera activity alerts followed it), so read the live state first. Can't read it: disarm anyway.
      if (await this.refresh() && this.monitoring?.armedState === ArmedState.DISARMED
        && !this.monitoring.delayedArmedState?.desiredArmedState) {
        this.log.info(`${lock} was unlocked with its keypad; the security system is already off.`);
        return;
      }
      try {
        await this.arm(Hk.DISARMED, `${lock} unlocked with its keypad`);
      } catch {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.arm(Hk.DISARMED, `${lock} unlocked with its keypad (retry)`);
      }
    });
  }

  /**
   * The Home Occupied switch (or another source of presence) changed. Empty arms Away the way Away
   * from the Home app does: waiting for robots that are out, with the normal exit delay. Occupied
   * disarms an Away system only (armed, arming, or waiting on a hold), never Home, Night or Off.
   * Failures are logged, not thrown: the presence fact stays true either way.
   * @param {boolean} occupied
   * @param {string} [source] who says so, for the log
   */
  async occupancyChanged(occupied, source = 'Home Occupied') {
    try {
      if (occupied) {
        await this.serial(() => this.disarmAway(source));
      } else {
        await this.armAwayEmpty(source);
      }
    } catch (error) {
      this.log.warn(`${source}: could not ${occupied ? 'disarm' : 'arm Away'} (${error.message}). `
        + 'The security system is left as it is.');
    }
  }

  async armAwayEmpty(source) {
    // The live state, not the last poll: Away arrived by another route a moment ago must not restart.
    await this.refresh();
    // Under a hold the system shows Home, but Away is on its way back (or asked for).
    if (this.target === Hk.AWAY || this.store.hold) {
      this.log.info(`${source}: nobody home; the security system is already Away, or waiting to be.`);
      return;
    }
    this.log.info(`${source}: nobody home; arming Away.`);
    await this.setTarget(Hk.AWAY, source);
  }

  /**
   * Someone is home: turn Away off. A held system (a robot is out) counts as Away, since the release
   * would arm it again. Like keypadDisarm: decide on the live state and retry once.
   */
  async disarmAway(source) {
    const live = await this.refresh();
    const away = this.target === Hk.AWAY || Boolean(this.store.hold);
    if (!away) {
      // Can't read ecobee: only the last state we saw can say, and that's no Away.
      this.log.info(`${source}: someone is home; the security system is ${HK_NAMES[this.current]}`
        + `${live ? '' : ' (as last seen; ecobee could not be read)'}, so it is left as it is.`);
      return;
    }
    if (this.store.hold) {
      this.log.info(`${source}: someone is home during the ${this.holders().join(' and ')} hold; it won't be put back to Away.`);
      this.dropHold();
    }
    try {
      await this.arm(Hk.DISARMED, `${source}: someone is home`);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.arm(Hk.DISARMED, `${source}: someone is home (retry)`);
    }
  }

  /** Robots (or other plugins) that asked for a hold and haven't released yet, held or not. */
  outNames() {
    return Object.keys(this.store.out ?? {});
  }

  /**
   * The system is being armed Away with robots out. With `armAt` (when the motion sensors arm, the
   * end of the exit delay), each robot heads back to its base if it can make it and stops where it
   * is if it doesn't; without it, it stops now (pause, not dock). They're forgotten and the hold
   * dropped right away; a robot that moves again asks for a new hold.
   *
   * Wait for them: ecobee accepts a later end for an exit delay that's counting down, so it's pushed
   * back by `returnWait`, and brought forward again (never before `armAt`) once every robot that
   * headed back has said it's in, or stopped (`/release`).
   */
  async haltRobots(reason, armAt) {
    const out = Object.entries(this.store.out ?? {});
    if (!out.length) {
      return;
    }
    delete this.store.out;
    if (this.store.hold) {
      this.dropHold();
    }
    this.save();
    if (armAt && this.returnWait > 0 && out.some(([, robot]) => robot.halt)) {
      try {
        await this.setExitDelayEnd(armAt + this.returnWait);
        this.log.info(`Exit delay extended by ${Math.round(this.returnWait / 1000)} s so robots can get back to their base.`);
        armAt += this.returnWait;
        this.store.returning = { armAt: armAt - this.returnWait, names: [] };
        this.save();
      } catch (error) {
        this.log.warn(`Could not extend the exit delay (${error.message}); robots have until it ends as usual.`);
      }
    }
    const names = out.map(([by]) => by).join(' and ');
    this.log.info(armAt ? `${reason}: asking ${names} to be back at base or stopped by ${new Date(armAt).toLocaleTimeString()}.`
      : `${reason}: asking ${names} to stop.`);
    await Promise.all(out.map(async ([by, robot]) => {
      if (!robot.halt) {
        this.log.warn(`${by} can't be asked to stop (${robot.plugin ?? 'its plugin'} doesn't support it); it may set off the motion sensors.`);
        return;
      }
      try {
        const result = await sendHalt(robot.halt, by, armAt);
        const what = result.returning ? 'heading back to its base' : result.halted ? 'stopped' : `not stopped (${result.reason ?? 'no reason given'})`;
        this.log[result.halted ? 'info' : 'warn'](`${by}: ${what}.`);
        if (result.returning && this.store.returning) {
          this.store.returning.names.push(by);
          this.save();
        }
      } catch (error) {
        this.log.warn(`Could not ask ${by} to stop (${error.message}); it may set off the motion sensors.`);
      }
    }));
    if (this.store.returning && !this.store.returning.names.length) {
      await this.armWhenBack('No robot is heading back');
    }
  }

  /** Robots that were sent back to their base and haven't said they're in yet. */
  returningNames() {
    return this.store.returning?.names ?? [];
  }

  /**
   * Every robot that headed back is in (or stopped): bring the end of the extended exit delay forward
   * again, to its original end, or a few seconds from now if that has passed.
   */
  async armWhenBack(why) {
    const { armAt } = this.store.returning;
    delete this.store.returning;
    this.save();
    const delayed = this.monitoring?.delayedArmedState;
    if (this.monitoring?.armedState === ArmedState.AWAY || delayed?.desiredArmedState !== ArmedState.AWAY) {
      return;
    }
    const until = Math.max(armAt, Date.now() + ARM_AFTER_RETURN);
    if (until >= Date.parse(delayed.delayedUntil ?? '')) {
      return;
    }
    this.log.info(`${why}: arming Away at ${new Date(until).toLocaleTimeString()}.`);
    try {
      await this.setExitDelayEnd(until);
    } catch (error) {
      this.log.warn(`Could not bring the exit delay forward (${error.message}); it ends as extended.`);
    }
  }

  /** Move the end of an Away exit delay (ecobee takes a new end while it counts down). */
  async setExitDelayEnd(until) {
    const monitoring = await this.cloud.setArmedState(this.homeId, ArmedState.AWAY, 0, until);
    this.commandAt = Date.now();
    this.reachable();
    if (monitoring) {
      this.apply({ monitoring });
    }
    this.schedule(2000);
  }

  /** Run hold/release/Home app commands one at a time. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** @param {number} [delay] exit delay in seconds; defaults to the one set in ecobee */
  async arm(value, source, delay = this.exitDelay(value)) {
    const armedState = TO_ECOBEE[value];
    const mode = { [Hk.STAY]: 'Stay', [Hk.AWAY]: 'Away', [Hk.NIGHT]: 'Night (ecobee Stay)' }[value];
    this.log.info(`${source}: ${value === Hk.DISARMED ? 'disarm' : `arm ${mode}`}`
      + (delay ? ` (exit delay ${delay} s)` : ''));
    try {
      const monitoring = await this.cloud.setArmedState(this.homeId, armedState, delay);
      this.commandAt = Date.now();
      this.reachable();
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

  /** Read the state now (for hold decisions). Resolves false if ecobee can't be read. */
  async refresh() {
    try {
      const home = (await this.cloud.getHomes()).find(h => h.id === this.homeId);
      if (!home) {
        throw new Error('the home is no longer on this ecobee account');
      }
      this.reachable();
      this.noteThermostats(home.devices?.thermostats);
      this.apply(home);
      return true;
    } catch (error) {
      this.log.warn(`Could not read the security state (${error.message}).`);
      return false;
    }
  }

  dropHold() {
    delete this.store.hold;
    this.save();
  }

  /** Who is holding Stay (several robots can be out at once). Up to 0.4.x `by` was a single name. */
  holders() {
    const by = this.store.hold?.by;
    return Array.isArray(by) ? by : by ? [by] : [];
  }

  /**
   * Another plugin (the robot vacuum) is about to move around the house. If the system is
   * armed Away (or arming Away), switch it to Stay and remember to put it back. Returns
   * `{ ok, held, state }`: `ok` false means it isn't safe to start (an alarm incident is open,
   * or the state isn't known yet).
   */
  hold(by, { plugin, halt } = {}) {
    return this.serial(async () => {
      // Decide on ecobee's live state, not the last poll: a disarm moments ago must not become a Stay.
      if (!(await this.refresh()) || !this.monitoring) {
        return { ok: false, held: false, state: 'unknown', reason: 'the security state is unknown' };
      }
      if (this.offline) {
        return { ok: false, held: false, state: 'offline', reason: 'the security system is offline' };
      }
      if (this.incidents.length) {
        return { ok: false, held: false, state: HK_NAMES[this.current], reason: 'an alarm incident is open' };
      }
      // Remember who's out (and how to stop them) until they release, held or not. Only once Stay is
      // decided: a poll seeing Away in between would otherwise stop this very robot.
      const noteOut = () => {
        this.store.out = { ...this.store.out, [by]: { plugin, halt, since: this.store.out?.[by]?.since ?? new Date().toISOString() } };
        this.save();
      };
      if (this.store.hold) {
        if (!this.holders().includes(by)) {
          this.store.hold = { ...this.store.hold, by: [...this.holders(), by] };
          this.save();
          this.log.info(`${by} joined the hold; Away comes back once ${this.holders().join(' and ')} are done.`);
        }
        noteOut();
        return { ok: true, held: true, state: HK_NAMES[this.target] };
      }
      if (this.target !== Hk.AWAY) {
        noteOut();
        return { ok: true, held: false, state: HK_NAMES[this.target] };
      }
      await this.arm(Hk.STAY, `${by} hold`);
      this.store.hold = { by: [by], since: new Date().toISOString() };
      noteOut();
      return { ok: true, held: true, state: HK_NAMES[this.target] };
    });
  }

  /** The vacuum is back: put the system back to Away if we moved it and nobody has changed it since. */
  release(by) {
    return this.serial(async () => {
      // A change since the last poll (say, a disarm in the ecobee app) drops the hold in apply(),
      // so a fresh read is what keeps us from arming Away over it. Can't read it: don't arm.
      if (!(await this.refresh())) {
        throw new Error('could not read the security state; not arming Away');
      }
      if (this.store.out?.[by]) {
        delete this.store.out[by];
        this.save();
      }
      if (this.returningNames().includes(by)) {
        this.store.returning.names = this.returningNames().filter(name => name !== by);
        this.save();
        const others = this.returningNames();
        if (others.length) {
          this.log.info(`${by} is back; still waiting for ${others.join(' and ')}.`);
        } else {
          await this.armWhenBack(`${by} is back`);
        }
        return { released: true, state: HK_NAMES[this.target] };
      }
      if (!this.store.hold) {
        return { released: false, state: HK_NAMES[this.target] };
      }
      const others = this.holders().filter(name => name !== by);
      if (others.length) {
        // Someone else is still out: keep Stay until the last one is done.
        this.store.hold = { ...this.store.hold, by: others };
        this.save();
        this.log.info(`${by} is done; staying in Stay for ${others.join(' and ')}.`);
        return { released: false, state: HK_NAMES[this.target], waiting: others };
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
        // A hold that switched an armed Away to Stay puts it back after a short countdown (the house was already empty).
        // Away asked for during the hold is a fresh request: someone may still be leaving, so the normal exit delay.
        await this.arm(Hk.AWAY, `${by} done`, hold.away ? undefined : RELEASE_EXIT_DELAY);
      } catch (error) {
        this.store.hold = hold;
        this.save();
        throw error;
      }
      return { released: true, state: HK_NAMES[this.target] };
    });
  }
}
