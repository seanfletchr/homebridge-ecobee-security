// A local control socket so other Homebridge plugins (each child bridge is its own process)
// can ask for a temporary Stay while they move around the house:
//   POST /hold?by=<name>     -> { ok, held, state, reason? }
//   POST /release?by=<name>  -> { released, state, waiting? }  (Away only once every holder has released)
// It's a Unix socket in the plugin's storage folder (mode 600), so only the homebridge user can use it.
// With `allowHolds` off it still listens, but refuses with 403 so the caller can log why.

import { chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

export function startControlServer({ path, log, getSystem, enabled }) {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    log.warn(`Could not remove an old control socket ${path}: ${error.message}`);
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const by = (url.searchParams.get('by') || 'another plugin').slice(0, 40);
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !['/hold', '/release'].includes(url.pathname)) {
      return reply(404, { error: 'POST /hold or /release' });
    }
    if (!enabled) {
      log.warn(`${by} asked for a security hold, but holds are off (Allow security holds in the plugin settings).`);
      return reply(403, { ok: false, error: 'security holds are turned off in the ecobee Security settings' });
    }
    const system = getSystem();
    if (!system) {
      return reply(503, { error: 'not connected to ecobee yet' });
    }
    try {
      reply(200, url.pathname === '/hold' ? await system.hold(by) : await system.release(by));
    } catch (error) {
      reply(502, { error: error.message });
    }
  });
  server.on('error', error => log.error(`Control socket ${path}: ${error.message}`));
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600);
      log.debug(`Control socket listening at ${path}`);
    } catch (error) {
      // Only the homebridge user may use the socket; don't serve it if that can't be ensured.
      log.error(`Control socket ${path}: ${error.message}; closing it.`);
      server.close();
    }
  });
  return server;
}
