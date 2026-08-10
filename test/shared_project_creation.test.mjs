import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import {
  acceptSharedReview,
  initializeSharedRepository,
  listSharedRepositoryProposals,
  materializeSharedRepositoryReview,
  proposeSharedProject,
  publishSharedRepositoryProposal,
  rejectSharedRepositoryProposal,
} from "../src/shared_context.mjs";
import {
  renderAppHtml,
  writeSharedProposalFileBatchDecision,
} from "../src/context_room.mjs";

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "shared-project@example.test"]);
  git(root, ["config", "user.name", "Shared Project Test"]);
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function makeSharedRepository(base, name) {
  const remote = path.join(base, `${name}.git`);
  const seed = path.join(base, `${name}-seed`);
  git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: `${name} Shared` });
  writeFile(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared context"]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed };
}

function fixture(t, { repositories = 1 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-project-")));
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });
  return {
    base,
    repositories: Array.from({ length: repositories }, (_, index) => makeSharedRepository(base, `remote-${index + 1}`)),
  };
}

function mainRevision(repository) {
  return git(repository, ["--git-dir", repository, "rev-parse", "refs/heads/main"]);
}

function remoteFile(repository, revision, relativePath) {
  return git(repository, ["--git-dir", repository, "show", `${revision}:${relativePath}`]);
}

test("a new Shared project stays proposal-only until every file is reviewed and accepted", (t) => {
  const { repositories: [repository] } = fixture(t);
  const mainBefore = mainRevision(repository.remote);

  const created = proposeSharedProject(repository.remote, {
    projectId: "orbit",
    title: "Orbit",
    path: "README.md",
    description: "Create the canonical Orbit documentation space and its initial review boundary.",
  });

  assert.equal(mainRevision(repository.remote), mainBefore);
  assert.equal(created.projectId, "orbit");
  assert.equal(created.projectPath, "projects/orbit");
  assert.equal(created.repositoryPath, "projects/orbit/docs/README.md");
  assert.deepEqual([...created.proposal.files].sort(), [
    "projects.json",
    "projects/orbit/docs/README.md",
  ]);
  assert.notEqual(
    spawnSync("git", ["--git-dir", repository.remote, "cat-file", "-e", "refs/heads/main:projects/orbit/docs/README.md"]).status,
    0,
  );

  const proposedCatalog = JSON.parse(remoteFile(repository.remote, `refs/heads/${created.proposal.branch}`, "projects.json"));
  assert.deepEqual(proposedCatalog.projects.at(-1), { id: "orbit", title: "Orbit" });
  const proposedDocument = remoteFile(repository.remote, `refs/heads/${created.proposal.branch}`, created.repositoryPath);
  assert.match(proposedDocument, /id: orbit\.docs\.readme/);
  assert.match(proposedDocument, /# Orbit/);

  const listed = listSharedRepositoryProposals(repository.remote, { allowOffline: false });
  const proposal = listed.proposals.find((item) => item.branch === created.proposal.branch);
  assert.equal(listed.projects.some((project) => project.id === "orbit"), false, "accepted catalog must not change before review");
  assert.equal(proposal?.createsProject, true);
  assert.equal(proposal?.projectTitle, "Orbit");
  assert.equal(proposal?.projectPath, "projects/orbit");

  const review = materializeSharedRepositoryReview(repository.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });
  assert.equal(review.metadata.createsProject, true);
  assert.equal(review.metadata.projectTitle, "Orbit");
  assert.deepEqual([...review.metadata.proposalFiles].sort(), [...created.proposal.files].sort());
  const reviewed = writeSharedProposalFileBatchDecision(review.reviewRoot, {
    expectedProposalHead: created.proposal.head,
    decision: "accept",
    files: created.proposal.files,
  });
  assert.deepEqual([...reviewed.reviewedPaths].sort(), [...created.proposal.files].sort());
  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept the Orbit Shared project" });

  assert.equal(accepted.accepted, true);
  assert.notEqual(mainRevision(repository.remote), mainBefore);
  const acceptedCatalog = JSON.parse(remoteFile(repository.remote, "refs/heads/main", "projects.json"));
  assert.deepEqual(acceptedCatalog.projects.at(-1), { id: "orbit", title: "Orbit" });
  assert.match(remoteFile(repository.remote, "refs/heads/main", created.repositoryPath), /id: orbit\.docs\.readme/);
});

test("rejecting a Shared project proposal preserves main and archives the exact head", (t) => {
  const { repositories: [repository] } = fixture(t);
  const mainBefore = mainRevision(repository.remote);
  const created = proposeSharedProject(repository.remote, {
    projectId: "nova",
    title: "Nova",
    description: "Exercise the terminal rejection path without mutating the accepted project catalog.",
  });

  const rejected = rejectSharedRepositoryProposal(repository.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });

  assert.equal(rejected.rejected, true);
  assert.equal(mainRevision(repository.remote), mainBefore);
  assert.equal(JSON.parse(remoteFile(repository.remote, "refs/heads/main", "projects.json")).projects.some((project) => project.id === "nova"), false);
  assert.equal(listSharedRepositoryProposals(repository.remote, { allowOffline: false }).proposals.some((item) => item.branch === created.proposal.branch), false);
  assert.equal(
    git(repository.seed, ["ls-remote", "--heads", "origin", rejected.rejectionBranch]).split(/\s+/)[0],
    created.proposal.head,
  );
});

test("project creation rejects partial file decisions and accepts the exact bundle", (t) => {
  const { repositories: [repository] } = fixture(t);
  const mainBefore = mainRevision(repository.remote);
  const created = proposeSharedProject(repository.remote, {
    projectId: "atomic",
    title: "Atomic",
    description: "Prove that the project catalog and its initial document remain one atomic reviewed result.",
  });
  const review = materializeSharedRepositoryReview(repository.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });
  assert.throws(
    () => writeSharedProposalFileBatchDecision(review.reviewRoot, {
      expectedProposalHead: created.proposal.head,
      decision: "accept",
      files: ["projects.json"],
    }),
    (error) => error?.code === "shared_project_creation_review_partial" && error?.statusCode === 409,
  );
  assert.throws(
    () => writeSharedProposalFileBatchDecision(review.reviewRoot, {
      expectedProposalHead: created.proposal.head,
      decision: "reject",
      files: [created.repositoryPath],
    }),
    (error) => error?.code === "shared_project_creation_review_partial" && error?.statusCode === 409,
  );
  assert.equal(mainRevision(repository.remote), mainBefore);

  const reviewed = writeSharedProposalFileBatchDecision(review.reviewRoot, {
    expectedProposalHead: created.proposal.head,
    decision: "accept",
    files: created.proposal.files,
  });
  assert.deepEqual([...reviewed.reviewedPaths].sort(), [...created.proposal.files].sort());
  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept the Atomic Shared project" });
  assert.equal(accepted.accepted, true);
  assert.notEqual(mainRevision(repository.remote), mainBefore);
});

test("Shared project creation validates identity, title, and initial document boundaries", (t) => {
  const { repositories: [repository] } = fixture(t);
  const valid = {
    title: "Invalid probe",
    description: "Validate the exact project creation boundary without publishing invalid proposals.",
  };

  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "Orbit" }), /must already use lowercase/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "../orbit" }), /must use lowercase/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "demo" }), /already exists/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "blank-title", title: "  " }), /title is required/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "multiline-title", title: "Two\nlines" }), /one line/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "hidden-doc", path: ".private.md" }), /hidden files or folders/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "escape-doc", path: "../README.md" }), /safe repository-relative path/);
  assert.throws(() => proposeSharedProject(repository.remote, { ...valid, projectId: "wrong-format", path: "README.txt" }), /must use the \.md extension/);
  assert.deepEqual(listSharedRepositoryProposals(repository.remote, { allowOffline: false }).proposals, []);
});

test("a project-creation proposal cannot smuggle another projects.json edit", (t) => {
  const { repositories: [repository] } = fixture(t);
  const created = proposeSharedProject(repository.remote, {
    projectId: "bounded",
    title: "Bounded",
    description: "Create one project while proving that every other catalog field stays immutable.",
  });
  const catalogPath = path.join(created.proposal.root, "projects.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  catalog.$schema = "https://invalid.example/changed-schema.json";
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");

  assert.throws(() => publishSharedRepositoryProposal(repository.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
    description: "Attempt to update the creation proposal with an unrelated catalog mutation.",
  }), /outside projects\/bounded\/docs\/ or projects\/bounded\/skills\//);
  assert.equal(
    git(repository.seed, ["ls-remote", "--heads", "origin", created.proposal.branch]).split(/\s+/)[0],
    created.proposal.head,
  );
});

test("the exact selected Shared receives the project proposal when several repositories exist", (t) => {
  const { repositories: [first, second] } = fixture(t, { repositories: 2 });
  const firstMain = mainRevision(first.remote);
  const secondMain = mainRevision(second.remote);

  const created = proposeSharedProject(second.remote, {
    projectId: "targeted",
    title: "Targeted",
    description: "Prove that a multi-Shared creation request cannot drift to another registered repository.",
  });

  assert.equal(mainRevision(first.remote), firstMain);
  assert.equal(mainRevision(second.remote), secondMain);
  assert.deepEqual(listSharedRepositoryProposals(first.remote, { allowOffline: false }).proposals, []);
  assert.equal(
    listSharedRepositoryProposals(second.remote, { allowOffline: false }).proposals.some((item) => item.branch === created.proposal.branch),
    true,
  );
  assert.equal(git(first.seed, ["ls-remote", "--heads", "origin", created.proposal.branch]), "");
  assert.equal(git(second.seed, ["ls-remote", "--heads", "origin", created.proposal.branch]).split(/\s+/)[0], created.proposal.head);
});

test("the Context Hub ships one explicit Shared-project proposal action", () => {
  const html = renderAppHtml();
  assert.match(html, /id="contextHubCreateSharedProject"/);
  assert.match(html, />New shared project</);
  assert.match(html, /function showContextHubCreateSharedProjectDialog\(\)/);
  assert.match(html, /POST \/api\/context-hub\/shared-projects|\/api\/context-hub\/shared-projects/);
  assert.match(html, /Shared main stays unchanged until human review and acceptance/);
});
