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
   * @param {(uuid: string, name: string) => import('homebridge').PlatformAccessory} options.register
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.unregister
   * @param {number} options.co2Alert ppm at or above which the CO2 sensor reports abnormal levels
   * @param {string} options.version plugin version, shown as firmware
   */
  constructor({ api, log, cloud, homeId, cached, register, unregister, co2Alert, version }) {
    Object.assign(this, { api, log, cloud, homeId, cached, register, unregister, co2Alert, version });
    this.C = api.hap.Characteristic;
    this.sensors = new Map();      // thermostat id -> { accessory, air, co2 }
    this.failures = 0;
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
    for (const t of thermostats) {
      const uuid = this.uuid(t.id);
      const accessory = this.cached.find(a => a.UUID === uuid) ?? this.register(uuid, `${t.name} Air Quality`);
      this.sensors.set(t.id, this.setUp(accessory, t));
    }
    if (thermostats.length) {
      this.log.info(`Air quality: ${thermostats.map(t => t.name).join(', ')}.`);
    }
    this.apply(thermostats);
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
    return { accessory, air, co2, name: thermostat.name };
  }

  async poll() {
    try {
      this.apply(await this.cloud.getAirQuality(this.homeId));
      if (this.failures >= FAULT_AFTER) {
        this.log.info('Air quality readings are back.');
      }
      this.failures = 0;
      this.setFault(false);
    } catch (error) {
      this.failures += 1;
      if (this.failures === FAULT_AFTER) {
        this.setFault(true);
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

  apply(thermostats) {
    const { AirQuality, VOCDensity, CarbonDioxideLevel, CarbonDioxideDetected } = this.C;
    for (const t of thermostats) {
      const sensor = this.sensors.get(t.id);
      if (!sensor) {
        continue;
      }
      const aq = t.airQuality ?? {};
      const runtime = t.runtime ?? {};
      sensor.air.updateCharacteristic(AirQuality, aq.isCalibrating ? AirQuality.UNKNOWN : level(aq.airQualityScore, AirQuality));
      if (Number.isFinite(runtime.actualVOC) && runtime.actualVOC >= 0) {
        sensor.air.updateCharacteristic(VOCDensity, Math.min(runtime.actualVOC, 10000));
      }
      if (Number.isFinite(runtime.actualCO2) && runtime.actualCO2 >= 0) {
        sensor.co2.updateCharacteristic(CarbonDioxideLevel, Math.min(runtime.actualCO2, 100000));
        sensor.co2.updateCharacteristic(CarbonDioxideDetected, runtime.actualCO2 >= this.co2Alert
          ? CarbonDioxideDetected.CO2_LEVELS_ABNORMAL : CarbonDioxideDetected.CO2_LEVELS_NORMAL);
      }
      this.log.debug(`${sensor.name}: air quality ${aq.airQualityScore?.toFixed?.(2)}, CO2 ${runtime.actualCO2} ppm, VOC ${runtime.actualVOC} ppb`);
    }
  }
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
