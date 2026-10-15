// Server side of the plugin's settings page (spawned by the Homebridge UI while the settings are
// open). Does the ecobee sign-in and hands only the refresh token back to the page, which saves it
// in the plugin config. The MFA token and PKCE verifier stay here, in memory.
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

(() => new UiServer())();
