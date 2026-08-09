import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withFilesystemLock } from "../src/filesystem_lock.mjs";

import {
  MAX_CONTEXT_TEXT_BYTES,
  applyTextPatch,
  assertAgentOperation,
  assertContextProjectPath,
  preflightTextPatch,
  validateTextPatch,
} from "../src/qm_gateway.mjs";

const agent = {
  kind: "agent",
  projectId: "hicharlie",
  operations: ["accepted:read", "proposal:list", "proposal:write", "proposal:publish"],
};

test("agent gateway keeps every request in its QM project and allowed operations", () => {
  assert.equal(assertAgentOperation(agent, "accepted:read", "hicharlie").projectId, "hicharlie");
  assert.throws(() => assertAgentOperation(agent, "accepted:read", "peerlab"), (error) => error.code === "agent_project_scope_denied");
  assert.throws(() => assertAgentOperation(agent, "proposal:accept", "hicharlie"), (error) => error.code === "agent_operation_denied");
});

test("agent gateway accepts only project docs and skills text paths", () => {
  assert.equal(assertContextProjectPath("hicharlie", "projects/hicharlie/docs/PRODUCT.md"), "projects/hicharlie/docs/PRODUCT.md");
  assert.equal(assertContextProjectPath("hicharlie", "projects/hicharlie/skills/release/SKILL.md"), "projects/hicharlie/skills/release/SKILL.md");
  for (const value of [
    "projects/peerlab/docs/README.md",
    "projects/hicharlie/../peerlab/docs/README.md",
    "/etc/passwd",
    "projects/hicharlie/assets/logo.png",
  ]) {
    assert.throws(() => assertContextProjectPath("hicharlie", value), (error) => error.code === "agent_path_denied");
  }
});

test("agent gateway rejects binary, oversized, symlink, gitlink, and stale patch inputs", () => {
  const valid = validateTextPatch({
    path: "projects/hicharlie/docs/PRODUCT.md",
    content: "# Product\n",
    expectedContentHash: "a".repeat(64),
    expectedProposalHead: "b".repeat(40),
    entryType: "file",
  }, { projectId: "hicharlie" });
  assert.equal(valid.content, "# Product\n");

  const invalid = [
    { ...valid, content: "bad\0binary" },
    { ...valid, content: "x".repeat(750_001) },
    { ...valid, entryType: "symlink" },
    { ...valid, entryType: "gitlink" },
    { ...valid, expectedContentHash: "" },
    { ...valid, expectedProposalHead: "" },
  ];
  for (const input of invalid) assert.throws(() => validateTextPatch(input, { projectId: "hicharlie" }));
});

test("agent patch preflight bounds an existing leaf before reading its bytes", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-preflight-size-"));
  const root = path.join(base, "proposal");
  const target = path.join(root, "projects/hicharlie/docs/OVERSIZED.md");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = Buffer.alloc(MAX_CONTEXT_TEXT_BYTES + 1, 0x78);
  fs.writeFileSync(target, bytes);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "projects/hicharlie/docs/OVERSIZED.md"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "-qm", "base",
  ], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const before = fs.lstatSync(target, { bigint: true });
  const originalReadFileSync = fs.readFileSync;
  let targetReadAttempts = 0;
  fs.readFileSync = function guardedRead(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(target)) {
      targetReadAttempts += 1;
      throw new Error("preflight attempted an unbounded parent-process read");
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(
      () => preflightTextPatch({ root }, {
        path: "projects/hicharlie/docs/OVERSIZED.md",
        content: "# Replacement\n",
        expectedContentHash: createHash("sha256").update(bytes).digest("hex"),
        expectedProposalHead: head,
        entryType: "file",
      }, { projectId: "hicharlie" }),
      (error) => error.statusCode === 413 && error.code === "agent_file_too_large",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  const after = fs.lstatSync(target, { bigint: true });
  assert.equal(targetReadAttempts, 0);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, size: after.size, mode: after.mode },
    { dev: before.dev, ino: before.ino, size: before.size, mode: before.mode },
  );
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test("agent patch preflight never follows a leaf swapped to an external symlink", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-preflight-leaf-race-"));
  const root = path.join(base, "proposal");
  const target = path.join(root, "projects/hicharlie/docs/PRODUCT.md");
  const outside = path.join(base, "outside-sentinel.md");
  const swapMarker = path.join(base, "swap-observed.txt");
  const readMarker = path.join(base, "read-observed.txt");
  const preload = path.join(base, "preload-leaf-race.cjs");
  const originalBytes = Buffer.from("# Original\n");
  const sentinelBytes = Buffer.from("private external sentinel\n");
  const previousNodeOptions = process.env.NODE_OPTIONS;
  t.after(() => {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    delete process.env.CONTEXT_ROOM_TEST_RACE_TARGET;
    delete process.env.CONTEXT_ROOM_TEST_RACE_SENTINEL;
    delete process.env.CONTEXT_ROOM_TEST_RACE_SWAP_MARKER;
    delete process.env.CONTEXT_ROOM_TEST_RACE_READ_MARKER;
    fs.rmSync(base, { recursive: true, force: true });
  });

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, originalBytes);
  fs.writeFileSync(outside, sentinelBytes, { mode: 0o640 });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "projects/hicharlie/docs/PRODUCT.md"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "-qm", "base",
  ], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const path = require("node:path");
const target = fs.realpathSync(path.resolve(process.env.CONTEXT_ROOM_TEST_RACE_TARGET || ""));
const sentinel = path.resolve(process.env.CONTEXT_ROOM_TEST_RACE_SENTINEL || "");
const swapMarker = process.env.CONTEXT_ROOM_TEST_RACE_SWAP_MARKER || "";
const readMarker = process.env.CONTEXT_ROOM_TEST_RACE_READ_MARKER || "";
const originalLstatSync = fs.lstatSync;
const originalReadSync = fs.readSync;
let swapped = false;
fs.lstatSync = function racedLstat(value, ...args) {
  const stats = originalLstatSync.call(this, value, ...args);
  if (!swapped && path.resolve(String(value)) === target && stats.isFile()) {
    fs.unlinkSync(target);
    fs.symlinkSync(sentinel, target);
    fs.appendFileSync(swapMarker, "swapped\n");
    swapped = true;
  }
  return stats;
};
fs.readSync = function observedRead(...args) {
  if (swapped) fs.appendFileSync(readMarker, "read\n");
  return originalReadSync.apply(this, args);
};
`, "utf8");
  process.env.CONTEXT_ROOM_TEST_RACE_TARGET = target;
  process.env.CONTEXT_ROOM_TEST_RACE_SENTINEL = outside;
  process.env.CONTEXT_ROOM_TEST_RACE_SWAP_MARKER = swapMarker;
  process.env.CONTEXT_ROOM_TEST_RACE_READ_MARKER = readMarker;
  process.env.NODE_OPTIONS = [previousNodeOptions, `--require=${preload}`].filter(Boolean).join(" ");

  let preflightError = null;
  try {
    preflightTextPatch({ root }, {
      path: "projects/hicharlie/docs/PRODUCT.md",
      content: "# Replacement\n",
      expectedContentHash: createHash("sha256").update(originalBytes).digest("hex"),
      expectedProposalHead: head,
      entryType: "file",
    }, { projectId: "hicharlie" });
  } catch (error) {
    preflightError = error;
  }
  assert.equal(fs.existsSync(swapMarker), true, "the anchored child must execute the deterministic post-lstat swap probe");
  assert.equal(preflightError?.statusCode, 403);
  assert.equal(preflightError?.code, "agent_path_denied");
  assert.equal(fs.readFileSync(swapMarker, "utf8"), "swapped\n");
  assert.equal(fs.existsSync(readMarker), false, "the swapped external leaf must be rejected before any content read");
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(outside), sentinelBytes);
});

test("agent patch preflight and write reject a hard-linked external file without changing its inode", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-hardlink-"));
  const root = path.join(base, "proposal");
  const target = path.join(root, "projects/hicharlie/docs/PRODUCT.md");
  const outside = path.join(base, "outside-sentinel.md");
  const sentinelBytes = Buffer.from("private external sentinel\n");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(outside, sentinelBytes, { mode: 0o640 });
  fs.linkSync(outside, target);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "projects/hicharlie/docs/PRODUCT.md"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "-qm", "base",
  ], { cwd: root });

  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const expectedContentHash = createHash("sha256").update(sentinelBytes).digest("hex");
  const input = {
    path: "projects/hicharlie/docs/PRODUCT.md",
    content: "must not overwrite the external inode\n",
    expectedContentHash,
    expectedProposalHead: head,
    entryType: "file",
  };
  const before = fs.lstatSync(outside, { bigint: true });
  assert.equal(before.nlink, 2n);

  for (const operation of [preflightTextPatch, applyTextPatch]) {
    assert.throws(
      () => operation({ root }, input, { projectId: "hicharlie" }),
      (error) => error.statusCode === 400 && error.code === "agent_entry_type_denied",
    );
    const after = fs.lstatSync(outside, { bigint: true });
    assert.deepEqual(fs.readFileSync(outside), sentinelBytes);
    assert.deepEqual(
      { dev: after.dev, ino: after.ino, nlink: after.nlink, mode: after.mode, size: after.size },
      { dev: before.dev, ino: before.ino, nlink: before.nlink, mode: before.mode, size: before.size },
    );
    assert.deepEqual(fs.readFileSync(target), sentinelBytes);
  }
});

test("agent patch install failure preserves the complete original file", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-atomic-failure-"));
  const root = path.join(base, "proposal");
  const target = path.join(root, "projects/hicharlie/docs/PRODUCT.md");
  const preload = path.join(base, "preload-install-failure.cjs");
  const originalBytes = Buffer.from("# Complete original\n");
  const previousNodeOptions = process.env.NODE_OPTIONS;
  t.after(() => {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    fs.rmSync(base, { recursive: true, force: true });
  });

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, originalBytes, { mode: 0o640 });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "projects/hicharlie/docs/PRODUCT.md"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "-qm", "base",
  ], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const before = fs.lstatSync(target, { bigint: true });
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const originalWriteSync = fs.writeSync;
let failed = false;
fs.writeSync = function failReplacementWrite(fd, buffer, offset, length, position) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  if (!failed && bytes.toString("utf8").includes("Partial replacement must never appear")) {
    failed = true;
    if (Number(length) > 0) originalWriteSync.call(this, fd, buffer, offset, Math.min(3, Number(length)), position);
    const error = new Error("injected replacement write failure");
    error.code = "EIO";
    throw error;
  }
  return originalWriteSync.apply(this, arguments);
};
`, "utf8");
  process.env.NODE_OPTIONS = [previousNodeOptions, `--require=${preload}`].filter(Boolean).join(" ");

  assert.throws(() => applyTextPatch({ root }, {
    path: "projects/hicharlie/docs/PRODUCT.md",
    content: "# Partial replacement must never appear\n",
    expectedContentHash: createHash("sha256").update(originalBytes).digest("hex"),
    expectedProposalHead: head,
  }, { projectId: "hicharlie" }));

  const after = fs.lstatSync(target, { bigint: true });
  assert.deepEqual(fs.readFileSync(target), originalBytes);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, mode: after.mode, size: after.size },
    { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size },
  );
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((name) => name.startsWith(".context-room-agent-patch-")),
    false,
  );
});

test("agent patches share the proposal registry lock used by publication", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-publish-lock-"));
  const cacheRoot = path.join(base, "repository-cache");
  const branch = "proposal/hicharlie/lock-proof";
  const workspaceName = createHash("sha256").update(branch).digest("hex").slice(0, 16);
  const root = path.join(cacheRoot, "proposals", workspaceName);
  const target = path.join(root, "projects/hicharlie/docs/PRODUCT.md");
  const lockPath = path.join(cacheRoot, "proposals.json.lock");
  const original = "# Before lock\n";
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, original);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "projects/hicharlie/docs/PRODUCT.md"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "-qm", "base",
  ], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  withFilesystemLock(lockPath, () => {
    assert.throws(() => applyTextPatch({ root, branch }, {
      path: "projects/hicharlie/docs/PRODUCT.md",
      content: "# Must wait for publication\n",
      expectedContentHash: createHash("sha256").update(original).digest("hex"),
      expectedProposalHead: head,
    }, { projectId: "hicharlie", lockTimeoutMs: 50 }), (error) => error.code === "agent_patch_busy");
  });

  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("agent patches reject symlinked parents without touching outside files", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-parent-link-"));
  const root = path.join(base, "proposal");
  const outside = path.join(base, "outside");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, "projects/hicharlie/docs"), { recursive: true });
  fs.mkdirSync(outside);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "--allow-empty", "-qm", "base",
  ], { cwd: root });

  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const sentinel = path.join(outside, "sentinel.md");
  const missing = path.join(outside, "created.md");
  const sentinelBytes = Buffer.from("private sentinel\n");
  fs.writeFileSync(sentinel, sentinelBytes, { mode: 0o640 });
  fs.symlinkSync(outside, path.join(root, "projects/hicharlie/docs/escape"), "dir");

  const before = fs.lstatSync(sentinel, { bigint: true });
  const assertDenied = (input) => assert.throws(
    () => applyTextPatch({ root }, input, { projectId: "hicharlie" }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "agent_path_denied");
      return true;
    },
  );

  assertDenied({
    path: "projects/hicharlie/docs/escape/sentinel.md",
    content: "overwritten\n",
    expectedContentHash: hash(sentinelBytes),
    expectedProposalHead: head,
    entryType: "file",
  });
  assertDenied({
    path: "projects/hicharlie/docs/escape/created.md",
    content: "created\n",
    expectedContentHash: hash(Buffer.alloc(0)),
    expectedProposalHead: head,
    entryType: "file",
  });

  const after = fs.lstatSync(sentinel, { bigint: true });
  assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, mode: after.mode },
    { dev: before.dev, ino: before.ino, mode: before.mode },
  );
  assert.equal(fs.existsSync(missing), false);
});

test("agent patches atomically replace regular files and create only anchored parents", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-qm-anchored-patch-"));
  const root = path.join(base, "proposal");
  const existing = path.join(root, "projects/hicharlie/docs/PRODUCT.md");
  const trackedLink = path.join(root, "projects/hicharlie/skills/deep/link.md");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "# Before\n", { mode: 0o750 });
  fs.chmodSync(existing, 0o750);
  fs.mkdirSync(path.dirname(trackedLink), { recursive: true });
  fs.symlinkSync("../target.md", trackedLink);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "projects/hicharlie/docs/PRODUCT.md", "projects/hicharlie/skills/deep/link.md"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=QM Test",
    "-c", "user.email=qm@example.test",
    "commit", "-qm", "base",
  ], { cwd: root });

  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const specialParent = path.join(root, "projects/hicharlie/skills");
  fs.rmSync(specialParent, { recursive: true, force: true });
  assert.throws(
    () => applyTextPatch({ root }, {
      path: "projects/hicharlie/skills/deep/link.md",
      content: "must not replace a tracked link\n",
      expectedContentHash: hash(Buffer.alloc(0)),
      expectedProposalHead: head,
    }, { projectId: "hicharlie" }),
    (error) => error.statusCode === 400 && error.code === "agent_entry_type_denied",
  );
  assert.equal(fs.existsSync(specialParent), false);

  const before = fs.lstatSync(existing, { bigint: true });
  const changed = applyTextPatch({ root }, {
    path: "projects/hicharlie/docs/PRODUCT.md",
    content: "# After\n",
    expectedContentHash: hash("# Before\n"),
    expectedProposalHead: head,
  }, { projectId: "hicharlie" });
  const after = fs.lstatSync(existing, { bigint: true });
  assert.equal(fs.readFileSync(existing, "utf8"), "# After\n");
  assert.equal(changed.contentHash, hash("# After\n"));
  assert.deepEqual({ dev: after.dev, mode: after.mode }, { dev: before.dev, mode: before.mode });
  assert.notEqual(after.ino, before.ino, "an existing proposal file should be installed by atomic replacement");
  assert.throws(
    () => applyTextPatch({ root }, {
      path: "projects/hicharlie/docs/PRODUCT.md",
      content: "# Stale overwrite\n",
      expectedContentHash: hash("# Before\n"),
      expectedProposalHead: head,
    }, { projectId: "hicharlie" }),
    (error) => (
      error.statusCode === 409
      && error.code === "agent_file_stale"
      && error.details?.currentContentHash === hash("# After\n")
    ),
  );
  const afterStale = fs.lstatSync(existing, { bigint: true });
  assert.equal(fs.readFileSync(existing, "utf8"), "# After\n");
  assert.deepEqual(
    { dev: afterStale.dev, ino: afterStale.ino, mode: afterStale.mode },
    { dev: after.dev, ino: after.ino, mode: after.mode },
  );

  const staleContentParent = path.join(root, "projects/hicharlie/docs/new-parent");
  assert.throws(
    () => applyTextPatch({ root }, {
      path: "projects/hicharlie/docs/new-parent/FILE.md",
      content: "# Must not be created\n",
      expectedContentHash: hash("stale non-empty content\n"),
      expectedProposalHead: head,
    }, { projectId: "hicharlie" }),
    (error) => (
      error.statusCode === 409
      && error.code === "agent_file_stale"
      && error.details?.currentContentHash === hash(Buffer.alloc(0))
    ),
  );
  assert.equal(fs.existsSync(staleContentParent), false);

  const nested = path.join(root, "projects/hicharlie/skills/release/SKILL.md");
  applyTextPatch({ root }, {
    path: "projects/hicharlie/skills/release/SKILL.md",
    content: "# Release\n",
    expectedContentHash: hash(Buffer.alloc(0)),
    expectedProposalHead: head,
  }, { projectId: "hicharlie" });
  assert.equal(fs.readFileSync(nested, "utf8"), "# Release\n");
  assert.equal(fs.lstatSync(nested).isFile(), true);

  const staleParent = path.join(root, "projects/hicharlie/skills/stale");
  assert.throws(
    () => applyTextPatch({ root }, {
      path: "projects/hicharlie/skills/stale/SKILL.md",
      content: "# Stale\n",
      expectedContentHash: hash(Buffer.alloc(0)),
      expectedProposalHead: "a".repeat(40),
    }, { projectId: "hicharlie" }),
    (error) => error.code === "agent_proposal_stale",
  );
  assert.equal(fs.existsSync(staleParent), false);

  const linkedRoot = path.join(base, "linked-proposal");
  fs.symlinkSync(root, linkedRoot, "dir");
  assert.throws(
    () => applyTextPatch({ root: linkedRoot }, {
      path: "projects/hicharlie/docs/PRODUCT.md",
      content: "# Via link\n",
      expectedContentHash: hash("# After\n"),
      expectedProposalHead: head,
    }, { projectId: "hicharlie" }),
    (error) => error.statusCode === 403 && error.code === "agent_path_denied",
  );
  assert.equal(fs.readFileSync(existing, "utf8"), "# After\n");

  const linkedAncestor = path.join(base, "linked-ancestor");
  fs.symlinkSync(base, linkedAncestor, "dir");
  assert.throws(
    () => applyTextPatch({ root: path.join(linkedAncestor, "proposal") }, {
      path: "projects/hicharlie/docs/PRODUCT.md",
      content: "# Via ancestor link\n",
      expectedContentHash: hash("# After\n"),
      expectedProposalHead: head,
    }, { projectId: "hicharlie" }),
    (error) => error.statusCode === 403 && error.code === "agent_path_denied",
  );
  const afterLinkedAncestor = fs.lstatSync(existing, { bigint: true });
  assert.equal(fs.readFileSync(existing, "utf8"), "# After\n");
  assert.deepEqual(
    { dev: afterLinkedAncestor.dev, ino: afterLinkedAncestor.ino, mode: afterLinkedAncestor.mode },
    { dev: afterStale.dev, ino: afterStale.ino, mode: afterStale.mode },
  );
});
