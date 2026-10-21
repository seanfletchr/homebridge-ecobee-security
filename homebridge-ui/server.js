// Server side of the plugin's settings page (spawned by the Homebridge UI while the settings are
// open). Does the ecobee sign-in and hands only the refresh token back to the page, which saves it
// in the plugin config. The MFA token and PKCE verifier stay here, in memory.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { memberTracking } from '../lib/ecobee.js';
import { findDoorbells, pairDoorbell, readPairing, unpairDoorbell } from '../lib/camera/hap-pairing.js';
import { BUILT_INS, cacheName, piperStatus, renderWithPiper, shippedFile } from '../lib/quick-responses.js';
import { browserSignInLink, finishBrowserSignIn, finishMfa, passwordSignIn, SignInError } from '../lib/auth.js';

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.mfa = undefined;
    this.link = undefined;

    this.onRequest('/password', ({ email, password } = {}) => this.guard(async () => {
      if (!email || !password) {
        throw new SignInError('Enter your ecobee email and password.', 'missing');
      }
      this.mfa = undefined;
      const { tokens, mfa } = await passwordSignIn(String(email).trim(), String(password));
      if (tokens) {
        return { refreshToken: tokens.refresh_token };
      }
      this.mfa = mfa;
      return { mfa: mfa.method };
    }));

    this.onRequest('/mfa', ({ code } = {}) => this.guard(async () => {
      if (!this.mfa) {
        throw new SignInError('The sign-in timed out. Enter your email and password again.', 'no_mfa');
      }
      const tokens = await finishMfa(this.mfa, code ?? '');
      this.mfa = undefined;
      return { refreshToken: tokens.refresh_token };
    }));

    this.onRequest('/browser-link', () => {
      this.link = browserSignInLink();
      return { url: this.link.url };
    });

    this.onRequest('/browser-finish', ({ callbackUrl } = {}) => this.guard(async () => {
      if (!this.link) {
        throw new SignInError('Get a sign-in link first.', 'no_link');
      }
      const tokens = await finishBrowserSignIn(this.link, callbackUrl ?? '');
      this.link = undefined;
      return { refreshToken: tokens.refresh_token };
    }));

    // Plugins that use security holds: installed ones that declare it, and any that have asked.
    // Only the request log leaves state.json (it also holds the ecobee sign-in).
    this.onRequest('/hold-plugins', async () => {
      const plugins = new Map();
      for (const p of installedHoldClients(this.homebridgeStoragePath)) {
        plugins.set(p.name, { key: p.name, displayName: p.displayName, names: [] });
      }
      let store = {};
      try {
        store = JSON.parse(await readFile(join(this.homebridgeStoragePath, 'ecobee-security', 'state.json'), 'utf8'));
      } catch {
        // Not started yet: only the installed ones.
      }
      for (const [key, r] of Object.entries(store.holdRequesters ?? {})) {
        const known = plugins.get(key);
        plugins.set(key, { key, displayName: known?.displayName ?? key, names: r.names ?? [], lastAsked: r.lastAsked });
      }
      return [...plugins.values()];
    });

    // Locks the plugin found that report keypad unlocks (only that list leaves state.json).
    this.onRequest('/keypad-locks', async () => {
      try {
        const store = JSON.parse(await readFile(join(this.homebridgeStoragePath, 'ecobee-security', 'state.json'), 'utf8'));
        return store.keypadLocks ?? [];
      } catch {
        return [];
      }
    });

    // The homes on the account, as the plugin last saw them (only that list leaves state.json).
    this.onRequest('/homes', async () => {
      try {
        const store = JSON.parse(await readFile(join(this.homebridgeStoragePath, 'ecobee-security', 'state.json'), 'utf8'));
        return store.homes ?? [];
      } catch {
        return [];
      }
    });

    // The household members the plugin last saw (only that list leaves state.json), with whether the
    // ecobee app can tell where they are. The plugin reads them from ecobee with its own sign-in, so
    // the page doesn't use the refresh token (a second user of it could invalidate the plugin's).
    this.onRequest('/members', async () => {
      try {
        const store = JSON.parse(await readFile(join(this.homebridgeStoragePath, 'ecobee-security', 'state.json'), 'utf8'));
        return (store.members ?? []).map(m => ({ accountId: m.accountId, name: m.name, ...memberTracking(m) }));
      } catch {
        return [];
      }
    });

    // The doorbell link: pairing with the doorbell's own HomeKit server. The setup code is used once
    // and neither logged nor kept.
    const pairingPath = () => join(this.homebridgeStoragePath, 'ecobee-security', 'doorbell-pairing.json');

    this.onRequest('/doorbell-link', async () => {
      const pairing = readPairing(pairingPath());
      let link;
      let store = {};
      try {
        store = JSON.parse(await readFile(join(this.homebridgeStoragePath, 'ecobee-security', 'state.json'), 'utf8'));
        link = store.doorbellLink;
      } catch {
        // not started yet
      }
      // hasDoorbell stays undefined until the plugin has looked at the account.
      return { paired: Boolean(pairing), id: pairing?.id, state: pairing ? link?.state : undefined, hasDoorbell: store.hasDoorbell, name: store.doorbellName };
    });

    this.onRequest('/doorbell-find', () => findDoorbells(5).catch((error) => {
      throw new RequestError(`Could not look for doorbells: ${error.message}`);
    }));

    this.onRequest('/doorbell-pair', async ({ id, code } = {}) => {
      try {
        await pairDoorbell({ id: String(id ?? ''), code, path: pairingPath() });
        return { paired: true };
      } catch (error) {
        throw new RequestError(error.message);
      }
    });

    this.onRequest('/doorbell-unpair', async ({ force } = {}) => {
      try {
        await unpairDoorbell({ path: pairingPath(), force: force === true });
        return { paired: false };
      } catch (error) {
        throw new RequestError(`The doorbell could not be reached to remove the link (${error.message}).`, { code: 'unreachable' });
      }
    });

    // Quick Responses. Piper's two paths come from the page (they may not be saved yet), else from the saved config.
    const piperSettings = async ({ piperPath, piperVoice } = {}) => {
      if (piperPath !== undefined || piperVoice !== undefined) {
        return { piperPath, piperVoice };
      }
      try {
        const config = JSON.parse(await readFile(join(this.homebridgeStoragePath, 'config.json'), 'utf8'));
        const block = (config.platforms ?? []).find(p => p.platform === 'EcobeeSecurityPlatform') ?? {};
        return { piperPath: block.piperPath, piperVoice: block.piperVoice };
      } catch {
        return {};
      }
    };

    this.onRequest('/piper-status', async (request = {}) => piperStatus(await piperSettings(request)));

    // The audio of one message as base64 WAV: the shipped recording while the built-in wording is unchanged,
    // else rendered with Piper (the rendering goes in the plugin's cache, where the bridge will find it too).
    this.onRequest('/quick-response-preview', async ({ id, phrase, piperPath, piperVoice } = {}) => {
      const message = { id: String(id ?? ''), phrase: String(phrase ?? '').trim() };
      if (!message.phrase) {
        throw new RequestError('Type what the doorbell should say first.');
      }
      let file = shippedFile(message);
      if (!file) {
        const settings = await piperSettings({ piperPath, piperVoice });
        if (!piperStatus(settings).found) {
          throw new RequestError('Changed wording needs Piper (see README)', { code: 'no_piper' });
        }
        const dir = join(this.homebridgeStoragePath, 'ecobee-security', 'quick-responses');
        mkdirSync(dir, { recursive: true });
        file = join(dir, cacheName(String(settings.piperVoice).trim(), message.phrase));
        try {
          if (!existsSync(file)) {
            await renderWithPiper({ ...settings, phrase: message.phrase, out: file });
          }
        } catch (error) {
          throw new RequestError(`Piper could not render this: ${error.message}`, { code: 'piper_failed' });
        }
      }
      return { audio: (await readFile(file)).toString('base64'), mime: 'audio/wav' };
    });

    // The built-in messages, for a settings page with none saved yet.
    this.onRequest('/quick-response-defaults', () => BUILT_INS);

    this.ready();
  }

  /** Turn sign-in failures into RequestErrors so the page can show ecobee's reason. */
  async guard(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SignInError) {
        throw new RequestError(error.message, { code: error.code });
      }
      throw new RequestError(`Sign-in failed: ${error.message}`, { code: 'unexpected' });
    }
  }
}

/** Installed plugins that declare they ask for holds: "homebridge-security-hold": { "client": true }. */
function installedHoldClients(storagePath) {
  const folders = new Set([fileURLToPath(new URL('../../', import.meta.url))]);
  if (storagePath) {
    folders.add(join(storagePath, 'node_modules'));
  }
  const found = new Map();
  const scan = folder => {
    let entries = [];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const dir = join(folder, entry.name);
      if (entry.name.startsWith('@')) {
        scan(dir);
        continue;
      }
      if (!entry.name.includes('homebridge')) {
        continue;
      }
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg['homebridge-security-hold']?.client === true && pkg.name && !found.has(pkg.name)) {
          found.set(pkg.name, { name: pkg.name, displayName: pkg.displayName || pkg.name });
        }
      } catch {
        // not a package
      }
    }
  };
  folders.forEach(scan);
  return [...found.values()];
}

(() => new UiServer())();
