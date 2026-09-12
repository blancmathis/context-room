import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readReviewCleanupPolicy, writeReviewCleanupPolicy, previewReviewCleanup, applyReviewCleanup } from "../src/review_cleanup.mjs";

const DAY = 86400000, now = Date.parse("2026-09-12T12:00:00Z");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cleanup-"));
  const previous = process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = path.join(root, "authority");
  t.after(() => { if (previous === undefined) delete process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME; else process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const item = (id, values = {}) => ({ id, projectId: "project-a", revision: "r1", title: id, submittedAt: new Date(now - 5 * DAY).toISOString(), ...values });

test("pending reviews never expire unless the human enables a rule", (t) => {
  const root = fixture(t);
  assert.equal(readReviewCleanupPolicy(root).enabled, false);
  const result = applyReviewCleanup(root, [item("a")], { now, automatic: true, reject: () => assert.fail("No default automatic rejection") });
  assert.equal(result.disabled, true);
});

test("one-time cleanup binds the exact revisions, project, and age and reports failures", (t) => {
  const root = fixture(t), items = [item("a"), item("b", { projectId: "project-b" }), item("draft", { draft: true }), item("offline", { available: false })];
  const options = { days: 2, projectIds: ["project-a"], now };
  const plan = previewReviewCleanup(root, items, options);
  assert.deepEqual(plan.items.map((entry) => entry.id), ["a"]);
  assert.throws(() => applyReviewCleanup(root, [item("a", { revision: "r2" })], { ...options, expectedRevision: plan.revision, reject: () => assert.fail("Stale selection") }), /selection changed/);
  const currentItems = [item("a", { revision: "r2" })];
  const fresh = previewReviewCleanup(root, currentItems, { ...options, now: now + 3 * DAY });
  const result = applyReviewCleanup(root, currentItems, { ...options, now: now + 3 * DAY, expectedRevision: fresh.revision, reject: () => { throw new Error("New disk edit blocks restoration"); } });
  assert.equal(result.applied.length, 0);
  assert.equal(result.errors[0].message, "New disk edit blocks restoration");
});

test("a changed revision starts a new age and an automatic rule cannot be forged in settings", (t) => {
  const root = fixture(t), options = { now, days: 2, projectIds: [] };
  writeReviewCleanupPolicy(root, { enabled: true, days: 2, projectIds: ["project-a"] });
  previewReviewCleanup(root, [item("a")], options);
  const next = previewReviewCleanup(root, [item("a", { revision: "r2" })], { ...options, now: now + DAY });
  assert.equal(next.items.length, 0);
  const result = applyReviewCleanup(root, [item("a", { revision: "r2" })], { now: now + 4 * DAY, automatic: true, reject: (entry) => ({ rejected: true, revision: entry.revision }) });
  assert.equal(result.applied.length, 1);
  const policyPath = path.join(root, ".context-room/review-cleanup/policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ enabled: true, days: 1, projectIds: [] }));
  assert.throws(() => readReviewCleanupPolicy(root), /human authorization/);
});

test("unknown direct-change age starts at observation and damaged history cannot accelerate rejection", (t) => {
  const root = fixture(t), entry = item("direct", { submittedAt: "" });
  assert.equal(previewReviewCleanup(root, [entry], { now, days: 1 }).items.length, 0);
  assert.equal(previewReviewCleanup(root, [entry], { now: now + DAY, days: 1 }).items.length, 1);
  fs.writeFileSync(path.join(root, ".context-room/review-cleanup/observations.json"), JSON.stringify({ direct: { revision: "r1", observedAt: 0 } }));
  assert.throws(() => previewReviewCleanup(root, [entry], { now, days: 1 }), /history has changed/);
});
