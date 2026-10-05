import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerContextHubProject } from "../src/context_hub.mjs";
import {
  createMemoryServer,
  initializeContextRoomProject,
  readDocReviewHistory,
  readDocReviewState,
  readGlobalReviewLedger,
  undoDocReviewAcceptance,
  writeDocReviewDecision,
} from "../src/context_room.mjs";

const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-receipts-suite-"));
const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
process.env.CONTEXT_ROOM_HUB_HOME = path.join(suiteHome, "hub");
test.after(() => {
  if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
  else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

const DOC = "docs/README.md";

function makeProject(name) {
  const root = fs.mkdtempSync(path.join(suiteHome, `${name}-`));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, DOC), `# ${name}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "receipts@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Receipts Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  return root;
}

const accept = (root, source = "file-review", extra = {}) => writeDocReviewDecision(root, DOC, { status: "verified", receiptSource: source, ...extra });
const entryOf = (root) => readDocReviewState(root).reviews[DOC] || null;
const baselinePathOf = (root) => path.join(root, entryOf(root).baselinePath);
const gitIndex = (root) => execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" });

test("undo restores the previous acceptance without touching the file or the Git index", () => {
  const root = makeProject("undo-previous");
  const v0 = accept(root);
  const entryV0 = entryOf(root);
  const baselineFile = baselinePathOf(root);
  const baselineV0 = fs.readFileSync(baselineFile, "utf8");
  fs.appendFileSync(path.join(root, DOC), "\nAgent edit V1.\n", "utf8");
  const indexBefore = gitIndex(root);
  const v1 = accept(root);
  assert.equal(v1.receipt.undo.available, true);
  assert.notDeepEqual(entryOf(root), entryV0);

  const undone = undoDocReviewAcceptance(root, { receiptId: v1.receipt.id });
  assert.equal(undone.undoOf, v1.receipt.id);
  assert.deepEqual(entryOf(root), entryV0);
  assert.equal(fs.readFileSync(baselineFile, "utf8"), baselineV0);
  assert.match(fs.readFileSync(path.join(root, DOC), "utf8"), /Agent edit V1/);
  assert.equal(gitIndex(root), indexBefore);

  // The undo is now the head: neither receipt can be undone again, even though V0 looks current.
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: v1.receipt.id }), { code: "review_decision_superseded" });
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: v0.receipt.id }), { code: "review_decision_superseded" });
  const history = readDocReviewHistory(root).receipts;
  assert.deepEqual(history.map((receipt) => receipt.action), ["undo", "accept", "accept"]);
  assert.ok(history.every((receipt) => !receipt.undo.available));
});

test("undo of a first acceptance restores absence and never invents an accepted version", () => {
  const root = makeProject("undo-first");
  const key = Object.keys(readGlobalReviewLedger(root).reviews);
  const first = accept(root);
  const baselineFile = baselinePathOf(root);
  assert.ok(fs.existsSync(baselineFile));
  undoDocReviewAcceptance(root, { receiptId: first.receipt.id });
  assert.equal(entryOf(root), null);
  assert.deepEqual(Object.keys(readGlobalReviewLedger(root).reviews), key);
  assert.equal(fs.existsSync(baselineFile), false);
});

test("undo refuses newer decisions, changed files and decisions that were not plain acceptances", () => {
  const root = makeProject("undo-refusals");
  const first = accept(root);
  const again = accept(root);
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: first.receipt.id }), { code: "review_decision_superseded" });
  fs.appendFileSync(path.join(root, DOC), "\nChanged after acceptance.\n", "utf8");
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: again.receipt.id }), { code: "review_revision_conflict" });

  const internal = accept(root, null);
  assert.deepEqual(internal.receipt.undo, { available: false, reason: "source_not_undoable" });
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: internal.receipt.id }), { code: "review_undo_unsupported" });
  const changes = writeDocReviewDecision(root, DOC, { status: "needs_changes", receiptSource: "file-review" });
  assert.equal(changes.receipt.undo.reason, "not_an_acceptance");
});

test("a replayed request returns its committed receipt instead of deciding twice", () => {
  const root = makeProject("undo-replay");
  const first = accept(root, "file-review", { requestId: "request-1" });
  const replay = accept(root, "file-review", { requestId: "request-1" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(readDocReviewHistory(root).receipts.length, 1);
  assert.throws(() => writeDocReviewDecision(root, DOC, { status: "needs_changes", receiptSource: "file-review", requestId: "request-1" }), { code: "review_request_reused" });
  const undo = undoDocReviewAcceptance(root, { receiptId: first.receipt.id, requestId: "undo-1" });
  assert.equal(undoDocReviewAcceptance(root, { receiptId: first.receipt.id, requestId: "undo-1" }).receipt.id, undo.receipt.id);
});

test("a decision killed after its evidence writes is invisible to readers and undone by the next writer", () => {
  const root = makeProject("undo-crash");
  const accepted = accept(root);
  const stateBefore = fs.readFileSync(path.join(root, ".context-room", "review-state.json"), "utf8");
  fs.appendFileSync(path.join(root, DOC), "\nCrash candidate.\n", "utf8");
  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith("review-ledger.json")) process.exit(9); };
    const { writeDocReviewDecision } = await import(${JSON.stringify(moduleUrl)});
    writeDocReviewDecision(${JSON.stringify(root)}, ${JSON.stringify(DOC)}, { status: "verified", receiptSource: "file-review" });
  `], { env: process.env, encoding: "utf8" });
  assert.equal(child.status, 9, child.stderr);
  assert.notEqual(fs.readFileSync(path.join(root, ".context-room", "review-state.json"), "utf8"), stateBefore);

  // Readers see the state from before the interrupted decision.
  assert.equal(entryOf(root).contentHash, accepted.contentHash);
  assert.equal(readDocReviewState(root).authorityViolation, undefined);

  // A dead writer's lock is reclaimed after its stale delay; skip that wait here.
  for (const lock of fs.readdirSync(process.env.CONTEXT_ROOM_HUB_HOME, { recursive: true }).filter((name) => /docqa-[a-f0-9]+\.lock$/.test(name))) {
    fs.rmSync(path.join(process.env.CONTEXT_ROOM_HUB_HOME, lock), { recursive: true, force: true });
  }
  // The next writer restores the files first. Its own undo is then refused: the file changed.
  assert.throws(() => undoDocReviewAcceptance(root, { receiptId: accepted.receipt.id }), { code: "review_revision_conflict" });
  assert.equal(fs.readFileSync(path.join(root, ".context-room", "review-state.json"), "utf8"), stateBefore);
  assert.equal(readDocReviewHistory(root).receipts.length, 1);
});

test("Hub routes list receipts, undo one acceptance and refuse a bare unverify", async (t) => {
  const root = makeProject("undo-routes");
  const registered = registerContextHubProject(root);
  const accepted = accept(root, "hub-queue");
  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce };

  const unverify = await fetch(origin + "/api/docqa/review", { method: "POST", headers, body: JSON.stringify({ path: DOC, status: "unverified", expectedContentHash: accepted.contentHash }) });
  assert.equal(unverify.status, 400);
  assert.equal((await unverify.json()).code, "review_unverify_requires_receipt");

  const history = await (await fetch(origin + "/api/context-hub/review-history?limit=5", { headers })).json();
  const listed = history.receipts.find((receipt) => receipt.id === accepted.receipt.id);
  assert.equal(listed.projectId, registered.id);
  assert.equal(listed.undo.available, true);
  assert.equal(JSON.stringify(history).includes("signature"), false);

  const noNonce = await fetch(origin + "/api/context-hub/review-undo", { method: "POST", headers: { ...headers, "x-context-room-owner-nonce": "" }, body: JSON.stringify({ projectId: registered.id, receiptId: accepted.receipt.id }) });
  assert.notEqual(noNonce.status, 200);
  const undo = await fetch(origin + "/api/context-hub/review-undo", { method: "POST", headers, body: JSON.stringify({ projectId: registered.id, receiptId: accepted.receipt.id, requestId: "route-undo" }) });
  assert.equal(undo.status, 200, await undo.clone().text());
  assert.equal(entryOf(root), null);
});

test("receipt files stay out of the project", () => {
  const root = makeProject("undo-private");
  accept(root);
  const listing = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf8" });
  assert.equal(/receipt|journal/.test(listing), false);
  assert.ok(fs.existsSync(path.join(process.env.CONTEXT_ROOM_HUB_HOME, "review-authority", "review-receipts")));
});
