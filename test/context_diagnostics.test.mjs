import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextDiagnosticsError,
  buildProposalContextImpact,
  classifyProposalChangedFiles,
  explainDoctorIssue,
  filterDoctorIssues,
  normalizeDoctorIssue,
  planDoctorRepair,
  runtimeDocumentationReferenceKind,
} from "../src/context_diagnostics.mjs";

test("Doctor recognizes only documented generated and owner-optional runtime references", () => {
  assert.equal(runtimeDocumentationReferenceKind(".context-room/README.md"), "generated-runtime");
  assert.equal(runtimeDocumentationReferenceKind("./.context-room/README.md#workflow"), "generated-runtime");
  assert.equal(runtimeDocumentationReferenceKind(".context-room/review-gate.json"), "owner-optional-runtime");
  assert.equal(runtimeDocumentationReferenceKind(".context-room/missing.json"), "");
  assert.equal(runtimeDocumentationReferenceKind("docs/.context-room/README.md"), "");
});

test("Doctor issue normalization and coordinate filters use structured fields only", () => {
  const issue = normalizeDoctorIssue({
    type: "provider-disabled",
    severity: "high",
    path: "apps/calls/AGENTS.md",
    provider: "codex",
    projectId: "hicharlie",
    locationId: "wt-main",
    message: "This misleading message mentions claude and another/project.",
  }, { root: "/tmp/hicharlie" });

  assert.equal(issue.resourceId, "file:apps/calls/AGENTS.md");
  assert.equal(issue.absolutePath, "/tmp/hicharlie/apps/calls/AGENTS.md");
  assert.equal(filterDoctorIssues([issue], { projectId: "hicharlie", locationId: "wt-main", folder: "apps/calls", provider: "codex" }).length, 1);
  assert.equal(filterDoctorIssues([issue], { provider: "claude-code" }).length, 0);
  assert.equal(filterDoctorIssues([issue], { projectId: "another" }).length, 0);
});

test("Doctor explain and plan require an emitted issue key and an explicit deterministic adapter", () => {
  const issue = normalizeDoctorIssue({ type: "managed-link-stale", path: ".codex/skills/a", message: "Managed link points to an old snapshot." });
  assert.equal(explainDoctorIssue(issue.key, { issues: [issue] }).issue.type, "managed-link-stale");

  const unavailable = planDoctorRepair(issue.key, { issues: [issue] });
  assert.equal(unavailable.repairable, false);

  let applied = false;
  const planned = planDoctorRepair(issue.key, {
    issues: [issue],
    context: { expectedRevision: "abc" },
    repairAdapters: {
      "managed-link-stale": {
        plan(current) {
          assert.equal(current.key, issue.key);
          return { kind: "shared-skills.reconcile-managed-link", resourceId: current.resourceId };
        },
        apply() { applied = true; },
      },
    },
  });
  assert.equal(planned.repairable, true);
  assert.equal(planned.actions[0].kind, "shared-skills.reconcile-managed-link");
  assert.equal(planned.expectedRevision, "abc");
  assert.equal(applied, false, "planning must never invoke an apply adapter");
  assert.throws(() => explainDoctorIssue("missing", { issues: [issue] }), (error) => error.code === "doctor-issue-not-found");
});

test("Doctor rejects protected repair boundaries even when an adapter proposes them", () => {
  const issue = normalizeDoctorIssue({ type: "watch-not-allowed", path: "docs" });
  assert.throws(() => planDoctorRepair(issue.key, {
    issues: [issue],
    repairAdapters: {
      "watch-not-allowed": { plan: () => ({ kind: "allowed-path.expand", path: "docs" }) },
    },
  }), (error) => error instanceof ContextDiagnosticsError && error.code === "forbidden-doctor-repair");

  assert.throws(() => planDoctorRepair(issue.key, {
    issues: [issue],
    repairAdapters: {
      "watch-not-allowed": { plan: () => ({ kind: "custom", changesReviewDecision: true }) },
    },
  }), (error) => error.code === "forbidden-doctor-repair");
});

test("Proposal changed-file classification keeps docs, instructions, and Shared Skills explicit", () => {
  const classified = classifyProposalChangedFiles([
    { path: "projects/hicharlie/docs/runtime.md", status: "modified" },
    { path: "projects/hicharlie/AGENTS.override.md", status: "added" },
    { path: "skill-locations.json", status: "modified" },
    { path: "skills/call-quality/SKILL.md", status: "deleted" },
    { path: "instruction-locations.json", status: "modified" },
    { path: "instructions/team/calls.md", status: "added" },
    { path: "projects/hicharlie/src/app.mjs", status: "modified" },
  ]);
  assert.equal(classified.changedFiles.length, 7);
  assert.equal(classified.documents.length, 4);
  assert.equal(classified.instructions.length, 3);
  assert.equal(classified.sharedSkills.length, 2);
});

test("Proposal context impact compares exact accepted and proposal revisions without mutating state", async () => {
  const calls = [];
  let mutated = false;
  const adapters = {
    readProposal: async ({ selector, repository }) => {
      calls.push("readProposal");
      return { repository, branch: selector, head: "proposal-head", title: "Improve calls", projectId: "hicharlie" };
    },
    readAcceptedRevision: async ({ refresh }) => {
      calls.push(`readAcceptedRevision:${refresh}`);
      return { revision: "accepted-main", defaultBranch: "trunk" };
    },
    findMergeBase: async () => { calls.push("findMergeBase"); return "old-base"; },
    diffRevisions: async () => {
      calls.push("diffRevisions");
      return [
        { path: "projects/hicharlie/docs/runtime.md", status: "modified" },
        { path: "projects/hicharlie/AGENTS.md", status: "modified" },
        { path: "skill-locations.json", status: "modified" },
      ];
    },
    analyzeContextDelta: async () => ({ resources: [{ id: "doc:runtime" }] }),
    listRegisteredConsumers: async () => [
      { projectId: "hicharlie", locationId: "main", provider: "codex", folder: "apps/calls" },
      { projectId: "hicharlie", locationId: "wt-2", provider: "claude-code", folder: "apps/calls" },
    ],
    detectGitConflicts: async () => [{ path: "skill-locations.json", kind: "content" }],
    analyzeSharedSkills: async () => ({
      collections: ["calls"], assignments: ["calls-codex"], providers: ["codex"], destinations: ["~/.codex/skills"], collisions: [{ skill: "call-quality" }],
    }),
    readHealthAt: async ({ phase }) => phase === "accepted"
      ? [{ key: "old", type: "stale-link", resourceId: "skill:a" }]
      : [{ key: "new", type: "collision", resourceId: "skill:b" }],
    listExactReviewInvalidations: async () => [{ reviewId: "review-1", fromRevision: "accepted-main", toRevision: "proposal-head" }],
    analyzeDependencyInvalidations: async () => ({
      changedDependencies: [{ documentId: "strategy.trust", beforeVersion: "a", afterVersion: "b" }],
      dependentReviews: [{ documentId: "product.review", path: "projects/hicharlie/docs/review.md", dependencies: ["strategy.trust"], reviewRequired: true }],
      diagnostics: [],
    }),
    applyProposal: async () => { mutated = true; },
    reconcileSkills: async () => { mutated = true; },
  };

  const result = await buildProposalContextImpact({ selector: "proposal/hicharlie/improve-calls", repository: "team", adapters });
  assert.equal(result.base, "accepted-main");
  assert.equal(result.head, "proposal-head");
  assert.equal(result.defaultBranch, "trunk");
  assert.equal(result.needsRebase, true);
  assert.equal(result.semanticConflicts, "not-evaluated");
  assert.equal(result.contextCoverage.schemaVersion, "context-room.proposal-context-coverage/1");
  assert.ok(result.contextCoverage.evaluatedPaths.includes("projects/hicharlie/docs/runtime.md"));
  assert.ok(result.contextCoverage.requiredReviewPaths.includes("projects/hicharlie/docs/review.md"));
  assert.equal(result.reviewInvalidation.mode, "exact-revision");
  assert.equal(result.dependencyInvalidations.schemaVersion, "context-room.proposal-dependency-invalidations/1");
  assert.equal(result.dependencyInvalidations.dependentReviews[0].documentId, "product.review");
  assert.equal(result.affected.consumers.length, 2);
  assert.deepEqual(result.affected.sharedSkills.collections, ["calls"]);
  assert.equal(result.healthDelta.resolved[0].key, "old");
  assert.equal(result.healthDelta.introduced[0].key, "new");
  assert.equal(result.readOnly, true);
  assert.equal(mutated, false);
  assert.ok(calls.includes("readAcceptedRevision:true"));
});

test("Proposal context impact requires a repository for an ambiguous selector", async () => {
  await assert.rejects(() => buildProposalContextImpact({
    selector: "proposal/global/update",
    adapters: {
      listProposalCandidates: async () => [
        { repository: "internal", branch: "proposal/global/update", head: "a" },
        { repository: "external", branch: "proposal/global/update", head: "b" },
      ],
    },
  }), (error) => error.code === "proposal-repository-required" && error.details.candidates.length === 2);
});

test("Proposal context impact fails closed when accepted shared freshness is unavailable", async () => {
  await assert.rejects(() => buildProposalContextImpact({
    selector: "proposal/global/update",
    repository: "internal",
    adapters: {
      readProposal: async () => ({ repository: "internal", branch: "proposal/global/update", head: "proposal-head" }),
      readAcceptedRevision: async () => ({ revision: "" }),
    },
  }), (error) => error.code === "shared-freshness-unverified");
});
