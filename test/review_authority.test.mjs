import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY,
  authorizeOwnerReviewScope,
  effectiveOwnerReviewScope,
  inspectOwnerProposalDecisions,
  inspectOwnerReviewScope,
  recordOwnerProposalDecision,
} from "../src/review_authority.mjs";

test("agent review authority reserves double confirmation for batch and terminal proposal decisions", () => {
  assert.equal(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.confirmationsRequired, 2);
  assert.deepEqual(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.appliesTo, ["multi-file-batch", "proposal-terminal"]);
  assert.equal(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.singleFileDecision, "direct-human-ui");
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /batch/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /proposal/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /after the first yes/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /restate the exact action, project, proposal or file scope, and effects/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.instruction, /second separate, unambiguous yes/i);
  assert.match(HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY.mutationRule, /do nothing/i);
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-review-authority-"));
  const root = path.join(base, "project");
  const home = path.join(base, "authority");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n");
  fs.writeFileSync(path.join(root, "docs", "INDEX.md"), "# Index\n");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, home };
}

function protectedSettings() {
  return {
    allowedPaths: ["AGENTS.md", "docs/", ".agents/skills/"],
    watchAllow: ["AGENTS.md", "docs/"],
    watchRules: [{ path: "docs/", mode: "recursive-live" }],
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] },
    startupSkills: { enabled: true, projectOnly: true, folderNames: [".agents/skills"] },
  };
}

test("direct config narrowing keeps the last owner-authorized review scope effective", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });

  const narrowed = {
    allowedPaths: [],
    watchAllow: [],
    watchRules: [{ path: "docs/private/", mode: "direct-current", files: ["docs/private/one.md"] }],
    startupContext: { enabled: false, projectOnly: true, fileNames: [], globalPaths: [] },
    startupSkills: { enabled: false, projectOnly: true, folderNames: [] },
  };
  const effective = effectiveOwnerReviewScope(root, narrowed, { authorityHome: home });

  assert.deepEqual(effective.watchAllow, ["AGENTS.md", "docs/"]);
  assert.equal(effective.watchRules.some((rule) => rule.path === "docs/" && rule.mode === "recursive-live"), true);
  assert.deepEqual(effective.watchRules.find((rule) => rule.path === "docs/private/"), { path: "docs/private/", mode: "recursive-live" });
  assert.equal(effective.startupContext.enabled, true);
  assert.equal(effective.startupSkills.enabled, true);
  assert.ok(effective.allowedPaths.includes("docs/"));

  const status = inspectOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.equal(status.tampered, true);
  assert.equal(status.severity, "critical");
  assert.ok(status.reductions.some((item) => item.field === "watchAllow"));
  assert.ok(status.reductions.some((item) => item.field === "startupSkills.enabled"));
  assert.ok(status.reductions.some((item) => item.reason === "narrower-descendant-override"));
});

test("an explicit owner authorization may intentionally replace the protected scope", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  const intentional = {
    allowedPaths: ["AGENTS.md"],
    watchAllow: ["AGENTS.md"],
    watchRules: [],
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] },
    startupSkills: { enabled: false, projectOnly: true, folderNames: [] },
  };
  authorizeOwnerReviewScope(root, intentional, { authorityHome: home, actor: "human-ui" });

  const status = inspectOwnerReviewScope(root, intentional, { authorityHome: home });
  assert.equal(status.tampered, false);
  assert.deepEqual(effectiveOwnerReviewScope(root, intentional, { authorityHome: home }).watchAllow, ["AGENTS.md"]);
});

test("a corrupted primary authority record fails closed through its signed mirror", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  const authorityPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  const tampered = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  tampered.scope.watchAllow = [];
  tampered.scope.watchRules = [];
  fs.writeFileSync(authorityPath, JSON.stringify(tampered, null, 2) + "\n");

  const narrowed = { ...protectedSettings(), watchAllow: [], watchRules: [] };
  const effective = effectiveOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.deepEqual(effective.watchAllow, ["AGENTS.md", "docs/"]);
  assert.deepEqual(effective.watchRules, [{ path: "docs/", mode: "recursive-live" }]);
  const inspected = inspectOwnerReviewScope(root, narrowed, { authorityHome: home });
  assert.equal(inspected.integrity, "recovered");
  assert.equal(inspected.tampered, true);
  assert.equal(inspected.severity, "critical");
});

test("corruption of both authority mirrors refuses to fall back to reduced project settings", (t) => {
  const { root, home } = fixture(t);
  authorizeOwnerReviewScope(root, protectedSettings(), { authorityHome: home, actor: "human-ui" });
  const authorityPath = inspectOwnerReviewScope(root, protectedSettings(), { authorityHome: home }).authorityPath;
  for (const filePath of [authorityPath, authorityPath + ".backup"]) {
    const tampered = JSON.parse(fs.readFileSync(filePath, "utf8"));
    tampered.scope.watchAllow = [];
    fs.writeFileSync(filePath, JSON.stringify(tampered, null, 2) + "\n");
  }

  assert.throws(
    () => effectiveOwnerReviewScope(root, { ...protectedSettings(), watchAllow: [] }, { authorityHome: home }),
    (error) => error?.code === "review_authority_unavailable" && error?.integrity === "invalid-signature",
  );
});

test("proposal terminal decisions are exact-revision receipts with tamper detection", (t) => {
  const { home } = fixture(t);
  const repository = "git@example.test:shared/context.git";
  const proposalHead = "a".repeat(40);
  recordOwnerProposalDecision(repository, {
    proposal: "proposal/demo/security",
    proposalHead,
    decision: "rejected",
    archiveRef: `rejected/demo/security-${proposalHead.slice(0, 12)}`,
  }, { authorityHome: home, actor: "owner@example.test" });

  const verified = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(verified.integrity, "verified");
  assert.equal(verified.decisions.length, 1);
  assert.equal(verified.decisions[0].proposalHead, proposalHead);
  assert.equal(verified.decisions[0].actor, "owner@example.test");

  const raw = JSON.parse(fs.readFileSync(verified.authorityPath, "utf8"));
  Object.values(raw.decisions)[0].decision = "accepted";
  fs.writeFileSync(verified.authorityPath, JSON.stringify(raw, null, 2) + "\n");
  const recovered = inspectOwnerProposalDecisions(repository, { authorityHome: home });
  assert.equal(recovered.integrity, "recovered");
  assert.equal(recovered.decisions[0].decision, "rejected");
  fs.writeFileSync(verified.authorityPath + ".backup", JSON.stringify(raw, null, 2) + "\n");
  assert.equal(inspectOwnerProposalDecisions(repository, { authorityHome: home }).integrity, "invalid-signature");
});
