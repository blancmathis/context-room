import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initializeContextRoomProject, writeMemoryWebappSettings, readProjectDocumentAssets, reviewProjectDocumentAsset,
  createLocalDocumentationProposal, submitLocalDocumentationProposal, reviewLocalDocumentationProposal } from "../src/context_room.mjs";
import { listDocumentAssets } from "../src/document_assets.mjs";
import { buildDocumentationCorpus, readDocumentation } from "../src/documentation.mjs";

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-assets-")), root = path.join(temp, "project"), old = {};
  for (const name of ["CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"]) { old[name] = process.env[name]; process.env[name] = path.join(temp, name); }
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  t.after(() => { for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } fs.rmSync(temp, { recursive: true, force: true }); });
  return { root, file: path.join(root, "docs/drawing.png") };
}

test("binary document review retains the accepted bytes through edits, deletion and refusal without Git", (t) => {
  const { root, file } = fixture(t), accepted = Buffer.from([137,80,78,71,0,255,10]);
  fs.writeFileSync(file, accepted);
  assert.equal(buildDocumentationCorpus(root).documents.some((doc) => doc.path.endsWith(".png")), false);
  let asset = readProjectDocumentAssets(root)[0];
  reviewProjectDocumentAsset(root, asset.path, { decision: "accepted", expectedRevision: asset.revision });
  fs.writeFileSync(file, Buffer.from([1,0,254]));
  const doc = readDocumentation(root, asset.path);
  assert.deepEqual(fs.readFileSync(doc.asset.acceptedFile), accepted);
  asset = readProjectDocumentAssets(root)[0];
  reviewProjectDocumentAsset(root, asset.path, { decision: "rejected", expectedRevision: asset.revision });
  assert.deepEqual(fs.readFileSync(file), accepted);
  fs.unlinkSync(file); asset = readProjectDocumentAssets(root)[0];
  reviewProjectDocumentAsset(root, asset.path, { decision: "rejected", expectedRevision: asset.revision });
  assert.deepEqual(fs.readFileSync(file), accepted);
  assert.equal(readProjectDocumentAssets(root)[0].pending, false);
});

test("local proposals contain accepted assets and can accept a human drawing without changing another asset", (t) => {
  const { root, file } = fixture(t), initial = Buffer.from([1,0,255]); fs.writeFileSync(file, initial);
  let asset = readProjectDocumentAssets(root)[0]; reviewProjectDocumentAsset(root, asset.path, { decision: "accepted", expectedRevision: asset.revision });
  const draft = createLocalDocumentationProposal(root, { title: "Drawing" });
  assert.deepEqual(fs.readFileSync(path.join(draft.editRoot, asset.path)), initial);
  fs.writeFileSync(path.join(draft.editRoot, asset.path), Buffer.from([1,0,254]));
  const submitted = submitLocalDocumentationProposal(root, draft.id);
  const human = Buffer.from([1,0,253]);
  reviewLocalDocumentationProposal(root, draft.id, { path: asset.path, decision: "accepted", expectedRevision: submitted.submittedRevision, content: human });
  assert.deepEqual(fs.readFileSync(file), human);
  assert.equal(readProjectDocumentAssets(root)[0].pending, false);
});

test("stale binary decisions preserve newer changes and reject a tampered accepted ledger", (t) => {
  const { root, file } = fixture(t); fs.writeFileSync(file, Buffer.from([1,0,255]));
  const first = readProjectDocumentAssets(root)[0]; fs.writeFileSync(file, Buffer.from([2,0,255]));
  assert.throws(() => reviewProjectDocumentAsset(root, first.path, { decision: "accepted", expectedRevision: first.revision }), /changed/);
  const fresh = readProjectDocumentAssets(root)[0]; reviewProjectDocumentAsset(root, fresh.path, { decision: "accepted", expectedRevision: fresh.revision });
  const ledger = path.join(root, ".context-room/document-assets/accepted.json");
  const state = JSON.parse(fs.readFileSync(ledger)); state[fresh.path].hash = "0".repeat(64); fs.writeFileSync(ledger, JSON.stringify(state));
  assert.throws(() => buildDocumentationCorpus(root), /authority/);
  assert.deepEqual(fs.readFileSync(file), Buffer.from([2,0,255]));
});

test("inspecting a location with symbolic links succeeds, reports them and never follows or changes them", (t) => {
  const { root } = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), "cr-assets-out-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, "docs"), { recursive: true });
  fs.writeFileSync(path.join(outside, "docs/hidden.png"), Buffer.from([1, 2, 3]));
  fs.symlinkSync(outside, path.join(root, "archive"));
  fs.symlinkSync(path.join(outside, "gone"), path.join(root, "docs/broken"));
  fs.symlinkSync(path.join(outside, "docs/hidden.png"), path.join(root, "docs/linked.png"));
  writeMemoryWebappSettings(root, { allowedPaths: ["docs/", "archive/docs/"], watchAllow: ["docs/", "archive/docs/"] });
  const assets = readProjectDocumentAssets(root);
  assert.deepEqual(assets.map((asset) => asset.path), []);
  assert.deepEqual({ count: assets.symbolicLinks.count, broken: assets.symbolicLinks.broken }, { count: 3, broken: 1 });
  assert.equal(fs.lstatSync(path.join(root, "archive")).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(path.join(outside, "docs/hidden.png")), Buffer.from([1, 2, 3]));
  assert.throws(() => reviewProjectDocumentAsset(root, "docs/linked.png", { decision: "accepted", expectedRevision: "x" }), /Symbolic links cannot be mutated/);
});

test("a scope that leaves the project root is refused before any directory is read", (t) => {
  const { root } = fixture(t), outside = path.join(path.dirname(root), "out");
  fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
  fs.symlinkSync(root, path.join(outside, "sub/l"));
  for (const scope of ["../out/", "docs/../../out/"]) assert.throws(() => listDocumentAssets(root, { allowedPaths: [scope] }), /canonical relative/);
});

test("an accepted asset under a folder that later became a link does not fail inspection", (t) => {
  const { root, file } = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), "cr-assets-out-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 0, 255, 10]));
  const asset = readProjectDocumentAssets(root)[0];
  reviewProjectDocumentAsset(root, asset.path, { decision: "accepted", expectedRevision: asset.revision });
  fs.renameSync(path.join(root, "docs"), path.join(outside, "docs"));
  fs.symlinkSync(path.join(outside, "docs"), path.join(root, "docs"));
  const assets = readProjectDocumentAssets(root);
  assert.deepEqual(assets.map((item) => item.path), []);
  assert.ok(assets.symbolicLinks.count >= 1);
});
