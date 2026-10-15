#!/usr/bin/env node
// Browser sign-in for homebridge-ecobee-security. ecobee's login page shows a CAPTCHA to scripts,
// so you sign in yourself in Chrome and paste the final redirect URL here. Prints a refresh token
// to paste into the plugin settings (Homebridge UI > Plugins > ecobee Smart Security > Settings).
import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline';

import { AUDIENCE, AUTH, CLIENT_ID, REDIRECT_URI, SCOPE, tokenRequest } from '../lib/ecobee.js';

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
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
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
  if (!tokens.refresh_token) {
    throw new Error('signed in, but ecobee returned no refresh token');
  }
  console.log(`
Signed in. Paste this refresh token into the plugin settings ("Refresh token"), save, and restart
the bridge. Treat it like a password: it gives full access to your ecobee account.

${tokens.refresh_token}
`);
}

main().catch(error => {
  console.error(`Sign-in failed: ${error.message}`);
  process.exit(1);
});
