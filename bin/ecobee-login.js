#!/usr/bin/env node
// Sign-in for homebridge-ecobee-security from a terminal, for when the Homebridge UI isn't
// available (its plugin settings page has the same sign-in). Prints a refresh token to paste into
// the plugin config.
//
//   ecobee-login.js            email, password and MFA code (the password is never saved)
//   ecobee-login.js --browser  sign in on ecobee's web page instead and paste the callback URL
import readline from 'node:readline';

import { browserSignInLink, finishBrowserSignIn, finishMfa, passwordSignIn } from '../lib/auth.js';

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

async function withPassword() {
  console.log('\nSign in to ecobee. Your password goes only to auth.ecobee.com and isn\'t saved.\n');
  const username = await ask('ecobee email: ');
  const password = await ask('Password (hidden): ', { hidden: true });
  const { tokens, mfa } = await passwordSignIn(username, password);
  if (tokens) {
    return tokens;
  }
  const code = await ask(mfa.method === 'oob' ? 'Code ecobee just sent you: ' : 'Code from your authenticator app: ');
  return finishMfa(mfa, code);
}

async function withBrowser() {
  const link = browserSignInLink();
  console.log(`
1. In Chrome, open a new tab, press Option-Command-I, go to Network and tick "Preserve log".
2. Open this link in that tab and sign in (email, password, CAPTCHA, MFA code):

${link.url}

3. When the page goes blank, type  code=  in the Network filter, right-click the entry and
   Copy > Copy URL (or: the last "resume" request > Headers > Response Headers > location).
   It starts with com.ecobee.athenamobile://
4. Paste it below straight away; the code expires quickly.
`);
  return finishBrowserSignIn(link, await ask('Callback URL: '));
}

async function main() {
  const tokens = process.argv.includes('--browser') ? await withBrowser() : await withPassword();
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
