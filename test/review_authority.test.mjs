import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY,
  authorizeOwnerReviewScope,
  authorizeOwnerTrustedState,
  effectiveOwnerReviewScope,
  inspectOwnerProposalDecisions,
  inspectOwnerReviewScope,
  inspectOwnerTrustedState,
  recordOwnerProposalDecision,
} from "../src/review_authority.mjs";
import * as reviewAuthorityModule from "../src/review_authority.mjs";

function terminalChallengeStore(options) {
  assert.equal(
    typeof reviewAuthorityModule.createTerminalDecisionChallengeStore,
    "function",
    "review authority must expose an in-memory one-shot terminal decision challenge store",
  );
  return reviewAuthorityModule.createTerminalDecisionChallengeStore(options);
}

function verifiedAcceptanceFlashStore(options) {
  assert.equal(
    typeof reviewAuthorityModule.createVerifiedAcceptanceFlashStore,
    "function",
    "review authority must expose an in-memory one-shot verified acceptance flash store",
  );
  return reviewAuthorityModule.createVerifiedAcceptanceFlashStore(options);
}

test("verified acceptance flashes are allowlisted, opaque, expiring, and one-shot", () => {
  let now = Date.parse("2026-08-07T10:00:00.000Z");
  const store = verifiedAcceptanceFlashStore({ now: () => now, ttlMs: 1_000 });
  const issued = store.issue({
    outcome: "merge",
    commit: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    hubRefresh: { status: "complete", error: "must not escape" },
    title: "must not escape",
  });

  assert.match(issued.token, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(store.consume(issued.token), {
    outcome: "merge",
    commit: "abcdef0123456789abcdef0123456789abcdef01",
    hubRefresh: { status: "complete" },
  });
  assert.throws(
    () => store.consume(issued.token),
    (error) => error?.code === "verified_acceptance_flash_invalid" && error?.statusCode === 404,
  );

  const rejected = store.issue({
    outcome: "reject",
    rejectionBranch: "rejected/demo/one-shot-0123456789ab",
    hubRefresh: { status: "pending", error: "must not escape" },
    commit: "must not escape",
    title: "must not escape",
  });
  assert.deepEqual(store.consume(rejected.token), {
    outcome: "reject",
    rejectionBranch: "rejected/demo/one-shot-0123456789ab",
    hubRefresh: { status: "pending" },
  });

  const customRejected = store.issue({
    outcome: "reject",
    rejectionBranch: "denied/demo/custom-prefix-0123456789ab",
    hubRefresh: { status: "complete" },
  });
  assert.deepEqual(store.consume(customRejected.token), {
    outcome: "reject",
    rejectionBranch: "denied/demo/custom-prefix-0123456789ab",
    hubRefresh: { status: "complete" },
  });

  const expiring = store.issue({
    outcome: "merge",
    commit: "0123456789abcdef0123456789abcdef01234567",
    hubRefresh: "pending",
  });
  now += 1_000;
  assert.throws(
    () => store.consume(expiring.token),
    (error) => error?.code === "verified_acceptance_flash_invalid" && error?.statusCode === 404,
  );
  assert.throws(
    () => store.issue({ outcome: "merge", commit: "not-a-commit", hubRefresh: "complete" }),
    (error) => error?.code === "verified_acceptance_flash_payload_invalid" && error?.statusCode === 400,
  );
  assert.throws(
    () => store.issue({ outcome: "reject", rejectionBranch: "rejected/demo/../escape", hubRefresh: "complete" }),
    (error) => error?.code === "verified_acceptance_flash_payload_invalid" && error?.statusCode === 400,
  );
});

test("agent review authority reserves double confirmation for batch and terminal proposal decisions", () => {
  assert.equal(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.confirmationsRequired, 2);
  assert.deepEqual(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.appliesTo, ["multi-file-batch", "proposal-terminal"]);
  assert.equal(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.singleFileDecision, "direct-human-ui");
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /batch/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /proposal/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /after the first yes/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /restate the exact action, project, proposal or file scope, and effects/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /second separate, unambiguous yes/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.mutationRule, /do nothing/i);
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-review-authority-"));
  const root = path.join(base, "project");
  const home = path.join(base, "authority");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n");
  fs.writeFileSync(path.join(root, "docs", "INDEX.md"), "# Index\n");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, home };
}

function stableSignedValue(value) {
  if (Array.isArray(value)) return value.map(stableSignedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSignedValue(value[key])]));
}

function signedAuthorityState(home, payload) {
  const key = fs.readFileSync(path.join(home, "authority.key"));
  const signature = createHmac("sha256", key).update(JSON.stringify(stableSignedValue(payload))).digest("hex");
  return { ...payload, signature };
}

function lexicalAuthorityPath(home, root, prefix = "") {
  const id = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
  return path.join(home, `${prefix}${id}.json`);
}

function writeSignedMirrors(filePath, state) {
  const bytes = JSON.stringify(state, null, 2) + "\n";
  fs.writeFileSync(filePath, bytes, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(`${filePath}.backup`, bytes, { encoding: "utf8", mode: 0o600 });
}

async function waitForFile(filePath, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, message);
}

function runGatedProposalDecisionChild({ repository, authorityHome, decision, actor, authorityPath, ready, release }) {
  const moduleUrl = new URL("../src/review_authority.mjs", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    const [moduleUrl, repository, authorityHome, rawDecision, actor, authorityPath, ready, release] = process.argv.slice(1);
    const originalOpenSync = fs.openSync.bind(fs);
    let paused = false;
    fs.openSync = function patchedOpenSync(filePath, ...args) {
      const result = originalOpenSync(filePath, ...args);
      if (!paused && String(filePath) === authorityPath) {
        paused = true;
        fs.writeFileSync(ready, "ready\\n", "utf8");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
      }
      return result;
    };
    const api = await import(moduleUrl);
    try {
      api.recordOwnerProposalDecision(repository, JSON.parse(rawDecision), { authorityHome, actor });
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: error.code || "", statusCode: error.statusCode || 0, message: error.message },
      }));
    }
  `;
  const result = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      source,
      moduleUrl,
      repository,
      authorityHome,
      JSON.stringify(decision),
      actor,
      authorityPath,
      ready,
      release,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `proposal decision child exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid proposal decision child output: ${stdout || stderr}`)); }
    });
  });
  return { ready, release, result };
}

function runFirstKeyCreationChild({ repository, authorityHome, decision, ready, release }) {
  const moduleUrl = new URL("../src/review_authority.mjs", import.meta.url).href;
  const keyPath = path.join(authorityHome, "authority.key");
  const source = `
    import fs from "node:fs";
    const [moduleUrl, repository, authorityHome, rawDecision, keyPath, ready, release] = process.argv.slice(1);
    const originalLinkSync = fs.linkSync.bind(fs);
    let paused = false;
    fs.linkSync = function patchedLinkSync(source, destination) {
      if (!paused && String(destination) === keyPath) {
        paused = true;
        fs.writeFileSync(ready, "ready\\n", "utf8");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
      }
      return originalLinkSync(source, destination);
    };
    const api = await import(moduleUrl);
    try {
      api.recordOwnerProposalDecision(repository, JSON.parse(rawDecision), { authorityHome, actor: repository });
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: error.code || "", statusCode: error.statusCode || 0, message: error.message },
      }));
    }
  `;
  const result = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      source,
      moduleUrl,
      repository,
      authorityHome,
      JSON.stringify(decision),
      keyPath,
      ready,
      release,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `first key creation child exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid first key creation child output: ${stdout || stderr}`)); }
    });
  });
  return { ready, result };
}

function crashProposalDecisionAfterRename({ repository, authorityHome, authorityPath, destination, decision, actor }) {
  const moduleUrl = new URL("../src/review_authority.mjs", import.meta.url).href;
  const crashDestination = destination === "backup" ? `${authorityPath}.backup` : authorityPath;
  const source = `
    import fs from "node:fs";
    const [moduleUrl, repository, authorityHome, authorityPath, crashDestination, rawDecision, actor] = process.argv.slice(1);
    const originalRenameSync = fs.renameSync.bind(fs);
    fs.renameSync = function patchedRenameSync(sourcePath, destinationPath) {
      const result = originalRenameSync(sourcePath, destinationPath);
      if (String(destinationPath) === crashDestination) process.exit(97);
      return result;
    };
    const api = await import(moduleUrl);
    api.recordOwnerProposalDecision(repository, JSON.parse(rawDecision), { authorityHome, actor });
  `;
  return spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    source,
    moduleUrl,
    repository,
    authorityHome,
    authorityPath,
    crashDestination,
    JSON.stringify(decision),
    actor,
  ], { encoding: "utf8" });
}

function protectedSettings() {
  return {
    allowedPaths: ["AGENTS.md", "docs/", ".agents/skills/"],
    watchAllow: ["AGENTS.md", "docs/"],
    watchRules: [{ path: "docs/", mode: "recursive-live" }],
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] },
    startupSkills: { enabled: true, projectOnly: true, folderNames: [".agents/skills"] },
  };
}

test("direct config narrowing keeps the last owner-authorized review scope effective", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });

  const narrowed = {
    allowedPaths: [],
    watchAllow: [],
    watchRules: [{ path: "docs/private/", mode: "direct-current", files: ["docs/private/one.md"] }],
    startupContext: { enabled: false, projectOnly: true, fileNames: [], globalPaths: [] },
    startupSkills: { enabled: false, projectOnly: true, folderNames: [] },
  };
  const effective = effectiveOwnerReviewScope(root, narrowed, { authorityHome: home });

  assert.deepEqual(effective.watchAllow, ["AGENTS.md", "docs/"]);
  assert.equal(effective.watchRules.some((rule) => rule.path === "docs/" && rule.mode === "recursive-live"), true);
  assert.deepEqual(effective.watchRules.find((rule) => rule.path === "docs/private/"), { path: "docs/private/", mode: "recursive-live" });
  assert.equal(effective.startupContext.enabled, true);
  assert.equal(effective.startupSkills.enabled, true);
  assert.ok(effective.allowedPaths.includes("docs/"));

  const status = inspectOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.equal(status.tampered, true);
  assert.equal(status.severity, "critical");
  assert.ok(status.reductions.some((item) => item.field === "watchAllow"));
  assert.ok(status.reductions.some((item) => item.field === "startupSkills.enabled"));
  assert.ok(status.reductions.some((item) => item.reason === "narrower-descendant-override"));
});

test("an explicit owner authorization may intentionally replace the protected scope", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  const intentional = {
    allowedPaths: ["AGENTS.md"],
    watchAllow: ["AGENTS.md"],
    watchRules: [],
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] },
    startupSkills: { enabled: false, projectOnly: true, folderNames: [] },
  };
  authorizeOwnerReviewScope(root, intentional, { authorityHome: home, actor: "human-ui" });

  const status = inspectOwnerReviewScope(root, intentional, { authorityHome: home });
  assert.equal(status.tampered, false);
  assert.deepEqual(effectiveOwnerReviewScope(root, intentional, { authorityHome: home }).watchAllow, ["AGENTS.md"]);
});

test("real project roots and symlink aliases share one review and trusted-state authority", (t) => {
  const { base, root, home } = fixture(t);
  const alias = path.join(base, "project-alias");
  fs.symlinkSync(root, alias, "dir");
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  authorizeOwnerTrustedState(root, "review-state", { version: 2, reviews: {} }, { authorityHome: home, actor: "human-ui" });

  const narrowed = {
    allowedPaths: [],
    watchAllow: [],
    watchRules: [],
    startupContext: { enabled: false, projectOnly: true, fileNames: [], globalPaths: [] },
    startupSkills: { enabled: false, projectOnly: true, folderNames: [] },
  };
  const realStatus = inspectOwnerReviewScope(root, narrowed, { authorityHome: home });
  const aliasStatus = inspectOwnerReviewScope(alias, narrowed, { authorityHome: home });
  assert.equal(aliasStatus.authorityPath, realStatus.authorityPath);
  assert.equal(aliasStatus.tampered, true);
  assert.ok(effectiveOwnerReviewScope(alias, narrowed, { authorityHome: home }).watchAllow.includes("docs/"));

  const forged = inspectOwnerTrustedState(alias, "review-state", {
    version: 2,
    reviews: { "docs/INDEX.md": { status: "verified", contentHash: "forged" } },
  }, { authorityHome: home });
  const trusted = inspectOwnerTrustedState(root, "review-state", { version: 2, reviews: {} }, { authorityHome: home });
  assert.equal(forged.authorityPath, trusted.authorityPath);
  assert.equal(forged.configured, true);
  assert.equal(forged.trusted, false);
  assert.equal(forged.identityMatches, true);
});

test("one signed lexical-root authority migrates to the canonical real path under lock", (t) => {
  const { base, root, home } = fixture(t);
  const alias = path.join(base, "legacy-project-alias");
  fs.symlinkSync(root, alias, "dir");
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "initial-key" });
  const canonicalPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  fs.unlinkSync(canonicalPath);
  fs.unlinkSync(`${canonicalPath}.backup`);

  const { signature: _signature, ...canonicalPayload } = canonical;
  const legacyState = signedAuthorityState(home, {
    ...canonicalPayload,
    projectRoot: path.resolve(alias),
    actor: "legacy-alias-owner",
  });
  const legacyPath = lexicalAuthorityPath(home, alias);
  writeSignedMirrors(legacyPath, legacyState);

  const narrowed = { ...protectedSettings(), allowedPaths: [], watchAllow: [], watchRules: [] };
  const effective = effectiveOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.ok(effective.watchAllow.includes("docs/"));
  const migrated = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  assert.equal(migrated.projectRoot, fs.realpathSync(root));
  assert.equal(migrated.actor, "legacy-alias-owner");
  assert.equal(inspectOwnerReviewScope(alias, narrowed, { authorityHome: home }).integrity, "verified");

  const trustedValue = { version: 2, reviews: { "docs/INDEX.md": { status: "verified" } } };
  authorizeOwnerTrustedState(root, "review-state", trustedValue, { authorityHome: home, actor: "trusted-key" });
  const canonicalTrustedPath = inspectOwnerTrustedState(root, "review-state", trustedValue, { authorityHome: home }).authorityPath;
  const canonicalTrusted = JSON.parse(fs.readFileSync(canonicalTrustedPath, "utf8"));
  fs.unlinkSync(canonicalTrustedPath);
  fs.unlinkSync(`${canonicalTrustedPath}.backup`);
  const { signature: _trustedSignature, ...trustedPayload } = canonicalTrusted;
  const legacyTrustedPath = lexicalAuthorityPath(home, alias, "trusted-review-state-");
  const legacyTrustedState = signedAuthorityState(home, {
    ...trustedPayload,
    resourceRoot: path.resolve(alias),
    actor: "legacy-trusted-owner",
  });
  fs.writeFileSync(`${legacyTrustedPath}.backup`, JSON.stringify(legacyTrustedState, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  const migratedTrusted = inspectOwnerTrustedState(root, "review-state", trustedValue, { authorityHome: home });
  assert.equal(migratedTrusted.integrity, "verified");
  assert.equal(migratedTrusted.trusted, true);
  assert.equal(JSON.parse(fs.readFileSync(canonicalTrustedPath, "utf8")).resourceRoot, fs.realpathSync(root));
});

test("multiple signed lexical-root authorities fail closed instead of selecting one", (t) => {
  const { base, root, home } = fixture(t);
  const aliases = [path.join(base, "legacy-alias-a"), path.join(base, "legacy-alias-b")];
  for (const alias of aliases) fs.symlinkSync(root, alias, "dir");
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "initial-key" });
  const canonicalPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  fs.unlinkSync(canonicalPath);
  fs.unlinkSync(`${canonicalPath}.backup`);
  const { signature: _signature, ...canonicalPayload } = canonical;
  aliases.forEach((alias, index) => {
    writeSignedMirrors(lexicalAuthorityPath(home, alias), signedAuthorityState(home, {
      ...canonicalPayload,
      projectRoot: path.resolve(alias),
      actor: `legacy-owner-${index}`,
      scope: index === 0 ? canonicalPayload.scope : { ...canonicalPayload.scope, watchAllow: [] },
    }));
  });

  const narrowed = { ...protectedSettings(), allowedPaths: [], watchAllow: [], watchRules: [] };
  assert.throws(
    () => effectiveOwnerReviewScope(root, narrowed, { authorityHome: home }),
    (error) => error?.code === "review_authority_unavailable" && error?.integrity === "conflict",
  );
  const inspected = inspectOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.equal(inspected.integrity, "conflict");
  assert.equal(inspected.severity, "critical");
  assert.equal(fs.existsSync(canonicalPath), false);
});

test("unrelated authority files do not exhaust canonical legacy migration", (t) => {
  const { root, home } = fixture(t);
  fs.mkdirSync(home, { recursive: true });
  for (let index = 0; index < 300; index += 1) {
    const id = createHash("sha256").update(`unrelated-${index}`).digest("hex").slice(0, 24);
    fs.writeFileSync(path.join(home, `${id}.json`), JSON.stringify({
      version: 1,
      projectRoot: `/missing/unrelated-${index}`,
      scope: {},
      signature: "not-relevant-to-this-project",
    }) + "\n");
  }

  const before = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home });
  assert.equal(before.integrity, "missing");
  const effective = effectiveOwnerReviewScope(root, protectedSettings(), { authorityHome: home });
  assert.ok(effective.watchAllow.includes("docs/"));
  assert.equal(inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).integrity, "verified");
});

test("a large mixed authority home still isolates and migrates the one matching project", (t) => {
  const { base, root, home } = fixture(t);
  const alias = path.join(base, "large-home-legacy-alias");
  fs.symlinkSync(root, alias, "dir");
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "large-home-key" });
  const canonicalPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  fs.unlinkSync(canonicalPath);
  fs.unlinkSync(`${canonicalPath}.backup`);
  const { signature: _signature, ...canonicalPayload } = canonical;
  writeSignedMirrors(lexicalAuthorityPath(home, alias), signedAuthorityState(home, {
    ...canonicalPayload,
    projectRoot: path.resolve(alias),
    actor: "large-home-legacy-owner",
  }));
  for (let index = 0; index < 4_200; index += 1) {
    const id = createHash("sha256").update(`large-unrelated-${index}`).digest("hex").slice(0, 24);
    fs.writeFileSync(path.join(home, `${id}.json`), JSON.stringify({
      version: 1,
      projectRoot: `/missing/large-unrelated-${index}`,
      scope: {},
      signature: "unrelated",
    }) + "\n");
  }
  for (let index = 0; index < 4_100; index += 1) {
    fs.writeFileSync(path.join(home, `unrelated-sidecar-${String(index).padStart(5, "0")}`), "");
  }

  const narrowed = { ...protectedSettings(), allowedPaths: [], watchAllow: [], watchRules: [] };
  const effective = effectiveOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.ok(effective.watchAllow.includes("docs/"));
  const migrated = inspectOwnerReviewScope(alias, narrowed, { authorityHome: home });
  assert.equal(migrated.integrity, "verified");
  assert.equal(JSON.parse(fs.readFileSync(canonicalPath, "utf8")).actor, "large-home-legacy-owner");
});

test("an oversized authority inventory fails closed without silently bootstrapping", (t) => {
  const { root, home } = fixture(t);
  fs.mkdirSync(home, { recursive: true });
  const oversized = path.join(home, `${createHash("sha256").update("oversized-authority").digest("hex").slice(0, 24)}.json`);
  fs.writeFileSync(oversized, "");
  fs.truncateSync(oversized, 512 * 1024 * 1024 + 1);

  const inspected = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home });
  const canonicalPath = inspected.authorityPath;
  assert.equal(inspected.integrity, "conflict");
  assert.equal(inspected.severity, "critical");
  assert.throws(
    () => effectiveOwnerReviewScope(root, protectedSettings(), { authorityHome: home }),
    (error) => error?.code === "review_authority_unavailable" && error?.integrity === "conflict",
  );
  assert.equal(fs.existsSync(canonicalPath), false);
  assert.equal(fs.existsSync(`${canonicalPath}.backup`), false);
});

test("a corrupted primary authority record fails closed through its signed mirror", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  const authorityPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  const tampered = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  tampered.scope.watchAllow = [];
  tampered.scope.watchRules = [];
  fs.writeFileSync(authorityPath, JSON.stringify(tampered, null, 2) + "\n");

  const narrowed = { ...protectedSettings(), watchAllow: [], watchRules: [] };
  const effective = effectiveOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.deepEqual(effective.watchAllow, ["AGENTS.md", "docs/"]);
  assert.deepEqual(effective.watchRules, [{ path: "docs/", mode: "recursive-live" }]);
  const inspected = inspectOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.equal(inspected.integrity, "recovered");
  assert.equal(inspected.tampered, true);
  assert.equal(inspected.severity, "critical");
});

test("corruption of both authority mirrors refuses to fall back to reduced project settings", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  const authorityPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  for (const filePath of [authorityPath, authorityPath + ".backup"]) {
    const tampered = JSON.parse(fs.readFileSync(filePath, "utf8"));
    tampered.scope.watchAllow = [];
    fs.writeFileSync(filePath, JSON.stringify(tampered, null, 2) + "\n");
  }

  assert.throws(
    () => effectiveOwnerReviewScope(root, { ...protectedSettings(), watchAllow: [] }, { authorityHome: home }),
    (error) => error?.code === "review_authority_unavailable" && error?.integrity === "invalid-signature",
  );
});

test("proposal terminal decisions are exact-revision receipts with tamper detection", (t) => {
  const { home } = fixture(t);
  const repository = "git@example.test:shared/context.git";
  const proposalHead = "a".repeat(40);
  recordOwnerProposalDecision(repository, {
    proposal: "proposal/demo/security",
    proposalHead,
    decision: "rejected",
    archiveRef: `rejected/demo/security-${proposalHead.slice(0, 12)}`,
  }, { authorityHome: home, actor: "owner@example.test" });

  const verified = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(verified.integrity, "verified");
  assert.equal(verified.decisions.length, 1);
  assert.equal(verified.decisions[0].proposalHead, proposalHead);
  assert.equal(verified.decisions[0].actor, "owner@example.test");

  const raw = JSON.parse(fs.readFileSync(verified.authorityPath, "utf8"));
  Object.values(raw.decisions)[0].decision = "accepted";
  fs.writeFileSync(verified.authorityPath, JSON.stringify(raw, null, 2) + "\n");
  const recovered = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(recovered.integrity, "recovered");
  assert.equal(recovered.decisions[0].decision, "rejected");
  fs.writeFileSync(verified.authorityPath + ".backup", JSON.stringify(raw, null, 2) + "\n");
  assert.equal(inspectOwnerProposalDecisions(repository, { authorityHome: home }).integrity, "invalid-signature");
});

test("signed proposal decisions recover crashes after backup and primary publication without rewriting receipts", (t) => {
  for (const destination of ["backup", "primary"]) {
    const { home } = fixture(t);
    const repository = `git@example.test:shared/signed-crash-${destination}.git`;
    const first = {
      proposal: `proposal/demo/first-${destination}`,
      proposalHead: "1".repeat(40),
      decision: "rejected",
      archiveRef: `rejected/demo/first-${destination}-${"1".repeat(12)}`,
    };
    recordOwnerProposalDecision(repository, first, { authorityHome: home, actor: "first-owner" });
    const before = inspectOwnerProposalDecisions(repository, { authorityHome: home });
    const firstReceipt = before.decisions.find((item) => item.proposal === first.proposal);
    const second = {
      proposal: `proposal/demo/crash-${destination}`,
      proposalHead: "2".repeat(40),
      decision: "accepted",
      acceptedCommit: "3".repeat(40),
    };
    const crashed = crashProposalDecisionAfterRename({
      repository,
      authorityHome: home,
      authorityPath: before.authorityPath,
      destination,
      decision: second,
      actor: `crash-owner-${destination}`,
    });
    assert.equal(crashed.status, 97, crashed.stderr || crashed.stdout);
    assert.equal(fs.existsSync(`${before.authorityPath}.transaction`), true);

    const recovered = inspectOwnerProposalDecisions(repository, { authorityHome: home });
    assert.equal(recovered.integrity, "verified");
    assert.equal(recovered.writable, true);
    assert.equal(recovered.decisions.length, 2);
    const recoveredFirst = recovered.decisions.find((item) => item.proposal === first.proposal);
    assert.equal(recoveredFirst.actor, firstReceipt.actor);
    assert.equal(recoveredFirst.decidedAt, firstReceipt.decidedAt);
    const recoveredSecond = recovered.decisions.find((item) => item.proposal === second.proposal);
    assert.equal(recoveredSecond.actor, `crash-owner-${destination}`);
    const decidedAt = recoveredSecond.decidedAt;

    recordOwnerProposalDecision(repository, second, { authorityHome: home, actor: "retry-must-not-rewrite" });
    const retried = inspectOwnerProposalDecisions(repository, { authorityHome: home });
    const retriedSecond = retried.decisions.find((item) => item.proposal === second.proposal);
    assert.equal(retriedSecond.actor, `crash-owner-${destination}`);
    assert.equal(retriedSecond.decidedAt, decidedAt);
    assert.equal(fs.readFileSync(before.authorityPath, "utf8"), fs.readFileSync(`${before.authorityPath}.backup`, "utf8"));
    assert.equal(fs.existsSync(`${before.authorityPath}.transaction`), false);
  }
});

test("a lone valid signed backup is promoted to a writable primary under the authority lock", (t) => {
  const { home } = fixture(t);
  const repository = "git@example.test:shared/backup-only-recovery.git";
  recordOwnerProposalDecision(repository, {
    proposal: "proposal/demo/backup-only",
    proposalHead: "9".repeat(40),
    decision: "accepted",
    acceptedCommit: "a".repeat(40),
  }, { authorityHome: home, actor: "backup-owner" });
  const before = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  fs.unlinkSync(before.authorityPath);
  assert.equal(fs.existsSync(`${before.authorityPath}.transaction`), false);

  const recovered = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(recovered.integrity, "verified");
  assert.equal(recovered.writable, true);
  assert.equal(recovered.decisions[0].actor, "backup-owner");
  assert.equal(fs.readFileSync(before.authorityPath, "utf8"), fs.readFileSync(`${before.authorityPath}.backup`, "utf8"));
});

test("different valid signed primary and backup states fail closed without a transaction journal", (t) => {
  const { home } = fixture(t);
  const repository = "git@example.test:shared/signed-conflict.git";
  recordOwnerProposalDecision(repository, {
    proposal: "proposal/demo/old",
    proposalHead: "4".repeat(40),
    decision: "rejected",
    archiveRef: `rejected/demo/old-${"4".repeat(12)}`,
  }, { authorityHome: home, actor: "old-owner" });
  const authorityPath = inspectOwnerProposalDecisions(repository, { authorityHome: home }).authorityPath;
  const oldPrimary = fs.readFileSync(authorityPath);
  recordOwnerProposalDecision(repository, {
    proposal: "proposal/demo/new",
    proposalHead: "5".repeat(40),
    decision: "accepted",
    acceptedCommit: "6".repeat(40),
  }, { authorityHome: home, actor: "new-owner" });
  fs.writeFileSync(authorityPath, oldPrimary);

  const conflicted = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(conflicted.integrity, "conflict");
  assert.equal(conflicted.writable, false);
  assert.deepEqual(conflicted.decisions, []);
  assert.throws(
    () => recordOwnerProposalDecision(repository, {
      proposal: "proposal/demo/third",
      proposalHead: "7".repeat(40),
      decision: "accepted",
      acceptedCommit: "8".repeat(40),
    }, { authorityHome: home, actor: "must-fail" }),
    /authority is conflict/,
  );
});

test("proposal decision receipts serialize cross-process read-modify-write and keep exact retries immutable", async (t) => {
  const { base, home } = fixture(t);
  const repository = "git@example.test:shared/concurrent-context.git";
  const initialHead = "1".repeat(40);
  recordOwnerProposalDecision(repository, {
    proposal: "proposal/demo/initial",
    proposalHead: initialHead,
    decision: "rejected",
    archiveRef: `rejected/demo/initial-${initialHead.slice(0, 12)}`,
  }, { authorityHome: home, actor: "initial-owner" });
  const authorityPath = inspectOwnerProposalDecisions(repository, { authorityHome: home }).authorityPath;
  const specs = [
    {
      proposal: "proposal/demo/concurrent-alpha",
      proposalHead: "a".repeat(40),
      decision: "rejected",
      archiveRef: `rejected/demo/concurrent-alpha-${"a".repeat(12)}`,
    },
    {
      proposal: "proposal/demo/concurrent-beta",
      proposalHead: "b".repeat(40),
      decision: "accepted",
      acceptedCommit: "c".repeat(40),
    },
  ];
  const children = specs.map((decision, index) => {
    const ready = path.join(base, `decision-${index}.ready`);
    const release = path.join(base, `decision-${index}.release`);
    t.after(() => {
      try { fs.writeFileSync(release, "release\n", "utf8"); } catch {}
    });
    return runGatedProposalDecisionChild({
      repository,
      authorityHome: home,
      decision,
      actor: `owner-${index}`,
      authorityPath,
      ready,
      release,
    });
  });

  const firstReadyDeadline = Date.now() + 10_000;
  while (!children.some((child) => fs.existsSync(child.ready)) && Date.now() < firstReadyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const firstIndex = children.findIndex((child) => fs.existsSync(child.ready));
  assert.notEqual(firstIndex, -1, "one decision writer must read the signed state while holding the authority lock");
  const secondIndex = firstIndex === 0 ? 1 : 0;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    fs.existsSync(children[secondIndex].ready),
    false,
    "the second process must not read stale authority state while the first writer is paused",
  );

  fs.writeFileSync(children[firstIndex].release, "release\n", "utf8");
  await waitForFile(
    children[secondIndex].ready,
    "the second decision writer must proceed after the first atomic update releases the lock",
  );
  fs.writeFileSync(children[secondIndex].release, "release\n", "utf8");
  const outcomes = await Promise.all(children.map((child) => child.result));
  assert.deepEqual(outcomes, [{ ok: true }, { ok: true }]);

  const inspected = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(inspected.integrity, "verified");
  assert.equal(inspected.decisions.length, 3);
  for (const decision of specs) {
    assert.ok(inspected.decisions.some((item) => item.proposal === decision.proposal && item.proposalHead === decision.proposalHead));
  }

  const beforeRetry = inspected.decisions.find((item) => item.proposal === specs[0].proposal);
  recordOwnerProposalDecision(repository, specs[0], { authorityHome: home, actor: "different-retry-owner" });
  const afterRetry = inspectOwnerProposalDecisions(repository, { authorityHome: home }).decisions
    .find((item) => item.proposal === specs[0].proposal);
  assert.equal(afterRetry.actor, beforeRetry.actor);
  assert.equal(afterRetry.decidedAt, beforeRetry.decidedAt);
  assert.throws(
    () => recordOwnerProposalDecision(repository, {
      proposal: specs[0].proposal,
      proposalHead: specs[0].proposalHead,
      decision: "accepted",
      acceptedCommit: "d".repeat(40),
    }, { authorityHome: home, actor: "opposite-owner" }),
    (error) => error?.code === "proposal_decision_conflict" && error?.statusCode === 409,
  );
  const final = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(final.decisions.length, 3);
  assert.equal(final.decisions.find((item) => item.proposal === specs[0].proposal).decision, "rejected");
});

test("concurrent first decision receipts publish one complete HMAC key across repository locks", async (t) => {
  const { base, home } = fixture(t);
  const release = path.join(base, "first-key.release");
  t.after(() => {
    try { fs.writeFileSync(release, "release\n", "utf8"); } catch {}
  });
  const repositories = [
    "git@example.test:shared/first-key-alpha.git",
    "git@example.test:shared/first-key-beta.git",
  ];
  const children = repositories.map((repository, index) => runFirstKeyCreationChild({
    repository,
    authorityHome: home,
    decision: {
      proposal: `proposal/demo/first-key-${index}`,
      proposalHead: String(index + 1).repeat(40),
      decision: "rejected",
      archiveRef: `rejected/demo/first-key-${index}-${String(index + 1).repeat(12)}`,
    },
    ready: path.join(base, `first-key-${index}.ready`),
    release,
  }));

  await Promise.all(children.map((child, index) => waitForFile(
    child.ready,
    `first key writer ${index} must reach atomic publication before release`,
  )));
  fs.writeFileSync(release, "release\n", "utf8");
  assert.deepEqual(await Promise.all(children.map((child) => child.result)), [{ ok: true }, { ok: true }]);
  for (const repository of repositories) {
    const inspected = inspectOwnerProposalDecisions(repository, { authorityHome: home });
    assert.equal(inspected.integrity, "verified");
    assert.equal(inspected.decisions.length, 1);
  }
  const key = fs.readFileSync(path.join(home, "authority.key"));
  assert.equal(key.length, 32);
  assert.equal(fs.statSync(path.join(home, "authority.key")).mode & 0o777, 0o600);
});

test("terminal decision challenges require the exact principal, authority, proposal, head, and action without consuming on mismatch", () => {
  let currentTime = Date.parse("2026-08-07T08:00:00.000Z");
  const store = terminalChallengeStore({ now: () => currentTime, ttlMs: 30_000 });
  const binding = {
    principal: "remote-human:mathis",
    authorityId: "authority-hicharlie",
    proposal: "proposal/hicharlie/review-outcome",
    proposalHead: "a".repeat(40),
    action: "accept",
  };
  const issued = store.issue(binding);

  assert.match(issued.challengeId, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(issued.expiresAt, new Date(currentTime + 30_000).toISOString());

  const mismatches = {
    principal: "remote-human:florent",
    authorityId: "authority-other",
    proposal: "proposal/hicharlie/other",
    proposalHead: "b".repeat(40),
    action: "reject",
  };
  for (const [field, value] of Object.entries(mismatches)) {
    assert.throws(
      () => store.consume(issued.challengeId, { ...binding, [field]: value }),
      (error) => error?.code === "terminal_decision_challenge_mismatch" && error?.statusCode === 403,
      `${field} must be part of the exact challenge binding`,
    );
  }

  assert.doesNotThrow(() => store.consume(issued.challengeId, binding));
  assert.throws(
    () => store.consume(issued.challengeId, binding),
    (error) => error?.code === "terminal_decision_challenge_replayed" && error?.statusCode === 403,
  );
});

test("terminal decision challenges expire and cannot authorize the terminal mutation", () => {
  let currentTime = Date.parse("2026-08-07T08:00:00.000Z");
  const store = terminalChallengeStore({ now: () => currentTime, ttlMs: 1_000 });
  const binding = {
    principal: "local-human:owner",
    authorityId: "authority-local",
    proposal: "proposal/global/documentation",
    proposalHead: "c".repeat(40),
    action: "accept",
  };
  const issued = store.issue(binding);

  currentTime += 1_001;
  assert.throws(
    () => store.consume(issued.challengeId, binding),
    (error) => error?.code === "terminal_decision_challenge_expired" && error?.statusCode === 403,
  );
});
