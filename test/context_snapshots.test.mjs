import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ContextSnapshotError,
  buildContextSnapshotManifest,
  createContextSnapshot,
  diffContextSnapshots,
  diffStoredContextSnapshots,
  listContextSnapshots,
  pruneContextSnapshots,
  readContextSnapshot,
} from "../src/context_snapshots.mjs";

function baseEffective(overrides = {}) {
  return {
    coordinate: { projectId: "hicharlie", locationId: "wt-main", folder: "apps/calls", provider: "codex" },
    resolverVersion: "resolver-7",
    providerProfileVersion: "codex-3",
    resources: [
      {
        id: "local:/repo/AGENTS.md",
        kind: "instruction",
        source: { type: "local", content: "must not persist" },
        locator: { path: "AGENTS.md" },
        providers: ["codex"],
        version: { hash: "aaa" },
        truthState: "accepted",
        review: { status: "verified", text: "also omitted" },
        content: "never store this",
      },
    ],
    applications: [
      {
        resourceId: "local:/repo/AGENTS.md",
        status: "active",
        scope: { type: "project" },
        order: 20,
        reason: { rule: "project instruction", message: "omitted" },
        destination: null,
        provider: "codex",
      },
    ],
    watermarks: { gitHead: "head-one", configRevision: "cfg-one", reviewRevision: "review-one", task: "omit" },
    sharedRevisions: [],
    ...overrides,
  };
}

function tempStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-snapshots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertSnapshotError(error, code) {
  assert.ok(error instanceof ContextSnapshotError);
  assert.equal(error.code, code);
  return true;
}

test("snapshot manifests are deterministic, content-addressed metadata only", () => {
  const first = buildContextSnapshotManifest(baseEffective());
  const reordered = buildContextSnapshotManifest(baseEffective({
    resources: [
      { id: "z", kind: "skill", source: "local", locator: { path: ".codex/skills/z" }, providers: ["codex"], version: "z", truthState: "accepted", review: null },
      ...baseEffective().resources,
    ],
  }));
  const reorderedAgain = buildContextSnapshotManifest(baseEffective({
    resources: [
      ...baseEffective().resources,
      { id: "z", kind: "skill", source: "local", locator: { path: ".codex/skills/z" }, providers: ["codex"], version: "z", truthState: "accepted", review: null },
    ],
  }));

  assert.equal(first.snapshotId.length, 64);
  assert.equal(reordered.snapshotId, reorderedAgain.snapshotId);
  assert.notEqual(first.snapshotId, reordered.snapshotId);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /must not persist|also omitted|never store this|"task"/);
  assert.equal(first.resolverVersion, "resolver-7");
  assert.equal(first.providerProfileVersion, "codex-3");
});

test("create persists private immutable snapshots and returns the same ID for the same state", async (t) => {
  const storageRoot = tempStore(t);
  const first = await createContextSnapshot(baseEffective(), { storageRoot });
  const firstMtime = fs.statSync(first.path).mtimeMs;
  const second = await createContextSnapshot(baseEffective(), { storageRoot });

  assert.equal(first.manifest.snapshotId, second.manifest.snapshotId);
  assert.equal(fs.statSync(storageRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first.path).mtimeMs, firstMtime);
  assert.deepEqual(readContextSnapshot(first.manifest.snapshotId, { storageRoot }), first.manifest);
  assert.equal(listContextSnapshots({ storageRoot }).length, 1);
});

test("shared snapshot creation requires a matching online accepted revision", async (t) => {
  const storageRoot = tempStore(t);
  const effective = baseEffective({
    sharedRevisions: [{ id: "team", repository: "git@example.test:team/docs.git", defaultBranch: "stable", projectId: "hicharlie", revision: "accepted-2" }],
  });

  await assert.rejects(
    createContextSnapshot(effective, { storageRoot }),
    (error) => assertSnapshotError(error, "shared-freshness-unverified"),
  );
  await assert.rejects(
    createContextSnapshot(effective, { storageRoot, verifySharedRevision: async () => ({ revision: "accepted-1", online: true }) }),
    (error) => assertSnapshotError(error, "shared-freshness-unverified"),
  );
  const calls = [];
  const result = await createContextSnapshot(effective, {
    storageRoot,
    verifySharedRevision: async (shared, options) => {
      calls.push({ shared, options });
      return { revision: "accepted-2", online: true };
    },
  });
  assert.equal(result.manifest.sharedRevisions[0].defaultBranch, "stable");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.refresh, true);
});

test("snapshot retention removes expired and excess manifests without deleting the current result", async (t) => {
  const storageRoot = tempStore(t);
  const results = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await createContextSnapshot(baseEffective({ watermarks: { gitHead: `head-${index}` } }), {
      storageRoot,
      maxEntries: 100,
    });
    results.push(result);
    const stamp = new Date(Date.now() - (index + 1) * 1_000);
    fs.utimesSync(result.path, stamp, stamp);
  }
  const removed = pruneContextSnapshots({ storageRoot, maxEntries: 2, maxAgeMs: Number.POSITIVE_INFINITY });
  assert.equal(removed.length, 2);
  assert.equal(listContextSnapshots({ storageRoot }).length, 2);

  const latest = await createContextSnapshot(baseEffective({ watermarks: { gitHead: "latest" } }), {
    storageRoot,
    maxEntries: 0,
    maxAgeMs: 0,
  });
  assert.equal(fs.existsSync(latest.path), true);
});

test("snapshot diff reports resource, application, review, destination and shared transition changes", async () => {
  const before = buildContextSnapshotManifest(baseEffective({
    sharedRevisions: [{ id: "team", repository: "repo", defaultBranch: "main", projectId: "hicharlie", revision: "c1" }],
  }));
  const changedInstruction = {
    ...baseEffective().resources[0],
    version: { hash: "bbb" },
  };
  const after = buildContextSnapshotManifest(baseEffective({
    resources: [
      changedInstruction,
      { id: "shared:skill/call-quality", kind: "skill", source: { type: "shared", sharedId: "team" }, locator: { path: "skills/call-quality" }, providers: ["codex"], version: { revision: "c2", blob: "b2" }, truthState: "accepted", review: null },
    ],
    applications: [{
      ...baseEffective().applications[0],
      status: "shadowed",
      destination: { path: "/managed/codex" },
    }],
    sharedRevisions: [{ id: "team", repository: "repo", defaultBranch: "main", projectId: "hicharlie", revision: "c2" }],
  }));
  const callbackCalls = [];
  const diff = await diffContextSnapshots(before, after, {
    diffSharedRevisions: async (repository, options) => {
      callbackCalls.push({ repository, options });
      return {
        history: "first-parent",
        commits: [{ revision: "c2" }],
        changedPaths: ["skills/call-quality/SKILL.md", "projects/hicharlie/docs/calls.md"],
        applicablePaths: ["skills/call-quality/SKILL.md"],
      };
    },
  });

  assert.deepEqual(diff.resources.added.map((item) => item.id), ["shared:skill/call-quality"]);
  assert.deepEqual(diff.resources.modified.map((item) => item.resourceId), ["local:/repo/AGENTS.md"]);
  assert.equal(diff.applications[0].change, "modified");
  assert.deepEqual(new Set(diff.applications[0].fields), new Set(["status", "destination"]));
  assert.deepEqual(diff.reviewsObsolete.map((item) => item.resourceId), ["local:/repo/AGENTS.md"]);
  assert.equal(diff.sharedTransitions[0].commitCount, 1);
  assert.deepEqual(diff.sharedTransitions[0].applicablePaths, ["skills/call-quality/SKILL.md"]);
  assert.equal(callbackCalls[0].options.projectId, "hicharlie");
});

test("existing manifests can be diffed offline and do not claim verified shared history", async (t) => {
  const storageRoot = tempStore(t);
  const before = await createContextSnapshot(baseEffective({
    sharedRevisions: [{ id: "team", repository: "repo", revision: "c1" }],
  }), { storageRoot, verifySharedRevision: async () => "c1" });
  const after = await createContextSnapshot(baseEffective({
    resources: [{ ...baseEffective().resources[0], version: { hash: "changed" } }],
    sharedRevisions: [{ id: "team", repository: "repo", revision: "c2" }],
  }), { storageRoot, verifySharedRevision: async () => "c2" });

  const diff = await diffStoredContextSnapshots(before.manifest.snapshotId, after.manifest.snapshotId, { storageRoot });
  assert.equal(diff.sharedTransitions[0].history, "not-checked-offline");
  assert.deepEqual(diff.sharedTransitions[0].applicablePaths, ["AGENTS.md"]);
});

test("snapshot diff rejects different targets and rewritten shared history", async () => {
  const before = buildContextSnapshotManifest(baseEffective({
    sharedRevisions: [{ id: "team", repository: "repo", revision: "c1" }],
  }));
  const otherTarget = buildContextSnapshotManifest(baseEffective({
    coordinate: { projectId: "other", locationId: "wt-main", folder: "apps/calls", provider: "codex" },
  }));
  await assert.rejects(
    diffContextSnapshots(before, otherTarget),
    (error) => assertSnapshotError(error, "snapshot-target-mismatch"),
  );

  const after = buildContextSnapshotManifest(baseEffective({
    sharedRevisions: [{ id: "team", repository: "repo", revision: "c2" }],
  }));
  await assert.rejects(
    diffContextSnapshots(before, after, { diffSharedRevisions: async () => ({ diverged: true }) }),
    (error) => assertSnapshotError(error, "shared-history-diverged"),
  );
});

test("tampered or missing manifests fail closed", async (t) => {
  const storageRoot = tempStore(t);
  const result = await createContextSnapshot(baseEffective(), { storageRoot });
  fs.writeFileSync(result.path, `${JSON.stringify({ ...result.manifest, resolverVersion: "tampered" })}\n`, "utf8");
  assert.throws(
    () => readContextSnapshot(result.manifest.snapshotId, { storageRoot }),
    (error) => assertSnapshotError(error, "invalid-snapshot"),
  );
  assert.throws(
    () => readContextSnapshot("0".repeat(64), { storageRoot }),
    (error) => assertSnapshotError(error, "snapshot-not-found"),
  );
});
