// "Vacation Mode" switch: on while an ecobee vacation is running on any of the home's thermostats,
// for other accessories to follow. Turning it on starts a vacation now (until the switch is turned off);
// turning it off ends the running vacation. Dated vacations are set in the ecobee app.
import { SignInRequiredError, vacationPlan, vacationsOf } from './ecobee.js';

// After a change, ecobee may take a while to show it: re-read after each of these waits.
const CONFIRM_DELAYS = [2000, 5000, 10000];
const FAULT_AFTER = 3;
const REVERT_DELAY = 1000;
// Safety cap for a vacation the switch starts: it ends when the switch goes off, this is only the backstop.
const VACATION_DAYS = 30;

export class VacationSwitch {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('./ecobee.js').EcobeeCloud} options.cloud
   * @param {string} options.homeId
   * @param {string} options.name
   * @param {import('homebridge').PlatformAccessory[]} options.cached
   * @param {string} options.version
   * @param {() => boolean} options.cloudDown the security system can't reach ecobee
   * @param {(uuid: string, name: string) => import('homebridge').PlatformAccessory} options.create
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.register
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.update
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.unregister
   * @param {number[]} [options.confirmDelays]
   *
   * Reading is driven from outside: the platform's shared tick calls handle() with each read.
   */
  constructor({ api, log, cloud, homeId, name, cached, version, cloudDown, create, register, update, unregister, confirmDelays = CONFIRM_DELAYS }) {
    Object.assign(this, { api, log, cloud, homeId, name, cached, version, cloudDown, create, register, update, unregister, confirmDelays });
    this.C = api.hap.Characteristic;
    this.vacations = [];
    this.on = false;
    this.failures = 0;
    this.unreachable = false;
    this.stopped = false;
    this.known = false;       // a first read has succeeded
    this.confirming = false;  // a change is being confirmed; the switch keeps what the user set
    this.waits = new Set();
  }

  start() {
    const { Service } = this.api.hap;
    const C = this.C;
    const uuid = this.api.hap.uuid.generate('ecobee-security:vacation');
    const cached = this.cached.find(a => a.UUID === uuid);
    const stale = this.cached.filter(a => a !== cached);
    if (stale.length) {
      this.unregister(stale);
    }
    const accessory = cached ?? this.create(uuid, this.name);
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'ecobee')
      .setCharacteristic(C.Model, 'Vacation Mode')
      .setCharacteristic(C.SerialNumber, `${this.homeId}-vacation`)
      .setCharacteristic(C.FirmwareRevision, this.version);
    this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, this.name);
    this.service.setCharacteristic(C.Name, this.name);
    this.service.getCharacteristic(C.On)
      .onGet(() => {
        if (this.isOut()) {
          throw this.noResponse();
        }
        return this.on;
      })
      .onSet(value => this.set(value));
    if (cached) {
      this.update([accessory]);
    } else {
      this.register([accessory]);
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

  show() {
    const { On } = this.C;
    this.service.updateCharacteristic(On, this.isOut() ? this.noResponse() : this.on);
  }

  /** Takes a read of the thermostats; logs when a vacation starts or ends. */
  apply(thermostats) {
    const vacations = vacationsOf(thermostats);
    const was = this.known ? this.on : undefined;
    this.vacations = vacations;
    this.on = vacations.length > 0;
    this.known = true;
    if (this.on && was !== true) {
      this.log.info(`ecobee vacation started: ${vacations.map(describe).join('; ')}.`);
    } else if (!this.on && was === true) {
      this.log.info('ecobee vacation ended.');
    }
    return this.on;
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
        this.log[this.failures >= FAULT_AFTER ? 'warn' : 'debug'](`Could not read the ecobee vacation (${error.message}).`);
      }
    } else {
      this.apply(thermostats);
      if (this.failures >= FAULT_AFTER) {
        this.log.info('Vacation state is readable again.');
      }
      this.failures = 0;
      this.unreachable = false;
    }
    this.show();
  }

  /**
   * After a change, re-reads (fresh) after each delay until the vacation is running (`wantOn`) or
   * gone; true when it got there. The switch shows what the user set meanwhile.
   */
  async confirm(wantOn) {
    this.confirming = true;
    try {
      for (const delay of this.confirmDelays) {
        await this.wait(delay);
        if (this.stopped) {
          return false;
        }
        try {
          this.apply(await this.cloud.getThermostats(this.homeId, 0));
        } catch (error) {
          this.log.debug(`Could not re-read the ecobee vacation (${error.message}).`);
          continue;
        }
        if (this.on === wantOn) {
          return true;
        }
      }
      return false;
    } finally {
      this.confirming = false;
    }
  }

  /** Shows the switch as `value` shortly after HomeKit's own update has landed. */
  revert(value) {
    clearTimeout(this.revertTimer);
    this.revertTimer = setTimeout(() => this.service.updateCharacteristic(this.C.On, value), REVERT_DELAY);
  }

  /** Starts a vacation now on every thermostat of the home; confirmation follows in the background. */
  async startVacation() {
    const name = `HomeKit ${new Date().toISOString().slice(5, 16).replace(/\D/g, '')}`;
    let started = 0;
    try {
      // Fresh, for the thermostat's clock and template temperatures.
      const thermostats = await this.cloud.getThermostats(this.homeId, 0);
      for (const t of thermostats) {
        try {
          await this.cloud.createVacation(t.id, vacationPlan(t, name, VACATION_DAYS));
          started += 1;
        } catch (error) {
          this.log.warn(`Could not start a vacation on "${t.name}" (${error.message}).`);
        }
      }
    } catch (error) {
      this.log.warn(`Could not start the ecobee vacation (${error.message}).`);
    }
    if (!started) {
      this.revert(false);
      return;
    }
    this.confirm(true).then(ok => {
      if (!ok && !this.stopped) {
        this.log.warn('The ecobee vacation did not start; showing the switch as off.');
        this.show();
      }
    });
  }

  async set(value) {
    if (this.isOut()) {
      throw this.noResponse();
    }
    if (value === this.on) {
      return;
    }
    if (value) {
      await this.startVacation();
      return;
    }
    // Off: end every running vacation; confirmation follows in the background.
    const running = [...this.vacations];
    try {
      for (const v of running) {
        await this.cloud.deleteVacation(v.thermostatId, v.name);
        this.log.info(`Ended the ecobee vacation "${v.name}".`);
      }
    } catch (error) {
      this.log.warn(`Could not end the ecobee vacation (${error.message}).`);
    }
    this.confirm(false).then(ok => {
      if (!ok && !this.stopped) {
        this.log.warn('The ecobee vacation is still running; showing the switch as on.');
        this.show();
      }
    });
  }
}

function describe(v) {
  return `"${v.name}"${v.endDate ? `, ends ${v.endDate}${v.endTime ? ` ${v.endTime}` : ''}` : ''}`;
}
