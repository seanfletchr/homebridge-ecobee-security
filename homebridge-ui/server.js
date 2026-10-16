// Server side of the plugin's settings page (spawned by the Homebridge UI while the settings are
// open). Does the ecobee sign-in and hands only the refresh token back to the page, which saves it
// in the plugin config. The MFA token and PKCE verifier stay here, in memory.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

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
