import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIPv4 } from 'node:net';
import { HttpClient, IPDiscovery } from 'hap-controller';

// Pairing with the doorbell's own HomeKit (HAP) server as a controller, for the doorbell link. Used by
// the settings page (server side) and the plugin. The setup code is never logged or kept.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @returns {{id: string, pairingData: object} | undefined} */
export function readPairing(path) {
  try {
    const pairing = JSON.parse(readFileSync(path, 'utf8'));
    return pairing?.id && pairing.pairingData ? pairing : undefined;
  } catch {
    return undefined;
  }
}

export function writePairing(path, pairing) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(pairing, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function pickAddress(service) {
  return service.allAddresses?.find(a => isIPv4(a)) ?? service.address;
}

/** Is this mDNS entry an ecobee doorbell camera (video doorbell, EB-CAMSDB model)? */
export const isDoorbell = service => service.ci === 18 && String(service.md ?? '').startsWith('EB-CAMSDB');

/** Find a device by HAP id (case-insensitive) or by a test; resolves the mDNS entry. */
export async function findService({ id, test }, timeout = 20000) {
  const discovery = new IPDiscovery();
  discovery.start();
  const start = Date.now();
  try {
    while (Date.now() - start < timeout) {
      const hit = discovery.list().find(s => (id ? s.id?.toLowerCase() === id.toLowerCase() : test(s)));
      if (hit) {
        return hit;
      }
      await sleep(500);
    }
  } finally {
    discovery.stop();
  }
  throw new Error('The doorbell was not found on the network.');
}

/** Doorbells that can be paired (nobody else is paired with them), seen on the network within `seconds`. */
export async function findDoorbells(seconds = 5) {
  const discovery = new IPDiscovery();
  discovery.start();
  await sleep(seconds * 1000);
  const list = discovery.list();
  discovery.stop();
  return list.filter(isDoorbell).map(s => ({
    id: s.id,
    name: String(s.name ?? '').replace(/\._hap\._tcp.*$/, ''),
    availableToPair: s.availableToPair === true,
  }));
}

/** Pair with a doorbell using its 8-digit setup code, and save the pairing. */
export async function pairDoorbell({ id, code, path, findTimeout }) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (digits.length !== 8) {
    throw new Error('The setup code is 8 digits.');
  }
  const pin = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  const service = await findService({ id }, findTimeout);
  if (!service.availableToPair) {
    throw new Error('The doorbell is already paired with something. Remove it from the Home app first.');
  }
  const method = await new IPDiscovery().getPairMethod(service);
  const client = new HttpClient(service.id, pickAddress(service), service.port);
  try {
    await client.pairSetup(pin, method);
    writePairing(path, { id: service.id, pairingData: client.getLongTermData() });
  } finally {
    await client.close?.().catch?.(() => {});
  }
  return { id: service.id };
}

/**
 * Remove our pairing from the doorbell and delete the file. With `force`, delete the file even when
 * the doorbell can't be reached.
 */
export async function unpairDoorbell({ path, force = false, findTimeout }) {
  const pairing = readPairing(path);
  if (!pairing) {
    return;
  }
  try {
    const service = await findService({ id: pairing.id }, findTimeout);
    const client = new HttpClient(service.id, pickAddress(service), service.port, pairing.pairingData);
    try {
      await client.removePairing(pairing.pairingData.iOSDevicePairingID);
    } finally {
      await client.close?.().catch?.(() => {});
    }
  } catch (error) {
    if (!force) {
      throw error;
    }
  }
  if (existsSync(path)) {
    rmSync(path);
  }
}
