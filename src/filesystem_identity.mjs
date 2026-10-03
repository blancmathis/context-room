import fs from "node:fs";

const VERSION = 1;
const PROVIDER = "ino-birthtime";
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;

function isRecord(value) {
  return value !== null && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value, keys) {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isDecimal(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function validationReason(identity) {
  if (identity === null || identity === undefined) return "identity_missing";
  if (!isRecord(identity)) return "identity_schema_invalid";
  if (!hasExactKeys(identity, ["v", "provider", "ino", "birthtimeNs"])) return "identity_schema_invalid";
  if (identity.v !== VERSION) return "identity_version_unsupported";
  if (identity.provider !== PROVIDER) return "identity_provider_unsupported";
  if (!isDecimal(identity.ino, POSITIVE_DECIMAL)) return "identity_inode_invalid";
  if (!isDecimal(identity.birthtimeNs, POSITIVE_DECIMAL)) return "identity_birthtime_invalid";
  return "";
}

function result(status, reason) {
  return { status, reason };
}

function unreadable(reason) {
  return { ...result("unverified", reason), identity: null };
}

// This fingerprint does not prove canonical location, volume or Git membership.
// Callers must retain those checks and their live dev/ino race guards.
export function readFilesystemIdentity(filePath, { lstat = fs.lstatSync } = {}) {
  let stats;
  try {
    stats = lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return unreadable("identity_path_missing");
    if (error?.code === "EACCES" || error?.code === "EPERM") return unreadable("identity_permission_denied");
    return unreadable("identity_read_failed");
  }
  if (!stats || typeof stats.isSymbolicLink !== "function"
    || typeof stats.isDirectory !== "function" || typeof stats.isFile !== "function") {
    return unreadable("identity_stat_invalid");
  }
  if (stats.isSymbolicLink()) return unreadable("identity_symbolic_link");
  if (!stats.isDirectory() && !stats.isFile()) return unreadable("identity_object_unsupported");
  if (typeof stats.ino !== "bigint" || stats.ino <= 0n) return unreadable("identity_inode_invalid");
  if (typeof stats.birthtimeNs !== "bigint" || stats.birthtimeNs <= 0n) return unreadable("identity_birthtime_unavailable");
  return {
    ...result("verified", "identity_read"),
    identity: { v: VERSION, provider: PROVIDER, ino: stats.ino.toString(), birthtimeNs: stats.birthtimeNs.toString() },
  };
}

// Compare serialized identities, not reader result envelopes. Missing evidence
// always requires confirmation; it is never treated as an absent constraint.
export function compareFilesystemIdentity(expected, current) {
  const expectedReason = validationReason(expected);
  if (expectedReason) return result("unverified", `expected_${expectedReason}`);
  const currentReason = validationReason(current);
  if (currentReason) return result("unverified", `current_${currentReason}`);
  if (expected.ino !== current.ino) return result("different", "identity_inode_changed");
  if (expected.birthtimeNs !== current.birthtimeNs) return result("different", "identity_birthtime_changed");
  return result("same", "identity_matches");
}

function legacyIdentity(value) {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length !== 2) return null;
    const [dev, ino] = parts;
    return isDecimal(dev, NONNEGATIVE_DECIMAL) && isDecimal(ino, POSITIVE_DECIMAL) ? { dev, ino } : null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["dev", "ino"])) return null;
  return isDecimal(value.dev, NONNEGATIVE_DECIMAL) && isDecimal(value.ino, POSITIVE_DECIMAL)
    ? { dev: value.dev, ino: value.ino } : null;
}

// Aliases are explicit enrollment evidence supplied by the caller for this exact
// location, after verifying its current durable identity. This function never
// discovers aliases, migrates records or grants review/device authority.
export function compareFilesystemIdentityWithAliases(expected, current, { aliases = [] } = {}) {
  const currentReason = validationReason(current);
  if (currentReason) return result("unverified", `current_${currentReason}`);
  const legacy = legacyIdentity(expected);
  if (!legacy) return compareFilesystemIdentity(expected, current);
  if (!Array.isArray(aliases)) return result("unverified", "identity_aliases_invalid");
  const confirmed = aliases.some((value) => {
    const alias = legacyIdentity(value);
    return alias && alias.dev === legacy.dev && alias.ino === legacy.ino;
  });
  return confirmed ? result("same", "legacy_identity_alias") : result("unverified", "legacy_identity_unconfirmed");
}
