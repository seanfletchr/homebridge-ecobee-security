// Member presence sensors: one occupancy sensor per ticked household member, Occupied while the ecobee
// app's location says that member is home. Only members whose phone reports to ecobee with location set
// to Always are published (others read Away whatever they do). Reading is driven from outside: the
// platform's members timer calls handle() with each read.
import { SignInRequiredError, memberTracking } from './ecobee.js';

const FAULT_AFTER = 3;

export class MemberPresence {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {string} options.homeId
   * @param {string[]} options.listed accountIds of the members to publish
   * @param {import('homebridge').PlatformAccessory[]} options.cached presence accessories restored by Homebridge
   * @param {string} options.version
   * @param {(uuid: string, name: string) => import('homebridge').PlatformAccessory} options.create
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.register
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.update
   */
  constructor({ api, log, homeId, listed, cached, version, create, register, update }) {
    Object.assign(this, { api, log, homeId, listed, cached, version, create, register, update });
    this.C = api.hap.Characteristic;
    this.sensors = new Map();   // accountId -> { accessory, service, name, home }
    this.untracked = new Map(); // accountId -> reason last logged
    this.failures = 0;
    this.offline = false;       // after repeated failed reads the sensors show No Response
  }

  uuid(accountId) {
    return this.api.hap.uuid.generate(`ecobee-security:presence:${this.homeId}:${accountId}`);
  }

  /** Sets up the accessories Homebridge restored for listed members; they show No Response until the first read. */
  start() {
    const kept = [];
    for (const accountId of this.listed) {
      const accessory = this.cached.find(a => a.UUID === this.uuid(accountId));
      if (accessory) {
        this.sensors.set(accountId, this.setUp(accessory, accountId, accessory.displayName));
        kept.push(accessory);
      }
    }
    if (kept.length) {
      this.update(kept);
    }
  }

  stop() {
    // Nothing of our own to cancel: the platform owns the timer.
  }

  noResponse() {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  setUp(accessory, accountId, name) {
    const { Service } = this.api.hap;
    const C = this.C;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'ecobee')
      .setCharacteristic(C.Model, 'ecobee Autopilot')
      .setCharacteristic(C.SerialNumber, `presence-${accountId}`.slice(0, 64))
      .setCharacteristic(C.FirmwareRevision, this.version);
    const service = accessory.getService(Service.OccupancySensor) ?? accessory.addService(Service.OccupancySensor, name);
    service.setCharacteristic(C.Name, name);
    const sensor = { accessory, service, name, home: undefined, last: undefined }; // last: the last known state, for the log
    service.getCharacteristic(C.OccupancyDetected).onGet(() => {
      if (this.offline || sensor.home === undefined) {
        throw this.noResponse();
      }
      return this.value(sensor.home);
    });
    return sensor;
  }

  value(home) {
    const { OccupancyDetected } = this.C;
    return home ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  /** Shows the sensor's state, or No Response when it is unknown or reads have been failing. */
  show(sensor) {
    sensor.service.updateCharacteristic(this.C.OccupancyDetected,
      this.offline || sensor.home === undefined ? this.noResponse() : this.value(sensor.home));
  }

  /** One read of the home's members (or its error) from the platform's timer. */
  handle(result, error) {
    if (error) {
      this.failures += 1;
      if (this.failures === FAULT_AFTER) {
        this.offline = true;
        this.sensors.forEach(sensor => this.show(sensor));
      }
      if (!(error instanceof SignInRequiredError)) {
        this.log[this.failures >= FAULT_AFTER ? 'warn' : 'debug'](`Could not read the household members (${error.message}).`);
      }
      return;
    }
    if (this.failures >= FAULT_AFTER) {
      this.log.info('Member presence is readable again.');
    }
    this.failures = 0;
    this.offline = false;

    const byId = new Map(result.members.map(m => [m.accountId, m]));
    const added = [];
    for (const accountId of this.listed) {
      const member = byId.get(accountId);
      let sensor = this.sensors.get(accountId);
      const tracking = member ? memberTracking(member) : { tracked: false, reason: 'not a member of this home any more' };
      let home;
      if (tracking.tracked) {
        this.untracked.delete(accountId);
        if (member.presence === 'HOME') {
          home = true;
        } else if (member.presence === 'AWAY') {
          home = false;
        }
        if (!sensor) {
          const uuid = this.uuid(accountId);
          const accessory = this.create(uuid, member.name);
          sensor = this.setUp(accessory, accountId, member.name);
          this.sensors.set(accountId, sensor);
          added.push(accessory);
        }
      } else if (this.untracked.get(accountId) !== tracking.reason) {
        this.untracked.set(accountId, tracking.reason);
        const who = member?.name ?? sensor?.name ?? 'A household member';
        this.log.info(`${who}: ${sensor ? 'presence is unknown' : 'no presence sensor yet'}, ${tracking.reason}.`);
      }
      if (!sensor) {
        continue;
      }
      if (member?.name && member.name !== sensor.name) {
        sensor.name = member.name;
        sensor.service.updateCharacteristic(this.C.Name, member.name);
      }
      if (home !== undefined) {
        if (sensor.last !== undefined && home !== sensor.last) {
          this.log.info(`${sensor.name} is now ${home ? 'home' : 'away'}.`);
        } else if (sensor.last === undefined) {
          this.log.debug(`${sensor.name} is ${home ? 'home' : 'away'}.`);
        }
        sensor.last = home;
      }
      sensor.home = home;
      this.show(sensor);
    }
    if (added.length) {
      this.register(added);
    }
  }
}
