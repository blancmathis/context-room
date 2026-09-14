import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalNotebookRoot, readNotebookJson, writeNotebookJson, withNotebookLock } from './notebook_io.mjs';

export const DEVICE_PROTOCOL = 1;
const STATE = 'devices.json';
const PAIRING_MS = 120_000;
const DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function deviceError(code, message, statusCode = 403) {
  return Object.assign(new Error(message), { code, statusCode });
}
function requirePrivateRoot(root) {
  canonicalNotebookRoot(root);
  const stat = fs.lstatSync(root);
  if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw deviceError('device_storage_private', 'Device credentials require a private directory owned by this account.');
  }
}
export function prepareDeviceDirectory(root) {
  const parent = path.dirname(root);
  if (!fs.existsSync(root)) {
    canonicalNotebookRoot(parent);
    fs.mkdirSync(root, { mode: 0o700 });
  }
  requirePrivateRoot(root);
  return root;
}
function readPrivateJson(root, rel, fallback = null) {
  requirePrivateRoot(root);
  const value = readNotebookJson(root, rel, fallback);
  if (value !== fallback) {
    const stat = fs.lstatSync(path.join(root, rel));
    if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
      throw deviceError('device_storage_private', 'Device credentials are not private.');
    }
  }
  return value;
}

/** One local identity. No device, account or TLS material is stored in a project. */
export function ensureDeviceIdentity(root) {
  prepareDeviceDirectory(root);
  return withNotebookLock(root, 'identity.lock', () => {
    let identity = readPrivateJson(root, 'identity.json');
    if (!identity) {
      const temporary = fs.mkdtempSync(path.join(root, '.certificate-'));
      fs.chmodSync(temporary, 0o700);
      try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
          '-nodes', '-sha256', '-days', '365', '-subj', '/CN=Context Room Devices',
          '-keyout', path.join(temporary, 'key.pem'), '-out', path.join(temporary, 'cert.pem')],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
        identity = { version: DEVICE_PROTOCOL, serverId: randomUUID(), key: fs.readFileSync(path.join(temporary, 'key.pem'), 'utf8'),
          cert: fs.readFileSync(path.join(temporary, 'cert.pem'), 'utf8') };
        writeNotebookJson(root, 'identity.json', identity, { exclusive: true });
      } catch {
        throw deviceError('device_certificate_unavailable', 'The local TLS certificate could not be created. Check OpenSSL.', 503);
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
    if (identity.version !== DEVICE_PROTOCOL || !/^[a-f0-9-]{36}$/.test(identity.serverId || '')) {
      throw deviceError('device_identity_invalid', 'The saved device identity is invalid.', 409);
    }
    const cert = new X509Certificate(identity.cert);
    if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) {
      throw deviceError('device_certificate_expired', 'The device certificate requires explicit renewal and verification.', 409);
    }
    return { ...identity, fingerprint: digest(cert.raw), expiresAt: Date.parse(cert.validTo) };
  });
}

function exactPaths(values) {
  if (!Array.isArray(values) || !values.length || values.length > 128) {
    throw deviceError('device_scope_invalid', 'Choose between one and 128 exact notebooks.', 400);
  }
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !value.endsWith('.crnb') || value.includes('\\') || /[\x00-\x1f]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
      throw deviceError('device_scope_invalid', 'A notebook grant requires exact relative .crnb paths.', 400);
    }
    return value;
  }))].sort();
}
function grant(value) {
  if (value?.mode !== 'draw' || !/^[a-f0-9]{24}$/.test(value.projectId || '')
    || typeof value.root !== 'string' || path.resolve(value.root) !== value.root
    || !/^\d+:\d+$/.test(value.rootIdentity || '')) {
    throw deviceError('device_scope_invalid', 'An exact drawing grant is required; owner review is a separate authority.', 400);
  }
  return { mode: 'draw', projectId: value.projectId, root: value.root, rootIdentity: value.rootIdentity, paths: exactPaths(value.paths) };
}
function savedGrant(value, serverId) {
  if (value?.mode === 'owner') {
    if (value.serverId !== serverId) throw deviceError('device_scope_invalid', 'The owner permission belongs to another Mac.', 409);
    return { mode: 'owner', serverId };
  }
  return grant(value);
}
const publicGrant = value => value.mode === 'owner' ? { mode: 'owner', serverId: value.serverId }
  : { mode: value.mode, projectId: value.projectId, paths: value.paths };
const publicDevice = value => ({ id: value.id, label: value.label, createdAt: value.createdAt, expiresAt: value.expiresAt,
  revokedAt: value.revokedAt || null, grants: value.grants.map(publicGrant) });

export function createDeviceAuthority({ stateRoot, serverId, now = Date.now }) {
  prepareDeviceDirectory(stateRoot);
  const stateIdentity = canonicalNotebookRoot(stateRoot);
  function read() {
    if (canonicalNotebookRoot(stateRoot) !== stateIdentity) throw deviceError('device_storage_changed', 'Device storage was replaced.', 409);
    const state = readPrivateJson(stateRoot, STATE, { version: DEVICE_PROTOCOL, serverId, devices: [], pairings: [] });
    if (state.version !== DEVICE_PROTOCOL || state.serverId !== serverId || !Array.isArray(state.devices) || !Array.isArray(state.pairings)
      || state.devices.length > 128 || state.pairings.length > 16) {
      throw deviceError('device_storage_invalid', 'Saved device authority is invalid.', 409);
    }
    return state;
  }
  function update(operation) {
    return withNotebookLock(stateRoot, 'devices.lock', () => {
      const state = read();
      const result = operation(state);
      writeNotebookJson(stateRoot, STATE, state);
      return result;
    });
  }
  function pairing(scopes, label) {
      const cleanLabel = String(label).trim().slice(0, 100);
      if (!cleanLabel || /[\x00-\x1f]/.test(cleanLabel)) throw deviceError('device_label_invalid', 'Choose a device name.', 400);
      return update(state => {
        state.pairings = state.pairings.filter(item => item.expiresAt > now());
        if (state.pairings.length >= 16 || state.devices.filter(d => !d.revokedAt && d.expiresAt > now()).length >= 32 || state.devices.length >= 128) {
          throw deviceError('device_limit', 'Remove expired devices before pairing another.', 409);
        }
        const secret = token(), id = randomUUID(), expiresAt = now() + PAIRING_MS;
        state.pairings.push({ id, hash: digest(secret), expiresAt, grants: scopes, label: cleanLabel });
        return { protocolVersion: DEVICE_PROTOCOL, serverId, pairingId: id, token: secret, expiresAt, grants: scopes.map(publicGrant) };
      });
  }
  return {
    /** Drawing tickets cannot be upgraded by supplying another grant mode. */
    createPairing({ grants, label = 'Tablet' }) {
      if (!Array.isArray(grants) || !grants.length || grants.length > 16) throw deviceError('device_scope_invalid', 'Choose an exact project scope.', 400);
      return pairing(grants.map(grant), label);
    },
    /** Separate, explicit local owner pairing action. */
    createOwnerPairing({ label = 'Owner tablet' } = {}) { return pairing([{ mode: 'owner', serverId }], label); },
    pair({ pairingId, token: secret, protocolVersion }) {
      if (protocolVersion !== DEVICE_PROTOCOL) throw deviceError('device_protocol', 'Update the device client before pairing.', 409);
      if (!validToken(secret) || typeof pairingId !== 'string') throw deviceError('device_pairing_invalid', 'Pairing expired or is invalid.');
      return update(state => {
        const index = state.pairings.findIndex(item => item.id === pairingId);
        const pairing = state.pairings[index];
        if (!pairing || pairing.expiresAt <= now() || !timingSafeEqual(Buffer.from(pairing.hash, 'hex'), Buffer.from(digest(secret), 'hex'))) {
          throw deviceError('device_pairing_invalid', 'Pairing expired or is invalid.');
        }
        if (state.devices.length >= 128) throw deviceError('device_limit', 'Remove expired devices before pairing another.', 409);
        const credential = token();
        const device = { id: randomUUID(), hash: digest(credential), label: pairing.label, grants: pairing.grants.map(value => savedGrant(value, serverId)),
          createdAt: now(), expiresAt: now() + DEVICE_MS, revokedAt: null };
        state.pairings.splice(index, 1);
        state.devices.push(device);
        return { protocolVersion: DEVICE_PROTOCOL, serverId, device: publicDevice(device), token: credential };
      });
    },
    authenticate(secret) {
      if (!validToken(secret)) throw deviceError('device_unauthorized', 'Pair this device from the Mac.');
      const hash = digest(secret);
      const device = read().devices.find(item => typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash)
        && timingSafeEqual(Buffer.from(item.hash, 'hex'), Buffer.from(hash, 'hex')));
      if (!device || device.revokedAt || !(device.expiresAt > now())) throw deviceError('device_unauthorized', 'Pairing expired or was revoked.');
      return { ...publicDevice(device), grants: device.grants.map(value => savedGrant(value, serverId)) };
    },
    list() { return read().devices.map(publicDevice); },
    inspect(id) {
      const device = read().devices.find(item => item.id === id);
      if (!device || device.revokedAt || !(device.expiresAt > now())) throw deviceError('device_unauthorized', 'Pairing expired or was revoked.');
      return { ...publicDevice(device), grants: device.grants.map(value => savedGrant(value, serverId)) };
    },
    revoke(id) {
      return update(state => {
        const device = state.devices.find(item => item.id === id);
        if (!device) throw deviceError('device_unknown', 'Unknown device.', 404);
        device.revokedAt ||= now();
        return publicDevice(device);
      });
    },
    cancelPairing(id) { return update(state => { state.pairings = state.pairings.filter(item => item.id !== id); return { cancelled: true }; }); },
  };
}
