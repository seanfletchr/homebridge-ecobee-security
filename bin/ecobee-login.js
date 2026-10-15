#!/usr/bin/env node
// Sign-in for homebridge-ecobee-security. Prints a refresh token to paste into the plugin settings
// (Homebridge UI > Plugins > ecobee Smart Security > Settings).
//
// Default: browser sign-in. ecobee's login page shows a CAPTCHA to scripts, so you sign in yourself
// in Chrome and paste the final redirect URL here.
// --password (experimental): email, password and MFA code straight to ecobee's token endpoint, no
// browser. The password is only sent to auth.ecobee.com and never saved.
import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';

import { AUDIENCE, AUTH, CLIENT_ID, REDIRECT_URI, SCOPE, tokenRequest } from '../lib/ecobee.js';

const TIMEOUT = 20 * 1000;

// One reader for the whole run. Lines are queued, so piped input that arrives before the next
// question isn't lost.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
rl._writeToOutput = text => {
  if (!muted) {
    rl.output.write(text);
  }
};
const lines = [];
const waiting = [];
rl.on('line', line => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on('close', () => waiting.splice(0).forEach(resolve => resolve('')));

async function ask(question, { hidden = false } = {}) {
  rl.output.write(question);
  // Hide what's typed after the prompt.
  muted = hidden;
  const answer = lines.length ? lines.shift() : await new Promise(resolve => waiting.push(resolve));
  muted = false;
  if (hidden) {
    rl.output.write('\n');
  }
  return answer.trim();
}

async function browserSignIn() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const url = new URL('/authorize', AUTH);
  Object.entries({
    audience: AUDIENCE, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
    response_type: 'code', prompt: 'login', state, nonce: randomBytes(16).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log(`
1. In Chrome, open a new tab, press Option-Command-I, go to Network and tick "Preserve log".
2. Open this link in that tab and sign in (email, password, CAPTCHA, MFA code):

${url.href}

3. When the page goes blank, type  code=  in the Network filter, right-click the entry and
   Copy > Copy URL (or: the last "resume" request > Headers > Response Headers > location).
   It starts with com.ecobee.athenamobile://
4. Paste it below straight away; the code expires quickly.
`);

  const callback = new URL(await ask('Callback URL: '));
  if (callback.searchParams.get('state') !== state) {
    throw new Error('that URL is from a different sign-in attempt; run this again');
  }
  const code = callback.searchParams.get('code');
  if (!code) {
    throw new Error('no code= in that URL');
  }
  return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
}

/** POST to Auth0 and return the status and JSON whatever happened, so every answer can be reported. */
async function post(path, body) {
  const res = await fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function failure(step, { status, json }) {
  return new Error(`${step}: HTTP ${status} ${json.error ?? ''}: ${json.error_description ?? JSON.stringify(json)}`);
}

async function passwordSignIn() {
  console.log('\nExperimental: signs in without a browser. Your password goes only to auth.ecobee.com and isn\'t saved.\n');
  const username = await ask('ecobee email: ');
  const password = await ask('Password (hidden): ', { hidden: true });

  const first = await post('/oauth/token', { grant_type: 'password', username, password, audience: AUDIENCE, scope: SCOPE });
  if (first.status === 200) {
    console.log('Signed in without MFA.');
    return first.json;
  }
  if (first.json.error !== 'mfa_required') {
    throw failure('Password step', first);
  }
  const mfaToken = first.json.mfa_token;
  console.log('ecobee asked for MFA.');

  // Ask Auth0 which factor to use: an authenticator app code (otp) or a code sent by SMS/email (oob).
  const challenge = await post('/mfa/challenge', { mfa_token: mfaToken, challenge_type: 'otp oob' });
  if (challenge.status !== 200) {
    throw failure('MFA challenge', challenge);
  }
  const { challenge_type: type, oob_code: oobCode } = challenge.json;
  console.log(`MFA method: ${type}${challenge.json.binding_method ? ` (${challenge.json.binding_method})` : ''}`);

  const code = await ask(type === 'oob' ? 'Code ecobee just sent you: ' : 'Code from your authenticator app: ');
  const second = type === 'oob'
    ? await post('/oauth/token', { grant_type: 'http://auth0.com/oauth/grant-type/mfa-oob', mfa_token: mfaToken, oob_code: oobCode, binding_code: code })
    : await post('/oauth/token', { grant_type: 'http://auth0.com/oauth/grant-type/mfa-otp', mfa_token: mfaToken, otp: code });
  if (second.status !== 200) {
    throw failure('MFA step', second);
  }
  return second.json;
}

async function main() {
  const tokens = process.argv.includes('--password') ? await passwordSignIn() : await browserSignIn();
  if (!tokens.refresh_token) {
    throw new Error('signed in, but ecobee returned no refresh token');
  }
  console.log(`
Signed in. Paste this refresh token into the plugin settings ("Refresh token"), save, and restart
the bridge. Treat it like a password: it gives full access to your ecobee account.

${tokens.refresh_token}
`);
}

main().then(() => rl.close(), error => {
  console.error(`Sign-in failed: ${error.message}`);
  process.exit(1);
});
