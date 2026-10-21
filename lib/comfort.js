// "Comfort Setting" accessory: one HomeKit Television tile with an input per ecobee comfort setting
// (climate: Home, Away, Sleep and your own). Active is on while a comfort hold runs and off while the
// thermostats follow their schedule; the selected input is the held setting, or the one the schedule is
// on now. Picking an input holds it, switching the tile off goes back to the schedule. Holds set in the
// ecobee app or on the thermostat show up too. HomeKit allows one television per bridge, so this is its
// own accessory, published once after the first successful read (so the inputs exist when it is added).
// Reading is driven from outside: the platform's shared tick calls handle() with each read of the thermostats.
import { SignInRequiredError, vacationsOf } from './ecobee.js';

const FAULT_AFTER = 3;
const REVERT_DELAY = 1000;
const CONFIRM_DELAY = 3000;
const DEBOUNCE_DELAY = 300;

// Fixed input identifiers for ecobee's built-in settings; others are hashed from the climateRef.
const FIXED = { home: 1, away: 2, sleep: 3 };

function wantedId(ref) {
  if (ref in FIXED) {
    return FIXED[ref];
  }
  const smart = /^smart(\d+)$/.exec(ref);
  if (smart && Number(smart[1]) < 900) {
    return 10 + Number(smart[1]);
  }
  let hash = 2166136261;
  for (const ch of ref) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return 1000 + (hash % 998999);
}

export class ComfortSetting {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('./ecobee.js').EcobeeCloud} options.cloud
   * @param {string} options.homeId
   * @param {string} options.holdType nextTransition or indefinite
   * @param {string} options.version
   * @param {() => boolean} options.cloudDown the security system can't reach ecobee
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.publish as its own HomeKit accessory
   * @param {() => string[]} options.hidden climateRefs hidden in the Home app's input list
   * @param {(refs: string[]) => void} options.setHidden
   * @param {number} [options.confirmDelay]
   * @param {number} [options.debounceDelay]
   */
  constructor({ api, log, cloud, homeId, holdType, version, cloudDown, publish, hidden = () => [], setHidden = () => {},
    confirmDelay = CONFIRM_DELAY, debounceDelay = DEBOUNCE_DELAY }) {
    Object.assign(this, { api, log, cloud, homeId, holdType, version, cloudDown, publish, hidden, setHidden, confirmDelay, debounceDelay });
    this.C = api.hap.Characteristic;
    this.climates = new Map();   // climateRef -> { name, ids } (the union over the thermostats)
    this.inputs = new Map();     // climateRef -> { service, id, name }
    this.ids = new Map();        // climateRef -> identifier, never reassigned while running
    this.active = undefined;     // climateRef of the running hold, as last read
    this.scheduled = undefined;  // climateRef the schedule is on now
    this.requested = undefined;  // { want, seq }: the latest change sent and not yet confirmed
    this.seq = 0;
    this.confirms = 0;           // confirmations in progress; reads wait until they are done
    this.queue = Promise.resolve();
    this.onVacation = false;
    this.failures = 0;
    this.unreachable = false;
    this.stopped = false;
    this.known = false;          // a first read has succeeded
    this.published = false;
    this.pending = undefined;    // { active?, id? } written by HomeKit, acted on once it stops writing
    this.waits = new Set();
  }

  start() {}

  stop() {
    this.stopped = true;
    clearTimeout(this.revertTimer);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    for (const t of this.waits) {
      clearTimeout(t);
    }
    this.waits.clear();
  }

  isOut() {
    return this.unreachable || this.cloudDown();
  }

  noResponse() {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  wait(ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.waits.delete(t);
        resolve();
      }, ms);
      this.waits.add(t);
    });
  }

  idFor(ref) {
    let id = this.ids.get(ref);
    if (id === undefined) {
      const used = new Set(this.ids.values());
      id = wantedId(ref);
      while (used.has(id)) {
        id += 1;
      }
      this.ids.set(ref, id);
    }
    return id;
  }

  refFor(id) {
    for (const [ref, entry] of this.inputs) {
      if (entry.id === id) {
        return ref;
      }
    }
    return undefined;
  }

  nameOf(ref) {
    return ref === undefined ? 'the schedule' : (this.climates.get(ref)?.name ?? ref);
  }

  /** The held setting: the latest change not yet confirmed, otherwise what ecobee last said. */
  heldRef() {
    return this.requested ? this.requested.want : this.active;
  }

  holdRunning() {
    return !this.onVacation && this.heldRef() !== undefined;
  }

  /** The input shown: the held setting, otherwise the one the schedule is on now. */
  shownId() {
    const ref = [this.heldRef(), this.scheduled].find(r => r && this.inputs.has(r)) ?? this.inputs.keys().next().value;
    return ref === undefined ? 0 : this.inputs.get(ref).id;
  }

  /** Builds the accessory with its Television service the first time a read has climates. */
  ensure() {
    if (this.accessory) {
      return;
    }
    const { api, homeId, version, C } = this;
    const { Service } = api.hap;
    const uuid = api.hap.uuid.generate(`ecobee-security:comfort-tv:${homeId}`);
    this.accessory = new api.platformAccessory('Comfort Setting', uuid, api.hap.Categories.TV_STREAMING_STICK);
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'ecobee')
      .setCharacteristic(C.Model, 'Comfort Setting')
      .setCharacteristic(C.SerialNumber, `${homeId}-comfort`)
      .setCharacteristic(C.FirmwareRevision, version);
    const tv = this.accessory.addService(new Service.Television('Comfort Setting'));
    this.tv = tv;
    tv.setCharacteristic(C.ConfiguredName, 'Comfort Setting');
    tv.setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    tv.getCharacteristic(C.RemoteKey).onSet(() => {});
    tv.getCharacteristic(C.Active)
      .onGet(() => this.read(() => (this.holdRunning() ? 1 : 0)))
      .onSet(value => this.write({ active: value === C.Active.ACTIVE }));
    tv.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.read(() => this.shownId()))
      .onSet(value => this.write({ id: Number(value) }));
  }

  read(value) {
    if (this.isOut() || !this.known) {
      throw this.noResponse();
    }
    return value();
  }

  /** Adds, removes and renames the inputs to match the climates. */
  reconcile(climates) {
    if (!climates.size && !this.accessory) {
      return;
    }
    this.ensure();
    const { Service } = this.api.hap;
    const C = this.C;
    for (const [ref, entry] of this.inputs) {
      if (!climates.has(ref)) {
        this.tv.removeLinkedService(entry.service);
        this.accessory.removeService(entry.service);
        this.inputs.delete(ref);
      }
    }
    for (const [ref, { name }] of climates) {
      let entry = this.inputs.get(ref);
      if (!entry) {
        const service = new Service.InputSource(name, ref);
        const id = this.idFor(ref);
        const visibility = this.hidden().includes(ref) ? C.TargetVisibilityState.HIDDEN : C.TargetVisibilityState.SHOWN;
        service
          .setCharacteristic(C.Identifier, id)
          .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
          .setCharacteristic(C.InputSourceType, C.InputSourceType.OTHER)
          .setCharacteristic(C.CurrentVisibilityState, visibility)
          .setCharacteristic(C.TargetVisibilityState, visibility);
        // The Home app's show/hide toggle in the input list: follow it and remember it.
        service.getCharacteristic(C.TargetVisibilityState).onSet(value => {
          service.updateCharacteristic(C.CurrentVisibilityState, value);
          const hidden = new Set(this.hidden());
          hidden[value === C.TargetVisibilityState.HIDDEN ? 'add' : 'delete'](ref);
          this.setHidden([...hidden]);
        });
        this.accessory.addService(service);
        this.tv.addLinkedService(service);
        entry = { service, id, name: undefined };
        this.inputs.set(ref, entry);
      }
      // New, or renamed in the ecobee app.
      if (entry.name !== name) {
        entry.service.setCharacteristic(C.Name, name).setCharacteristic(C.ConfiguredName, name);
        entry.name = name;
      }
    }
    // The inputs in ecobee's order (the climates as the thermostats list them).
    const order = Buffer.concat([...climates.keys()].flatMap((ref, i) => {
      const id = Buffer.alloc(4);
      id.writeUInt32LE(this.inputs.get(ref).id);
      return [...(i ? [Buffer.from([0x00, 0x00])] : []), Buffer.from([0x01, 0x04]), id];
    })).toString('base64');
    if (this.order !== order) {
      this.order = order;
      this.tv.updateCharacteristic(C.DisplayOrder, order);
    }
  }

  /** Reads the thermostats: climates (the union), the running hold, the scheduled climate and a vacation. Logs a changed setting. */
  apply(thermostats) {
    const climates = new Map();
    for (const t of thermostats) {
      for (const c of t.program?.climates ?? []) {
        if (!c.climateRef) {
          continue;
        }
        const entry = climates.get(c.climateRef) ?? { name: c.name || c.climateRef, ids: [] };
        entry.ids.push(t.id);
        climates.set(c.climateRef, entry);
      }
    }
    this.reconcile(climates);
    this.climates = climates;
    // A temperature-only hold has no climate: the same as following the schedule.
    let active;
    for (const t of thermostats) {
      const hold = (t.events ?? []).find(e => e.type === 'hold' && e.running && e.holdClimateRef);
      if (hold && climates.has(hold.holdClimateRef)) {
        active = hold.holdClimateRef;
        break;
      }
    }
    this.scheduled = thermostats.map(t => t.program?.currentClimateRef).find(ref => ref && climates.has(ref));
    const was = this.known ? this.active : undefined;
    const wasKnown = this.known;
    this.active = active;
    this.onVacation = vacationsOf(thermostats).length > 0;
    this.known = true;
    if (wasKnown && active !== was) {
      this.log.info(active
        ? `Comfort setting now: ${climates.get(active).name} (hold ${this.holdType === 'indefinite' ? 'until you change it' : 'until the next scheduled change'})`
        : 'Comfort setting now: following the schedule');
    }
    if (!this.published && this.inputs.size) {
      this.published = true;
      this.publish([this.accessory]);
      this.log.info('"Comfort Setting" is published as its own HomeKit accessory. If it isn\'t in the Home app yet, '
        + 'add it with the setup code shown above.');
    }
  }

  /** One shared read of the thermostats (or its error) from the platform's tick. */
  handle(thermostats, error) {
    if (this.confirms > 0) {
      return;
    }
    if (error) {
      this.failures += 1;
      if (this.failures >= FAULT_AFTER) {
        this.unreachable = true;
      }
      if (!(error instanceof SignInRequiredError)) {
        this.log[this.failures >= FAULT_AFTER ? 'warn' : 'debug'](`Could not read the ecobee comfort setting (${error.message}).`);
      }
    } else {
      this.apply(thermostats);
      if (this.failures >= FAULT_AFTER) {
        this.log.info('Comfort setting is readable again.');
      }
      this.failures = 0;
      this.unreachable = false;
    }
    this.show();
  }

  /** The tile: No Response while ecobee can't be reached, otherwise its state (including a change not yet confirmed). */
  show() {
    if (!this.tv || !this.published || this.debounceTimer) {
      return;   // not published yet, or HomeKit is still writing
    }
    const { Active, ActiveIdentifier } = this.C;
    const out = this.isOut() || !this.known;
    this.tv.updateCharacteristic(Active, out ? this.noResponse() : (this.holdRunning() ? 1 : 0));
    this.tv.updateCharacteristic(ActiveIdentifier, out ? this.noResponse() : this.shownId());
  }

  /** Shows the state as it really is shortly after HomeKit's own update has landed. */
  revert() {
    clearTimeout(this.revertTimer);
    this.revertTimer = setTimeout(() => this.show(), REVERT_DELAY);
  }

  /** After a change, re-reads (fresh) and shows the real state; warns when it isn't what was asked for. Only the latest change is judged. */
  async confirm(want, seq) {
    this.confirms += 1;
    try {
      await this.wait(this.confirmDelay);
      if (this.stopped || this.requested?.seq !== seq) {
        return;   // superseded by a newer change, which confirms for itself
      }
      try {
        this.apply(await this.cloud.getThermostats(this.homeId, 0));
      } catch (error) {
        this.log.debug(`Could not re-read the ecobee comfort setting (${error.message}).`);
      }
      if (this.requested?.seq !== seq) {
        return;
      }
      this.requested = undefined;
      if (this.active !== want) {
        this.log.warn(`ecobee did not apply the comfort setting (asked for ${this.nameOf(want)}, ecobee has ${this.nameOf(this.active)}); showing its real state.`);
      }
    } finally {
      this.confirms -= 1;
    }
    if (this.confirms === 0) {
      this.show();
    }
  }

  /** Holds a comfort setting (climateRef), or goes back to the schedule (undefined). Callers check() first. */
  change(want) {
    const seq = ++this.seq;
    this.requested = { want, seq };
    this.show();
    const run = this.queue.then(async () => {
      try {
        if (want) {
          await this.cloud.setComfortHold(this.climates.get(want).ids, want, this.holdType);
        } else {
          await this.cloud.resumeProgram([...new Set([...this.climates.values()].flatMap(e => e.ids))]);
        }
      } catch (error) {
        this.log.warn(`Could not change the ecobee comfort setting (${error.message}).`);
        if (this.requested?.seq === seq) {
          this.requested = undefined;
        }
        this.revert();
        throw error;
      }
      this.confirm(want, seq);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Whether a change may go ahead: throws No Response while ecobee can't be reached, false (and says why) on vacation. */
  check() {
    if (this.isOut()) {
      throw this.noResponse();
    }
    if (this.onVacation) {
      this.log.info('ecobee is on vacation; end the vacation to change the comfort setting.');
      this.revert();
      return false;
    }
    return true;
  }

  /**
   * HomeKit writes Active and ActiveIdentifier separately (often both when an input is picked while the
   * tile is off); the last values win and are acted on together once the writes stop.
   */
  write(part) {
    this.log.debug(`Comfort Setting: HomeKit set ${Object.entries(part).map(([k, v]) => `${k === 'active' ? 'Active' : 'ActiveIdentifier'}=${typeof v === 'boolean' ? Number(v) : v}`).join(' ')}`);
    if (this.isOut() || !this.known) {
      throw this.noResponse();
    }
    this.pending = { ...this.pending, ...part };
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const intent = this.pending;
      this.pending = undefined;
      this.flush(intent).catch(error => this.log.debug(`Comfort setting change failed (${error.message}).`));
    }, this.debounceDelay);
  }

  async flush({ active, id }) {
    if (this.stopped) {
      return;
    }
    if (this.isOut()) {
      this.revert();
      return;
    }
    if (!this.check()) {
      return;
    }
    // Picking an input means holding it; Active off wins and goes back to the schedule.
    const on = active ?? (id !== undefined ? true : this.holdRunning());
    const ref = on ? this.refFor(id === undefined ? this.shownId() : id) : undefined;
    this.log.debug(`Comfort Setting: flush ${JSON.stringify({ active, id })} -> ${on ? `hold ${ref === undefined ? '(unknown input)' : this.nameOf(ref)}` : 'schedule'}`);
    if (!on) {
      if (this.heldRef() !== undefined) {
        await this.change(undefined);
      }
      return;
    }
    if (!ref) {
      this.log.warn('That comfort setting is no longer in ecobee; showing its real state.');
      this.revert();
      return;
    }
    if (this.heldRef() !== ref) {
      await this.change(ref);
    }
  }
}
