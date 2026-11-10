import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  buildDocQaReport,
  buildReadOnlyDocumentationReviewSnapshot,
  initializeContextRoomProject,
  writeDocReviewBaseline,
  writeDocReviewDecision,
} from "../src/context_room.mjs";

// Accepting files one after another in the review flow must cost the same at
// the 50th file as at the first. Each report used to check the Git index once
// per reviewed file (2-3 git processes each), so every acceptance made the
// next refresh slower. The check now reads the index for all files at once.

const gitEnv = {
  GIT_AUTHOR_NAME: "Context Room Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Context Room Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
};

function countingGit(t) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-git-count-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return (fn) => {
    fs.writeFileSync(log, "");
    fn();
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  };
}

function project(t, docs) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cr-flow-speed-"));
  const root = path.join(parent, "project");
  const previous = { HOME: process.env.HOME, hub: process.env.CONTEXT_ROOM_HUB_HOME, shared: process.env.CONTEXT_ROOM_SHARED_HOME };
  process.env.HOME = parent;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(parent, "hub");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(parent, "shared");
  t.after(() => {
    for (const [key, name] of [["HOME", "HOME"], ["hub", "CONTEXT_ROOM_HUB_HOME"], ["shared", "CONTEXT_ROOM_SHARED_HOME"]]) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, env: { ...process.env, ...gitEnv }, stdio: "ignore" });
  git("init", "--initial-branch=main");
  for (let i = 0; i < docs; i += 1) fs.writeFileSync(path.join(root, "docs", `doc${i}.md`), `# Doc ${i}\n\nBody ${i}.\n`);
  initializeContextRoomProject(root, { title: "Speed", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  git("add", ".");
  git("commit", "-qm", "init");
  for (let i = 0; i < docs; i += 1) fs.appendFileSync(path.join(root, "docs", `doc${i}.md`), "\nPending change.\n");
  return root;
}

test("git work per review report does not grow with the number of accepted files", (t) => {
  const docs = 24;
  const root = project(t, docs);
  const count = countingGit(t);
  const accept = (from, to) => {
    for (let i = from; i < to; i += 1) writeDocReviewDecision(root, `docs/doc${i}.md`, { status: "verified" });
  };

  accept(0, 2);
  const reportAfterTwo = count(() => buildDocQaReport(root));
  const snapshotAfterTwo = count(() => buildReadOnlyDocumentationReviewSnapshot(root));
  accept(2, docs);
  const reportAfterAll = count(() => buildDocQaReport(root));
  const snapshotAfterAll = count(() => buildReadOnlyDocumentationReviewSnapshot(root));

  // Before the fix: about +2 git processes per accepted file (+44 here).
  assert.ok(reportAfterAll <= reportAfterTwo + 2, `docqa report: ${reportAfterTwo} git calls after 2 reviews, ${reportAfterAll} after ${docs}`);
  assert.ok(snapshotAfterAll <= snapshotAfterTwo + 2, `review snapshot: ${snapshotAfterTwo} git calls after 2 reviews, ${snapshotAfterAll} after ${docs}`);
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path.startsWith("docs/")), false, "every accepted file leaves the queue");
});

// A staged file differs from HEAD in the index, so the batch leaves it to the
// exact per-file check. The result must match what the exact check gave.
test("a reviewed file staged in Git keeps the same review result", (t) => {
  const root = project(t, 3);
  writeDocReviewDecision(root, "docs/doc0.md", { status: "verified" });
  writeDocReviewDecision(root, "docs/doc1.md", { status: "verified" });
  const queued = (report) => report.queue.map((item) => item.path).filter((p) => p.startsWith("docs/")).sort();
  const before = queued(buildDocQaReport(root));
  assert.deepEqual(before, ["docs/doc2.md"]);
  execFileSync("git", ["add", "docs/doc1.md"], { cwd: root, env: { ...process.env, ...gitEnv }, stdio: "ignore" });
  assert.deepEqual(queued(buildDocQaReport(root)), before);
});

// The review flow saves the review base after the next file opens, so the
// agent may write again in between. The base must be the version the reviewer
// saw (X1); a newer one (X2) is refused, so X1 -> X2 stays visible in review.
test("a queued review base write refuses a version the reviewer never saw", (t) => {
  const root = project(t, 1);
  const rel = "docs/doc0.md";
  const seen = fs.readFileSync(path.join(root, rel), "utf8");
  const seenHash = buildDocQaReport(root).queue.find((item) => item.path === rel).currentHash;
  fs.appendFileSync(path.join(root, rel), "\nWritten after the click.\n");
  assert.throws(
    () => writeDocReviewBaseline(root, rel, { note: "inline review applied", expectedContentHash: seenHash }),
    (error) => error.statusCode === 409 && error.code === "review_revision_conflict",
  );
  const pending = buildDocQaReport(root).queue.find((item) => item.path === rel);
  assert.ok(pending, "the file stays in review");
  assert.notEqual(pending.currentHash, seenHash);
  // The version seen still writes as before.
  fs.writeFileSync(path.join(root, rel), seen);
  assert.equal(writeDocReviewBaseline(root, rel, { expectedContentHash: seenHash }).path, rel);
});
