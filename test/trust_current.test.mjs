import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerContextHubProject } from "../src/context_hub.mjs";
import {
  buildDocQaReport,
  createMemoryServer,
  initializeContextRoomProject,
  previewTrustCurrentDocVersions,
  readDocReviewHistory,
  readDocReviewState,
  readGlobalReviewLedger,
  trustCurrentDocVersions,
  undoDocReviewAcceptance,
  writeDocReviewDecision,
} from "../src/context_room.mjs";

const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-trust-suite-"));
const previous = { hub: process.env.CONTEXT_ROOM_HUB_HOME, shared: process.env.CONTEXT_ROOM_SHARED_HOME };
process.env.CONTEXT_ROOM_HUB_HOME = path.join(suiteHome, "hub");
process.env.CONTEXT_ROOM_SHARED_HOME = path.join(suiteHome, "shared");
test.after(() => {
  for (const [key, value] of [["CONTEXT_ROOM_HUB_HOME", previous.hub], ["CONTEXT_ROOM_SHARED_HOME", previous.shared]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

const DOCS = ["docs/README.md", "docs/guide.md", "docs/notes/plan.md"];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Trust Test", GIT_AUTHOR_EMAIL: "trust@example.test", GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Trust Test", GIT_COMMITTER_EMAIL: "trust@example.test", GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
};

function makeProject(name) {
  const root = fs.mkdtempSync(path.join(suiteHome, `${name}-`));
  for (const doc of DOCS) {
    fs.mkdirSync(path.dirname(path.join(root, doc)), { recursive: true });
    fs.writeFileSync(path.join(root, doc), `# ${path.basename(doc)}\n\nBody of ${doc}.\n`, "utf8");
  }
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore", env: gitEnv });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore", env: gitEnv });
  return root;
}

test("trusting the current versions accepts the exact list in one receipt, and undo removes it all", () => {
  const root = makeProject("trust");
  const ledgerBefore = readGlobalReviewLedger(root).reviews;
  const before = buildDocQaReport(root);
  assert.deepEqual(before.summary.trustCurrent, { offered: true, count: DOCS.length });
  const preview = previewTrustCurrentDocVersions(root);
  assert.equal(preview.offered, true);
  assert.deepEqual(preview.items.map((item) => item.path), [...DOCS].sort((left, right) => left.localeCompare(right, "en")));

  // Never a default: nothing was accepted by looking.
  assert.deepEqual(readDocReviewState(root).reviews, {});
  assert.throws(() => trustCurrentDocVersions(root, { items: [] }), { code: "trust_current_items_required" });

  const trusted = trustCurrentDocVersions(root, { items: preview.items, requestId: "trust-1" });
  assert.equal(trusted.count, DOCS.length);
  assert.equal(trusted.receipt.action, "trust-current");
  assert.equal(trusted.receipt.count, DOCS.length);
  assert.equal(trusted.receipt.undo.available, true);
  const reviews = readDocReviewState(root).reviews;
  for (const doc of DOCS) assert.equal(reviews[doc].status, "verified", doc);
  const after = buildDocQaReport(root);
  assert.equal(after.summary.needsReview, 0);
  assert.deepEqual(after.summary.trustCurrent, { offered: false, count: 0 });
  assert.equal(previewTrustCurrentDocVersions(root).reason, "has_accepted_versions");

  // One receipt for the whole gesture; a replay returns it.
  const history = readDocReviewHistory(root).receipts;
  assert.equal(history.length, 1);
  assert.equal(history[0].count, DOCS.length);
  assert.equal(trustCurrentDocVersions(root, { items: preview.items, requestId: "trust-1" }).receipt.id, trusted.receipt.id);

  // A file edit after the gesture does not block undo: there is no earlier accepted version.
  fs.appendFileSync(path.join(root, DOCS[0]), "\nAgent edit.\n", "utf8");
  const undone = undoDocReviewAcceptance(root, { receiptId: trusted.receipt.id, requestId: "undo-1" });
  assert.equal(undone.count, DOCS.length);
  assert.deepEqual(readDocReviewState(root).reviews, {});
  assert.deepEqual(readGlobalReviewLedger(root).reviews, ledgerBefore);
  assert.equal(buildDocQaReport(root).summary.needsReview, DOCS.length);
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: trusted.receipt.id }), { code: "review_decision_superseded" });
  assert.deepEqual(readDocReviewHistory(root).receipts.map((receipt) => receipt.action), ["undo", "trust-current"]);
  // Offered again once nothing is accepted.
  assert.equal(previewTrustCurrentDocVersions(root).offered, true);
});

test("undo of a trust is refused once a newer decision covers one of its files", () => {
  const root = makeProject("trust-newer");
  const trusted = trustCurrentDocVersions(root, { items: previewTrustCurrentDocVersions(root).items });
  fs.appendFileSync(path.join(root, DOCS[1]), "\nNew text.\n", "utf8");
  writeDocReviewDecision(root, DOCS[1], { status: "verified", receiptSource: "file-review" });
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: trusted.receipt.id }), { code: "review_decision_superseded" });
  assert.equal(readDocReviewState(root).reviews[DOCS[0]].status, "verified");
});

test("a file changed or added between the list and the confirmation stops the whole gesture", () => {
  const root = makeProject("trust-stale");
  const preview = previewTrustCurrentDocVersions(root);
  fs.appendFileSync(path.join(root, DOCS[2]), "\nChanged while the list was open.\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "new.md"), "# New\n", "utf8");
  execFileSync("git", ["add", "docs/new.md", DOCS[2]], { cwd: root, stdio: "ignore", env: gitEnv });
  assert.throws(() => trustCurrentDocVersions(root, { items: preview.items }), (error) => {
    assert.equal(error.code, "trust_current_stale");
    assert.deepEqual(error.details.changed, [DOCS[2]]);
    assert.deepEqual(error.details.added, ["docs/new.md"]);
    return true;
  });
  assert.deepEqual(readDocReviewState(root).reviews, {});
  assert.equal(readDocReviewHistory(root).receipts.length, 0);
  // A forged hash is refused the same way.
  const forged = previewTrustCurrentDocVersions(root).items.map((item, index) => index ? item : { ...item, contentHash: "0".repeat(64) });
  assert.throws(() => trustCurrentDocVersions(root, { items: forged }), { code: "trust_current_stale" });
});

test("Hub route lists the files, refuses the gesture without the human nonce and accepts it with it", async (t) => {
  const root = makeProject("trust-route");
  const registered = registerContextHubProject(root);
  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId };

  const listResponse = await fetch(`${origin}/api/context-hub/trust-current?projectId=${encodeURIComponent(registered.id)}`, { headers });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.count, DOCS.length);

  const body = JSON.stringify({ projectId: registered.id, items: list.items, requestId: "route-trust" });
  const noNonce = await fetch(origin + "/api/context-hub/trust-current", { method: "POST", headers, body });
  assert.equal(noNonce.status, 403);
  assert.equal((await noNonce.json()).code, "review_authority_nonce_required");
  const wrongNonce = await fetch(origin + "/api/context-hub/trust-current", { method: "POST", headers: { ...headers, "x-context-room-owner-nonce": "agent-guess" }, body });
  assert.equal(wrongNonce.status, 403);
  assert.deepEqual(readDocReviewState(root).reviews, {});

  const ownerHeaders = { ...headers, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const trusted = await fetch(origin + "/api/context-hub/trust-current", { method: "POST", headers: ownerHeaders, body });
  assert.equal(trusted.status, 200, await trusted.clone().text());
  const result = await trusted.json();
  assert.equal(result.count, DOCS.length);
  assert.equal(Object.keys(readDocReviewState(root).reviews).length, DOCS.length);

  const undo = await fetch(origin + "/api/context-hub/review-undo", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ projectId: registered.id, receiptId: result.receipt.id }) });
  assert.equal(undo.status, 200, await undo.clone().text());
  assert.deepEqual(readDocReviewState(root).reviews, {});
});
