// Air quality from ecobee thermostats with the sensor (ecobee Premium): one accessory per thermostat
// with an Air Quality Sensor (overall level, VOC) and a Carbon Dioxide Sensor (ppm, high-CO2 alert).
// ecobee's own HomeKit integration doesn't expose these readings.
import { SignInRequiredError } from './ecobee.js';

const POLL = 5 * 60 * 1000;        // ecobee updates thermostat runtime every few minutes
const FAULT_AFTER = 3;

export class AirQualitySensors {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {import('./ecobee.js').EcobeeCloud} options.cloud
   * @param {string} options.homeId
   * @param {import('homebridge').PlatformAccessory[]} options.cached accessories restored by Homebridge
   * @param {(uuid: string, name: string) => import('homebridge').PlatformAccessory} options.create new, unregistered accessory
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.register
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.update
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.unregister
   * @param {number} options.co2Alert ppm at or above which the CO2 sensor reports abnormal levels
   * @param {string} options.version plugin version, shown as firmware
   */
  constructor({ api, log, cloud, homeId, cached, create, register, update, unregister, co2Alert, version }) {
    Object.assign(this, { api, log, cloud, homeId, cached, create, register, update, unregister, co2Alert, version });
    this.C = api.hap.Characteristic;
    this.sensors = new Map();      // thermostat id -> { accessory, air, co2 }
    this.failures = 0;
    this.offline = false;          // after repeated failed reads the sensors show No Response
    this.stopped = false;
  }

  uuid(thermostatId) {
    return this.api.hap.uuid.generate(`ecobee-security:air-quality:${thermostatId}`);
  }

  /** First read: create, keep or remove accessories to match the thermostats with air quality. */
  async start() {
    const thermostats = (await this.cloud.getAirQuality(this.homeId))
      .filter(t => t.airQuality?.hasAirQualityEnabled);
    const wanted = new Set(thermostats.map(t => this.uuid(t.id)));
    const stale = this.cached.filter(a => !wanted.has(a.UUID));
    if (stale.length) {
      this.unregister(stale);
    }
    // Build each accessory completely (services and first readings) before it's published.
    const added = [];
    const kept = [];
    for (const t of thermostats) {
      const uuid = this.uuid(t.id);
      const cached = this.cached.find(a => a.UUID === uuid);
      const accessory = cached ?? this.create(uuid, `${t.name} Air Quality`);
      (cached ? kept : added).push(accessory);
      this.sensors.set(t.id, this.setUp(accessory, t));
    }
    this.apply(thermostats);
    if (added.length) {
      this.register(added);
    }
    if (kept.length) {
      this.update(kept);
    }
    for (const t of thermostats) {
      this.log.info(`Air quality, ${t.name}: ${describe(t)}.`);
    }
    this.schedule(POLL);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  schedule(delay) {
    if (!this.stopped && this.sensors.size) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.poll(), delay);
    }
  }

  setUp(accessory, thermostat) {
    const { Service } = this.api.hap;
    const C = this.C;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'ecobee')
      .setCharacteristic(C.Model, 'Thermostat air quality')
      .setCharacteristic(C.SerialNumber, thermostat.id)
      .setCharacteristic(C.FirmwareRevision, this.version);
    const air = accessory.getService(Service.AirQualitySensor)
      ?? accessory.addService(Service.AirQualitySensor, `${thermostat.name} Air Quality`);
    // ecobee reports VOC in ppb, often above HomeKit's default 1000 limit.
    air.getCharacteristic(C.VOCDensity).setProps({ maxValue: 10000 });
    const co2 = accessory.getService(Service.CarbonDioxideSensor)
      ?? accessory.addService(Service.CarbonDioxideSensor, `${thermostat.name} CO2`);
    co2.getCharacteristic(C.CarbonDioxideLevel);
    for (const service of [air, co2]) {
      if (!service.testCharacteristic(C.StatusFault)) {
        service.addCharacteristic(C.StatusFault);
      }
    }
    const sensor = { accessory, air, co2, name: thermostat.name, out: false };
    for (const [service, characteristic] of this.readings(sensor)) {
      service.getCharacteristic(characteristic).onGet(() => {
        if (this.offline || sensor.out) {
          throw this.noResponse();
        }
        return service.getCharacteristic(characteristic).value;
      });
    }
    return sensor;
  }

  async poll() {
    try {
      const thermostats = await this.cloud.getAirQuality(this.homeId);
      if (this.failures >= FAULT_AFTER) {
        this.log.info('Air quality readings are back.');
      }
      this.failures = 0;
      this.setFault(false);
      this.setOffline(false);
      this.apply(thermostats);
    } catch (error) {
      this.failures += 1;
      if (this.failures === FAULT_AFTER) {
        this.setFault(true);
        this.setOffline(true);
      }
      if (!(error instanceof SignInRequiredError)) {
        this.log[this.failures >= FAULT_AFTER ? 'warn' : 'debug'](`Could not read air quality (${error.message}).`);
      }
    }
    this.schedule(POLL);
  }

  setFault(on) {
    const { StatusFault } = this.C;
    for (const { air, co2 } of this.sensors.values()) {
      air.updateCharacteristic(StatusFault, on ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
      co2.updateCharacteristic(StatusFault, on ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
    }
  }

  noResponse() {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** The readings of one sensor accessory, as [service, characteristic] pairs. */
  readings({ air, co2 }) {
    const C = this.C;
    return [[air, C.AirQuality], [air, C.VOCDensity], [co2, C.CarbonDioxideLevel], [co2, C.CarbonDioxideDetected]];
  }

  /**
   * Stale readings show as No Response (like the security tile) once reads have failed for a while.
   * Back online, the last values are put back until apply() brings the new ones.
   */
  setOffline(on) {
    if (this.offline === on) {
      return;
    }
    this.offline = on;
    for (const sensor of this.sensors.values()) {
      this.show(sensor, on || sensor.out);
    }
  }

  /** No Response for one sensor accessory's readings, or their last values. */
  show(sensor, noResponse) {
    for (const [service, characteristic] of this.readings(sensor)) {
      service.updateCharacteristic(characteristic, noResponse ? this.noResponse() : service.getCharacteristic(characteristic).value);
    }
  }

  apply(thermostats) {
    const { AirQuality, VOCDensity, CarbonDioxideLevel, CarbonDioxideDetected } = this.C;
    for (const t of thermostats) {
      const sensor = this.sensors.get(t.id);
      if (!sensor) {
        continue;
      }
      const aq = t.airQuality ?? {};
      const runtime = t.runtime ?? {};
      // ecobee's cloud can't reach this thermostat: its readings are old.
      const out = runtime.connected === false;
      if (out !== sensor.out) {
        sensor.out = out;
        this.log.debug(`Air quality, ${sensor.name}: ${out ? "ecobee can't reach the thermostat" : 'thermostat reachable again'}.`);
        this.show(sensor, out || this.offline);
      }
      if (out) {
        continue;
      }
      sensor.air.updateCharacteristic(AirQuality, aq.isCalibrating ? AirQuality.UNKNOWN : level(aq.airQualityScore, AirQuality));
      if (Number.isFinite(runtime.actualVOC) && runtime.actualVOC >= 0) {
        sensor.air.updateCharacteristic(VOCDensity, Math.min(runtime.actualVOC, 10000));
      }
      if (Number.isFinite(runtime.actualCO2) && runtime.actualCO2 >= 0) {
        sensor.co2.updateCharacteristic(CarbonDioxideLevel, Math.min(runtime.actualCO2, 100000));
        sensor.co2.updateCharacteristic(CarbonDioxideDetected, runtime.actualCO2 >= this.co2Alert
          ? CarbonDioxideDetected.CO2_LEVELS_ABNORMAL : CarbonDioxideDetected.CO2_LEVELS_NORMAL);
      }
      this.log.debug(`Air quality, ${sensor.name}: ${describe(t)}.`);
    }
  }
}

const LEVEL_NAMES = ['unknown', 'excellent', 'good', 'fair', 'inferior', 'poor'];

function describe(t) {
  const aq = t.airQuality ?? {};
  const r = t.runtime ?? {};
  const name = aq.isCalibrating ? 'calibrating' : LEVEL_NAMES[level(aq.airQualityScore, { UNKNOWN: 0, EXCELLENT: 1, GOOD: 2, FAIR: 3, INFERIOR: 4, POOR: 5 })];
  return `${name} (score ${Number.isFinite(aq.airQualityScore) ? aq.airQualityScore.toFixed(2) : '?'}), `
    + `CO2 ${r.actualCO2 ?? '?'} ppm, VOC ${r.actualVOC ?? '?'} ppb`;
}

/**
 * ecobee's 0 (clean) … 1 (poor) score onto HomeKit's five levels, following the eight segments of
 * the ecobee app's bar: 1–2 Excellent (the app calls 0.21 "Clean"), 3–4 Good, 5 Fair, 6 Inferior,
 * 7–8 Poor.
 */
export function level(score, AirQuality) {
  if (!Number.isFinite(score)) {
    return AirQuality.UNKNOWN;
  }
  if (score < 0.25) {
    return AirQuality.EXCELLENT;
  }
  if (score < 0.5) {
    return AirQuality.GOOD;
  }
  if (score < 0.625) {
    return AirQuality.FAIR;
  }
  if (score < 0.75) {
    return AirQuality.INFERIOR;
  }
  return AirQuality.POOR;
}
