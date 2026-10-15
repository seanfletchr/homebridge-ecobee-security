// ecobee sign-in, shared by bin/ecobee-login.js and the Homebridge UI settings page.
//
// Password sign-in goes straight to Auth0's token endpoint as the ecobee app's client (no login
// page, so no CAPTCHA), followed by the account's MFA code if it has MFA. The browser sign-in is
// the fallback: the user signs in on ecobee's page and pastes the app callback URL.
// Only the refresh token is kept; passwords and codes are passed through and never stored.
import { createHash, randomBytes } from 'node:crypto';

import { AUDIENCE, AUTH, CLIENT_ID, REDIRECT_URI, SCOPE } from './ecobee.js';

const TIMEOUT = 20 * 1000;

/** A sign-in step failed; `message` is ecobee's reason, fit to show the user. */
export class SignInError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(`${AUTH}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (error) {
    throw new SignInError(`Could not reach ecobee (${error.message})`, 'network');
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function fail({ status, json }) {
  const reason = json.error_description || json.error || `HTTP ${status}`;
  return new SignInError(reason.endsWith('.') ? reason : `${reason}.`, json.error ?? `http_${status}`);
}

function tokens(json) {
  if (!json.refresh_token) {
    throw new SignInError('Signed in, but ecobee returned no refresh token.', 'no_refresh_token');
  }
  return json;
}

/**
 * Step 1 of password sign-in. Resolves `{ tokens }` when no MFA is needed, otherwise
 * `{ mfa }` to pass to finishMfa() together with the code ecobee asks for. `mfa.method` is
 * 'otp' (authenticator app) or 'oob' (a code ecobee sends by SMS or email).
 */
export async function passwordSignIn(username, password) {
  const first = await post('/oauth/token', { grant_type: 'password', username, password, audience: AUDIENCE, scope: SCOPE });
  if (first.status === 200) {
    return { tokens: tokens(first.json) };
  }
  if (first.json.error !== 'mfa_required') {
    throw fail(first);
  }
  const mfaToken = first.json.mfa_token;
  const challenge = await post('/mfa/challenge', { mfa_token: mfaToken, challenge_type: 'otp oob' });
  if (challenge.status !== 200) {
    throw fail(challenge);
  }
  return {
    mfa: {
      token: mfaToken,
      method: challenge.json.challenge_type === 'oob' ? 'oob' : 'otp',
      oobCode: challenge.json.oob_code,
    },
  };
}

/** Step 2 of password sign-in: the MFA code. */
export async function finishMfa(mfa, code) {
  const otp = String(code).replace(/\s+/g, '');
  const result = mfa.method === 'oob'
    ? await post('/oauth/token', { grant_type: 'http://auth0.com/oauth/grant-type/mfa-oob', mfa_token: mfa.token, oob_code: mfa.oobCode, binding_code: otp })
    : await post('/oauth/token', { grant_type: 'http://auth0.com/oauth/grant-type/mfa-otp', mfa_token: mfa.token, otp });
  if (result.status !== 200) {
    throw fail(result);
  }
  return tokens(result.json);
}

/** Browser sign-in, step 1: the link to open, plus what finishBrowserSignIn() needs later. */
export function browserSignInLink() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const url = new URL('/authorize', AUTH);
  Object.entries({
    audience: AUDIENCE, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
    response_type: 'code', prompt: 'login', state, nonce: randomBytes(16).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  return { url: url.href, verifier, state };
}

/** Browser sign-in, step 2: the com.ecobee.athenamobile://…?code=… URL the user copied. */
export async function finishBrowserSignIn(link, callbackUrl) {
  let callback;
  try {
    callback = new URL(String(callbackUrl).trim());
  } catch {
    throw new SignInError('That isn\'t a URL. It should start with com.ecobee.athenamobile://', 'bad_url');
  }
  if (callback.searchParams.get('state') !== link.state) {
    throw new SignInError('That URL is from a different sign-in attempt. Get a new link and try again.', 'bad_state');
  }
  const code = callback.searchParams.get('code');
  if (!code) {
    throw new SignInError('There\'s no code= in that URL.', 'bad_url');
  }
  const result = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: link.verifier, redirect_uri: REDIRECT_URI });
  if (result.status !== 200) {
    throw fail(result);
  }
  return tokens(result.json);
}
