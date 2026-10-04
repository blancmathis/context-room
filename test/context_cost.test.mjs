import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { contextCost } from "../src/context_cost.mjs";
import { buildContextGraph, resolveEffectiveContext } from "../src/context_engine.mjs";
import { buildContextInventory } from "../src/context_inventory.mjs";

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-cost-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, home, write };
}

function entry(kind, file, { scope = "project", metadata = {} } = {}) {
  return {
    resource: { id: "file://" + file, kind, locator: file, metadata: { absolutePath: file, ...metadata } },
    application: { status: "active", scope, order: 0 },
  };
}

test("context cost splits startup, on-demand and unknown context and gauges hard limits only", (t) => {
  const { root, home, write } = workspace(t);
  const agents = write(path.join(root, "AGENTS.md"), "a".repeat(400));
  const description = "d".repeat(900);
  const skill = write(path.join(root, ".agents/skills/tidy/SKILL.md"), `---\nname: tidy\ndescription: ${description}\n---\n\n${"b".repeat(800)}\n`);
  const doc = write(path.join(root, "docs/guide.md"), "c".repeat(120));
  const hooks = write(path.join(home, ".claude/settings.json"), "{}");
  const effective = {
    coordinate: { provider: "codex", folder: "." },
    instructions: [entry("instruction", agents)],
    skills: [entry("skill", skill)],
    documents: [entry("document", doc)],
    hooks: [entry("hook", hooks, { scope: "device" })],
    unknown: [{ kind: "hook-output", resourceId: "file://" + hooks, locator: "~/.claude/settings.json", reason: "unknown size" }],
  };

  const cost = contextCost(effective, { root, home });
  assert.deepEqual(cost.entries["file://" + agents], { mode: "startup", startupTokens: 100, bytes: 400 });
  assert.equal(cost.entries["file://" + skill].mode, "description");
  assert.equal(cost.entries["file://" + skill].startupTokens, Math.ceil(`tidy: ${description}`.length / 4));
  assert.equal(cost.entries["file://" + skill].onDemandTokens, 200, "the skill body is loaded on use, not at startup");
  assert.deepEqual(cost.entries["file://" + doc], { mode: "on-demand", onDemandTokens: 30 });
  assert.deepEqual(cost.entries["file://" + hooks], { mode: "unknown" });
  assert.deepEqual(cost.startup, { tokens: 100 + cost.entries["file://" + skill].startupTokens, resources: 2, unmeasured: 0 });
  assert.deepEqual(cost.onDemand, { tokens: 230, resources: 2, unmeasured: 0 });
  assert.deepEqual(cost.unknown.map((item) => item.kind), ["hook-output"]);
  assert.deepEqual(cost.limits.map((limit) => [limit.id, limit.used, limit.max]), [["codex-project-doc", 400, 32768], ["skill-description", 900, 1024]]);

  const claude = contextCost({ ...effective, coordinate: { provider: "claude-code", folder: "." } }, { root, home });
  assert.deepEqual(claude.unknown.map((item) => item.kind), ["hook-output", "memory"]);
  assert.deepEqual(claude.limits.map((limit) => limit.id), ["skill-description"], "the Codex byte limit applies to Codex only");

  fs.rmSync(doc);
  assert.deepEqual(contextCost(effective, { root, home }).onDemand, { tokens: 200, resources: 2, unmeasured: 1 }, "an unreadable resource is counted as not measured, never as zero");
});

test("an unregistered root keeps its own context while other projects are registered", (t) => {
  const { root, write } = workspace(t);
  write(path.join(root, "AGENTS.md"), "Project rules.\n");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-cost-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const inventory = buildContextInventory({ root, projectId: "project-unregistered", locationId: "location-unregistered", folder: "." }, {
    provider: "codex",
    readers: {
      listProjects: () => [{ id: "location-other", logicalProjectId: "project-other", root: other, available: true }],
      readSettings: () => ({ startupContext: { enabled: true }, startupSkills: { enabled: true }, startupHooks: { enabled: true } }),
    },
  });
  const effective = resolveEffectiveContext(buildContextGraph(inventory));
  assert.ok(effective.instructions.some((item) => item.resource.metadata?.absolutePath === fs.realpathSync(path.join(root, "AGENTS.md"))),
    JSON.stringify(effective.coverage));
});
