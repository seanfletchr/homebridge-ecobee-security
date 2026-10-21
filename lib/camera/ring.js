// "Doorbell Pressed" occupancy sensor on the doorbell accessory: Detected for a few seconds after each press, so
// automations can react to a ring (the Home app has no trigger for the video doorbell's own ring). A new ring
// starts the time again. Shows No Response while the doorbell link is down. It is never the accessory's primary
// service and leaves the doorbell's own services alone.

export const RING_NAME = 'Doorbell Pressed';
export const RING_SUBTYPE = 'doorbell-ring';
export const RING_HOLD = 10 * 1000;

export class RingSensor {
  /**
   * @param {object} options
   * @param {import('homebridge').API['hap']} options.hap
   * @param {import('homebridge').PlatformAccessory} options.accessory the doorbell accessory
   * @param {number} [options.hold] how long a ring counts, in ms
   */
  constructor({ hap, accessory, hold = RING_HOLD }) {
    this.hap = hap;
    this.hold = hold;
    this.offline = false;
    this.detected = false;
    const { Service, Characteristic } = hap;
    this.service = accessory.getServiceById(Service.OccupancySensor, RING_SUBTYPE)
      ?? accessory.addService(new Service.OccupancySensor(RING_NAME, RING_SUBTYPE));
    // Name and ConfiguredName, on new and restored services: the Home app otherwise labels it with the accessory's name.
    this.service.setCharacteristic(Characteristic.Name, RING_NAME);
    if (!this.service.testCharacteristic(Characteristic.ConfiguredName)) {
      this.service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    this.service.setCharacteristic(Characteristic.ConfiguredName, RING_NAME);
    this.service.setPrimaryService(false);
    this.char = this.service.getCharacteristic(Characteristic.OccupancyDetected);
    this.char.onGet(() => {
      if (this.offline) {
        throw this.noResponse();
      }
      return this.value();
    });
  }

  noResponse() {
    return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  value() {
    const { OccupancyDetected } = this.hap.Characteristic;
    return this.detected ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  /** A press of any kind: Detected, for `hold` from now. */
  ring() {
    this.detected = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.detected = false;
      this.show();
    }, this.hold);
    this.show();
  }

  /** The doorbell link is down (or back): No Response, or the real state. */
  setOffline(offline) {
    if (offline === this.offline) {
      return;
    }
    this.offline = offline;
    this.show();
  }

  show() {
    this.char.updateValue(this.offline ? this.noResponse() : this.value());
  }

  stop() {
    clearTimeout(this.timer);
  }
}
