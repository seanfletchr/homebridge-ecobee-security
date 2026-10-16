// A local control socket so other Homebridge plugins (each child bridge is its own process)
// can ask for a temporary Stay while they move around the house:
//   POST /hold?by=<name>&plugin=<package>     -> { ok, held, state, reason? }
//   POST /release?by=<name>&plugin=<package>  -> { released, state, waiting? }  (Away only once every holder has released)
// It's a Unix socket in the plugin's storage folder (mode 600), so only the homebridge user can use it.
// Holds need `allowHolds` and the asking plugin ticked in the settings (`isAllowed`); otherwise it
// answers 403 so the caller can log why. Every request is noted (`noteRequest`) so the settings page
// can list the plugins that asked. A release is always accepted from a current holder, so taking a
// plugin's permission away can't leave the system stuck in Stay.

import { chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

export function startControlServer({ path, log, getSystem, isAllowed, noteRequest }) {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    log.warn(`Could not remove an old control socket ${path}: ${error.message}`);
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const by = (url.searchParams.get('by') || 'another plugin').slice(0, 40);
    // Requests are allowed per plugin; one that doesn't say which it is goes by its `by` name.
    const plugin = (url.searchParams.get('plugin') || '').slice(0, 100) || undefined;
    const key = plugin ?? by;
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !['/hold', '/release'].includes(url.pathname)) {
      return reply(404, { error: 'POST /hold or /release' });
    }
    const system = getSystem();
    const releasing = url.pathname === '/release';
    noteRequest?.({ key, plugin, by });
    if (!(releasing && system?.holders().includes(by))) {
      const allowed = isAllowed(key);
      if (allowed !== true) {
        const why = allowed === 'off'
          ? 'security holds are turned off in the ecobee Smart Security settings'
          : `${key} isn't allowed to ask for security holds in the ecobee Smart Security settings`;
        log.warn(`${by}${plugin ? ` (${plugin})` : ''} asked for a security hold, but ${why}.`);
        return reply(403, { ok: false, error: why });
      }
    }
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
