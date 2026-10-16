// Disarm on a keypad unlock: watch the locks on the other bridges of this Homebridge for an unlock
// that the lock says was done with its keypad (HomeKit's Lock Last Known Action). Child bridges run
// in their own processes, so the locks are read over HAP on 127.0.0.1, which Homebridge allows with
// just the bridge's PIN in insecure mode (the Homebridge UI's accessory control uses the same).
// HAP events need a paired session, so the locks are polled; reading a few values locally every
// second costs next to nothing.

import { readFileSync } from 'node:fs';

const POLL = 1000;
// No locks found (or a bridge went away): look again this often.
const RESCAN = 10 * 60 * 1000;
// Other child bridges may still be starting: rescan every 30 s for this long.
const GRACE = 3 * 60 * 1000;
const GRACE_RESCAN = 30 * 1000;
const TIMEOUT = 3000;
// An unlock whose "by keypad" comes in a later update than the state still counts within this.
const LABEL_LAG = 5000;

const INFO = '3E';
const LOCK = '45';
const NAME = '23';
const CONFIGURED_NAME = 'E3';
const SERIAL = '30';
const CURRENT = '1D';
const LAST_ACTION = '1C';

const UNSECURED = 0;
const UNSECURED_BY_KEYPAD = 5;

/** Apple's HAP types come as "45" or "00000045-0000-1000-8000-0026BB765291". */
function shortType(type) {
  const t = String(type).toUpperCase();
  if (t.includes('-') && !t.endsWith('-0000-1000-8000-0026BB765291')) {
    return t;
  }
  return t.split('-')[0].replace(/^0+/, '');
}

export class KeypadLocks {
  /**
   * @param {object} opts
   * @param {string} opts.configPath Homebridge's config.json (bridge ports and PINs)
   * @param {string} opts.ownPlatform this plugin's platform name (its own bridge is skipped)
   * @param {(lock: {key: string, name: string, bridge: string}) => void} opts.onKeypadUnlock
   * @param {(locks: {key: string, name: string, bridge: string}[]) => void} [opts.onLocks] the locks found, after each scan
   */
  constructor({ configPath, ownPlatform, log, onKeypadUnlock, onLocks }) {
    this.configPath = configPath;
    this.ownPlatform = ownPlatform;
    this.log = log;
    this.onKeypadUnlock = onKeypadUnlock;
    this.onLocks = onLocks;
    /** @type {Map<string, object>} key → lock: { key, name, bridge, aid, current, last, state, lastAction, pendingUntil } */
    this.locks = new Map();
    this.scannedAt = 0;
    this.warned = new Set();
  }

  start() {
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.poll(), POLL);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Every bridge in config.json with a fixed port, except this plugin's own. */
  bridges() {
    const config = JSON.parse(readFileSync(this.configPath, 'utf8'));
    const main = config.bridge ?? {};
    const list = [{ name: main.name ?? 'Homebridge', port: main.port, pin: main.pin }];
    for (const block of [...(config.platforms ?? []), ...(config.accessories ?? [])]) {
      const child = block?._bridge;
      if (child?.port && block.platform !== this.ownPlatform) {
        list.push({ name: child.name ?? block.platform ?? block.accessory, port: child.port, pin: child.pin ?? main.pin });
      }
    }
    return list.filter(b => b.port && b.pin);
  }

  async request(bridge, path) {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
      headers: { Authorization: bridge.pin },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (response.status === 401 || response.status === 470) {
      const error = new Error('not allowed');
      error.auth = true;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  /** Find every lock that reports how it was last locked or unlocked. */
  async scan() {
    this.scannedAt = Date.now();
    let bridges;
    try {
      bridges = this.bridges();
    } catch (error) {
      this.warnOnce('config', `Keypad unlock: could not read the Homebridge config (${error.message}).`);
      return;
    }
    const found = new Map();
    let denied = 0;
    for (const bridge of bridges) {
      let data;
      try {
        data = await this.request(bridge, '/accessories');
      } catch (error) {
        denied += error.auth ? 1 : 0;
        continue;
      }
      for (const accessory of data.accessories ?? []) {
        const services = accessory.services ?? [];
        const lock = services.find(s => shortType(s.type) === LOCK);
        const all = services.flatMap(s => s.characteristics ?? []);
        const current = lock?.characteristics?.find(c => shortType(c.type) === CURRENT);
        const last = all.find(c => shortType(c.type) === LAST_ACTION);
        if (!current || !last) {
          continue;
        }
        const info = services.find(s => shortType(s.type) === INFO)?.characteristics ?? [];
        const nameOf = chars => chars.find(c => shortType(c.type) === CONFIGURED_NAME)?.value
          || chars.find(c => shortType(c.type) === NAME)?.value;
        const name = nameOf(lock.characteristics) || nameOf(info) || `Lock ${accessory.aid}`;
        const serial = info.find(c => shortType(c.type) === SERIAL)?.value;
        const key = serial ? String(serial) : `${bridge.name}/${name}`;
        const known = this.locks.get(key);
        found.set(key, {
          key, name, bridge, aid: accessory.aid, current: current.iid, last: last.iid,
          // Keep what we knew if it's the same lock on the same bridge; otherwise start from its first read.
          ...(known?.bridge.port === bridge.port && known.aid === accessory.aid
            ? { state: known.state, lastAction: known.lastAction, pendingUntil: known.pendingUntil } : {}),
        });
      }
    }
    if (denied && denied === bridges.length) {
      this.warnOnce('denied', 'Keypad unlock: Homebridge didn\'t let the plugin read the other bridges. Turn on insecure mode '
        + '(Homebridge Settings > Homebridge Insecure Mode / Accessory Control) and restart Homebridge.');
    }
    const before = [...this.locks.keys()].sort().join();
    this.locks = found;
    if ([...found.keys()].sort().join() !== before) {
      if (found.size) {
        this.log.info(`Keypad unlock: watching ${[...found.values()].map(l => `"${l.name}" (${l.bridge.name})`).join(', ')}.`);
        this.warned.delete('none');
      }
      this.onLocks?.([...found.values()].map(({ key, name, bridge }) => ({ key, name, bridge: bridge.name })));
    }
    if (!found.size && !this.starting()) {
      this.warnOnce('none', 'Keypad unlock: no lock on this Homebridge reports keypad unlocks; checking again every 10 minutes.');
    }
  }

  async poll() {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const every = this.starting() ? GRACE_RESCAN : RESCAN;
      if (this.rescan || (!this.locks.size && Date.now() - this.scannedAt >= every)) {
        this.rescan = false;
        await this.scan();
      }
      const byBridge = new Map();
      for (const lock of this.locks.values()) {
        byBridge.set(lock.bridge.port, [...(byBridge.get(lock.bridge.port) ?? []), lock]);
      }
      await Promise.all([...byBridge.values()].map(locks => this.read(locks)));
    } finally {
      this.polling = false;
    }
  }

  async read(locks) {
    const ids = locks.flatMap(l => [`${l.aid}.${l.current}`, `${l.aid}.${l.last}`]).join(',');
    let values;
    try {
      const data = await this.request(locks[0].bridge, `/characteristics?id=${ids}`);
      values = new Map((data.characteristics ?? []).map(c => [`${c.aid}.${c.iid}`, c.value]));
    } catch {
      // Bridge restarting (or the lock moved): forget the states, so an unlock isn't seen in
      // whatever it reports when it's back, and look for the locks again (at most every 30 s).
      locks.forEach(l => Object.assign(l, { state: undefined, lastAction: undefined, pendingUntil: undefined }));
      if (Date.now() - this.scannedAt >= GRACE_RESCAN) {
        this.rescan = true;
      }
      return;
    }
    for (const lock of locks) {
      this.update(lock, values.get(`${lock.aid}.${lock.current}`), values.get(`${lock.aid}.${lock.last}`));
    }
  }

  /**
   * Only an unlock counts, never a label: the lock must go to unlocked while saying it was unlocked
   * with its keypad (in the same update, or within a few seconds after). An app unlock passes through
   * other labels, and a label left from an earlier keypad unlock has no state change to go with it.
   */
  update(lock, state, lastAction) {
    if (state === undefined || lastAction === undefined) {
      return;
    }
    const first = lock.state === undefined;
    const unlocked = !first && state === UNSECURED && lock.state !== UNSECURED;
    const now = Date.now();
    if (state !== lock.state) {
      lock.pendingUntil = unlocked ? now + LABEL_LAG : undefined;
    }
    lock.state = state;
    lock.lastAction = lastAction;
    if (lock.pendingUntil && now > lock.pendingUntil) {
      lock.pendingUntil = undefined;
    }
    if (lock.pendingUntil && lastAction === UNSECURED_BY_KEYPAD) {
      lock.pendingUntil = undefined;
      this.onKeypadUnlock({ key: lock.key, name: lock.name, bridge: lock.bridge.name });
    }
  }

  /** Within the start-up grace period, when other bridges may not be up yet. */
  starting() {
    return Date.now() - this.startedAt < GRACE;
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.log.warn(message);
    }
  }
}
