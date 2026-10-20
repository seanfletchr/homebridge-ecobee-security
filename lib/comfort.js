// "Comfort Setting" accessory: one switch per ecobee comfort setting (climate: Home, Away, Sleep and
// your own), on for the one that is held. Turning one on holds it, turning the active one off goes back
// to the schedule. Mirrors holds set in the ecobee app or on the thermostat. Reading is driven from
// outside: the platform's shared tick calls handle() with each read of the thermostats.
import { SignInRequiredError, vacationsOf } from './ecobee.js';

const FAULT_AFTER = 3;
const REVERT_DELAY = 1000;
const CONFIRM_DELAY = 3000;

export class ComfortSetting {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('./ecobee.js').EcobeeCloud} options.cloud
   * @param {string} options.homeId
   * @param {string} options.holdType nextTransition or indefinite
   * @param {import('homebridge').PlatformAccessory | undefined} options.cached
   * @param {string} options.version
   * @param {() => boolean} options.cloudDown the security system can't reach ecobee
   * @param {(uuid: string, name: string) => import('homebridge').PlatformAccessory} options.create
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.register
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.update
   * @param {number} [options.confirmDelay]
   */
  constructor({ api, log, cloud, homeId, holdType, cached, version, cloudDown, create, register, update, confirmDelay = CONFIRM_DELAY }) {
    Object.assign(this, { api, log, cloud, homeId, holdType, cached, version, cloudDown, create, register, update, confirmDelay });
    this.C = api.hap.Characteristic;
    this.switches = new Map();   // climateRef -> { service, name, ids }
    this.active = undefined;     // climateRef of the running hold
    this.onVacation = false;
    this.failures = 0;
    this.unreachable = false;
    this.stopped = false;
    this.known = false;          // a first read has succeeded
    this.confirming = false;     // a change is being confirmed; the switches keep what the user set
    this.registered = false;
    this.waits = new Set();
  }

  start() {
    const { Service } = this.api.hap;
    const C = this.C;
    const uuid = this.api.hap.uuid.generate(`ecobee-security:comfort:${this.homeId}`);
    this.accessory = this.cached ?? this.create(uuid, 'Comfort Setting');
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'ecobee')
      .setCharacteristic(C.Model, 'Comfort Setting')
      .setCharacteristic(C.SerialNumber, `${this.homeId}-comfort`)
      .setCharacteristic(C.FirmwareRevision, this.version);
    // Switches restored by Homebridge answer No Response until the first read.
    for (const service of this.accessory.services.filter(s => s.UUID === Service.Switch.UUID && s.subtype)) {
      this.bind(service, service.subtype, service.displayName);
    }
    if (this.cached) {
      this.registered = true;
      this.update([this.accessory]);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.revertTimer);
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

  bind(service, ref, name) {
    const { On } = this.C;
    const entry = this.switches.get(ref) ?? { service, name, ids: [] };
    entry.service = service;
    entry.name = name;
    entry.labelled = undefined;
    this.switches.set(ref, entry);
    service.getCharacteristic(On)
      .onGet(() => {
        if (this.isOut() || !this.known) {
          throw this.noResponse();
        }
        return this.isOn(ref);
      })
      .onSet(value => this.set(ref, Boolean(value)));
    return entry;
  }

  /** Name and ConfiguredName: with several switches of one type, the Home app labels them by ConfiguredName. */
  label(entry, name) {
    const { Name, ConfiguredName } = this.C;
    entry.service.setCharacteristic(Name, name);
    if (!entry.service.testCharacteristic(ConfiguredName)) {
      entry.service.addOptionalCharacteristic(ConfiguredName);
    }
    entry.service.setCharacteristic(ConfiguredName, name);
    entry.name = name;
    entry.labelled = name;
  }

  isOn(ref) {
    return !this.onVacation && this.active === ref;
  }

  /** Shows each switch: No Response while ecobee can't be reached, otherwise its state. */
  show() {
    const { On } = this.C;
    for (const [ref, { service }] of this.switches) {
      service.updateCharacteristic(On, this.isOut() || !this.known ? this.noResponse() : this.isOn(ref));
    }
  }

  /** Reads the thermostats: climates (the union), the running hold and a vacation. Logs a changed setting. */
  apply(thermostats) {
    const { Service } = this.api.hap;
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
    let changed = false;
    for (const [ref, entry] of this.switches) {
      if (!climates.has(ref)) {
        this.accessory.removeService(entry.service);
        this.switches.delete(ref);
        changed = true;
      }
    }
    for (const [ref, { name, ids }] of climates) {
      let entry = this.switches.get(ref);
      if (!entry) {
        const service = new Service.Switch(name, ref);
        this.accessory.addService(service);
        entry = this.bind(service, ref, name);
        changed = true;
      }
      // New, restored from cache without a ConfiguredName, or renamed in the ecobee app.
      if (entry.labelled !== name) {
        this.label(entry, name);
        changed = true;
      }
      entry.ids = ids;
    }
    // A temperature-only hold has no climate: all off, the same as following the schedule.
    let active;
    for (const t of thermostats) {
      const hold = (t.events ?? []).find(e => e.type === 'hold' && e.running && e.holdClimateRef);
      if (hold && climates.has(hold.holdClimateRef)) {
        active = hold.holdClimateRef;
        break;
      }
    }
    const was = this.known ? this.active : undefined;
    const wasKnown = this.known;
    this.active = active;
    this.onVacation = vacationsOf(thermostats).length > 0;
    this.known = true;
    if (wasKnown && active !== was) {
      this.log.info(active
        ? `Comfort setting now: ${this.switches.get(active).name} (hold ${this.holdType === 'indefinite' ? 'until you change it' : 'until the next scheduled change'})`
        : 'Comfort setting now: following the schedule');
    }
    if (!this.registered && this.switches.size) {
      this.registered = true;
      this.register([this.accessory]);
    } else if (changed && this.registered) {
      this.update([this.accessory]);
    }
  }

  /** One shared read of the thermostats (or its error) from the platform's tick. */
  handle(thermostats, error) {
    if (this.confirming) {
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

  /** Shows the switches as they really are shortly after HomeKit's own update has landed. */
  revert() {
    clearTimeout(this.revertTimer);
    this.revertTimer = setTimeout(() => this.show(), REVERT_DELAY);
  }

  /** After a change, re-reads (fresh) and shows the real state; warns when it isn't what was asked for. */
  async confirm(want) {
    this.confirming = true;
    try {
      await this.wait(this.confirmDelay);
      if (this.stopped) {
        return;
      }
      try {
        this.apply(await this.cloud.getThermostats(this.homeId, 0));
      } catch (error) {
        this.log.debug(`Could not re-read the ecobee comfort setting (${error.message}).`);
      }
      if (this.active !== want) {
        this.log.warn('ecobee did not apply the comfort setting; showing its real state.');
      }
    } finally {
      this.confirming = false;
    }
    this.show();
  }

  async set(ref, on) {
    const { On } = this.C;
    if (this.isOut()) {
      throw this.noResponse();
    }
    if (this.onVacation) {
      this.log.info('ecobee is on vacation; end the vacation to change the comfort setting.');
      this.revert();
      return;
    }
    if (on === (this.active === ref)) {
      return;
    }
    const entry = this.switches.get(ref);
    try {
      if (on) {
        await this.cloud.setComfortHold(entry.ids, ref, this.holdType);
      } else {
        await this.cloud.resumeProgram([...new Set([...this.switches.values()].flatMap(e => e.ids))]);
      }
    } catch (error) {
      this.log.warn(`Could not change the ecobee comfort setting (${error.message}).`);
      this.revert();
      throw this.noResponse();
    }
    // The others go off at once; ecobee's own answer follows.
    for (const [other, { service }] of this.switches) {
      if (other !== ref || !on) {
        service.updateCharacteristic(On, false);
      }
    }
    this.confirm(on ? ref : undefined);
  }
}
