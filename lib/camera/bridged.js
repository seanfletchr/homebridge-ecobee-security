// Sensors the doorbell bridges to HomeKit (an ecobee SmartSensor, say), re-published as platform
// accessories on this bridge, with their values taken from the doorbell link.

const OFFLINE_AFTER = 60 * 1000;
const CHECK_EVERY = 5 * 1000;

export const HAP_BRIDGED = 'hap-bridged';

export class BridgedSensors {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('./hap-link.js').DoorbellHapLink} options.link
   * @param {string} options.pluginName
   * @param {string} options.platformName
   * @param {import('homebridge').PlatformAccessory[]} options.cached
   * @param {string} options.version
   */
  constructor({ api, log, link, pluginName, platformName, cached, version }) {
    this.api = api;
    this.log = log;
    this.link = link;
    this.pluginName = pluginName;
    this.platformName = platformName;
    this.version = version;
    /** @type {Map<string, import('homebridge').PlatformAccessory>} */
    this.accessories = new Map(cached.map(a => [a.UUID, a]));
    /** key ("aid.iid") -> Characteristic */
    this.characteristics = new Map();
    this.offline = false;
    const { Characteristic } = api.hap;
    // The sensor characteristics worth mirroring, by short HAP UUID.
    this.mirrored = new Map([
      ['6A', Characteristic.ContactSensorState],
      ['22', Characteristic.MotionDetected],
      ['71', Characteristic.OccupancyDetected],
      ['75', Characteristic.StatusActive],
      ['79', Characteristic.StatusLowBattery],
      ['68', Characteristic.BatteryLevel],
      ['8F', Characteristic.ChargingState],
    ]);
    const { Service } = api.hap;
    this.serviceTypes = new Map([
      ['80', Service.ContactSensor],
      ['85', Service.MotionSensor],
      ['86', Service.OccupancySensor],
      ['96', Service.Battery],
    ]);
    link.on('accessories', list => this.update(list));
    link.on('characteristic', change => this.changed(change));
    link.on('unpaired', () => this.removeAll());
    this.timer = setInterval(() => this.checkOnline(), CHECK_EVERY);
  }

  stop() {
    clearInterval(this.timer);
  }

  update(list) {
    const { hap } = this.api;
    const { Service, Characteristic } = hap;
    const wanted = new Set();
    this.characteristics.clear();
    for (const info of list) {
      const uuid = hap.uuid.generate(`ecobee-security:hap:${this.link.pairing?.id}:${info.aid}`);
      wanted.add(uuid);
      const name = info.name || 'Doorbell sensor';
      let accessory = this.accessories.get(uuid);
      const isNew = !accessory;
      if (isNew) {
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.kind = HAP_BRIDGED;
        this.accessories.set(uuid, accessory);
      }
      accessory.displayName = name;
      accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Name, name)
        .setCharacteristic(Characteristic.Manufacturer, info.manufacturer || 'ecobee')
        .setCharacteristic(Characteristic.Model, info.model || 'Sensor')
        .setCharacteristic(Characteristic.SerialNumber, info.serial || `${info.aid}`)
        .setCharacteristic(Characteristic.FirmwareRevision, info.firmware || this.version);

      const keep = new Set();
      for (const svc of info.services) {
        const Type = this.serviceTypes.get(svc.type);
        if (!Type) {
          continue;
        }
        const subtype = String(svc.iid);
        const serviceName = svc.name || name;
        const service = accessory.getServiceById(Type, subtype) ?? accessory.addService(Type, serviceName, subtype);
        service.setCharacteristic(Characteristic.Name, serviceName);
        keep.add(service);
        for (const c of svc.characteristics) {
          const Class = this.mirrored.get(c.type);
          if (!Class || c.value === undefined || c.value === null) {
            continue;
          }
          const characteristic = service.getCharacteristic(Class);
          characteristic.updateValue(this.convert(Class, c.value));
          this.characteristics.set(c.key, characteristic);
        }
      }
      for (const stale of accessory.services.filter(s => s.UUID !== Service.AccessoryInformation.UUID && !keep.has(s))) {
        accessory.removeService(stale);
      }
      if (isNew) {
        this.api.registerPlatformAccessories(this.pluginName, this.platformName, [accessory]);
        this.log.info(`"${name}" (bridged by the doorbell) added to HomeKit.`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }
    const gone = [...this.accessories.entries()].filter(([uuid]) => !wanted.has(uuid));
    if (gone.length) {
      this.api.unregisterPlatformAccessories(this.pluginName, this.platformName, gone.map(([, a]) => a));
      gone.forEach(([uuid, a]) => {
        this.accessories.delete(uuid);
        this.log.info(`"${a.displayName}" is no longer bridged by the doorbell; removed from HomeKit.`);
      });
    }
    this.offline = false;
  }

  /** Without a pairing there is nothing to mirror: take the accessories out of HomeKit. */
  removeAll() {
    if (!this.accessories.size) {
      return;
    }
    this.api.unregisterPlatformAccessories(this.pluginName, this.platformName, [...this.accessories.values()]);
    this.log.info('The doorbell link was removed; the sensors it bridged are removed from HomeKit.');
    this.accessories.clear();
    this.characteristics.clear();
  }

  convert(Class, value) {
    const { Characteristic } = this.api.hap;
    return Class === Characteristic.MotionDetected || Class === Characteristic.StatusActive ? Boolean(value) : Number(value);
  }

  changed({ key, value, type }) {
    const characteristic = this.characteristics.get(key);
    if (!characteristic || value === null || value === undefined) {
      return;
    }
    characteristic.updateValue(this.convert(this.mirrored.get(type), value));
  }

  /** Down for a minute: the sensors show No Response until the link is back (the next change or read). */
  checkOnline() {
    const offline = !this.link.up && this.link.paired && this.link.downFor() > OFFLINE_AFTER;
    if (offline === this.offline) {
      return;
    }
    this.offline = offline;
    const error = new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    for (const accessory of this.accessories.values()) {
      for (const service of accessory.services) {
        for (const characteristic of service.characteristics) {
          if ([...this.mirrored.values()].some(Class => characteristic.UUID === Class.UUID) && service.UUID !== this.api.hap.Service.AccessoryInformation.UUID) {
            characteristic.updateValue(offline ? error : characteristic.value);
          }
        }
      }
    }
    if (offline) {
      this.log.warn('The doorbell link has been down for a minute; the sensors it bridges show No Response until it is back.');
    }
  }
}
