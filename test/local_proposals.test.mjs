import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginLocalProposal, listLocalProposals, submitLocalProposal, inspectLocalProposal,
  decideLocalProposalFile, readLocalProposalFile, readAcceptedLocalProposalFile,
} from "../src/local_proposals.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-local-proposals-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/a.md"), "accepted A\n");
  fs.writeFileSync(path.join(root, "docs/b.md"), "accepted B\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const begin = () => beginLocalProposal(root, { title: "Documentation update", allowedPaths: ["docs/"],
    files: ["a.md", "b.md"].map((name) => ({ path: `docs/${name}`, content: fs.readFileSync(path.join(root, "docs", name)) })) });
  const edit = (proposal, file, text) => fs.writeFileSync(path.join(proposal.editRoot, file), text);
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const decide = (proposal, file, decision = "accepted", extra = {}) => decideLocalProposalFile(root, proposal.id, {
    path: file, decision, expectedRevision: proposal.submittedRevision, ...extra,
  });
  return { root, begin, edit, read, decide };
}

test("two local workspaces expose the whole corpus, stay isolated and share immutable stored bytes", (t) => {
  const { root, begin, edit, read } = fixture(t);
  const first = begin();
  const second = begin();
  assert.notEqual(first.editRoot, second.editRoot);
  assert.equal(fs.readFileSync(path.join(second.editRoot, "docs/b.md"), "utf8"), "accepted B\n");
  assert.equal(fs.statSync(path.join(first.editRoot, "docs/a.md")).nlink, 1);
  assert.equal(fs.statSync(path.join(second.editRoot, "docs/a.md")).nlink, 1);
  edit(first, "docs/a.md", "first proposal\n");
  assert.equal(read("docs/a.md"), "accepted A\n");
  assert.equal(fs.readFileSync(path.join(second.editRoot, "docs/a.md"), "utf8"), "accepted A\n");
  assert.equal(listLocalProposals(root, { readyOnly: true }).length, 0);
  const published = submitLocalProposal(root, first.id);
  assert.equal(listLocalProposals(root, { readyOnly: true }).length, 1);
  assert.deepEqual(published.changes.map((entry) => entry.path), ["docs/a.md"]);
  assert.equal(readLocalProposalFile(root, first.id, "docs/a.md").afterBytes.toString(), "first proposal\n");
  const objectFolder = path.join(root, ".context-room/local-proposals/objects");
  assert.equal(fs.readdirSync(objectFolder).flatMap((folder) => fs.readdirSync(path.join(objectFolder, folder))).length, 3);
});

test("acceptance is per file, human correction accepts exactly its bytes, rejection leaves originals intact", (t) => {
  const { root, begin, edit, read, decide } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "agent A");
  edit(proposal, "docs/b.md", "agent B");
  proposal = submitLocalProposal(root, proposal.id);
  const one = decide(proposal, "docs/a.md", "accepted", { content: "human A" });
  assert.equal(one.status, "submitted");
  assert.equal(read("docs/a.md"), "human A");
  assert.equal(read("docs/b.md"), "accepted B\n");
  const two = decide(proposal, "docs/b.md", "rejected");
  assert.equal(two.status, "resolved");
  assert.equal(read("docs/b.md"), "accepted B\n");
  fs.writeFileSync(path.join(root, "docs/a.md"), "later unaccepted content");
  assert.equal(readAcceptedLocalProposalFile(root, "docs/a.md").bytes.toString(), "human A");
  assert.equal(readAcceptedLocalProposalFile(root, "docs/unknown.md"), undefined);
  assert.equal(decide(proposal, "docs/a.md").status, "resolved");
  assert.equal(read("docs/a.md"), "later unaccepted content");
});

test("addition, binary modification, deletion and rename keep exact octets", (t) => {
  const { root, begin, edit, decide } = fixture(t);
  let proposal = begin();
  const pngBytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10]);
  edit(proposal, "docs/image.png", pngBytes);
  fs.renameSync(path.join(proposal.editRoot, "docs/a.md"), path.join(proposal.editRoot, "docs/renamed.md"));
  proposal = submitLocalProposal(root, proposal.id);
  for (const change of proposal.changes) decide(proposal, change.path);
  assert.equal(fs.existsSync(path.join(root, "docs/a.md")), false);
  assert.equal(readAcceptedLocalProposalFile(root, "docs/a.md"), null);
  assert.deepEqual(fs.readFileSync(path.join(root, "docs/image.png")), pngBytes);
  assert.equal(fs.readFileSync(path.join(root, "docs/renamed.md"), "utf8"), "accepted A\n");
});

test("a second proposal and an external edit cannot overwrite the changed original", (t) => {
  const { root, begin, edit, read, decide } = fixture(t);
  let first = begin();
  let second = begin();
  edit(first, "docs/a.md", "first");
  edit(second, "docs/a.md", "second");
  first = submitLocalProposal(root, first.id);
  second = submitLocalProposal(root, second.id);
  decide(first, "docs/a.md");
  assert.throws(() => decide(second, "docs/a.md"), { code: "local_proposal_conflict" });
  assert.equal(read("docs/a.md"), "first");
  fs.writeFileSync(path.join(root, "docs/a.md"), "external");
  assert.throws(() => decide(second, "docs/a.md"), { code: "local_proposal_conflict" });
  assert.equal(read("docs/a.md"), "external");
  decide(second, "docs/a.md", "rejected");
  assert.equal(read("docs/a.md"), "external");
});

test("post-submit edits freeze the old review and require a new submission", (t) => {
  const { root, begin, edit, decide, read } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "version one");
  proposal = submitLocalProposal(root, proposal.id);
  edit(proposal, "docs/a.md", "version two");
  assert.equal(readLocalProposalFile(root, proposal.id, "docs/a.md").afterBytes.toString(), "version one");
  assert.throws(() => decide(proposal, "docs/a.md"), { code: "local_proposal_stale" });
  const next = submitLocalProposal(root, proposal.id);
  assert.throws(() => decide(proposal, "docs/a.md"), { code: "local_proposal_stale" });
  decide(next, "docs/a.md");
  assert.equal(read("docs/a.md"), "version two");
});

test("source and workspace symlink substitutions and out-of-scope files are blocked", (t) => {
  const { root, begin, edit, decide } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "changed");
  proposal = submitLocalProposal(root, proposal.id);
  fs.renameSync(path.join(root, "docs"), path.join(root, "saved-docs"));
  fs.symlinkSync(path.join(root, "saved-docs"), path.join(root, "docs"));
  assert.throws(() => decide(proposal, "docs/a.md"), { code: "local_proposal_path" });
  assert.equal(fs.readFileSync(path.join(root, "saved-docs/a.md"), "utf8"), "accepted A\n");
  fs.unlinkSync(path.join(root, "docs"));
  fs.renameSync(path.join(root, "saved-docs"), path.join(root, "docs"));
  edit(proposal, "outside.md", "outside");
  assert.throws(() => submitLocalProposal(root, proposal.id), { code: "local_proposal_scope" });
  fs.unlinkSync(path.join(proposal.editRoot, "outside.md"));
  fs.unlinkSync(path.join(proposal.editRoot, "docs/a.md"));
  fs.symlinkSync(path.join(root, "docs/a.md"), path.join(proposal.editRoot, "docs/a.md"));
  assert.throws(() => submitLocalProposal(root, proposal.id), { code: "local_proposal_path" });
});

test("interruption after source application recovers the accepted snapshot and decision on retry", (t) => {
  const { root, begin, edit, decide, read } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "new bytes");
  proposal = submitLocalProposal(root, proposal.id);
  const link = fs.linkSync;
  fs.linkSync = (source, target) => {
    link(source, target);
    if (target === path.join(fs.realpathSync(root), "docs/a.md")) throw new Error("simulated interruption after rename");
  };
  try { assert.throws(() => decide(proposal, "docs/a.md"), /simulated interruption/); }
  finally { fs.linkSync = link; }
  assert.equal(read("docs/a.md"), "new bytes");
  assert.equal(inspectLocalProposal(root, proposal.id).status, "submitted");
  assert.equal(decide(proposal, "docs/a.md").status, "accepted");
  assert.equal(readAcceptedLocalProposalFile(root, "docs/a.md").bytes.toString(), "new bytes");
});

test("interrupted application followed by external edits reports recovery conflict and preserves data", (t) => {
  const { root, begin, edit, decide, read } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "new bytes");
  proposal = submitLocalProposal(root, proposal.id);
  const link = fs.linkSync;
  fs.linkSync = (source, target) => {
    link(source, target);
    if (target === path.join(fs.realpathSync(root), "docs/a.md")) throw new Error("interruption");
  };
  try { assert.throws(() => decide(proposal, "docs/a.md"), /interruption/); }
  finally { fs.linkSync = link; }
  fs.writeFileSync(path.join(root, "docs/a.md"), "external after crash");
  assert.throws(() => decide(proposal, "docs/a.md"), { code: "local_proposal_recovery_conflict" });
  assert.equal(read("docs/a.md"), "external after crash");
  assert.equal(readLocalProposalFile(root, proposal.id, "docs/a.md").afterBytes.toString(), "new bytes");
});

test("the review revision binds accepted bases as well as proposed bytes", (t) => {
  const { root, begin, edit, decide, read } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "proposed");
  proposal = submitLocalProposal(root, proposal.id);
  const manifest = path.join(root, ".context-room/local-proposals/proposals", proposal.id + ".json");
  const changed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  changed.base["docs/a.md"] = changed.base["docs/b.md"];
  fs.writeFileSync(manifest, JSON.stringify(changed));
  assert.throws(() => decide(proposal, "docs/a.md"), { code: "local_proposal_corrupt" });
  assert.equal(read("docs/a.md"), "accepted A\n");
});
