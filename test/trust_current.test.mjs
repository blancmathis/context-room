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
  assert.deepEqual(before.summary.trustCurrent, { offered: true });
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
  assert.deepEqual(after.summary.trustCurrent, { offered: false });
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
  // The request id of an undone trust gets a clear refusal, never a replay of a receipt that accepts nothing.
  assert.throws(() => trustCurrentDocVersions(root, { items: preview.items, requestId: "trust-1" }), { code: "trust_current_undone" });
  assert.deepEqual(readDocReviewState(root).reviews, {});
});

test("a file already accepted at the Git top level is never a candidate of a subfolder project", () => {
  const top = makeProject("trust-top");
  writeDocReviewDecision(top, "docs/notes/plan.md", { status: "verified", receiptSource: "file-review" });
  // Changed since that acceptance: it waits in review, but its accepted version belongs to the top level.
  fs.appendFileSync(path.join(top, "docs/notes/plan.md"), "\nAgent edit.\n", "utf8");
  const sub = path.join(top, "docs");
  initializeContextRoomProject(sub, { title: "sub", allowedPaths: ["notes/", "guide.md"], watchAllow: ["notes/", "guide.md"] });
  const preview = previewTrustCurrentDocVersions(sub);
  assert.deepEqual(preview.items.map((item) => item.path), ["guide.md"]);
  assert.deepEqual(preview.excluded, [{ path: "notes/plan.md", reason: "accepted_at_git_top_level" }]);
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

test("control files above the 750 KB file limit still snapshot: a 1 000-file trust, a later decision and the undo all succeed", () => {
  const root = makeProject("trust-large");
  const many = Array.from({ length: 1_000 }, (_, index) => `docs/bulk/${String(index).padStart(4, "0")}-a-fairly-long-document-name.md`);
  fs.mkdirSync(path.join(root, "docs", "bulk"), { recursive: true });
  for (const doc of many) fs.writeFileSync(path.join(root, doc), `# ${doc}\n`, "utf8");
  const preview = previewTrustCurrentDocVersions(root);
  assert.equal(preview.count, many.length + DOCS.length);
  const trusted = trustCurrentDocVersions(root, { items: preview.items });
  const stateBytes = fs.statSync(path.join(root, ".context-room", "review-state.json")).size;
  assert.ok(stateBytes > 750_000, `state is ${stateBytes} bytes`);
  const ledgerBytes = fs.statSync(path.join(root, ".context-room", "review-ledger.json")).size;
  assert.ok(ledgerBytes > 750_000, `ledger is ${ledgerBytes} bytes`);
  // A later single decision snapshots the large state and ledger.
  fs.writeFileSync(path.join(root, "docs", "later.md"), "# Later\n", "utf8");
  writeDocReviewDecision(root, "docs/later.md", { status: "verified", receiptSource: "file-review" });
  assert.equal(readDocReviewState(root).reviews["docs/later.md"].status, "verified");
  // The undo of the trust restores both large files.
  const undone = undoDocReviewAcceptance(root, { receiptId: trusted.receipt.id });
  assert.equal(undone.count, many.length + DOCS.length);
  assert.deepEqual(Object.keys(readDocReviewState(root).reviews), ["docs/later.md"]);
});

test("a trust of 2 000 files of 15 KB splits its baseline into parts under the bound; a later decision and the undo succeed", () => {
  const root = makeProject("trust-split");
  const body = "Line with \"quotes\" and text.\n".repeat(520).slice(0, 15_000);
  const many = Array.from({ length: 2_000 }, (_, index) => `docs/bulk/${String(index).padStart(4, "0")}.md`);
  fs.mkdirSync(path.join(root, "docs", "bulk"), { recursive: true });
  for (const doc of many) fs.writeFileSync(path.join(root, doc), `# ${doc}\n\n${body}`, "utf8");
  const preview = previewTrustCurrentDocVersions(root);
  assert.equal(preview.count, many.length + DOCS.length);
  const trusted = trustCurrentDocVersions(root, { items: preview.items });
  const receipt = readDocReviewHistory(root).receipts[0];
  assert.equal(receipt.action, "trust-current");
  const bundlesDir = path.join(root, ".context-room", "review-baselines", ".bundles");
  const parts = fs.readdirSync(bundlesDir).filter((name) => name.endsWith(".json"));
  assert.ok(parts.length >= 4, `${parts.length} parts`);
  for (const name of parts) assert.ok(fs.statSync(path.join(bundlesDir, name)).size < 8 * 1024 * 1024, name);
  const reviews = readDocReviewState(root).reviews;
  assert.equal(new Set(Object.values(reviews).map((entry) => entry.baselinePath)).size, parts.length);
  // Every entry reads its accepted text back from its own part.
  const controlFiles = [".context-room/review-state.json", ".context-room/review-ledger.json"].map((rel) => path.join(root, rel));
  const controlSnapshot = () => controlFiles.map((file) => {
    const stat = fs.statSync(file);
    return [file, stat.ino, stat.size, stat.mtimeMs, fs.readFileSync(file, "utf8")];
  });
  const beforeReports = controlSnapshot();
  const comparable = (report) => JSON.stringify({ ...report, generatedAt: null });
  const readOnlyReport = buildDocQaReport(root, { readOnly: true });
  const startedAt = Date.now();
  const firstReport = buildDocQaReport(root);
  const firstMs = Date.now() - startedAt;
  const secondReport = buildDocQaReport(root);
  assert.equal(firstReport.summary.needsReview, 0);
  // The writable report gives the read-only result, file by file, and writes nothing when nothing differs.
  assert.equal(comparable(firstReport), comparable(readOnlyReport));
  assert.equal(comparable(secondReport), comparable(firstReport));
  assert.deepEqual(controlSnapshot(), beforeReports, "a report with nothing to migrate writes no control file");
  assert.ok(firstMs < 30_000, `writable report took ${firstMs} ms`);
  // A later single decision, then the undo of the whole trust.
  fs.writeFileSync(path.join(root, "docs", "later.md"), "# Later\n", "utf8");
  writeDocReviewDecision(root, "docs/later.md", { status: "verified", receiptSource: "file-review" });
  const undone = undoDocReviewAcceptance(root, { receiptId: trusted.receipt.id });
  assert.equal(undone.count, many.length + DOCS.length);
  assert.deepEqual(Object.keys(readDocReviewState(root).reviews), ["docs/later.md"]);
  const left = fs.readdirSync(bundlesDir).filter((name) => parts.includes(name));
  assert.deepEqual(left, [], "the undo removes every part");
  // Trusted again: the same parts are written again.
  const again = previewTrustCurrentDocVersions(root);
  assert.equal(again.offered, false);
  assert.equal(again.reason, "has_accepted_versions");
});

test("more files than one trust can take are refused at the list, with a plain sentence", () => {
  const root = makeProject("trust-limit");
  fs.mkdirSync(path.join(root, "docs", "bulk"), { recursive: true });
  for (let index = 0; index < 5_001; index += 1) fs.writeFileSync(path.join(root, "docs", "bulk", `${index}.md`), "# x\n", "utf8");
  const preview = previewTrustCurrentDocVersions(root);
  assert.equal(preview.offered, false);
  assert.equal(preview.reason, "too_many_files");
  assert.equal(preview.maxFiles, 5_000);
  assert.ok(preview.count > 5_000);
  assert.throws(() => trustCurrentDocVersions(root, { items: [{ path: "docs/README.md", contentHash: "0".repeat(64) }] }), (error) => {
    assert.equal(error.code, "trust_current_unavailable");
    assert.match(error.message, /smaller folder/);
    return true;
  });
});

test("a trust list of long paths above the command-line limit still reads the Git index", () => {
  const root = makeProject("trust-long-paths");
  // About 4 900 paths of ~420 characters: more than 2 MB of Git arguments in one command.
  const folder = path.join("docs", ...Array.from({ length: 4 }, (_, index) => `${"long-folder-name-".repeat(5)}${index}`));
  fs.mkdirSync(path.join(root, folder), { recursive: true });
  const names = Array.from({ length: 4_900 }, (_, index) => path.join(folder, `${"a-long-document-name-".repeat(3)}${String(index).padStart(4, "0")}.md`));
  for (const name of names) fs.writeFileSync(path.join(root, name), "# x\n", "utf8");
  assert.ok(names.reduce((sum, name) => sum + name.length + 1, 0) > 2_000_000);
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore", env: gitEnv });
  const preview = previewTrustCurrentDocVersions(root);
  assert.equal(preview.offered, true, preview.reason);
  assert.equal(preview.count, names.length + DOCS.length);
});

test("a temporary part left by a crashed writer is removed at the next trust", () => {
  const root = makeProject("trust-stale-tmp");
  const bundlesDir = path.join(root, ".context-room", "review-baselines", ".bundles");
  fs.mkdirSync(bundlesDir, { recursive: true });
  const stale = path.join(bundlesDir, `.context-room-review-4242-${"ab".repeat(12)}.tmp`);
  const other = path.join(bundlesDir, "keep-me.tmp");
  fs.writeFileSync(stale, "{\"version\":1,", "utf8");
  fs.writeFileSync(other, "x", "utf8");
  const preview = previewTrustCurrentDocVersions(root);
  trustCurrentDocVersions(root, { items: preview.items });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(other), true, "only the writer's own temporary names are removed");
});
