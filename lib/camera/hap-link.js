import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { HttpClient } from 'hap-controller';

import { findService, pickAddress, readPairing } from './hap-pairing.js';

// The doorbell's own HomeKit server on the LAN, as a controller: the ring and motion arrive within a
// second, and so do the sensors the doorbell bridges to HomeKit.

const BACKOFF_START = 5 * 1000;
const BACKOFF_MAX = 5 * 60 * 1000;
const LIVENESS = 60 * 1000;
const WATCH_FILE = 10 * 1000;

const DOORBELL = '121';
const MOTION_SERVICE = '85';
const INPUT_EVENT = '73';
const MOTION_DETECTED = '22';
const MUTE = '11A';
const OPERATING_MODE = '21A';
const INDICATOR = '21D';
const NIGHT_VISION = '11B';

/** The short form of a HAP UUID: "0000006A-0000-1000-8000-0026BB765291" and "6A" are both "6A". */
export const short = uuid => String(uuid ?? '').split('-')[0].replace(/^0+/, '').toUpperCase() || '0';

/**
 * Events: `ring` (0 single, 1 double, 2 long), `motion` (boolean), `accessories` (the bridged ones:
 * [{aid, name, manufacturer, model, serial, firmware, services: [{iid, type, name, characteristics:
 * [{key, type, value}]}]}]), `characteristic` ({aid, iid, key, type, value}, bridged only), `state`
 * ('up' | 'down'), `setting` ({name: 'mute' | 'indicator' | 'nightVision', value}: the doorbell's own toggles, sent on every
 * (re)connect and when they change), `unpaired` (the pairing file is gone).
 */
export class DoorbellHapLink extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.pairingPath
   * @param {import('homebridge').Logging} options.log
   * @param {string} [options.name] for the log
   */
  constructor({ pairingPath, log, name = 'Doorbell' }) {
    super();
    this.pairingPath = pairingPath;
    this.log = log;
    this.name = name;
    this.up = false;
    this.downSince = Date.now();
    this.motion = undefined;
    this.stopped = false;
    this.pairing = undefined;
    this.pairingText = undefined;
    this.generation = 0;
    this.lost = undefined;
    this.client = undefined;
    this.model = undefined;
  }

  get paired() {
    return Boolean(this.pairing);
  }

  /** How long the link has been down (ms), 0 while up. Counted from when there was a pairing to use. */
  downFor() {
    return this.up ? 0 : Date.now() - this.downSince;
  }

  start() {
    this.checkFile();
    this.watch = setInterval(() => this.checkFile(), WATCH_FILE);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watch);
    this.generation++;
    this.lost?.('stopped');
    this.setUp(false);
  }

  /** Follow the pairing file: it appears when the settings page pairs, and goes when it unpairs. */
  checkFile() {
    let text;
    try {
      text = readFileSync(this.pairingPath, 'utf8');
    } catch {
      text = undefined;
    }
    if (text === this.pairingText) {
      return;
    }
    this.pairingText = text;
    const pairing = text ? readPairing(this.pairingPath) : undefined;
    this.generation++;
    this.lost?.('pairing changed');
    this.pairing = pairing;
    if (!pairing) {
      this.log.info(`"${this.name}" doorbell link: no pairing${text ? ' (unreadable file)' : ''}.`);
      this.setUp(false);
      this.emit('unpaired');
      return;
    }
    this.log.info(`"${this.name}" doorbell link: paired; connecting.`);
    this.downSince = Date.now();
    this.run(this.generation).catch(() => {});
  }

  setUp(up) {
    if (up === this.up) {
      return;
    }
    this.up = up;
    if (!up) {
      this.downSince = Date.now();
    }
    this.emit('state', up ? 'up' : 'down');
  }

  async run(generation) {
    let backoff = BACKOFF_START;
    let wasUp = false;
    while (!this.stopped && generation === this.generation) {
      let client;
      let probe;
      try {
        const service = await findService({ id: this.pairing.id }, 30000);
        const address = pickAddress(service);
        client = new HttpClient(service.id, address, service.port, this.pairing.pairingData, {
          usePersistentConnections: true, subscriptionsUseSameConnection: true,
        });
        const db = await client.getAccessories();
        if (generation !== this.generation) {
          return;
        }
        const model = this.read(db);
        const gone = new Promise((resolve) => {
          this.lost = resolve;
        });
        this.client = client;
        this.model = model;
        client.on('event', event => this.onEvent(model, event));
        client.on('event-disconnect', () => this.lost?.('the doorbell closed the connection'));
        await client.subscribeCharacteristics(model.eventKeys);
        probe = setInterval(async () => {
          try {
            await client.getCharacteristics([model.livenessKey]);
          } catch (error) {
            this.lost?.(`no answer (${error.message})`);
          }
        }, LIVENESS);
        backoff = BACKOFF_START;
        this.log.info(`"${this.name}" doorbell link ${wasUp ? 'is back' : 'up'} (${address}:${service.port}; `
          + `${model.bridged.length} bridged accessor${model.bridged.length === 1 ? 'y' : 'ies'}).`);
        wasUp = true;
        this.emit('accessories', model.bridged);
        if (model.motion !== undefined) {
          this.motion = model.motion;
          this.emit('motion', model.motion);
        }
        for (const [name, setting] of Object.entries(model.settings)) {
          this.emit('setting', { name, value: setting.value });
        }
        this.setUp(true);
        const why = await gone;
        this.setUp(false);
        if (this.stopped || generation !== this.generation) {
          return;
        }
        this.log.warn(`"${this.name}" doorbell link lost (${why}); reconnecting.`);
      } catch (error) {
        if (this.stopped || generation !== this.generation) {
          return;
        }
        this.setUp(false);
        this.log.debug(`"${this.name}" doorbell link: ${error.message}; trying again in ${backoff / 1000} s.`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
      } finally {
        clearInterval(probe);
        this.lost = undefined;
        if (this.client === client) {
          this.client = undefined;
          this.model = undefined;
        }
        try {
          client?.removeAllListeners();
          client?.closePersistentConnection();
        } catch {
          // already closed
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /** Which of the doorbell's own toggles ('mute', 'indicator', 'nightVision') it has; empty while the link is down. */
  settings() {
    return this.model ? Object.keys(this.model.settings) : [];
  }

  /** Write one of the doorbell's own toggles. Rejects while the link is down or if the doorbell lacks it. */
  async write(name, value) {
    const client = this.client;
    const setting = this.model?.settings[name];
    if (!this.up || !client || !setting) {
      throw new Error(`the doorbell link is down or has no "${name}"`);
    }
    const result = await client.setCharacteristics({ [setting.key]: value });
    const failed = (result?.characteristics ?? []).find(c => c.status);
    if (failed) {
      throw new Error(`the doorbell refused "${name}" (status ${failed.status})`);
    }
    setting.value = value;
  }

  /** Pick the doorbell's own services and the bridged accessories out of the accessory database. */
  read(db) {
    const accessories = db.accessories ?? [];
    const main = accessories.find(a => a.services.some(s => short(s.type) === DOORBELL)) ?? accessories[0];
    const model = { eventKeys: [], bridged: [], mainAid: String(main?.aid), ringKey: undefined, motionKey: undefined, motion: undefined, settings: {}, settingKeys: new Map() };
    for (const accessory of accessories) {
      const aid = String(accessory.aid);
      const info = { aid, name: undefined, manufacturer: undefined, model: undefined, serial: undefined, firmware: undefined, services: [] };
      for (const service of accessory.services) {
        const type = short(service.type);
        const characteristics = [];
        for (const c of service.characteristics) {
          const key = `${aid}.${c.iid}`;
          const ctype = short(c.type);
          if ((c.perms ?? []).includes('ev')) {
            model.eventKeys.push(key);
          }
          if (type === '3E') {
            const field = { 23: 'name', 20: 'manufacturer', 21: 'model', 30: 'serial', 52: 'firmware' }[ctype];
            if (field) {
              info[field] = c.value;
            }
          } else if (aid === model.mainAid) {
            if (type === DOORBELL && ctype === INPUT_EVENT) {
              model.ringKey = key;
            } else if ((type === DOORBELL && ctype === MUTE) || (type === OPERATING_MODE && (ctype === INDICATOR || ctype === NIGHT_VISION))) {
              const name = { [MUTE]: 'mute', [INDICATOR]: 'indicator', [NIGHT_VISION]: 'nightVision' }[ctype];
              model.settings[name] = { key, value: c.value };
              model.settingKeys.set(key, name);
            } else if (type === MOTION_SERVICE && ctype === MOTION_DETECTED) {
              model.motionKey = key;
              model.motion = Boolean(c.value);
            }
          } else {
            characteristics.push({ key, iid: c.iid, type: ctype, value: c.value });
          }
        }
        if (aid !== model.mainAid && type !== '3E' && type !== 'A2') {
          const nameChar = service.characteristics.find(c => short(c.type) === '23');
          info.services.push({ iid: service.iid, type, name: nameChar?.value, characteristics });
        }
      }
      if (aid !== model.mainAid) {
        model.bridged.push(info);
      }
    }
    model.livenessKey = model.motionKey ?? model.eventKeys[0];
    model.byKey = new Map();
    for (const accessory of model.bridged) {
      for (const service of accessory.services) {
        for (const c of service.characteristics) {
          model.byKey.set(c.key, { aid: accessory.aid, iid: c.iid, type: c.type });
        }
      }
    }
    return model;
  }

  onEvent(model, event) {
    for (const c of event.characteristics ?? []) {
      const key = `${c.aid}.${c.iid}`;
      if (key === model.ringKey) {
        if (c.value === 0 || c.value === 1 || c.value === 2) {
          this.emit('ring', c.value);
        }
      } else if (key === model.motionKey) {
        this.motion = Boolean(c.value);
        this.emit('motion', this.motion);
      } else if (model.settingKeys.has(key)) {
        const name = model.settingKeys.get(key);
        model.settings[name].value = c.value;
        this.emit('setting', { name, value: c.value });
      } else if (model.byKey.has(key)) {
        this.emit('characteristic', { ...model.byKey.get(key), key, value: c.value });
      }
    }
  }
}
