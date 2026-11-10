import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  beginLocalProposal, listLocalProposals, submitLocalProposal, inspectLocalProposal,
  decideLocalProposalFile, readLocalProposalFile, readAcceptedLocalProposalFile, rebaseLocalProposalFile,
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

test("a file absent from the agent working copy is reviewed and accepted against the real project file", (t) => {
  const { root, begin, edit, read, decide } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/readme.md"), "real unaccepted readme\n");
  let proposal = begin();
  assert.equal(fs.existsSync(path.join(proposal.editRoot, "docs/readme.md")), false);
  edit(proposal, "docs/readme.md", "agent readme\n");
  proposal = submitLocalProposal(root, proposal.id);
  const change = proposal.changes.find((entry) => entry.path === "docs/readme.md");
  assert.equal(change.kind, "modified");
  assert.equal(change.unseen, true);
  assert.equal(readLocalProposalFile(root, proposal.id, "docs/readme.md").beforeBytes.toString(), "real unaccepted readme\n");
  decide(proposal, "docs/readme.md");
  assert.equal(read("docs/readme.md"), "agent readme\n");
});

test("a target changed after submission is refused with a precise message and can be compared again", (t) => {
  const { root, begin, edit, read, decide } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/new.md", "agent new\n");
  proposal = submitLocalProposal(root, proposal.id);
  fs.writeFileSync(path.join(root, "docs/new.md"), "created by a human after submission\n");
  assert.throws(() => decide(proposal, "docs/new.md"), (error) => error.code === "local_proposal_conflict"
    && /docs\/new\.md now exists in the project/.test(error.message) && /Compare with current file/.test(error.message)
    && error.details?.expected === "absent" && error.details?.current === "present");
  assert.equal(read("docs/new.md"), "created by a human after submission\n");
  assert.throws(() => rebaseLocalProposalFile(root, proposal.id, { path: "docs/new.md", expectedRevision: "stale" }), { code: "local_proposal_stale" });
  const rebased = rebaseLocalProposalFile(root, proposal.id, { path: "docs/new.md", expectedRevision: proposal.submittedRevision });
  assert.notEqual(rebased.submittedRevision, proposal.submittedRevision);
  assert.throws(() => decide(proposal, "docs/new.md"), { code: "local_proposal_stale" });
  const file = readLocalProposalFile(root, proposal.id, "docs/new.md");
  assert.equal(file.kind, "modified");
  assert.equal(file.beforeBytes.toString(), "created by a human after submission\n");
  decide(rebased, "docs/new.md");
  assert.equal(read("docs/new.md"), "agent new\n");

  let edited = begin();
  edit(edited, "docs/b.md", "agent B\n");
  edited = submitLocalProposal(root, edited.id);
  fs.writeFileSync(path.join(root, "docs/b.md"), "human B\n");
  assert.throws(() => decide(edited, "docs/b.md"), /docs\/b\.md was edited in the project after this proposal was made/);
  assert.equal(inspectLocalProposal(root, edited.id).submittedRevision, edited.submittedRevision);
  assert.equal(read("docs/b.md"), "human B\n");
});

test("a compare that finds the agent's version already in the project closes that change without a decision", (t) => {
  const { root, begin, edit, read, decide } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/a.md", "agent A\n");
  edit(proposal, "docs/b.md", "agent B\n");
  proposal = submitLocalProposal(root, proposal.id);
  fs.writeFileSync(path.join(root, "docs/b.md"), "agent B\n");
  assert.throws(() => decide(proposal, "docs/b.md"), (error) => error.code === "local_proposal_conflict" && error.details?.action === "compare-current");
  const settled = rebaseLocalProposalFile(root, proposal.id, { path: "docs/b.md", expectedRevision: proposal.submittedRevision });
  assert.equal(settled.settled, true);
  assert.deepEqual(settled.changes.map((change) => change.path), ["docs/a.md"]);
  assert.equal(settled.status, "submitted");
  decide(settled, "docs/a.md");
  const kept = inspectLocalProposal(root, proposal.id);
  assert.equal(kept.status, "accepted");
  assert.deepEqual(Object.keys(kept.decisions), ["docs/a.md"], "a settled file never gets a decision");
  assert.equal(kept.settledFiles["docs/b.md"].reason, "already-in-project", "the settled file stays recorded");
  assert.equal(kept.settledFiles["docs/b.md"].by, "human");
  assert.ok(Date.parse(kept.settledFiles["docs/b.md"].at));
  assert.equal(read("docs/b.md"), "agent B\n");

  let only = begin();
  edit(only, "docs/b.md", "second agent B\n");
  only = submitLocalProposal(root, only.id);
  fs.rmSync(path.join(root, "docs/b.md"));
  fs.writeFileSync(path.join(root, "docs/b.md"), "second agent B\n");
  const closed = rebaseLocalProposalFile(root, only.id, { path: "docs/b.md", expectedRevision: only.submittedRevision });
  assert.equal(closed.settled, true);
  assert.deepEqual(closed.changes, []);
  assert.equal(closed.status, "settled", "no decision was made: the status never claims one");
  assert.deepEqual(closed.decisions, {});
  assert.equal(listLocalProposals(root, { readyOnly: true }).some((entry) => entry.id === only.id), false);
  assert.throws(() => submitLocalProposal(root, only.id), (error) => error.code === "local_proposal_closed");

  let gone = begin();
  fs.rmSync(path.join(gone.editRoot, "docs/a.md"));
  gone = submitLocalProposal(root, gone.id);
  fs.rmSync(path.join(root, "docs/a.md"));
  const both = rebaseLocalProposalFile(root, gone.id, { path: "docs/a.md", expectedRevision: gone.submittedRevision });
  assert.equal(both.settled, true);
  assert.equal(both.status, "settled");
  assert.equal(both.settledFiles["docs/a.md"].reason, "deleted-both-sides");
});

test("a mode the agent set on a file it never received is kept and shown as a permissions change", (t) => {
  const { root, begin, edit, decide } = fixture(t);
  for (const name of ["run.md", "same.md"]) fs.writeFileSync(path.join(root, "docs", name), "project " + name + "\n", { mode: 0o644 });
  fs.chmodSync(path.join(root, "docs/run.md"), 0o644);
  fs.chmodSync(path.join(root, "docs/same.md"), 0o644);
  fs.writeFileSync(path.join(root, "docs/tool.md"), "project tool\n");
  fs.chmodSync(path.join(root, "docs/tool.md"), 0o755);
  let proposal = begin();
  edit(proposal, "docs/run.md", "agent run\n");
  fs.chmodSync(path.join(proposal.editRoot, "docs/run.md"), 0o755);
  edit(proposal, "docs/same.md", "project same.md\n");
  fs.chmodSync(path.join(proposal.editRoot, "docs/same.md"), 0o755);
  edit(proposal, "docs/tool.md", "agent tool\n");
  fs.chmodSync(path.join(proposal.editRoot, "docs/tool.md"), 0o644);
  proposal = submitLocalProposal(root, proposal.id);
  const change = (rel) => proposal.changes.find((entry) => entry.path === rel);
  assert.equal(change("docs/run.md").unseen, true);
  assert.equal(change("docs/run.md").after.mode & 0o777, 0o755);
  assert.equal(change("docs/run.md").before.mode & 0o777, 0o644);
  assert.ok(change("docs/same.md"), "a mode-only change is still a change");
  assert.equal(change("docs/same.md").after.mode & 0o777, 0o755);
  assert.equal(change("docs/tool.md").after.mode & 0o777, 0o755, "a new file's default mode keeps the project's permissions");
  decide(proposal, "docs/run.md");
  assert.equal(fs.statSync(path.join(root, "docs/run.md")).mode & 0o777, 0o755);
});

test("an agent under umask 002 does not cause a permissions change on files it never received", (t) => {
  const { root, begin, edit } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/g.md"), "project g\n");
  fs.chmodSync(path.join(root, "docs/g.md"), 0o644);
  fs.writeFileSync(path.join(root, "docs/x.md"), "project x\n");
  fs.chmodSync(path.join(root, "docs/x.md"), 0o644);
  let proposal = begin();
  const previous = process.umask(0o002);
  try {
    edit(proposal, "docs/g.md", "agent g\n");
    fs.chmodSync(path.join(proposal.editRoot, "docs/g.md"), 0o664);
    edit(proposal, "docs/x.md", "agent x\n");
    fs.chmodSync(path.join(proposal.editRoot, "docs/x.md"), 0o775);
  } finally { process.umask(previous); }
  proposal = submitLocalProposal(root, proposal.id);
  const change = (rel) => proposal.changes.find((entry) => entry.path === rel);
  assert.equal(change("docs/g.md").after.mode & 0o777, 0o644, "664 is not a change Git tracks");
  assert.equal(change("docs/g.md").before.mode, change("docs/g.md").after.mode);
  assert.equal(change("docs/x.md").after.mode & 0o777, 0o775, "a real executable bit change is kept");
});

test("a rebased file the agent had is not described as unseen", (t) => {
  const { root, begin, edit } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/b.md", "agent B\n");
  proposal = submitLocalProposal(root, proposal.id);
  fs.writeFileSync(path.join(root, "docs/b.md"), "human B\n");
  rebaseLocalProposalFile(root, proposal.id, { path: "docs/b.md", expectedRevision: proposal.submittedRevision });
  const file = readLocalProposalFile(root, proposal.id, "docs/b.md");
  assert.equal(file.unseen, undefined);
  assert.equal(file.rebased, true);
  assert.equal(file.beforeBytes.toString(), "human B\n");
});

test("accept after a compare keeps a permission change made by the human unless the agent changed it", (t) => {
  const { root, begin, edit, read, decide } = fixture(t);
  let proposal = begin();
  edit(proposal, "docs/b.md", "agent B\n");
  proposal = submitLocalProposal(root, proposal.id);
  fs.chmodSync(path.join(root, "docs/b.md"), 0o755);
  assert.throws(() => decide(proposal, "docs/b.md"), /changed permissions in the project/);
  const rebased = rebaseLocalProposalFile(root, proposal.id, { path: "docs/b.md", expectedRevision: proposal.submittedRevision });
  const file = readLocalProposalFile(root, proposal.id, "docs/b.md");
  assert.equal(file.before.mode & 0o777, 0o755);
  assert.equal(file.after.mode & 0o777, 0o755, "the review shows the mode that Accept writes");
  decide(rebased, "docs/b.md");
  assert.equal(read("docs/b.md"), "agent B\n");
  assert.equal(fs.statSync(path.join(root, "docs/b.md")).mode & 0o777, 0o755);

  let chmod = begin();
  edit(chmod, "docs/a.md", "agent A\n");
  fs.chmodSync(path.join(chmod.editRoot, "docs/a.md"), 0o600);
  chmod = submitLocalProposal(root, chmod.id);
  fs.writeFileSync(path.join(root, "docs/a.md"), "human A\n");
  const again = rebaseLocalProposalFile(root, chmod.id, { path: "docs/a.md", expectedRevision: chmod.submittedRevision });
  assert.equal(readLocalProposalFile(root, chmod.id, "docs/a.md").after.mode & 0o777, 0o600);
  decide(again, "docs/a.md");
  assert.equal(fs.statSync(path.join(root, "docs/a.md")).mode & 0o777, 0o600, "the agent's own mode change is kept");
});

test("submit refuses a project file over the proposal file limit with a clear message", (t) => {
  const { root, begin, edit } = fixture(t);
  fs.writeFileSync(path.join(root, "docs/huge.md"), Buffer.alloc(32 * 1024 * 1024 + 1, 0x61));
  const proposal = begin();
  edit(proposal, "docs/huge.md", "agent summary\n");
  assert.throws(() => submitLocalProposal(root, proposal.id), (error) => error.code === "local_proposal_size"
    && /docs\/huge\.md in the project is larger than 32 MiB/.test(error.message));
  assert.equal(inspectLocalProposal(root, proposal.id).status, "editing");
});

test("the review offers Compare with current file only for a conflict that asks for it", () => {
  const source = fs.readFileSync(new URL("../src/ui/local-proposal-review.mjs", import.meta.url), "utf8");
  assert.match(source, /error\.details\?\.action === "compare-current"/);
  assert.doesNotMatch(source, /\/Compare with current file\/\.test\(/);
});
