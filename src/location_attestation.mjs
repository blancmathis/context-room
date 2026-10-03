import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFilesystemIdentity, compareFilesystemIdentity } from "./filesystem_identity.mjs";
import { withFilesystemLock } from "./filesystem_lock.mjs";
import { ensureAuthorityKey } from "./review_authority.mjs";

const LEGACY = /^(?:0|[1-9]\d*):[1-9]\d*$/;
const MAX_ALIASES = 1024;
const MAX_BYTES = 128 * 1024;
const fault = message => Object.assign(new Error(message), { code: "location_attestation_conflict", statusCode: 409 });
const validAliases = aliases => Array.isArray(aliases)
  && aliases.every(alias => typeof alias === "string" && LEGACY.test(alias));
// Use the review authority's canonical serialization and existing private key.
function stable(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
const signature = (key, payload) => createHmac("sha256", key).update(JSON.stringify(stable(payload))).digest("hex");
function pathsFor(root, { authorityHome } = {}) {
  const configured = path.resolve(authorityHome || process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME
    || (process.env.CONTEXT_ROOM_HUB_HOME && path.join(process.env.CONTEXT_ROOM_HUB_HOME, "review-authority"))
    || path.join(os.homedir(), ".context-room", "hub", "review-authority"));
  // Canonicalize existing parents (macOS /var, for example), while leaving the
  // authority directory itself subject to the private, non-link check below.
  let parent = path.dirname(configured);
  const missing = [path.basename(configured)];
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
    missing.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  const base = path.join(fs.realpathSync(parent), ...missing);
  const id = createHash("sha256").update(root).digest("hex");
  return { base, key: path.join(base, "authority.key"), state: path.join(base, `location-${id}.json`) };
}
function snapshotRoot(root) {
  if (typeof root !== "string" || path.resolve(root) !== root) throw fault("Use an exact absolute location.");
  const before = fs.lstatSync(root);
  if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(root) !== root) throw fault("The exact location is unavailable.");
  const durable = readFilesystemIdentity(root);
  const after = fs.lstatSync(root);
  if (before.dev !== after.dev || before.ino !== after.ino) throw fault("The location changed during observation.");
  return { legacy: `${before.dev}:${before.ino}`, durable: durable.identity };
}
function assertRoot(root, expected) {
  const current = snapshotRoot(root);
  if (current.legacy !== expected.legacy || compareFilesystemIdentity(expected.durable, current.durable).status !== "same") {
    throw fault("The location changed before attestation publication.");
  }
}
function assertObserved(root, expected) {
  const current = snapshotRoot(root);
  if (current.legacy !== expected.legacy || JSON.stringify(current.durable) !== JSON.stringify(expected.durable)) {
    throw fault("The location changed during attestation lookup.");
  }
}
function privateDirectory(base) {
  const stat = fs.lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(base) !== base
    || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw fault("Location attestations require a private directory owned by this account.");
  }
  return `${stat.dev}:${stat.ino}`;
}
function readPrivate(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)
      || (before.mode & 0o077n) || (process.getuid && before.uid !== BigInt(process.getuid()))) throw fault("Unsafe attestation file.");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), visible = fs.lstatSync(file, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || after.dev !== visible.dev || after.ino !== visible.ino || visible.isSymbolicLink()
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw fault("Attestation changed during reading.");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readAttestation(root, paths) {
  try {
    privateDirectory(paths.base);
    const key = readPrivate(paths.key, 32);
    if (key.length !== 32) return null;
    const record = JSON.parse(readPrivate(paths.state, MAX_BYTES).toString("utf8"));
    if (!record || record.v !== 1 || record.path !== root || typeof record.updatedAt !== "string"
      || !Number.isFinite(Date.parse(record.updatedAt))
      || !validAliases(record.aliases?.observed) || !validAliases(record.aliases?.confirmed)
      || !record.aliases.observed.length || record.aliases.observed.length + record.aliases.confirmed.length > MAX_ALIASES
      || compareFilesystemIdentity(record.durable, record.durable).status !== "same"
      || typeof record.signature !== "string" || !/^[a-f0-9]{64}$/.test(record.signature)) return null;
    const { signature: signed, ...payload } = record;
    return timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(key, payload), "hex")) ? record : null;
  } catch { return null; }
}
function syncDirectory(base) {
  const fd = fs.openSync(base, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function publish(file, bytes, beforePublish) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    beforePublish();
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function writeAttestation(root, paths, observed, key, previous, aliases) {
  if (previous) {
    const { signature: signed, ...payload } = previous;
    if (signed !== signature(key, payload)) throw fault("The authority key changed during attestation lookup.");
  }
  const seen = new Set(aliases.observed);
  aliases = { observed: [...seen].sort(), confirmed: [...new Set(aliases.confirmed)].filter(alias => !seen.has(alias)).sort() };
  if (aliases.observed.length + aliases.confirmed.length > MAX_ALIASES) throw fault("Too many legacy identities for this location.");
  if (previous && JSON.stringify(previous.aliases) === JSON.stringify(aliases)) return previous;
  const directory = privateDirectory(paths.base);
  const payload = { v: 1, path: root, durable: observed.durable, aliases, updatedAt: new Date().toISOString() };
  const record = { ...payload, signature: signature(key, payload) };
  publish(paths.state, JSON.stringify(record, null, 2) + "\n", () => {
    assertRoot(root, observed);
    if (privateDirectory(paths.base) !== directory || !readPrivate(paths.key, 32).equals(key)) throw fault("The authority directory or key changed.");
  });
  return record;
}

/** Explicit enrollment only. Replacing durable evidence requires replace:true and abandons its aliases. */
export function attestLocation(root, { legacy = [], replace = false, ...options } = {}) {
  const observed = snapshotRoot(root);
  if (!observed.durable) throw fault("The durable location identity cannot be verified.");
  const aliases = typeof legacy === "string" ? [legacy] : legacy;
  if (!validAliases(aliases)) throw fault("Invalid legacy location identities.");
  const paths = pathsFor(root, options);
  if (paths.base === root || paths.base.startsWith(root + path.sep)) throw fault("Keep location attestations outside the project.");
  fs.mkdirSync(paths.base, { recursive: true, mode: 0o700 });
  privateDirectory(paths.base);
  const key = withFilesystemLock(`${paths.key}.lock`, () => {
    const directory = privateDirectory(paths.base);
    // Retain the attestation reader's no-link checks before the shared helper touches an existing key.
    try { readPrivate(paths.key, 32); } catch (error) { if (error.code !== "ENOENT") throw error; }
    ensureAuthorityKey(paths);
    if (privateDirectory(paths.base) !== directory) throw fault("The authority directory changed.");
    return readPrivate(paths.key, 32);
  });
  if (key.length !== 32) throw fault("Invalid review authority key.");
  return withFilesystemLock(`${paths.state}.lock`, () => {
    assertRoot(root, observed);
    let previous = readAttestation(root, paths);
    if (previous && compareFilesystemIdentity(previous.durable, observed.durable).status !== "same") {
      if (replace !== true) throw fault("The attested location was replaced.");
      previous = null;
    }
    return writeAttestation(root, paths, observed, key, previous, {
      observed: [...(previous?.aliases.observed || []), observed.legacy],
      confirmed: [...(previous?.aliases.confirmed || []), ...aliases],
    });
  });
}

/** Records a new mount identity only when a signed, matching enrollment already exists. Never creates one. */
export function observeLocation(root, options = {}) {
  let observed;
  try { observed = snapshotRoot(root); } catch { return { status: "unverified", added: false }; }
  const paths = pathsFor(root, options);
  const initial = readAttestation(root, paths);
  if (!initial) return { status: "unverified", added: false };
  const status = compareFilesystemIdentity(initial.durable, observed.durable).status;
  if (status !== "same") return { status, added: false };
  return withFilesystemLock(`${paths.state}.lock`, () => {
    assertRoot(root, observed);
    const previous = readAttestation(root, paths);
    if (!previous) return { status: "unverified", added: false };
    const status = compareFilesystemIdentity(previous.durable, observed.durable).status;
    if (status !== "same") return { status, added: false };
    const key = readPrivate(paths.key, 32), added = !previous.aliases.observed.includes(observed.legacy);
    writeAttestation(root, paths, observed, key, previous, {
      observed: [...previous.aliases.observed, observed.legacy], confirmed: previous.aliases.confirmed,
    });
    return { status: "same", added };
  });
}

/** Pure lookup for derived fingerprints. Readers never record observed identities. */
export function rootIdentityAliases(root, options = {}) {
  try {
    const observed = snapshotRoot(root), record = readAttestation(root, pathsFor(root, options));
    assertObserved(root, observed);
    const aliases = record && compareFilesystemIdentity(record.durable, observed.durable).status === "same"
      ? [...record.aliases.observed, ...record.aliases.confirmed] : [];
    return [...new Set([observed.legacy, ...aliases])];
  } catch { return []; }
}

/** Strict current dev:ino wins; alias requires observed continuity, confirmed is human-supplied history. */
export function acceptsRootIdentity(root, stored, options = {}) {
  if (typeof stored !== "string" || !LEGACY.test(stored)) return "unverified";
  try {
    const observed = snapshotRoot(root);
    if (stored === observed.legacy) return "same";
    const record = readAttestation(root, pathsFor(root, options));
    assertObserved(root, observed);
    const continuity = record && compareFilesystemIdentity(record.durable, observed.durable).status;
    if (continuity === "same" && record.aliases.observed.includes(stored)) return "alias";
    if (continuity === "same" && record.aliases.confirmed.includes(stored)) return "confirmed";
    return continuity === "unverified" ? "unverified" : "different";
  } catch { return "unverified"; }
}
