import { createHash } from "node:crypto";

export const CONTEXT_SETTINGS_SCHEMA_VERSION = "context-room.settings/1";

export class ContextSettingsError extends Error {
  constructor(code, message, { details = null, retryable = false } = {}) {
    super(message);
    this.name = "ContextSettingsError";
    this.code = String(code || "settings-operation-failed");
    this.details = details;
    this.retryable = Boolean(retryable);
  }
}

const PROVIDERS = new Set(["codex", "claude-code", "opencode"]);
const PROVIDER_STATES = new Set(["inherit", "enabled", "disabled"]);
const WATCH_MODES = new Set(["recursive-live", "recursive-current", "direct-live", "direct-current"]);

function setting(definition) {
  return Object.freeze({
    mutable: true,
    sharedIntent: false,
    ...definition,
  });
}

const EXACT_SETTINGS = Object.freeze([
  setting({ key: "allowedPaths", store: "project", scope: "project", type: "path-list", summary: "Folders and files Context Room may read and manage.", caution: "This command never widens allowed paths implicitly." }),
  setting({ key: "watchAllow", store: "project", scope: "project", type: "path-list", summary: "Explicit files and legacy live folders included in human review." }),
  setting({ key: "watchRules", store: "project", scope: "project", type: "watch-rules", summary: "Structured folder review rules and their discovery mode." }),
  setting({ key: "startupContext.enabled", store: "project", scope: "project", type: "boolean", summary: "Discover provider instruction files for this project." }),
  setting({ key: "startupContext.projectOnly", store: "project", scope: "project", type: "boolean", summary: "Restrict startup instruction discovery to this project." }),
  setting({ key: "startupContext.fileNames", store: "project", scope: "project", type: "file-name-list", summary: "Instruction file names considered during startup discovery." }),
  setting({ key: "startupContext.globalPaths", store: "project", scope: "project", type: "home-path-list", summary: "Explicit device instruction files included for this project." }),
  setting({ key: "startupSkills.enabled", store: "project", scope: "project", type: "boolean", summary: "Discover locally installed skills around this project." }),
  setting({ key: "startupSkills.projectOnly", store: "project", scope: "project", type: "boolean", summary: "Restrict local skill discovery to this project." }),
  setting({ key: "startupSkills.folderNames", store: "project", scope: "project", type: "relative-path-list", summary: "Local folders searched for skills." }),
  setting({ key: "startupHooks.enabled", store: "project", scope: "project", type: "boolean", summary: "Discover configured hook sources." }),
  setting({ key: "startupHooks.projectOnly", store: "project", scope: "project", type: "boolean", summary: "Restrict hook discovery to this project." }),
  setting({ key: "startupHooks.agentHooks", store: "project", scope: "project", type: "boolean", summary: "Include agent-provider hook sources." }),
  setting({ key: "startupHooks.codexHooks", store: "project", scope: "project", type: "boolean", summary: "Compatibility alias for agent-provider hook discovery." }),
  setting({ key: "startupHooks.gitHooks", store: "project", scope: "project", type: "boolean", summary: "Include Git hook sources." }),
  setting({ key: "startupHooks.hookManagers", store: "project", scope: "project", type: "boolean", summary: "Include configured hook-manager sources." }),
  setting({ key: "startupHooks.fileNames", store: "project", scope: "project", type: "file-name-list", summary: "Project hook configuration file names to discover." }),
  setting({ key: "startupHooks.agentHookPaths", store: "project", scope: "project", type: "relative-path-list", summary: "Explicit agent hook configuration paths." }),
  setting({ key: "startupHooks.codexPaths", store: "project", scope: "project", type: "relative-path-list", summary: "Compatibility paths for Codex hook discovery." }),
  setting({ key: "startupHooks.managerPaths", store: "project", scope: "project", type: "relative-path-list", summary: "Hook-manager configuration paths to discover." }),
  setting({ key: "hubSections", store: "project", scope: "project", type: "hub-sections", summary: "Sections and navigation cards shown in the project Hub." }),
  setting({ key: "hubCards", store: "project", scope: "project", type: "boolean-map", summary: "Enabled state for Hub cards." }),
]);

const PATTERN_SETTINGS = Object.freeze([
  setting({ pattern: /^sharedSkills\.providers\.([a-z0-9-]+)$/, key: "sharedSkills.providers.<provider>", store: "shared-skills-device", scope: "device", type: "provider-state", summary: "Device-wide availability preference for one Shared Skills provider." }),
  setting({ pattern: /^sharedSkills\.providerOverrides\.([a-z0-9-]+)$/, key: "sharedSkills.providerOverrides.<provider>", store: "shared-skills-project", scope: "project/provider", type: "provider-state", summary: "Project override for one Shared Skills provider." }),
  setting({ pattern: /^sharedSkills\.assignmentOverrides\.([a-zA-Z0-9._-]+)\.disabled$/, key: "sharedSkills.assignmentOverrides.<assignment>.disabled", store: "shared-skills-project", scope: "project", type: "boolean", summary: "Disable one accepted shared assignment on this device for the selected project." }),
  setting({ pattern: /^sharedSkills\.assignmentOverrides\.([a-zA-Z0-9._-]+)\.exclude$/, key: "sharedSkills.assignmentOverrides.<assignment>.exclude", store: "shared-skills-project", scope: "project", type: "skill-name-list", summary: "Exclude individual skills locally from one accepted assignment." }),
]);

const FORBIDDEN_PREFIXES = Object.freeze([
  ["reviewGate", "The owner-controlled Git review gate is not available through the Settings CLI."],
  ["appearance", "Appearance is a device UI preference, not context configuration."],
  ["sounds", "Interface sounds are not context configuration."],
  ["shortcuts", "Keyboard shortcuts are not context configuration."],
  ["explorer", "Computer browsing preferences are not context configuration."],
  ["codexPrompts", "Codex prompt overrides are intentionally excluded from context Settings."],
  ["markdownTemplates", "Visual and document templates are intentionally excluded from context Settings."],
  ["reviewDecisions", "Human review decisions cannot be changed by an agent command."],
  ["documents", "Document content must be edited and reviewed as a document, not as a setting."],
  ["hooks", "Hook content cannot be changed through the Settings CLI."],
  ["sharedSkills.collections", "Shared collections are shared intent and must change through a skills proposal."],
  ["sharedSkills.assignments", "Shared assignments are shared intent and must change through a skills proposal."],
]);

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(prefix, value) {
  return `${prefix}-` + createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex").slice(0, 24);
}

function settingDefinition(key) {
  const normalized = String(key || "").trim();
  const exact = EXACT_SETTINGS.find((item) => item.key === normalized);
  if (exact) return { ...exact, requestedKey: normalized, captures: [] };
  for (const definition of PATTERN_SETTINGS) {
    const match = normalized.match(definition.pattern);
    if (match) return { ...definition, requestedKey: normalized, captures: match.slice(1) };
  }
  const forbidden = FORBIDDEN_PREFIXES.find(([prefix]) => normalized === prefix || normalized.startsWith(prefix + "."));
  if (forbidden) throw new ContextSettingsError("setting-not-manageable", forbidden[1], { details: { key: normalized } });
  throw new ContextSettingsError("unknown-setting", `Unknown context setting: ${normalized || "(empty)"}`, { details: { key: normalized } });
}

function assertSimpleString(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new ContextSettingsError("invalid-setting-value", `${label} must be a non-empty string.`, { details: { value } });
  return value.trim();
}

function validateStringList(value, label, predicate = () => true) {
  if (!Array.isArray(value)) throw new ContextSettingsError("invalid-setting-value", `${label} must be an array.`, { details: { value } });
  const result = [];
  for (const item of value) {
    const normalized = assertSimpleString(item, label);
    if (!predicate(normalized)) throw new ContextSettingsError("invalid-setting-value", `${label} contains an unsupported value: ${normalized}`, { details: { value: normalized } });
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function validateHubCard(card, label) {
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new ContextSettingsError("invalid-setting-value", `${label} must contain objects.`);
  const allowed = new Set(["id", "title", "description", "path", "paths", "enabled", "autoChildren", "cards"]);
  for (const key of Object.keys(card)) if (!allowed.has(key)) throw new ContextSettingsError("invalid-setting-value", `${label} contains unsupported field: ${key}`);
  const result = { id: assertSimpleString(card.id, `${label}.id`), title: assertSimpleString(card.title, `${label}.title`) };
  if (card.description != null) result.description = String(card.description);
  if (card.path != null) result.path = assertSimpleString(card.path, `${label}.path`);
  if (card.paths != null) result.paths = validateStringList(card.paths, `${label}.paths`);
  if (card.enabled != null) result.enabled = Boolean(card.enabled);
  if (card.autoChildren != null) result.autoChildren = Boolean(card.autoChildren);
  if (card.cards != null) {
    if (!Array.isArray(card.cards)) throw new ContextSettingsError("invalid-setting-value", `${label}.cards must be an array.`);
    result.cards = card.cards.map((child, index) => validateHubCard(child, `${label}.cards[${index}]`));
  }
  return result;
}

function validateValue(definition, value) {
  switch (definition.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new ContextSettingsError("invalid-setting-value", `${definition.requestedKey} must be true or false.`);
      return value;
    case "path-list":
      return validateStringList(value, definition.requestedKey, (item) => !item.includes("\0"));
    case "home-path-list":
      return validateStringList(value, definition.requestedKey, (item) => item.startsWith("~/") && !item.split("/").includes(".."));
    case "relative-path-list":
      return validateStringList(value, definition.requestedKey, (item) => !item.startsWith("/") && !item.startsWith("../") && !item.split("/").includes(".."));
    case "file-name-list":
      return validateStringList(value, definition.requestedKey, (item) => !item.includes("/") && item !== "." && item !== "..");
    case "skill-name-list":
      return validateStringList(value, definition.requestedKey, (item) => /^[a-zA-Z0-9._-]+$/.test(item));
    case "provider-state": {
      const state = String(value || "").trim();
      if (!PROVIDER_STATES.has(state)) throw new ContextSettingsError("invalid-setting-value", `${definition.requestedKey} must be inherit, enabled, or disabled.`);
      const provider = definition.captures[0];
      if (!PROVIDERS.has(provider)) throw new ContextSettingsError("invalid-setting-value", `Unsupported provider: ${provider}`, { details: { providers: [...PROVIDERS] } });
      return state;
    }
    case "boolean-map": {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextSettingsError("invalid-setting-value", `${definition.requestedKey} must be an object of booleans.`);
      return Object.fromEntries(Object.entries(value).map(([key, enabled]) => {
        if (typeof enabled !== "boolean") throw new ContextSettingsError("invalid-setting-value", `${definition.requestedKey}.${key} must be true or false.`);
        return [assertSimpleString(key, definition.requestedKey), enabled];
      }));
    }
    case "watch-rules": {
      if (!Array.isArray(value)) throw new ContextSettingsError("invalid-setting-value", "watchRules must be an array.");
      return value.map((rule, index) => {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new ContextSettingsError("invalid-setting-value", `watchRules[${index}] must be an object.`);
        const allowed = new Set(["path", "mode", "files"]);
        for (const key of Object.keys(rule)) if (!allowed.has(key)) throw new ContextSettingsError("invalid-setting-value", `watchRules[${index}] contains unsupported field: ${key}`);
        const mode = assertSimpleString(rule.mode, `watchRules[${index}].mode`);
        if (!WATCH_MODES.has(mode)) throw new ContextSettingsError("invalid-setting-value", `Unsupported watch mode: ${mode}`);
        const result = { path: assertSimpleString(rule.path, `watchRules[${index}].path`), mode };
        if (rule.files != null) result.files = validateStringList(rule.files, `watchRules[${index}].files`);
        return result;
      });
    }
    case "hub-sections": {
      if (!Array.isArray(value)) throw new ContextSettingsError("invalid-setting-value", "hubSections must be an array.");
      return value.map((section, index) => {
        if (!section || typeof section !== "object" || Array.isArray(section)) throw new ContextSettingsError("invalid-setting-value", `hubSections[${index}] must be an object.`);
        const allowed = new Set(["id", "title", "cards"]);
        for (const key of Object.keys(section)) if (!allowed.has(key)) throw new ContextSettingsError("invalid-setting-value", `hubSections[${index}] contains unsupported field: ${key}`);
        if (!Array.isArray(section.cards)) throw new ContextSettingsError("invalid-setting-value", `hubSections[${index}].cards must be an array.`);
        return { id: assertSimpleString(section.id, `hubSections[${index}].id`), title: assertSimpleString(section.title, `hubSections[${index}].title`), cards: section.cards.map((card, cardIndex) => validateHubCard(card, `hubSections[${index}].cards[${cardIndex}]`)) };
      });
    }
    default:
      throw new ContextSettingsError("invalid-setting-definition", `Unsupported setting type: ${definition.type}`);
  }
}

function readAtPath(object, key) {
  return String(key).split(".").reduce((value, part) => value && typeof value === "object" ? value[part] : undefined, object);
}

function writeAtPath(object, key, value) {
  const result = deepClone(object || {});
  const parts = String(key).split(".");
  let cursor = result;
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part];
    cursor[part] = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = deepClone(value);
  return result;
}

function targetForStore(target, store) {
  return { ...(target || {}), store };
}

function assertAdapter(adapter) {
  for (const method of ["read", "write", "savePlan", "readPlan", "saveReceipt", "readReceipt"]) {
    if (typeof adapter?.[method] !== "function") throw new ContextSettingsError("invalid-settings-adapter", `Settings adapter is missing ${method}().`);
  }
}

export function listContextSettings() {
  return [...EXACT_SETTINGS, ...PATTERN_SETTINGS].map(({ pattern: _pattern, ...definition }) => deepClone(definition));
}

export function explainContextSetting(key) {
  const definition = settingDefinition(key);
  const { pattern: _pattern, captures: _captures, ...publicDefinition } = definition;
  return deepClone({ schemaVersion: CONTEXT_SETTINGS_SCHEMA_VERSION, ...publicDefinition });
}

export function getContextSettings(adapter, { key = "", target = null } = {}) {
  assertAdapter(adapter);
  if (key) {
    const definition = settingDefinition(key);
    const state = adapter.read(targetForStore(target, definition.store));
    return { schemaVersion: CONTEXT_SETTINGS_SCHEMA_VERSION, key: definition.requestedKey, value: deepClone(readAtPath(state.settings, definition.requestedKey)), revision: String(state.revision || ""), scope: definition.scope, store: definition.store };
  }
  const values = {};
  const revisions = {};
  for (const definition of EXACT_SETTINGS) {
    const state = adapter.read(targetForStore(target, definition.store));
    values[definition.key] = deepClone(readAtPath(state.settings, definition.key));
    revisions[definition.store] = String(state.revision || "");
  }
  return { schemaVersion: CONTEXT_SETTINGS_SCHEMA_VERSION, values, revisions };
}

function normalizeRequestedChanges(set) {
  const entries = Array.isArray(set) ? set : Object.entries(set || {}).map(([key, value]) => ({ key, value }));
  if (!entries.length) throw new ContextSettingsError("empty-settings-plan", "At least one --set value is required.");
  return entries.map((entry) => {
    const definition = settingDefinition(entry.key);
    return { definition, key: definition.requestedKey, value: validateValue(definition, entry.value) };
  });
}

export function planContextSettingsChange(adapter, { set, target = null, expectedRevision = "" } = {}) {
  assertAdapter(adapter);
  const changes = normalizeRequestedChanges(set);
  const stores = [...new Set(changes.map((change) => change.definition.store))];
  if (stores.length !== 1) throw new ContextSettingsError("mixed-settings-scope", "One settings plan cannot cross persistence stores.", { details: { stores } });
  const store = stores[0];
  const storeTarget = targetForStore(target, store);
  const state = adapter.read(storeTarget);
  const revision = String(state.revision || "");
  if (expectedRevision && expectedRevision !== revision) throw new ContextSettingsError("stale-plan", "Settings changed before the plan was created.", { details: { expectedRevision, revision }, retryable: true });
  let nextSettings = deepClone(state.settings || {});
  const operations = changes.map(({ definition, key, value }) => {
    const before = deepClone(readAtPath(nextSettings, key));
    nextSettings = writeAtPath(nextSettings, key, value);
    return { key, before, after: deepClone(value), scope: definition.scope, store: definition.store };
  });
  const planBody = { schemaVersion: CONTEXT_SETTINGS_SCHEMA_VERSION, command: "settings.apply", target: deepClone(target), store, baseRevision: revision, operations };
  const plan = { ...planBody, planId: digest("plan", planBody), changes: operations.length, sharedIntentChanged: false, humanReviewDecisionChanged: false };
  adapter.savePlan(deepClone(plan));
  return deepClone(plan);
}

export function applyContextSettingsPlan(adapter, planId, { idempotencyKey = "" } = {}) {
  assertAdapter(adapter);
  const normalizedPlanId = String(planId || "").trim();
  if (!normalizedPlanId) throw new ContextSettingsError("missing-plan", "A settings plan ID is required.");
  const operationId = digest("op", { planId: normalizedPlanId, idempotencyKey: String(idempotencyKey || "") });
  const previous = adapter.readReceipt(operationId);
  if (previous) return { ...deepClone(previous), idempotentReplay: true };
  const plan = adapter.readPlan(normalizedPlanId);
  if (!plan || plan.schemaVersion !== CONTEXT_SETTINGS_SCHEMA_VERSION) throw new ContextSettingsError("unknown-plan", `Unknown settings plan: ${normalizedPlanId}`);
  const storeTarget = targetForStore(plan.target, plan.store);
  const state = adapter.read(storeTarget);
  const revision = String(state.revision || "");
  if (revision !== plan.baseRevision) throw new ContextSettingsError("stale-plan", "Settings changed after this plan was created.", { details: { expectedRevision: plan.baseRevision, revision }, retryable: true });
  let nextSettings = deepClone(state.settings || {});
  for (const operation of plan.operations) {
    const definition = settingDefinition(operation.key);
    if (definition.store !== plan.store) throw new ContextSettingsError("invalid-settings-plan", `Plan store does not match ${operation.key}.`);
    nextSettings = writeAtPath(nextSettings, operation.key, validateValue(definition, operation.after));
  }
  const written = adapter.write(storeTarget, { settings: nextSettings, expectedRevision: plan.baseRevision });
  const receipt = {
    schemaVersion: CONTEXT_SETTINGS_SCHEMA_VERSION,
    operationId,
    planId: normalizedPlanId,
    applied: true,
    revision: String(written?.revision || ""),
    changes: plan.operations.length,
    settingsChangedEvent: "settings.changed",
    sharedIntentChanged: false,
    humanReviewDecisionChanged: false,
  };
  adapter.saveReceipt(deepClone(receipt));
  return deepClone(receipt);
}

export function createMemoryContextSettingsAdapter(initial = {}) {
  const stores = new Map();
  const plans = new Map();
  const receipts = new Map();
  let writes = 0;
  for (const [store, state] of Object.entries(initial)) stores.set(store, { settings: deepClone(state.settings || {}), revision: String(state.revision || "revision-1") });
  const keyFor = (target) => `${String(target?.store || "project")}:${String(target?.projectId || target?.root || "default")}`;
  return {
    read(target) {
      const key = keyFor(target);
      const fallback = stores.get(target?.store) || { settings: {}, revision: "revision-1" };
      return deepClone(stores.get(key) || fallback);
    },
    write(target, { settings, expectedRevision }) {
      const key = keyFor(target);
      const current = this.read(target);
      if (expectedRevision !== current.revision) throw new ContextSettingsError("stale-plan", "Settings changed before they could be written.", { retryable: true });
      writes += 1;
      const next = { settings: deepClone(settings), revision: digest("revision", { previous: current.revision, settings }) };
      stores.set(key, next);
      return deepClone(next);
    },
    savePlan(plan) { plans.set(plan.planId, deepClone(plan)); },
    readPlan(planId) { return deepClone(plans.get(planId)); },
    saveReceipt(receipt) { receipts.set(receipt.operationId, deepClone(receipt)); },
    readReceipt(operationId) { return deepClone(receipts.get(operationId)); },
    seed(target, state) { stores.set(keyFor(target), deepClone(state)); },
    stats() { return { writes, plans: plans.size, receipts: receipts.size }; },
  };
}
