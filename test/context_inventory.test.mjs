import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildContextGraph, impactContext, resolveEffectiveContext } from "../src/context_engine.mjs";
import { buildContextInventory } from "../src/context_inventory.mjs";

function fixtureReaders(root, state = {}) {
  return {
    listProjects: () => state.projects || [{ id: "location-a", logicalProjectId: "project-a", root, available: true }],
    readSettings: () => ({
      startupContext: { enabled: true },
      startupSkills: { enabled: true },
      startupHooks: { enabled: true },
    }),
    listInstructions: () => state.instructions || [],
    listSkillFolders: () => state.skillFolders || [],
    listHooks: () => state.hooks || [],
    listDocuments: () => state.documents || [],
    readDocument: (_root, relPath) => state.documentContents[relPath],
    readReviewState: () => state.reviewState || { reviews: {} },
    readGlobalReviewLedger: () => state.globalLedger || { reviews: {} },
    readReviewQueue: () => ({ queue: state.queue || [] }),
    readDoctor: () => ({ issues: state.issues || [] }),
    readSharedConnection: () => state.connection || null,
    readSharedStatus: () => state.sharedStatus || { connected: false },
    verifySharedMain: () => state.sharedMain,
    readSharedDocuments: () => state.sharedDocuments || [],
    readSharedSkills: () => state.sharedSkills || { connected: false },
    readSharedInstructions: () => state.sharedInstructions || { connected: false },
    listProposals: () => state.proposals || [],
  };
}

test("inventory keeps only verified current local documents effective", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    const current = `---\ncontext_room:\n  kind: canonical\n  status: current\n---\n\nAccepted\n`;
    const pending = `---\ncontext_room:\n  kind: canonical\n  status: current\n---\n\nPending\n`;
    fs.writeFileSync(path.join(root, "docs", "accepted.md"), current);
    fs.writeFileSync(path.join(root, "docs", "pending.md"), pending);
    const currentHash = createHash("sha256").update(current).digest("hex");
    const pendingHash = createHash("sha256").update(pending).digest("hex");
    const readers = fixtureReaders(root, {
      documents: [{ path: "docs/accepted.md", exists: true }, { path: "docs/pending.md", exists: true }],
      documentContents: {
        "docs/accepted.md": { exists: true, content: current, contentHash: currentHash },
        "docs/pending.md": { exists: true, content: pending, contentHash: pendingHash },
      },
      reviewState: { reviews: { "docs/accepted.md": { status: "verified", contentHash: currentHash, reviewedAt: "2026-07-27T00:00:00Z" } } },
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "." }, { provider: "codex", readers });
    const effective = resolveEffectiveContext(buildContextGraph(inventory));
    assert.deepEqual(effective.documents.map((entry) => entry.resource.locator), ["docs/accepted.md"]);
    const blocked = effective.inactive.find((entry) => entry.resource.locator === "docs/pending.md");
    assert.equal(blocked?.application.status, "unverified", "unreviewed current documents remain visible but never enter effective documents");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inventory orders applicable instructions and leaves uncertain hooks inactive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "apps", "calls"), { recursive: true });
    const rootAgents = path.join(root, "AGENTS.md");
    const nestedAgents = path.join(root, "apps", "AGENTS.override.md");
    const hookPath = path.join(root, "hooks.json");
    fs.writeFileSync(rootAgents, "root");
    fs.writeFileSync(nestedAgents, "nested");
    fs.writeFileSync(hookPath, "{}");
    const readers = fixtureReaders(root, {
      instructions: [
        { startupContext: { absolutePath: nestedAgents, displayPath: nestedAgents, source: "project" } },
        { startupContext: { absolutePath: rootAgents, displayPath: rootAgents, source: "project" } },
      ],
      hooks: [{ startupHook: { absolutePath: hookPath, source: "custom", sourceLabel: "Custom", executable: false } }],
      documents: [], documentContents: {},
      reviewState: { reviews: {
        "AGENTS.md": { status: "verified", contentHash: createHash("sha256").update("root").digest("hex") },
        "apps/AGENTS.override.md": { status: "verified", contentHash: createHash("sha256").update("nested").digest("hex") },
      } },
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "apps/calls" }, { provider: "codex", readers });
    const effective = resolveEffectiveContext(buildContextGraph(inventory));
    assert.deepEqual(effective.instructions.filter((entry) => entry.resource.metadata.absolutePath.startsWith(fs.realpathSync(root))).map((entry) => path.basename(entry.resource.metadata.absolutePath)), ["AGENTS.md", "AGENTS.override.md"]);
    assert.equal(effective.inactive.find((entry) => entry.resource.kind === "hook")?.application.status, "uncertain");
    assert.equal(inventory.relations.some((relation) => relation.type === "overridden-by"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider-effective instructions stay active while their pending human review remains visible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const agents = path.join(root, "AGENTS.md");
    fs.writeFileSync(agents, "pending instruction");
    const readers = fixtureReaders(root, {
      instructions: [{ startupContext: { absolutePath: agents, displayPath: agents, source: "project" } }],
      queue: [{ path: "AGENTS.md", reviewReason: "unverified-current", review: null }],
      documents: [], documentContents: {},
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a" }, { provider: "codex", readers });
    const effective = resolveEffectiveContext(buildContextGraph(inventory));
    const projectInstruction = effective.instructions.find((entry) => entry.resource.metadata.absolutePath === fs.realpathSync(agents));
    assert.equal(projectInstruction.resource.truthState, "unverified");
    assert.equal(projectInstruction.resource.review.required, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider instruction discovery supplements legacy settings along the exact folder chain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const selected = path.join(root, "apps", "calls");
    fs.mkdirSync(selected, { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "root");
    fs.writeFileSync(path.join(root, "apps", "AGENTS.override.md"), "apps override");
    fs.writeFileSync(path.join(selected, "AGENTS.md"), "shadowed by local override");
    fs.writeFileSync(path.join(selected, "AGENTS.override.md"), "calls override");
    const readers = fixtureReaders(root, { instructions: [], documents: [], documentContents: {} });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "apps/calls" }, { provider: "codex", readers });
    const discovered = inventory.resources.filter((resource) => resource.kind === "instruction" && resource.metadata.absolutePath.startsWith(fs.realpathSync(root)));
    assert.deepEqual(discovered.map((resource) => path.basename(resource.metadata.absolutePath)), ["AGENTS.md", "AGENTS.override.md", "AGENTS.override.md"]);
    assert.equal(discovered.some((resource) => resource.metadata.absolutePath.endsWith("apps/calls/AGENTS.md")), false, "Codex uses one instruction file per directory and the override wins");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shared inventory uses accepted main documents and proposal metadata only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const sharedContent = `---\ncontext_room:\n  kind: canonical\n  status: current\n---\n\nCanonical main\n`;
    const sharedHash = createHash("sha256").update(sharedContent).digest("hex");
    const readers = fixtureReaders(root, {
      connection: { repository: "https://example.test/team/docs.git", projectId: "hicharlie" },
      sharedMain: {
        repository: "https://example.test/team/docs.git",
        revision: "a".repeat(40),
        defaultBranch: "main",
        repositoryConfig: { projectsPath: "projects" },
      },
      sharedDocuments: [{ path: "projects/hicharlie/docs/runtime.md", content: sharedContent, contentHash: sharedHash }],
      sharedSkills: { connected: true, repository: "https://example.test/team/docs.git", revision: "a".repeat(40), collections: [], destinations: [] },
      proposals: [{ branch: "proposal/hicharlie/rewrite", head: "b".repeat(40), title: "Rewrite runtime", description: "Proposal-only content", reviewStatus: "ready", files: ["projects/hicharlie/docs/runtime.md"] }],
      documents: [], documentContents: {},
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", shared: { repository: "https://example.test/team/docs.git", projectId: "hicharlie" } }, { provider: "codex", refreshShared: true, readers });
    const effective = resolveEffectiveContext(buildContextGraph(inventory));
    assert.equal(effective.documents.length, 1);
    assert.match(effective.documents[0].resource.id, /^git:https:\/\/example\.test\/team\/docs\.git#/);
    assert.equal(effective.proposals.length, 1);
    assert.equal(JSON.stringify(effective.documents).includes("Proposal-only content"), false);
    assert.equal(effective.graph.resources.find((resource) => resource.kind === "proposal").truthState, "proposal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepted Shared Instructions enter effective context with assignment provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const calls = path.join(root, "apps", "calls");
    const snapshotFile = path.join(root, "accepted", "AGENTS.md");
    const destination = path.join(calls, "AGENTS.md");
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.mkdirSync(calls, { recursive: true });
    fs.writeFileSync(snapshotFile, "accepted shared instructions");
    const revision = "b".repeat(40);
    const repository = "https://example.test/team/docs.git";
    const readers = fixtureReaders(root, {
      connection: { repository, projectId: "project-a" },
      sharedMain: { repository, revision, defaultBranch: "main", repositoryConfig: { projectsPath: "projects" } },
      sharedDocuments: [],
      sharedSkills: { connected: true, repository, revision, collections: [], destinations: [] },
      sharedInstructions: {
        connected: true,
        repository,
        projectId: "project-a",
        revision,
        collections: [{ id: "team", path: "instructions/team" }],
        links: [{ assignmentId: "team-project", collectionId: "team", provider: "codex", scope: "project", source: "AGENTS.md", target: snapshotFile, destination, relativeTarget: "apps/calls/AGENTS.md", status: "ready", materializationStatus: "installed", activationStatus: "active" }],
      },
      documents: [],
      documentContents: {},
    });
    const effective = resolveEffectiveContext(buildContextGraph(buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "apps/calls" }, { provider: "codex", readers, refreshShared: true })));
    const instruction = effective.instructions.find((entry) => entry.resource.source === "shared-main");
    assert.equal(instruction.resource.truthState, "accepted");
    assert.equal(instruction.resource.metadata.assignmentId, "team-project");
    assert.equal(instruction.application.status, "active");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installed Shared Instructions stay outside effective context when provider activation is not proven", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const snapshotFile = path.join(root, "accepted", "CALL.md");
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(snapshotFile, "accepted but undiscovered instructions");
    const revision = "d".repeat(40);
    const repository = "https://example.test/team/docs.git";
    const readers = fixtureReaders(root, {
      connection: { repository, projectId: "project-a" },
      sharedMain: { repository, revision, defaultBranch: "main", repositoryConfig: { projectsPath: "projects" } },
      sharedDocuments: [],
      sharedSkills: { connected: true, repository, revision, collections: [], destinations: [] },
      sharedInstructions: {
        connected: true,
        repository,
        projectId: "project-a",
        revision,
        collections: [{ id: "team", path: "instructions/team" }],
        links: [{ assignmentId: "team-project", collectionId: "team", provider: "codex", scope: "project", source: "CALL.md", target: snapshotFile, destination: path.join(root, "CALL.md"), relativeTarget: "CALL.md", status: "ready", materializationStatus: "installed", activationStatus: "inactive", activationReason: "Not discovered by Codex" }],
      },
      documents: [],
      documentContents: {},
    });
    const effective = resolveEffectiveContext(buildContextGraph(buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "." }, { provider: "codex", readers, refreshShared: true })));
    assert.equal(effective.instructions.some((entry) => entry.resource.metadata.assignmentId === "team-project"), false);
    assert.equal(effective.inactive.some((entry) => entry.resource.metadata.assignmentId === "team-project" && entry.resource.metadata.materializationStatus === "installed"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Shared Skills map nonempty destinations to their registered consumers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const otherRoot = path.join(root, "other-location");
    const skillRoot = path.join(root, "accepted", "team-skill");
    fs.mkdirSync(otherRoot, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "# Accepted team skill\n");
    const revision = "e".repeat(40);
    const repository = "https://example.test/team/docs.git";
    const readers = fixtureReaders(root, {
      projects: [
        { id: "location-a", logicalProjectId: "project-a", root, available: true },
        { id: "location-b", logicalProjectId: "project-a", root: otherRoot, available: true },
      ],
      connection: { repository, projectId: "project-a" },
      sharedMain: { repository, revision, defaultBranch: "main", repositoryConfig: { projectsPath: "projects" } },
      sharedSkills: {
        connected: true, repository, revision,
        collections: [{ id: "team", path: "skills/team" }],
        destinations: [{
          collectionId: "team", assignmentId: "team-project", provider: "codex", scope: "project", status: "ready",
          destination: path.join(otherRoot, ".agents", "skills"), skills: ["team-skill"],
          target: [{ skill: "team-skill", target: skillRoot }], consumers: [{ projectRoot: otherRoot }],
        }],
      },
      documents: [], documentContents: {},
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "." }, { provider: "codex", readers, refreshShared: true });
    const skill = inventory.resources.find((resource) => resource.kind === "skill" && resource.source === "shared-main");
    assert.ok(skill);
    assert.equal(skill.truthState, "accepted");
    assert.equal(skill.version, `${revision}:${createHash("sha256").update("# Accepted team skill\n").digest("hex")}`);
    const applications = inventory.applications.filter((application) => application.resourceId === skill.id);
    assert.equal(applications.length, 1);
    assert.equal(applications[0].coordinate.locationId, "location-b");
    assert.equal(applications[0].status, "active");
    assert.equal(applications[0].evidence.consumerSource, "accepted-assignment-consumers");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shared freshness is explicit and registered worktrees are the only targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const readers = fixtureReaders(root, {
      connection: { repository: "https://example.test/team/docs.git", projectId: "hicharlie" },
      sharedStatus: { revision: "c".repeat(40), online: false, repositoryConfig: { projectsPath: "projects", defaultBranch: "main" } },
      documents: [], documentContents: {},
    });
    assert.throws(() => buildContextInventory({ root, projectId: "project-a", locationId: "location-a" }, { provider: "codex", refreshShared: false, readers }), (error) => error.code === "shared-freshness-unverified");
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a" }, { provider: "codex", refreshShared: false, allowStale: true, readers });
    assert.equal(inventory.freshness.state, "offline");
    assert.deepEqual(inventory.registeredTargets.map((target) => target.locationId), ["location-a"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider skill discovery follows the exact folder chain for Codex and OpenCode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    const selected = path.join(root, "apps", "calls");
    for (const manifest of [
      path.join(root, ".agents", "skills", "root-agent", "SKILL.md"),
      path.join(root, "apps", ".agents", "skills", "app-agent", "SKILL.md"),
      path.join(selected, ".claude", "skills", "claude-compatible", "SKILL.md"),
      path.join(selected, ".opencode", "skills", "opencode-native", "SKILL.md"),
      path.join(root, ".codex", "skills", "legacy-codex", "SKILL.md"),
    ]) {
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, `# ${path.basename(path.dirname(manifest))}\n`);
    }
    const stableRoot = fs.realpathSync(root);
    const readers = fixtureReaders(root, {
      documents: [], documentContents: {},
      skillFolders: [{ absolutePath: path.join(root, ".codex", "skills"), displayPath: path.join(root, ".codex", "skills"), skills: ["legacy-codex"], readOnly: false }],
    });
    const codex = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "apps/calls" }, { provider: "codex", readers });
    assert.deepEqual(codex.resources.filter((resource) => resource.kind === "skill" && resource.source === "provider-profile" && resource.metadata.absolutePath.startsWith(stableRoot)).map((resource) => resource.metadata.name).sort(), ["app-agent", "root-agent"]);
    const nestedCodex = codex.applications.find((application) => application.resourceId.includes("app-agent"));
    assert.equal(nestedCodex.scope, "subtree");
    assert.equal(nestedCodex.subtree, "apps");
    assert.equal(codex.applications.find((application) => application.resourceId.includes("legacy-codex"))?.status, "uncertain");

    const opencode = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "apps/calls" }, { provider: "opencode", readers });
    assert.deepEqual(opencode.resources.filter((resource) => resource.kind === "skill" && resource.source === "provider-profile" && resource.metadata.absolutePath.startsWith(stableRoot)).map((resource) => resource.metadata.name).sort(), ["app-agent", "claude-compatible", "opencode-native", "root-agent"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider-profile hook activation is proven while unsupported legacy hooks stay uncertain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-"));
  try {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo check" }] }] } }));
    const legacyPath = path.join(root, "legacy-hook.json");
    fs.writeFileSync(legacyPath, "{}");
    const readers = fixtureReaders(root, {
      documents: [], documentContents: {},
      hooks: [{ startupHook: { absolutePath: legacyPath, provider: "claude-code", source: "custom", sourceLabel: "Custom", executable: false } }],
    });
    delete readers.listProviderHookSources;
    delete readers.listProviderSkillFolders;
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a" }, { provider: "claude-code", readers });
    const graph = buildContextGraph(inventory);
    const effective = resolveEffectiveContext(graph);
    assert.equal(effective.hooks.some((entry) => entry.resource.locator.endsWith("/.claude/settings.json")), true);
    assert.equal(effective.inactive.find((entry) => entry.resource.locator.endsWith("legacy-hook.json"))?.application.status, "uncertain");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inventory impact expands a proven global resource to every registered consumer only", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-inventory-impact-"));
  try {
    const root = path.join(base, "project-a-main");
    const worktree = path.join(base, "project-a-worktree");
    const other = path.join(base, "project-b-main");
    const unregistered = path.join(base, "not-registered");
    const globalAgent = path.join(base, "global", "AGENTS.md");
    for (const directory of [root, worktree, other, unregistered, path.dirname(globalAgent)]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(globalAgent, "global instructions");
    const readers = fixtureReaders(root, {
      projects: [
        { id: "location-a", logicalProjectId: "project-a", root, available: true },
        { id: "location-a-2", logicalProjectId: "project-a", root: worktree, available: true },
        { id: "location-b", logicalProjectId: "project-b", root: other, available: true },
        { id: "location-c-offline", logicalProjectId: "project-c", root: path.join(base, "registered-but-unavailable"), available: false },
      ],
      instructions: [], documents: [], documentContents: {},
    });
    readers.listProviderInstructions = () => [{
      label: "AGENTS.md",
      startupContext: {
        absolutePath: globalAgent,
        displayPath: globalAgent,
        source: "global",
        provider: "codex",
        activationProven: true,
        evidence: { profile: "codex", discovery: "test-global" },
      },
    }];
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a" }, { provider: "codex", readers });
    const impact = impactContext(buildContextGraph(inventory), fs.realpathSync(globalAgent));
    assert.equal(impact.status, "ok");
    assert.deepEqual(impact.projects.sort(), ["project-a", "project-b", "project-c"]);
    assert.deepEqual(impact.worktrees.sort(), ["location-a", "location-a-2", "location-b", "location-c-offline"]);
    assert.equal(impact.consumers.some((consumer) => consumer.locationId === "not-registered"), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function withHome(home, callback) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return callback(); } finally { process.env.HOME = previous; }
}

function claudeEffective(root, runtime) {
  const readers = fixtureReaders(root, { instructions: [], documents: [], documentContents: {} });
  readers.readProviderRuntime = () => runtime;
  const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "." }, { provider: "claude-code", readers });
  const effective = resolveEffectiveContext(buildContextGraph(inventory));
  const byName = (name) => [...effective.instructions, ...effective.inactive].find((entry) => entry.resource.locator.endsWith(name));
  return { effective, byName };
}

test("Claude Code loads AGENTS.md only without a CLAUDE.md-family file, from version 2.1.277", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-claude-agents-")));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(base, "home"), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  try {
    withHome(path.join(base, "home"), () => {
      const current = { mode: "claude-md-or-agents-md", modeSource: "default", version: "2.1.289", source: "test" };
      assert.equal(claudeEffective(root, current).byName("AGENTS.md").application.status, "active");
      assert.equal(claudeEffective(root, { ...current, version: "2.1.276" }).byName("AGENTS.md").application.status, "inactive");
      assert.equal(claudeEffective(root, { ...current, version: "" }).byName("AGENTS.md").application.status, "uncertain", "an unknown Claude Code version is not proof");
      assert.equal(claudeEffective(root, { ...current, mode: "claude-md" }).byName("AGENTS.md").application.status, "inactive");
      assert.equal(claudeEffective(root, { ...current, mode: "" }).byName("AGENTS.md").application.status, "uncertain");

      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", "CLAUDE.md"), "# Claude\n");
      const blocked = claudeEffective(root, current);
      const claude = blocked.byName(".claude/CLAUDE.md");
      assert.equal(claude.application.status, "active", ".claude/CLAUDE.md belongs to the project root chain");
      assert.equal(claude.application.scope, "project");
      assert.equal(blocked.byName("AGENTS.md").application.status, "inactive");
      assert.match(blocked.byName("AGENTS.md").application.reason, /CLAUDE\.md exists/);
      assert.equal(claudeEffective(root, { ...current, mode: "claude-md-and-agents-md" }).byName("AGENTS.md").application.status, "active");
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Claude Code rules load from .claude/rules and path-scoped rules stay uncertain", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-claude-rules-")));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(base, "home"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "rules", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Claude\n");
  fs.writeFileSync(path.join(root, ".claude", "rules", "style.md"), "# Style\n");
  fs.writeFileSync(path.join(root, ".claude", "rules", "api", "routes.md"), "---\npaths:\n  - src/api/**\n---\n\n# Routes\n");
  try {
    withHome(path.join(base, "home"), () => {
      const { byName } = claudeEffective(root, { mode: "claude-md-or-agents-md", modeSource: "default", version: "2.1.289" });
      assert.equal(byName(".claude/rules/style.md").application.status, "active");
      assert.equal(byName(".claude/rules/style.md").application.scope, "project");
      assert.equal(byName(".claude/rules/api/routes.md").application.status, "uncertain");
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("hook output and MCP tools are reported as unknown context", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-claude-unknown-")));
  const home = path.join(base, "home");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo context" }] }], PreToolUse: [] } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-mcp", env: { TOKEN: "secret" } } } }));
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { approved: { command: "a" }, pending: { command: "b" } } }));
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["approved"] }));
  try {
    withHome(home, () => {
      const { effective } = claudeEffective(root, { mode: "claude-md-or-agents-md", modeSource: "default", version: "2.1.289" });
      assert.deepEqual(effective.mcpServers.map((entry) => entry.resource.metadata.name).sort(), ["approved", "docs"]);
      const pending = effective.inactive.find((entry) => entry.resource.metadata?.name === "pending");
      assert.equal(pending.application.status, "uncertain", "a project MCP server is not loaded before approval");
      assert.equal(JSON.stringify(effective.mcpServers).includes("secret"), false, "MCP configuration values never enter the inventory");
      const hook = effective.unknown.find((item) => item.kind === "hook-output");
      assert.deepEqual(hook.events, ["SessionStart"]);
      assert.deepEqual(effective.unknown.filter((item) => item.kind === "mcp-tools").length, 2);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("local skills and provider configuration are accepted only with a current human review", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-skill-authority-")));
  try {
    for (const name of ["reviewed", "unreviewed"]) {
      fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
      fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
    }
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), "model = \"x\"\n");
    const reviewedHash = createHash("sha256").update("# reviewed\n").digest("hex");
    const readers = fixtureReaders(root, {
      skillFolders: [{ absolutePath: path.join(root, "skills"), displayPath: "skills", skills: ["reviewed", "unreviewed"] }],
      reviewState: { reviews: { "skills/reviewed/SKILL.md": { status: "verified", contentHash: reviewedHash, reviewedAt: "2026-10-04T00:00:00Z" } } },
      documents: [], documentContents: {},
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a", folder: "." }, { provider: "codex", readers });
    const byLocator = (suffix) => inventory.resources.find((item) => item.locator.endsWith(suffix));
    assert.equal(byLocator("skills/reviewed/SKILL.md").truthState, "accepted");
    assert.equal(byLocator("skills/unreviewed/SKILL.md").truthState, "discovered");
    assert.equal(byLocator(".codex/config.toml").truthState, "discovered");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inventory classifies local origins by install location only", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-origin-")));
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const root = path.join(base, "project");
    const codexHome = path.join(base, "codex-home");
    const write = (file, content = "x") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
    write(path.join(root, "AGENTS.md"), "root");
    write(path.join(codexHome, "skills", "mine", "SKILL.md"));
    write(path.join(codexHome, "skills", ".system", "builtin", "SKILL.md"));
    write(path.join(codexHome, "plugins", "cache", "tool", "skills", "plugged", "SKILL.md"));
    const outsideHook = write(path.join(base, "elsewhere", "hook.sh"));
    process.env.CODEX_HOME = codexHome;
    const readers = fixtureReaders(root, {
      instructions: [{ startupContext: { absolutePath: path.join(root, "AGENTS.md"), displayPath: "AGENTS.md", source: "project" } }],
      skillFolders: [
        { absolutePath: path.join(codexHome, "skills"), skills: ["mine"] },
        { absolutePath: path.join(codexHome, "skills", ".system"), skills: ["builtin"], readOnly: true },
        { absolutePath: path.join(codexHome, "plugins", "cache", "tool", "skills"), skills: ["plugged"] },
      ],
      hooks: [{ startupHook: { absolutePath: outsideHook, source: "custom", executable: true } }],
      documents: [], documentContents: {},
    });
    const inventory = buildContextInventory({ root, projectId: "project-a", locationId: "location-a" }, { provider: "codex", readers });
    const origin = (suffix) => inventory.resources.find((resource) => resource.metadata?.absolutePath?.endsWith(suffix))?.origin?.class;
    assert.equal(origin("project/AGENTS.md"), "yours");
    assert.equal(origin("skills/mine/SKILL.md"), "yours");
    assert.equal(origin(".system/builtin/SKILL.md"), "provider");
    assert.equal(origin("plugged/SKILL.md"), "unconfirmed");
    assert.equal(origin("elsewhere/hook.sh"), "unconfirmed");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
