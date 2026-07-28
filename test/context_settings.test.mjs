import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextSettingsError,
  applyContextSettingsPlan,
  createMemoryContextSettingsAdapter,
  explainContextSetting,
  getContextSettings,
  listContextSettings,
  planContextSettingsChange,
} from "../src/context_settings.mjs";

function adapterFixture() {
  const adapter = createMemoryContextSettingsAdapter();
  const target = { projectId: "hicharlie", locationId: "worktree-main" };
  adapter.seed({ ...target, store: "project" }, {
    revision: "project-r1",
    settings: {
      allowedPaths: ["docs/"],
      watchAllow: ["docs/"],
      watchRules: [],
      startupContext: { enabled: true, fileNames: ["AGENTS.md"], globalPaths: [] },
      startupSkills: { enabled: true, folderNames: [".codex/skills"] },
      startupHooks: { enabled: true, gitHooks: true },
      hubSections: [],
      hubCards: {},
    },
  });
  adapter.seed({ ...target, store: "shared-skills-device" }, { revision: "device-r1", settings: { sharedSkills: { providers: { codex: "enabled" } } } });
  adapter.seed({ ...target, store: "shared-skills-project" }, { revision: "skills-r1", settings: { sharedSkills: { providerOverrides: { codex: "inherit" }, assignmentOverrides: {} } } });
  return { adapter, target };
}

test("context settings registry exposes only context-manageable settings and scopes", () => {
  const entries = listContextSettings();
  assert.ok(entries.some((item) => item.key === "allowedPaths" && item.scope === "project"));
  assert.ok(entries.some((item) => item.key === "sharedSkills.providers.<provider>" && item.scope === "device"));
  assert.equal(entries.some((item) => /appearance|sounds|reviewGate|markdownTemplates/.test(item.key)), false);
  assert.equal(explainContextSetting("sharedSkills.providerOverrides.codex").scope, "project/provider");
  assert.throws(() => explainContextSetting("reviewGate.operations"), (error) => error instanceof ContextSettingsError && error.code === "setting-not-manageable");
  assert.throws(() => explainContextSetting("unknown.value"), (error) => error.code === "unknown-setting");
});

test("get reads one typed setting without exposing unrelated configuration", () => {
  const { adapter, target } = adapterFixture();
  const result = getContextSettings(adapter, { key: "allowedPaths", target });
  assert.deepEqual(result.value, ["docs/"]);
  assert.equal(result.revision, "project-r1");
  assert.equal(result.store, "project");
});

test("plan is content-addressed and never mutates settings", () => {
  const { adapter, target } = adapterFixture();
  const first = planContextSettingsChange(adapter, { target, set: { watchAllow: ["docs/", "AGENTS.md"] } });
  const second = planContextSettingsChange(adapter, { target, set: { watchAllow: ["docs/", "AGENTS.md"] } });
  assert.equal(first.planId, second.planId);
  assert.equal(first.baseRevision, "project-r1");
  assert.equal(adapter.stats().writes, 0);
  assert.deepEqual(getContextSettings(adapter, { key: "watchAllow", target }).value, ["docs/"]);
});

test("apply enforces revision and is idempotent", () => {
  const { adapter, target } = adapterFixture();
  const plan = planContextSettingsChange(adapter, { target, expectedRevision: "project-r1", set: { "startupSkills.enabled": false } });
  const first = applyContextSettingsPlan(adapter, plan.planId, { idempotencyKey: "voice-1" });
  const second = applyContextSettingsPlan(adapter, plan.planId, { idempotencyKey: "voice-1" });
  assert.equal(first.operationId, second.operationId);
  assert.equal(second.idempotentReplay, true);
  assert.equal(adapter.stats().writes, 1);
  assert.equal(getContextSettings(adapter, { key: "startupSkills.enabled", target }).value, false);
  assert.equal(first.settingsChangedEvent, "settings.changed");
});

test("stale plans are refused before any write", () => {
  const { adapter, target } = adapterFixture();
  const plan = planContextSettingsChange(adapter, { target, set: { allowedPaths: ["docs/", "context/"] } });
  adapter.seed({ ...target, store: "project" }, { revision: "project-r2", settings: { allowedPaths: ["docs/"], watchAllow: ["docs/"] } });
  assert.throws(() => applyContextSettingsPlan(adapter, plan.planId), (error) => error.code === "stale-plan" && error.retryable === true);
  assert.equal(adapter.stats().writes, 0);
});

test("typed validation rejects arbitrary JSON and unsafe setting families", () => {
  const { adapter, target } = adapterFixture();
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { "startupSkills.enabled": "yes" } }), (error) => error.code === "invalid-setting-value");
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { watchRules: [{ path: "docs/", mode: "magic" }] } }), (error) => error.code === "invalid-setting-value");
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { hubSections: [{ id: "main", title: "Main", cards: [], script: "nope" }] } }), (error) => error.code === "invalid-setting-value");
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { "appearance.fileTheme": "dracula" } }), (error) => error.code === "setting-not-manageable");
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { "sharedSkills.assignments.team": {} } }), (error) => error.code === "setting-not-manageable");
});

test("watch rules accept the four current product modes and reject legacy snapshot names", () => {
  const { adapter, target } = adapterFixture();
  const modes = ["recursive-live", "recursive-current", "direct-live", "direct-current"];
  const plan = planContextSettingsChange(adapter, {
    target,
    set: { watchRules: modes.map((mode, index) => ({ path: `docs/${index}/`, mode })) },
  });
  assert.deepEqual(plan.operations[0].after.map((rule) => rule.mode), modes);
  assert.throws(
    () => planContextSettingsChange(adapter, { target, set: { watchRules: [{ path: "docs/", mode: "recursive-snapshot" }] } }),
    (error) => error.code === "invalid-setting-value",
  );
});

test("shared skill provider and local assignment overrides are valid but shared intent is excluded", () => {
  const { adapter, target } = adapterFixture();
  const providerPlan = planContextSettingsChange(adapter, { target, set: { "sharedSkills.providers.codex": "disabled" } });
  assert.equal(providerPlan.store, "shared-skills-device");
  applyContextSettingsPlan(adapter, providerPlan.planId);
  assert.equal(getContextSettings(adapter, { key: "sharedSkills.providers.codex", target }).value, "disabled");

  const exclusionPlan = planContextSettingsChange(adapter, { target, set: { "sharedSkills.assignmentOverrides.calls.exclude": ["call-quality"] } });
  assert.equal(exclusionPlan.store, "shared-skills-project");
  assert.equal(exclusionPlan.sharedIntentChanged, false);
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { "sharedSkills.collections.calls.path": "skills/calls" } }), (error) => error.code === "setting-not-manageable");
});

test("plans cannot mix stores and expectedRevision is checked while planning", () => {
  const { adapter, target } = adapterFixture();
  assert.throws(() => planContextSettingsChange(adapter, { target, expectedRevision: "old", set: { allowedPaths: ["docs/"] } }), (error) => error.code === "stale-plan");
  assert.throws(() => planContextSettingsChange(adapter, { target, set: { allowedPaths: ["docs/"], "sharedSkills.providers.codex": "enabled" } }), (error) => error.code === "mixed-settings-scope");
});
