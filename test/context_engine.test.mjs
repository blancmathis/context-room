import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextGraph,
  contextProviderProfile,
  createContextEngine,
  impactContext,
  resolveEffectiveContext,
  traceContext,
} from "../src/context_engine.mjs";

const target = { projectId: "hicharlie", locationId: "wt-main", folder: "apps/calls", provider: "codex" };

function resource(id, kind, locator, input = {}) {
  return { id, kind, locator, version: `${id}-v1`, providers: ["all"], truthState: "accepted", ...input };
}

function application(resourceId, input = {}) {
  return {
    resourceId,
    coordinate: target,
    status: "active",
    scope: "project",
    order: 0,
    evidence: { source: "fixture" },
    ...input,
  };
}

test("provider profiles describe Codex, Claude Code, and OpenCode with primary evidence", () => {
  const codex = contextProviderProfile("codex");
  assert.deepEqual(codex.instructions.projectFiles.slice(0, 2), ["AGENTS.override.md", "AGENTS.md"]);
  assert.equal(codex.instructions.order, "global-then-root-to-folder");
  assert.equal(codex.instructions.deviceRoot, "~/.codex");
  assert.deepEqual(codex.instructions.nativeTargets, ["AGENTS.override.md", "AGENTS.md"]);
  assert.deepEqual(codex.skills.project, [".agents/skills"]);
  assert.deepEqual(codex.skills.global, ["~/.agents/skills"]);
  assert.deepEqual(codex.skills.admin, ["/etc/codex/skills"]);
  assert.equal(codex.hooks.activation, "active-config-layers-and-feature-gate");
  assert.match(codex.evidence[0], /^https:\/\/developers\.openai\.com\//);

  const claude = contextProviderProfile("claude-code");
  assert.deepEqual(claude.skills.project, [".claude/skills"]);
  assert.equal(claude.instructions.deviceRoot, "~/.claude");
  assert.equal(claude.instructions.nativeTargets.includes(".claude/rules/**/*.md"), true);
  assert.deepEqual(claude.instructions.concatenates, ["CLAUDE.md", "CLAUDE.local.md"]);
  assert.match(claude.instructions.precedence, /uncertain/);
  assert.match(claude.evidence[0], /^https:\/\/docs\.anthropic\.com\//);

  const opencode = contextProviderProfile("opencode");
  assert.deepEqual(opencode.skills.global, ["~/.config/opencode/skills", "~/.claude/skills", "~/.agents/skills"]);
  assert.deepEqual(opencode.skills.project, [".opencode/skills", ".claude/skills", ".agents/skills"]);
  assert.equal(opencode.instructions.deviceRoot, "~/.config/opencode");
  assert.deepEqual(opencode.instructions.nativeTargets, ["AGENTS.md", "CLAUDE.md"]);
  assert.match(opencode.skills.precedence, /uncertain/);
  assert.match(opencode.evidence[0], /^https:\/\/opencode\.ai\//);
});

test("effective context orders nested instructions and preserves explicit override shadowing", () => {
  const graph = buildContextGraph({
    coordinate: target,
    resources: [
      resource("global", "instruction", "~/.codex/AGENTS.md"),
      resource("root", "instruction", "AGENTS.md"),
      resource("apps", "instruction", "apps/AGENTS.md"),
      resource("local", "instruction", "apps/calls/AGENTS.md"),
      resource("override", "instruction", "apps/calls/AGENTS.override.md"),
    ],
    applications: [
      application("global", { scope: "device", order: 0 }),
      application("root", { order: 10 }),
      application("apps", { scope: "subtree", subtree: "apps", order: 20 }),
      application("local", { scope: "folder", subtree: "apps/calls", order: 30, status: "shadowed", reason: "AGENTS.override.md wins in this directory." }),
      application("override", { scope: "folder", subtree: "apps/calls", order: 31 }),
    ],
  });
  const effective = resolveEffectiveContext(graph);
  assert.deepEqual(effective.instructions.map((item) => item.resource.id), ["global", "root", "apps", "override"]);
  assert.equal(effective.inactive.find((item) => item.resource.id === "local").application.status, "shadowed");
  const trace = traceContext(graph, "AGENTS.override.md");
  assert.equal(trace.status, "ok");
  assert.deepEqual(trace.chain.map((item) => item.resource.id), ["global", "root", "apps", "local", "override"]);
});

test("effective context separates local/shared skills, proven hooks, and uncertain hooks", () => {
  const graph = buildContextGraph({
    coordinate: target,
    resources: [
      resource("local-skill", "skill", ".codex/skills/testing/SKILL.md", { providers: ["codex"] }),
      resource("shared-skill", "skill", "shared://skills/call-quality", { source: "shared-main", providers: ["codex"], metadata: { collectionId: "calls" } }),
      resource("hook-active", "hook", ".codex/hooks.json", { providers: ["codex"] }),
      resource("hook-uncertain", "hook", "scripts/preflight.sh", { providers: ["codex"] }),
      resource("config", "provider-config", "~/.codex/config.toml", { providers: ["codex"] }),
    ],
    applications: [
      application("local-skill", { destination: ".codex/skills/testing" }),
      application("shared-skill", { scope: "shared", destination: ".codex/skills/call-quality" }),
      application("hook-active"),
      application("hook-uncertain", { status: "uncertain", evidence: null, reason: "Executable exists but no provider activation is proven." }),
      application("config"),
    ],
  });
  const effective = resolveEffectiveContext(graph);
  assert.deepEqual(effective.skills.map((item) => item.resource.id), ["local-skill", "shared-skill"]);
  assert.deepEqual(effective.hooks.map((item) => item.resource.id), ["hook-active"]);
  assert.equal(effective.inactive.find((item) => item.resource.id === "hook-uncertain").application.status, "uncertain");
  assert.deepEqual(effective.providerConfigs.map((item) => item.resource.id), ["config"]);
});

test("only accepted current documents enter effective documents and proposal content stays metadata-only", () => {
  const graph = buildContextGraph({
    coordinate: target,
    resources: [
      resource("local-current", "document", "docs/current.md", { review: { status: "verified", contentHash: "abc" }, metadata: { documentStatus: "current", managed: true } }),
      resource("shared-current", "document", "shared://hicharlie/docs/current.md", { source: "shared-main", metadata: { documentStatus: "current", managed: true } }),
      resource("target-doc", "document", "docs/feature_target.md", { metadata: { documentStatus: "target", managed: true } }),
      resource("unverified-doc", "document", "docs/unverified.md", { truthState: "unverified", review: { status: "unverified" }, metadata: { documentStatus: "current", managed: true } }),
      resource("proposal-content", "proposal", "proposal://feature/docs/current.md", { truthState: "proposal" }),
    ],
    applications: ["local-current", "shared-current", "target-doc", "unverified-doc", "proposal-content"].map((id, order) => application(id, { order })),
    proposals: [{ id: "proposal-7", title: "Improve calls", head: "abc123", status: "review" }],
  });
  const effective = resolveEffectiveContext(graph);
  assert.deepEqual(effective.documents.map((item) => item.resource.id), ["local-current", "shared-current"]);
  assert.equal(effective.inactive.find((item) => item.resource.id === "target-doc").application.status, "blocked");
  assert.equal(effective.inactive.find((item) => item.resource.id === "unverified-doc").application.status, "unverified");
  assert.equal(effective.inactive.find((item) => item.resource.id === "proposal-content").application.status, "inactive");
  assert.deepEqual(effective.proposals, [{ id: "proposal-7", title: "Improve calls", head: "abc123", status: "review" }]);
  assert.equal(JSON.stringify(effective.proposals).includes("content"), false);
});

test("shared-only coordinates expose accepted shared documents without inventing a local environment", () => {
  const effective = resolveEffectiveContext({
    coordinate: { projectId: "remote-only", locationId: "", folder: ".", provider: "opencode" },
    localEnvironment: "unavailable",
    resources: [resource("shared", "document", "shared://remote/docs/index.md", { source: "shared-main", metadata: { documentStatus: "current", managed: true } })],
    applications: [application("shared", { coordinate: { projectId: "remote-only", locationId: "", folder: ".", provider: "opencode" }, scope: "shared" })],
  });
  assert.equal(effective.localEnvironment, "unavailable");
  assert.deepEqual(effective.documents.map((item) => item.resource.id), ["shared"]);
  assert.equal(effective.instructions.length, 0);
});

test("impact returns only explicitly registered worktrees and preserves subtree scope", () => {
  const globalResource = resource("global-agent", "instruction", "/Users/test/.codex/AGENTS.md");
  const graph = buildContextGraph({
    coordinate: target,
    resources: [globalResource],
    registeredTargets: [
      target,
      { projectId: "other", locationId: "wt-other", folder: ".", provider: "codex" },
    ],
    applications: [
      application("global-agent", { scope: "subtree", subtree: "apps/calls" }),
      application("global-agent", { coordinate: { projectId: "other", locationId: "wt-other", folder: ".", provider: "codex" }, scope: "project" }),
      application("global-agent", { coordinate: { projectId: "other", locationId: "unregistered", folder: ".", provider: "codex" }, scope: "project" }),
    ],
  });
  const impact = impactContext(graph, "/Users/test/.codex/AGENTS.md");
  assert.equal(impact.status, "ok");
  assert.deepEqual(impact.projects, ["hicharlie", "other"]);
  assert.deepEqual(impact.worktrees, ["wt-main", "wt-other"]);
  assert.equal(impact.consumers[0].subtree, "apps/calls");
  assert.equal(impact.consumers.some((item) => item.locationId === "unregistered"), false);
});

test("ambiguous selectors return candidates without guessing", () => {
  const graph = buildContextGraph({
    coordinate: target,
    resources: [
      resource("root-agent", "instruction", "AGENTS.md"),
      resource("nested-agent", "instruction", "apps/AGENTS.md"),
    ],
    applications: [application("root-agent"), application("nested-agent")],
  });
  const result = traceContext(graph, "AGENTS.md");
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates.map((item) => item.id), ["root-agent", "nested-agent"]);
});

test("injectable engine uses the same graph for effective, trace, and impact", () => {
  let calls = 0;
  const engine = createContextEngine({
    inventory(coordinate) {
      calls += 1;
      return {
        resources: [resource("root", "instruction", "AGENTS.md")],
        applications: [application("root", { coordinate })],
        freshness: { state: "fresh" },
      };
    },
  });
  assert.equal(engine.effective(target).instructions.length, 1);
  assert.equal(engine.trace(target, "root").status, "ok");
  assert.equal(engine.impact(target, "root").status, "ok");
  assert.equal(calls, 3);
});
