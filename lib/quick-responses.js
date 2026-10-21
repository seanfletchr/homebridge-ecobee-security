// Quick Responses: short messages the doorbell plays on its speaker, each its own switch in the Home app.
// The three built-in messages ship as recordings (assets/quick-responses); changed or added wording is
// rendered with Piper (https://github.com/OHF-Voice/piper1-gpl), if the user installed it, and cached. This
// file also serves the settings page (preview, Piper check), so it must not import anything from Homebridge.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSETS = fileURLToPath(new URL('../assets/quick-responses/', import.meta.url));
export const NAME_MAX = 14;
// The voice's settings, tuned by ear; used for every message (and part of the cache key).
export const PIPER_SETTINGS = ['--length-scale', '0.95', '--noise-scale', '0.4', '--noise-w-scale', '0.5', '--sentence-silence', '0.25'];
const RENDER_TIMEOUT = 2 * 60 * 1000;

export const BUILT_INS = [
  { id: 'leave-delivery', name: 'Leave Delivery', phrase: 'Hi there. You can just leave it. Thanks!' },
  { id: 'hang-on', name: 'Hang On', phrase: 'Just a sec, we\'ll be right there.' },
  { id: 'not-home', name: 'Not Home', phrase: 'Hi there, no one can answer the door right now, but we\'ll be notified that you stopped by.' },
];

const clean = text => String(text ?? '').trim();

/** A tile name: trimmed, at most NAME_MAX characters. */
export function tileName(name) {
  return clean(name).slice(0, NAME_MAX).trim();
}

/**
 * The messages to publish: `quickResponseMessages` from the config, or the built-ins when it is absent.
 * A built-in with `enabled: false` is left out. Entries without an id or wording are dropped (a built-in without wording or name takes its own), repeated ids too.
 * @returns {{id: string, name: string, phrase: string}[]}
 */
export function messagesFromConfig(config) {
  const list = config?.quickResponseMessages;
  if (!Array.isArray(list)) {
    return BUILT_INS.map(m => ({ ...m }));
  }
  const seen = new Set();
  const messages = [];
  for (const entry of list) {
    const id = clean(entry?.id);
    const builtIn = BUILT_INS.find(m => m.id === id);
    const name = tileName(entry?.name) || builtIn?.name;
    const phrase = clean(entry?.phrase) || builtIn?.phrase;
    // A built-in can be switched off (`enabled: false`); the entry stays so its wording survives.
    if (builtIn && entry?.enabled === false) {
      seen.add(id);
      continue;
    }
    if (!id || !name || !phrase || seen.has(id)) {
      continue;
    }
    seen.add(id);
    messages.push({ id, name, phrase });
  }
  return messages;
}

/** The shipped recording for a message whose id and wording are a built-in's, else undefined. */
export function shippedFile(message) {
  const builtIn = BUILT_INS.find(m => m.id === message.id);
  if (!builtIn || clean(message.phrase) !== builtIn.phrase) {
    return undefined;
  }
  const file = join(ASSETS, `${builtIn.id}.wav`);
  return existsSync(file) ? file : undefined;
}

/** Cache file name for a phrase rendered with a voice and our settings. */
export function cacheName(voice, phrase) {
  return `${createHash('sha256').update(`${voice}\n${PIPER_SETTINGS.join(' ')}\n${phrase}`).digest('hex')}.wav`;
}

/** A configured executable: a path, or a name looked up in the PATH. Undefined if it isn't there. */
export function findExecutable(path, env = process.env) {
  const wanted = clean(path);
  if (!wanted) {
    return undefined;
  }
  const candidates = wanted.includes('/') ? [wanted] : (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, wanted));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Is Piper set up? `{found, reason}` (a reason when not), checked by looking at the two paths. */
export function piperStatus({ piperPath, piperVoice } = {}) {
  if (!clean(piperPath) || !clean(piperVoice)) {
    return { found: false, reason: 'Piper path and voice are not set' };
  }
  if (!findExecutable(piperPath)) {
    return { found: false, reason: `no executable at ${clean(piperPath)}` };
  }
  try {
    if (!statSync(clean(piperVoice)).isFile()) {
      throw new Error('not a file');
    }
  } catch {
    return { found: false, reason: `no voice file at ${clean(piperVoice)}` };
  }
  return { found: true };
}

/**
 * Render a phrase to a WAV file with Piper (the phrase on stdin; `[[ phonemes ]]` pass through untouched).
 * Written to a temporary name and moved into place, so the cache never holds half a file.
 */
export function renderWithPiper({ piperPath, piperVoice, phrase, out, timeout = RENDER_TIMEOUT }) {
  const status = piperStatus({ piperPath, piperVoice });
  if (!status.found) {
    return Promise.reject(new Error(`Piper isn't set up (${status.reason})`));
  }
  const part = `${out}.part`;
  return new Promise((resolve, reject) => {
    const args = ['-m', clean(piperVoice), ...PIPER_SETTINGS, '-f', part];
    const child = spawn(findExecutable(piperPath), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const fail = (error) => {
      clearTimeout(timer);
      try {
        unlinkSync(part);
      } catch {
        // nothing written
      }
      reject(error);
    };
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on('error', () => {});
    child.on('error', error => fail(new Error(`could not run Piper: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        fail(new Error(`Piper stopped (${signal ?? code}) ${stderr.trim().split('\n').at(-1) ?? ''}`.trim()));
        return;
      }
      try {
        if (statSync(part).size < 100) {
          throw new Error('empty file');
        }
        renameSync(part, out);
      } catch (error) {
        fail(new Error(`Piper wrote no audio (${error.message})`));
        return;
      }
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.end(`${clean(phrase)}\n`);
  });
}

/**
 * Where each message's audio comes from: the shipped recording, a cached rendering, or a rendering still to do.
 * Rendering happens one at a time, in the background, from `render()`.
 */
export class MessageAudio {
  /**
   * @param {object} options
   * @param {string} options.dir the cache folder (<storage>/ecobee-security/quick-responses)
   * @param {string} [options.piperPath]
   * @param {string} [options.piperVoice]
   * @param {import('homebridge').Logging} options.log
   */
  constructor({ dir, piperPath, piperVoice, log }) {
    Object.assign(this, { dir, log });
    this.piperPath = clean(piperPath);
    this.piperVoice = clean(piperVoice);
    this.files = new Map();     // message id -> wav path, once there is audio
    this.pending = [];          // messages still to render
    this.failed = new Set();    // ids that can't get audio
    this.stopped = false;
  }

  /** The audio each message needs; then removes cache files nothing uses any more. Returns the ids that have audio now. */
  plan(messages) {
    this.files.clear();
    this.pending = [];
    const wanted = new Set();
    for (const message of messages) {
      const shipped = shippedFile(message);
      if (shipped) {
        this.files.set(message.id, shipped);
        continue;
      }
      if (!this.piperVoice) {
        continue;
      }
      const name = cacheName(this.piperVoice, message.phrase);
      wanted.add(name);
      const file = join(this.dir, name);
      if (existsSync(file)) {
        this.files.set(message.id, file);
      } else {
        this.pending.push({ message, file });
      }
    }
    // Without a voice there is nothing to tell old renderings apart from current ones: leave them.
    if (this.piperVoice) {
      this.clean(wanted);
    }
    return [...this.files.keys()];
  }

  clean(wanted) {
    let names = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (/\.wav(\.part)?$/.test(name) && !wanted.has(name)) {
        try {
          unlinkSync(join(this.dir, name));
          this.log.debug(`Removed unused Quick Response audio ${name}.`);
        } catch {
          // gone already
        }
      }
    }
  }

  /**
   * Render what is pending, one message at a time. `done(message, file | undefined, error)` after each.
   * Never throws.
   */
  async render(done) {
    if (this.pending.length) {
      try {
        mkdirSync(this.dir, { recursive: true });
      } catch (error) {
        this.log.warn(`Could not create ${this.dir}: ${error.message}`);
      }
    }
    while (this.pending.length && !this.stopped) {
      const { message, file } = this.pending.shift();
      try {
        await renderWithPiper({ piperPath: this.piperPath, piperVoice: this.piperVoice, phrase: message.phrase, out: file });
        this.files.set(message.id, file);
        done(message, file);
      } catch (error) {
        this.failed.add(message.id);
        done(message, undefined, error);
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}

/**
 * The Quick Responses accessory: ONE accessory (category switch) named "Quick Responses" with a Switch service per
 * message. Turning a switch on plays the message on the doorbell; it turns itself off when playback ends, or after a
 * second when the message can't be played. The Home app's tile for the accessory turns every switch on at once;
 * that is told apart from a single pick (several switches on within a moment) and plays nothing.
 */
export class QuickResponses {
  /**
   * @param {object} options
   * @param {import('homebridge').API} options.api
   * @param {import('homebridge').Logging} options.log
   * @param {string} options.cameraId
   * @param {{id: string, name: string, phrase: string}[]} options.messages
   * @param {MessageAudio} options.audio
   * @param {import('homebridge').PlatformAccessory[]} options.cached quick response accessories Homebridge restored (this one, and older one-per-message ones)
   * @param {string} options.version
   * @param {{playbackBlocker: () => string | undefined, playAudio: (file: string, name: string) => Promise<{sent: number}>}} options.camera
   * @param {(uuid: string, name: string, category: number) => import('homebridge').PlatformAccessory} options.create
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.register
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.update
   * @param {(accessories: import('homebridge').PlatformAccessory[]) => void} options.unregister
   * @param {number} [options.revertDelay]
   * @param {number} [options.waitMs] how long a message waits for a dropped doorbell connection to come back
   * @param {number} [options.pollMs] how often it looks
   * @param {number} [options.tapWindow] switches turned on within this long of each other are a tile tap (ms)
   */
  constructor({ api, log, cameraId, messages, audio, cached, version, camera, create, register, update, unregister, revertDelay = 1000, tapWindow = 300, waitMs = 20000, pollMs = 250 }) {
    Object.assign(this, { api, log, cameraId, messages, audio, cached, version, camera, create, register, update, unregister, revertDelay, tapWindow, waitMs, pollMs });
    this.waiting = undefined;   // { id, timer, deadline } a message waiting for the connection
    this.C = api.hap.Characteristic;
    this.services = new Map();  // message id -> { service, message }
    this.accessory = undefined;
    this.registered = false;
    this.playing = undefined;   // { id, abort }
    this.burst = undefined;     // { ids: Set, timer } switches that just turned on
    this.warned = new Set();
    this.timers = new Set();
    this.stopped = false;
  }

  uuid() {
    return this.api.hap.uuid.generate(`ecobee-security:quick-responses:${this.cameraId}`);
  }

  /**
   * Unregisters the older one-accessory-per-message switches, publishes the messages that have audio on the one
   * accessory, drops the services of removed messages, and renders the rest in the background.
   */
  start() {
    const older = this.cached.filter(a => a.UUID !== this.uuid());
    if (older.length) {
      this.unregister(older);
    }
    this.accessory = this.cached.find(a => a.UUID === this.uuid());
    this.registered = Boolean(this.accessory);
    const { Service } = this.api.hap;
    const ready = new Set(this.audio.plan(this.messages));
    const pending = new Set(this.audio.pending.map(p => p.message.id));
    const wanted = new Set();
    for (const message of this.messages) {
      const has = this.accessory?.services.some(sv => sv.UUID === Service.Switch.UUID && sv.subtype === message.id);
      if (ready.has(message.id) || (pending.has(message.id) && has)) {
        wanted.add(message.id);
      } else if (!pending.has(message.id)) {
        this.warnOnce(message, 'Piper is not set up (set the Piper path and voice in the settings)');
      }
    }
    if (this.accessory) {
      for (const sv of this.accessory.services.filter(x => x.UUID === Service.Switch.UUID && x.subtype)) {
        if (!wanted.has(sv.subtype)) {
          this.accessory.removeService(sv);
        }
      }
    }
    for (const message of this.messages.filter(m => wanted.has(m.id))) {
      this.show(message);
    }
    this.publish();
    this.audio.render((message, file, error) => this.rendered(message, file, error)).catch(() => {});
  }

  /** Registers, updates or (with no switches left) unregisters the accessory. */
  publish() {
    if (!this.accessory) {
      return;
    }
    const { Service } = this.api.hap;
    const count = this.accessory.services.filter(sv => sv.UUID === Service.Switch.UUID && sv.subtype).length;
    if (!count && this.registered) {
      this.unregister([this.accessory]);
      this.registered = false;
      this.accessory = undefined;
    } else if (count && !this.registered) {
      this.register([this.accessory]);
      this.registered = true;
    } else if (this.registered) {
      this.update([this.accessory]);
    }
  }

  stop() {
    this.stopped = true;
    this.audio.stop();
    this.playing?.abort();
    clearTimeout(this.burst?.timer);
    this.stopWaiting();
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  warnOnce(message, why) {
    if (!this.warned.has(message.id)) {
      this.warned.add(message.id);
      this.log.warn(`Quick Response "${message.name}" has no audio (${why}); not publishing it.`);
    }
  }

  /** A background rendering finished. */
  rendered(message, file, error) {
    if (this.stopped) {
      return;
    }
    if (error) {
      this.warnOnce(message, error.message);
      const entry = this.services.get(message.id);
      if (entry && this.accessory) {
        this.accessory.removeService(entry.service);
        this.services.delete(message.id);
        this.publish();
      }
      return;
    }
    this.log.info(`Quick Response "${message.name}" is ready.`);
    this.show(message);
    this.publish();
  }

  /** Sets up (or finds) a message's switch on the accessory. */
  show(message) {
    const { Service, Characteristic, Categories } = this.api.hap;
    if (!this.accessory) {
      this.accessory = this.create(this.uuid(), 'Quick Responses', Categories.SWITCH);
      this.accessory.context.kind = 'quickResponse';
      this.accessory.context.group = true;
    }
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, 'Quick Responses')
      .setCharacteristic(Characteristic.Manufacturer, 'ecobee')
      .setCharacteristic(Characteristic.Model, 'Quick Responses')
      .setCharacteristic(Characteristic.SerialNumber, `${this.cameraId}-quick-responses`.slice(0, 64))
      .setCharacteristic(Characteristic.FirmwareRevision, this.version);
    let service = this.accessory.getServiceById(Service.Switch, message.id);
    if (!service) {
      service = this.accessory.addService(new Service.Switch(message.name, message.id));
    }
    // Like the Comfort Setting switches: with several switches of one type the Home app labels them by ConfiguredName.
    service.setCharacteristic(Characteristic.Name, message.name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, message.name);
    service.getCharacteristic(Characteristic.On)
      .onGet(() => this.playing?.id === message.id)
      .onSet(on => this.set(message.id, Boolean(on)));
    service.updateCharacteristic(Characteristic.On, this.playing?.id === message.id);
    this.services.set(message.id, { service, message });
  }

  setOn(id, on) {
    this.services.get(id)?.service.updateCharacteristic(this.C.On, on);
  }

  /** Can't play: say why, and put the switch back after a second. */
  refuse(message, why) {
    this.log.info(`Quick Response "${message.name}" not played: ${why}.`);
    this.later(() => this.setOn(message.id, false));
  }

  later(fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, this.revertDelay);
    this.timers.add(timer);
  }

  set(id, on) {
    if (!this.services.has(id)) {
      return;
    }
    if (!on) {
      // Turned off while playing: stop it. While waiting for the connection: stop waiting.
      if (this.playing?.id === id) {
        this.playing.abort();
      } else if (this.waiting?.id === id) {
        this.stopWaiting();
        this.log.info(`Quick Response "${this.services.get(id).message.name}": no longer waiting for the doorbell connection.`);
      }
      return;
    }
    if (this.playing?.id === id || this.waiting?.id === id) {
      return;
    }
    // The tile turns every switch on within a moment; wait for the others before deciding.
    if (!this.burst) {
      this.burst = { ids: new Set(), timer: setTimeout(() => this.decide(), this.tapWindow) };
    }
    this.burst.ids.add(id);
  }

  /** The switches that turned on together: several = the tile was tapped, nothing plays. One = play it. */
  decide() {
    const ids = [...this.burst.ids];
    this.burst = undefined;
    if (ids.length > 1) {
      this.log.info('Quick Responses: several turned on at once (the tile was tapped); open the tile and pick one.');
      this.later(() => ids.forEach(id => this.setOn(id, false)));
      return;
    }
    const message = this.services.get(ids[0])?.message;
    if (!message) {
      return;
    }
    const file = this.audio.files.get(message.id);
    const why = !file
      ? 'its audio is still being prepared'
      : this.playing
        ? 'another message is playing'
        : undefined;
    if (why) {
      this.refuse(message, why);
      return;
    }
    // A dropped doorbell connection usually comes back within seconds: keep the switch on and wait for it.
    if (this.camera.connectionReady?.() === false) {
      this.startWaiting(message, file);
      return;
    }
    this.playIfClear(message, file);
  }

  /** Plays now unless something else (a microphone in a live view...) is in the way. */
  playIfClear(message, file) {
    const why = this.camera.playbackBlocker();
    if (why) {
      this.refuse(message, why);
      return;
    }
    this.play(message, file);
  }

  stopWaiting() {
    if (this.waiting) {
      clearInterval(this.waiting.timer);
      this.waiting = undefined;
    }
  }

  /** The switch stays on while the connection is down; a newer pick replaces the one waiting. */
  startWaiting(message, file) {
    if (this.waiting) {
      const old = this.services.get(this.waiting.id)?.message;
      this.log.info(`Quick Response "${old?.name}": no longer waiting, "${message.name}" was picked instead.`);
      this.setOn(this.waiting.id, false);
      this.stopWaiting();
    }
    this.log.info(`Quick Response "${message.name}": the doorbell connection is down; waiting up to ${Math.round(this.waitMs / 1000)} s.`);
    const deadline = Date.now() + this.waitMs;
    const waiting = { id: message.id, deadline, timer: undefined };
    waiting.timer = setInterval(() => {
      if (this.camera.connectionReady?.() !== false) {
        this.stopWaiting();
        this.playIfClear(message, file);
      } else if (Date.now() >= deadline) {
        this.stopWaiting();
        this.log.info(`Quick Response "${message.name}" not played: the doorbell connection didn't come back within ${Math.round(this.waitMs / 1000)} s.`);
        this.setOn(message.id, false);
      }
    }, this.pollMs);
    this.waiting = waiting;
  }

  async play(message, file) {
    const playing = { id: message.id, abort: () => {} };
    this.playing = playing;
    try {
      // The camera owns the audio sender; it also stops the playback when someone talks in a live view.
      const run = this.camera.playAudio(file, message.name);
      playing.abort = () => this.camera.cancelPlayback?.();
      const { sent } = await run;
      this.log.info(`Quick Response "${message.name}" played (${sent} packets).`);
    } catch (error) {
      this.log.warn(`Quick Response "${message.name}" failed: ${error.message}`);
    } finally {
      this.playing = undefined;
      this.setOn(message.id, false);
    }
  }
}
