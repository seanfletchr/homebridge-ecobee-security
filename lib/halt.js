// Ask a plugin that's out working (a robot vacuum) to head back to its base or stop where it is,
// because the system is being armed Away. Plugins give their halt endpoint with their hold request (`&halt=`): a Unix socket path,
// or an http(s) URL. POST <endpoint>/halt?by=<name>&armAt=<ISO time> -> 2xx, optionally JSON
// { halted, returning?, reason? }. `armAt` is when the motion sensors arm (the end of the exit delay),
// so a robot can head back to its base in time; without it, it stops where it is.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const TIMEOUT = 5 * 1000;

/** Resolves `{ halted, returning?, reason? }`; rejects if the plugin can't be reached. */
export function sendHalt(endpoint, by, armAt) {
  const query = `?by=${encodeURIComponent(by)}` + (armAt ? `&armAt=${encodeURIComponent(new Date(armAt).toISOString())}` : '');
  const options = { method: 'POST', timeout: TIMEOUT };
  let request = httpRequest;
  if (/^https?:\/\//i.test(endpoint)) {
    const url = new URL(endpoint);
    Object.assign(options, {
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
      path: `${url.pathname.replace(/\/$/, '')}/halt${query}`,
    });
    request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  } else {
    Object.assign(options, { socketPath: endpoint, path: `/halt${query}` });
  }
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = {};
        try {
          json = body.trim() ? JSON.parse(body) : {};
        } catch {
          // The status code is what counts.
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(json.error ?? `answered ${res.statusCode}`));
        }
        resolve({ halted: json.halted ?? true, returning: json.returning === true, reason: json.reason });
      });
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', error => reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
      ? new Error('the plugin is not running') : error));
    req.end();
  });
}
