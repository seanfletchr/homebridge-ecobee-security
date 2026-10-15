import { readFileSync } from 'node:fs';

/** The plugin version, reported to HomeKit as the accessories' firmware version. */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
