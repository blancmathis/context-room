import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordDocumentationRead } from "../src/documentation_readers.mjs";

function fixture(t) {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cr-readers-"));
  t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));
  return { storeRoot };
}
function corpus(values, target = { mode: "local" }, root = "/project") {
  return { root, target, documents: Object.entries(values).map(([path, rawContent]) => ({ path, rawContent, reviewStatus: "accepted" })) };
}

test("independent generic readers receive only changes to documents they encountered", (t) => {
  const options = fixture(t);
  const initial = corpus({ "a.md": "Alpha", "b.md": "Beta" });
  const a = recordDocumentationRead(initial, ["a.md"], options);
  const b = recordDocumentationRead(initial, ["b.md"], options);
  assert.notEqual(a.readerToken, b.readerToken);
  const changed = corpus({ "a.md": "Alpha accepted", "b.md": "Beta accepted" });
  changed.documents.push({ path: "pending.md", rawContent: "unaccepted secret", reviewStatus: "unverified" });
  const again = recordDocumentationRead(changed, [], { ...options, readerToken: a.readerToken });
  assert.equal(again.continuity, "resumed");
  assert.deepEqual(again.updates.map((entry) => entry.path), ["a.md"]);
  assert.equal(again.updates[0].diff.added, "Alpha accepted");
  assert.equal(JSON.stringify(again).includes("secret"), false);
  assert.equal(recordDocumentationRead(changed, [], { ...options, readerToken: a.readerToken }).updates.length, 0);
  assert.deepEqual(recordDocumentationRead(changed, [], { ...options, readerToken: b.readerToken }).updates.map((entry) => entry.path), ["b.md"]);
});

test("Shared reader follows revisions across immutable snapshot roots", (t) => {
  const options = fixture(t), target = { mode: "shared-only", repository: "team/docs", projectId: "demo" };
  const first = recordDocumentationRead(corpus({ "a.md": "v1" }, target, "/snapshots/one"), ["a.md"], options);
  const second = recordDocumentationRead(corpus({ "a.md": "v2" }, target, "/snapshots/two"), [], { ...options, readerToken: first.readerToken });
  assert.equal(second.updates[0].diff.added, "v2");
  assert.equal(recordDocumentationRead(corpus({ "a.md": "other" }, { ...target, projectId: "other" }), [], { ...options, readerToken: first.readerToken }).updates.length, 0);
});

test("diff budget is global and incomplete changes remain outstanding until fully read", (t) => {
  const options = { ...fixture(t), maxDiffChars: 10 };
  const first = recordDocumentationRead(corpus({ a: "a", b: "b" }), ["a", "b"], options);
  const next = corpus({ a: "A".repeat(40), b: "B".repeat(40) });
  const second = recordDocumentationRead(next, ["a"], { ...options, readerToken: first.readerToken });
  assert.ok(second.updates.reduce((n, entry) => n + entry.diff.added.length + entry.diff.removed.length, 0) <= 10);
  assert.ok(second.updates.every((entry) => entry.diff.truncated));
  assert.equal(recordDocumentationRead(next, [], { ...options, readerToken: first.readerToken }).updates.length, 2);
  recordDocumentationRead(next, ["a"], { ...options, readerToken: first.readerToken, completePaths: ["a"] });
  assert.deepEqual(recordDocumentationRead(next, [], { ...options, readerToken: first.readerToken }).updates.map((entry) => entry.path), ["b"]);
});

test("conversation identifiers resume without a separate initialization command and unknown tokens fail", (t) => {
  const options = { ...fixture(t), sessionId: "generic-harness-task" };
  const first = recordDocumentationRead(corpus({ a: "a" }), ["a"], options);
  assert.equal(recordDocumentationRead(corpus({ a: "changed" }), [], options).readerToken, first.readerToken);
  assert.throws(() => recordDocumentationRead(corpus({}), [], { ...options, readerToken: "reader-" + "f".repeat(64) }), /unknown/);
});
