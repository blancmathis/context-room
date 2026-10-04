import assert from "node:assert/strict";
import test from "node:test";

import {
  compareFilesystemIdentity,
  compareFilesystemIdentityWithAliases,
  readFilesystemIdentity,
} from "../src/filesystem_identity.mjs";

const ROOT = "/identity-fixture/project";
const INO = 9007199254740993n;
const BIRTHTIME_NS = 1800000000123456789n;
const identity = { v: 1, provider: "ino-birthtime", ino: INO.toString(), birthtimeNs: BIRTHTIME_NS.toString() };

function stats(overrides = {}) {
  return {
    dev: 16777229n, ino: INO, birthtimeNs: BIRTHTIME_NS,
    isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
    ...overrides,
  };
}

function read(overrides = {}) {
  return readFilesystemIdentity(ROOT, { lstat: () => stats(overrides) });
}

test("filesystem identity reads exact bigint decimals and requests lstat bigint", () => {
  const observed = readFilesystemIdentity(ROOT, { lstat: (filePath, options) => {
    assert.equal(filePath, ROOT);
    assert.deepEqual(options, { bigint: true });
    return stats();
  } });
  assert.deepEqual(observed, { status: "verified", reason: "identity_read", identity });
  assert.deepEqual(JSON.parse(JSON.stringify(observed.identity)), identity);
  assert.deepEqual(read({ isDirectory: () => false, isFile: () => true }).identity, identity);
});

test("filesystem identity survives a device change after serialization", () => {
  const saved = JSON.parse(JSON.stringify(read().identity));
  const remounted = read({ dev: 16777231n }).identity;
  assert.deepEqual(remounted, saved);
  assert.deepEqual(compareFilesystemIdentity(saved, remounted), { status: "same", reason: "identity_matches" });
});

test("filesystem identity refuses replacements with a different inode or creation time", () => {
  assert.deepEqual(compareFilesystemIdentity(identity, read({ ino: INO + 1n }).identity), {
    status: "different", reason: "identity_inode_changed",
  });
  assert.deepEqual(compareFilesystemIdentity(identity, read({ birthtimeNs: BIRTHTIME_NS + 1n }).identity), {
    status: "different", reason: "identity_birthtime_changed",
  });
});

test("filesystem identity refuses symlinks and unsupported filesystem objects", () => {
  assert.deepEqual(read({ isSymbolicLink: () => true }), {
    status: "unverified", reason: "identity_symbolic_link", identity: null,
  });
  assert.deepEqual(read({ isDirectory: () => false }), {
    status: "unverified", reason: "identity_object_unsupported", identity: null,
  });
});

test("filesystem identity never falls back to dev or millisecond creation times", () => {
  for (const birthtimeNs of [undefined, null, 0n, -1n, 42, "42"]) {
    assert.deepEqual(read({ birthtimeNs, birthtimeMs: 1800000000123n, birthtime: new Date() }), {
      status: "unverified", reason: "identity_birthtime_unavailable", identity: null,
    });
  }
  for (const ino of [undefined, 0n, -1n, 42, "42"]) {
    assert.deepEqual(read({ ino }), { status: "unverified", reason: "identity_inode_invalid", identity: null });
  }
  assert.deepEqual(readFilesystemIdentity(ROOT, { lstat: () => ({}) }), {
    status: "unverified", reason: "identity_stat_invalid", identity: null,
  });
});

test("filesystem identity reports missing paths, permissions and other lstat errors", () => {
  for (const [code, reason] of [
    ["ENOENT", "identity_path_missing"], ["ENOTDIR", "identity_path_missing"],
    ["EACCES", "identity_permission_denied"], ["EPERM", "identity_permission_denied"],
    ["EIO", "identity_read_failed"],
  ]) {
    assert.deepEqual(readFilesystemIdentity(ROOT, { lstat: () => { throw Object.assign(new Error("fixture"), { code }); } }), {
      status: "unverified", reason, identity: null,
    });
  }
});

test("filesystem identity fails closed on missing, truncated, mistyped and unknown schemas", () => {
  const invalid = [
    null, undefined, {}, [], "", "16777229:9007199254740993",
    { dev: "16777229", ino: identity.ino },
    { ...identity, v: undefined }, { ...identity, v: "1" }, { ...identity, v: 2 },
    { ...identity, provider: "apfs" }, { ...identity, provider: null },
    { v: 1, provider: "ino-birthtime", ino: identity.ino },
    { ...identity, ino: INO }, { ...identity, birthtimeNs: BIRTHTIME_NS },
    { ...identity, ino: Number(INO) }, { ...identity, birthtimeNs: Number(BIRTHTIME_NS) },
    { ...identity, ino: "0" }, { ...identity, birthtimeNs: "0" },
    { ...identity, ino: " 42" }, { ...identity, birthtimeNs: "1e9" },
    { ...identity, ino: "0042" }, { ...identity, birthtimeNs: "-1" },
    { ...identity, dev: "16777229" }, Object.create(identity),
  ];
  for (const value of invalid) {
    for (const comparison of [compareFilesystemIdentity(value, identity), compareFilesystemIdentity(identity, value)]) {
      assert.equal(comparison.status, "unverified");
      assert.ok(comparison.reason.length > 0);
    }
    assert.equal(compareFilesystemIdentity(value, value).status, "unverified");
  }
  const saved = Object.assign(Object.create(null), identity);
  assert.equal(compareFilesystemIdentity(saved, identity).status, "same");
});

test("filesystem identity reasons distinguish absent, unknown and different evidence", () => {
  assert.equal(compareFilesystemIdentity(null, identity).reason, "expected_identity_missing");
  assert.equal(compareFilesystemIdentity(identity, null).reason, "current_identity_missing");
  assert.equal(compareFilesystemIdentity({ ...identity, v: 2 }, identity).reason, "expected_identity_version_unsupported");
  assert.equal(compareFilesystemIdentity(identity, { ...identity, provider: "unknown" }).reason, "current_identity_provider_unsupported");
});

test("filesystem legacy identity requires an exact alias supplied for this location", () => {
  const legacy = { dev: "16777229", ino: identity.ino };
  const legacyString = `${legacy.dev}:${legacy.ino}`;
  assert.deepEqual(compareFilesystemIdentityWithAliases(legacy, identity), {
    status: "unverified", reason: "legacy_identity_unconfirmed",
  });
  assert.equal(compareFilesystemIdentityWithAliases(legacyString, identity).status, "unverified");
  for (const expected of [legacy, legacyString]) {
    for (const alias of [legacy, legacyString]) {
      assert.deepEqual(compareFilesystemIdentityWithAliases(expected, identity, { aliases: [alias] }), {
        status: "same", reason: "legacy_identity_alias",
      });
    }
    assert.equal(compareFilesystemIdentityWithAliases(expected, identity, { aliases: [
      { ...legacy, dev: "16777231" }, { ...legacy, ino: (INO + 1n).toString() }, identity,
    ] }).status, "unverified");
    assert.equal(compareFilesystemIdentityWithAliases(expected, identity, { aliases: null }).status, "unverified");
  }
  // A match for one location is never remembered for a later comparison.
  assert.equal(compareFilesystemIdentityWithAliases(legacy, identity).status, "unverified");
});

test("filesystem aliases do not admit malformed legacy or durable evidence", () => {
  const legacy = { dev: "16777229", ino: identity.ino };
  const invalid = [
    null, undefined, {}, { dev: 16777229, ino: identity.ino }, { ...legacy, ino: INO },
    { ...legacy, ino: "0" }, { ...legacy, dev: "016777229" }, { ...legacy, v: 2 },
    "16777229", `${legacy.dev}:${legacy.ino}:extra`, ` ${legacy.dev}:${legacy.ino}`,
    { ...identity, v: 2 }, { ...identity, provider: "unknown" }, { ...identity, birthtimeNs: "0" },
  ];
  for (const expected of invalid) {
    assert.equal(compareFilesystemIdentityWithAliases(expected, identity, { aliases: [expected] }).status, "unverified");
  }
  assert.equal(compareFilesystemIdentityWithAliases(legacy, identity, { aliases: invalid }).status, "unverified");
  for (const current of [null, {}, legacy, { ...identity, birthtimeNs: "0" }]) {
    assert.equal(compareFilesystemIdentityWithAliases(legacy, current, { aliases: [legacy] }).status, "unverified");
  }
});

test("filesystem aliases cannot override a changed durable identity or mutate history", () => {
  const legacy = Object.freeze({ dev: "16777229", ino: identity.ino });
  const saved = Object.freeze({ ...identity });
  const aliases = Object.freeze([legacy]);
  const history = JSON.stringify({ saved, aliases });
  assert.equal(compareFilesystemIdentityWithAliases(saved, read({ ino: INO + 1n }).identity, { aliases: [saved] }).status, "different");
  assert.equal(compareFilesystemIdentityWithAliases(saved, read({ birthtimeNs: BIRTHTIME_NS + 1n }).identity, { aliases: [saved] }).status, "different");
  assert.equal(compareFilesystemIdentityWithAliases(saved, identity, { aliases: null }).status, "same");
  assert.equal(compareFilesystemIdentityWithAliases(legacy, identity, { aliases }).status, "same");
  assert.equal(JSON.stringify({ saved, aliases }), history);
});
