export const CLI_REGISTRY_SCHEMA_VERSION = "context-room.cli-registry/4";
export const CLI_MACHINE_SCHEMA_VERSION = "context-room.cli/1";
export const CLI_MACHINE_SCHEMA_VERSION_V2 = "context-room.cli/2";
export const CLI_OUTPUT_FORMATS = Object.freeze(["human", "json"]);
export const CLI_DETAIL_LEVELS = Object.freeze(["compact", "standard", "full"]);
export const CLI_PROFILES = Object.freeze(["worker", "editing", "admin", "expert"]);
export const CLI_GLOBAL_OPTIONS = Object.freeze([
  "--format",
  "--contract",
  "--detail",
  "--profile",
  "--include",
  "--dry-run",
  "--quiet",
  "--verbose",
  "--no-color",
  "--non-interactive",
  "--fields",
  "--expand",
  "--summary",
]);
export const CLI_PRIMARY_COMMANDS = Object.freeze([
  "ask",
  "edit",
  "capabilities",
]);

export const CLI_PROFILE_COMMANDS = freeze({
  worker: ["ask"],
  editing: ["ask", "edit"],
  admin: [
    "project list", "project show", "project register",
    "ui list", "ui open",
    "watch set",
    "review list", "review show",
    "note add", "note list",
    "proposal list", "proposal impact",
    "shared connect", "shared status", "shared assign", "shared unassign", "shared local skill", "shared reconcile",
    "settings get", "settings set",
    "doctor",
  ],
  expert: [
    "context bundle", "context effective", "context explain", "context impact", "context snapshot", "context diff",
    "docs search", "docs inspect",
    "shared sync", "shared security",
    "hooks sync",
    "hub status",
  ],
});

export const CLI_CAPABILITY_SECTIONS = freeze({
  documentation: {
    summary: "Search and inspect accepted documentation.",
    commands: ["docs search", "docs inspect"],
  },
  context: {
    summary: "Resolve, explain, compare, and measure effective context.",
    commands: ["context bundle", "context effective", "context explain", "context impact", "context snapshot", "context diff"],
  },
  review: {
    summary: "Inspect reviews and proposals, manage watch rules, and leave annotations.",
    commands: ["watch set", "note add", "note list", "review list", "review show", "proposal list", "proposal impact"],
  },
  shared: {
    summary: "Connect, inspect, and manage accepted shared resources.",
    commands: ["shared connect", "shared status", "shared assign", "shared unassign", "shared local skill", "shared reconcile", "shared sync", "shared security"],
  },
  workspace: {
    summary: "Manage registered projects, worktrees, Hub state, and UI navigation.",
    commands: ["project list", "project show", "project register", "ui list", "ui open", "hub status"],
  },
  configuration: {
    summary: "Read or change context settings, diagnostics, and local hooks.",
    commands: ["settings get", "settings set", "doctor", "hooks sync"],
  },
});

const CAPABILITY_SECTION_BY_COMMAND = new Map(Object.entries(CLI_CAPABILITY_SECTIONS)
  .flatMap(([section, definition]) => definition.commands.map((command) => [command, section])));
const CLI_CANONICAL_COMMANDS = new Set([...CLI_PRIMARY_COMMANDS, ...CAPABILITY_SECTION_BY_COMMAND.keys()]);

const PROVIDER_SCOPES = ["device", "shared", "project", "worktree", "folder", "provider"];
const PROJECT_SCOPES = ["project", "worktree", "folder"];
const SHARED_SCOPES = ["shared", "project", "worktree", "provider"];

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function option(name, { value = "string", required = false, repeatable = false, description = "" } = {}) {
  return { name, kind: "option", value, required, repeatable, description };
}

function positional(name, { required = true, repeatable = false, description = "" } = {}) {
  return { name, kind: "positional", value: "string", required, repeatable, description };
}

const TARGET = [
  option("--project"),
  option("--location"),
  option("--folder"),
  option("--root"),
];
const PAGE = [option("--cursor"), option("--limit", { value: "integer" }), option("--query")];
const APPLY = [option("--plan", { value: "boolean" }), option("--apply")];
const PROVIDER = option("--provider", { value: "auto|codex|claude-code|opencode|all" });

function define(path, {
  aliases = [],
  summary,
  arguments: args = [],
  scopes = [],
  formats = CLI_OUTPUT_FORMATS,
  mutation = "read-only",
  protocol = "direct",
  humanDecision = "none",
  outputSchema = CLI_MACHINE_SCHEMA_VERSION,
  handlerKey,
  lifecycle = "current",
  ui = "none",
  exposure = "canonical",
  compatibilityOf = null,
  useWhen = [],
  doNotUseWhen = [],
  tags = [],
  requiredContext = [],
  freshness = "local",
  cost = "low",
  authority = mutation === "read-only" ? "read-only" : "local-reversible",
  effect = mutation === "read-only" ? "none" : authority === "shared-proposal" ? "proposal-only" : "reversible-local",
  replacement = null,
} = {}) {
  if (!path || !summary || !handlerKey) throw new TypeError(`Invalid CLI registry entry: ${path || "<missing path>"}`);
  return freeze({
    path,
    aliases,
    summary,
    arguments: args,
    scopes,
    formats,
    mutation,
    mutates: mutation === "mutating",
    protocol,
    humanDecision,
    outputSchema,
    handlerKey,
    lifecycle,
    ui,
    exposure,
    compatibilityOf,
    useWhen: useWhen.length ? useWhen : [summary],
    doNotUseWhen,
    tags,
    requiredContext,
    freshness,
    cost,
    authority,
    effect,
    replacement,
    section: CAPABILITY_SECTION_BY_COMMAND.get(path) || "",
  });
}

/**
 * Installed product command inventory. The dispatcher, capabilities, help, and
 * completions consume this same registry so a command cannot be advertised
 * independently from its executable contract.
 */
export const CLI_COMMAND_REGISTRY = freeze([
  define("ask", {
    summary: "Send a complete research brief to a fresh read-only agent working from accepted documentation.",
    arguments: [positional("research-brief"), ...TARGET, option("--repository"), option("--shared-project"), option("--goal"), option("--files"), option("--depth"), option("--budget", { value: "integer" })],
    scopes: ["shared", ...PROJECT_SCOPES],
    formats: ["human", "json"],
    handlerKey: "context.ask",
    ui: "both",
  }),
  define("edit", {
    summary: "Create, open, or list shared documentation proposal worktrees.",
    arguments: [positional("action", { description: "create, open, or list" }), positional("value", { required: false, description: "Complete description for create, exact proposal branch for open." }), option("--description"), option("--title"), option("--proposal"), option("--session"), ...TARGET],
    useWhen: ["Create a proposal for the selected project, list proposals for the project containing the current directory, or open one globally by exact branch."],
    scopes: ["shared", ...PROJECT_SCOPES],
    mutation: "mutating",
    protocol: "direct",
    humanDecision: "file-review-remains-human",
    authority: "shared-proposal",
    effect: "proposal-only",
    handlerKey: "docs.edit",
    ui: "both",
  }),
  define("capabilities", {
    summary: "List the installed machine-readable CLI contract.",
    arguments: [positional("command", { required: false }), option("--include", { description: "Expose one command namespace." }), option("--detail", { value: "compact|standard|full" }), option("--contract", { value: "v1|v2" })],
    useWhen: ["The agent needs to discover supported operations, arguments, authority, cost, or schemas."],
    tags: ["discovery", "contract", "capabilities"],
    handlerKey: "capabilities",
    ui: "diagnostic",
  }),
  define("completion", { summary: "Generate zsh, bash, or fish completion from the command registry.", arguments: [positional("shell", { required: false })], formats: ["human"], outputSchema: "text/plain", handlerKey: "completion", ui: "diagnostic", exposure: "internal" }),

  define("project current", { summary: "Resolve the current registered project and location.", arguments: TARGET, scopes: PROJECT_SCOPES, handlerKey: "project.current", ui: "both", exposure: "compatibility", replacement: "project show" }),
  define("project list", { summary: "List registered projects and worktree locations.", arguments: PAGE, scopes: ["device"], handlerKey: "project.list", ui: "both" }),
  define("project show", { summary: "Show one exact registered project or worktree.", arguments: TARGET, scopes: PROJECT_SCOPES, handlerKey: "project.show", ui: "both" }),
  define("project search", { summary: "Search the registered project catalog.", arguments: PAGE, scopes: ["device"], handlerKey: "project.search", ui: "both", exposure: "compatibility", replacement: "project list --query" }),
  define("project register", { summary: "Explicitly register a project or worktree location.", arguments: [...TARGET, option("--title"), option("--dry-run", { value: "boolean" })], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "direct", effect: "reversible-local", handlerKey: "project.register", ui: "both" }),
  define("project open", { summary: "Open a registered project in the running Hub.", arguments: TARGET, scopes: PROJECT_SCOPES, handlerKey: "project.open", ui: "both", exposure: "compatibility", replacement: "ui open" }),
  define("project recent", { summary: "List recently used registered locations.", arguments: PAGE, scopes: ["device"], handlerKey: "project.recent", ui: "both", exposure: "compatibility", replacement: "project list --recent" }),

  define("workspace list", { summary: "List active global Context Room workspaces without exposing drafts.", arguments: [...TARGET, ...PAGE], scopes: ["device", ...PROJECT_SCOPES], handlerKey: "workspace.list", ui: "both", exposure: "compatibility", replacement: "ui list" }),
  define("workspace open", { summary: "Create a URL for a new independent global Context Room workspace.", arguments: [...TARGET, option("--file")], scopes: ["device", ...PROJECT_SCOPES], handlerKey: "workspace.open", ui: "both", exposure: "compatibility", replacement: "ui open" }),

  define("ui list", { summary: "List active Context Room workspaces without exposing drafts.", arguments: [...TARGET, ...PAGE, option("--session"), option("--all", { value: "boolean" })], scopes: ["device", ...PROJECT_SCOPES], handlerKey: "ui.list", ui: "both", effect: "none" }),
  define("ui open", { summary: "Open or navigate one exact Context Room workspace.", arguments: [...TARGET, option("--workspace"), option("--session"), option("--recent", { value: "boolean" }), option("--label"), option("--proposal"), option("--file"), option("--view"), option("--settings"), option("--search"), option("--filter"), option("--heading"), option("--text"), option("--percent", { value: "number" })], scopes: ["device", ...PROJECT_SCOPES], handlerKey: "ui.open", ui: "both", effect: "ephemeral", mutation: "mutating", authority: "ui-navigation" }),

  define("watch set", { summary: "Add or widen one explicit folder watch rule. Only the human owner may narrow or remove review coverage.", arguments: [positional("path"), option("--mode", { value: "recursive-live|recursive-current|direct-current|direct-live" }), ...TARGET, option("--dry-run", { value: "boolean" })], scopes: ["project", "folder"], mutation: "mutating", protocol: "effect-aware", handlerKey: "watch.set", ui: "both", effect: "reversible-local", humanDecision: "review-scope-reduction-remains-human" }),

  define("note add", { summary: "Add an idempotent human-facing annotation without deciding a review.", arguments: [option("--path", { required: true }), option("--note", { required: true }), option("--target"), ...TARGET, option("--dry-run", { value: "boolean" })], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "direct", handlerKey: "note.add", ui: "both", effect: "reversible-local" }),
  define("note list", { summary: "List human-facing annotations.", arguments: [option("--path"), ...TARGET, ...PAGE], scopes: PROJECT_SCOPES, handlerKey: "note.list", ui: "both" }),

  define("agent prepare", { summary: "Build deterministic task startup context.", arguments: [option("--task", { required: true }), ...TARGET, option("--repository"), PROVIDER, option("--session"), option("--fresh", { value: "boolean" }), option("--budget", { value: "integer" })], scopes: PROVIDER_SCOPES, useWhen: ["An agent is beginning a task and needs the resolved target, accepted context, reviews, proposals, health, and next actions in one response."], doNotUseWhen: ["Only one exact context resource or relation needs inspection."], tags: ["prepare", "task", "startup", "context"], requiredContext: ["task"], freshness: "accepted-shared-head-when-connected", cost: "medium", handlerKey: "agent.prepare", ui: "both", exposure: "compatibility", replacement: "context bundle" }),
  define("agent instructions", { summary: "Generate provider-specific instructions for a coding agent.", arguments: [...TARGET, PROVIDER], scopes: PROVIDER_SCOPES, handlerKey: "agent.instructions", ui: "diagnostic", lifecycle: "removed", exposure: "internal", replacement: "context ask" }),
  define("agent changes", { summary: "Classify local and shared documentation changes.", arguments: [...TARGET, option("--session")], scopes: PROJECT_SCOPES, handlerKey: "agent.changes", ui: "diagnostic", exposure: "internal" }),
  define("agent handoff", { summary: "Plan or apply a deterministic documentation handoff.", arguments: [option("--task", { required: true }), option("--description"), option("--session"), option("--idempotency-key"), ...TARGET, ...APPLY], scopes: ["shared", ...PROJECT_SCOPES], mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", useWhen: ["The agent has finished documentation work and must route local files to review or shared files to proposals."], tags: ["handoff", "publish", "proposal", "review"], requiredContext: ["task", "project-or-location"], freshness: "fresh-before-apply", cost: "high", handlerKey: "agent.handoff", ui: "both", exposure: "internal" }),
  define("agent help", { summary: "Show the paste-ready agent workflow.", arguments: [option("--root")], formats: ["human"], outputSchema: "text/plain", handlerKey: "agent.help", ui: "both", lifecycle: "removed", exposure: "internal", replacement: "capabilities" }),
  define("agent state", { summary: "Inspect one active Context Room workspace.", arguments: [...TARGET, option("--workspace")], scopes: PROJECT_SCOPES, handlerKey: "agent.state", ui: "diagnostic", exposure: "compatibility", replacement: "ui list" }),
  define("agent watch", { summary: "Add or replace an explicit folder watch rule.", arguments: [option("--root"), option("--path", { required: true }), option("--mode"), ...APPLY], scopes: ["project", "folder"], mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.watch", ui: "both", exposure: "compatibility", replacement: "watch set" }),
  define("agent unwatch", { summary: "Legacy blocked command. Only the human owner may remove review coverage.", arguments: [option("--root"), option("--path", { required: true })], scopes: ["project", "folder"], mutation: "mutating", protocol: "human-only", handlerKey: "agent.unwatch", ui: "diagnostic", lifecycle: "removed", exposure: "internal", humanDecision: "review-scope-reduction-remains-human", replacement: "Context Room Settings" }),
  define("agent open", { summary: "Navigate one exact running Context Room workspace.", arguments: [...TARGET, option("--workspace"), option("--path"), option("--view"), option("--heading"), option("--text"), option("--percent", { value: "number" }), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.open", ui: "ui-control", exposure: "compatibility", replacement: "ui open" }),
  define("agent scroll", { summary: "Scroll one exact running Context Room workspace to a target.", arguments: [...TARGET, option("--workspace"), option("--path"), option("--heading"), option("--text"), option("--percent", { value: "number" }), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.scroll", ui: "ui-control", exposure: "compatibility", replacement: "ui open" }),
  define("agent highlight", { summary: "Highlight a target in one exact running Context Room workspace.", arguments: [...TARGET, option("--workspace"), option("--path"), option("--heading"), option("--text"), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.highlight", ui: "ui-control", exposure: "compatibility", replacement: "ui open" }),
  define("agent annotate", { summary: "Attach a human-facing annotation without deciding a review.", arguments: [option("--root"), option("--path", { required: true }), option("--note", { required: true }), option("--target"), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", humanDecision: "none", handlerKey: "agent.annotate", ui: "both", exposure: "compatibility", replacement: "note add" }),
  define("agent annotations", { summary: "List human-facing annotations.", arguments: [option("--root"), option("--path")], scopes: PROJECT_SCOPES, handlerKey: "agent.annotations", ui: "both", exposure: "compatibility", replacement: "note list" }),

  define("context ask", { summary: "Research accepted documentation from a complete task-specific brief.", arguments: [positional("research-brief"), ...TARGET, option("--repository"), option("--shared-project"), option("--goal"), option("--files"), option("--depth"), option("--budget", { value: "integer" })], scopes: ["shared", ...PROJECT_SCOPES], formats: ["human", "json"], handlerKey: "context.ask", ui: "both", exposure: "compatibility", replacement: "ask" }),
  define("context bundle", { summary: "Build a compact deterministic context bundle for one task.", arguments: [option("--task"), ...TARGET, option("--repository"), PROVIDER, option("--fresh", { value: "boolean" }), option("--budget", { value: "integer" })], scopes: PROVIDER_SCOPES, handlerKey: "context.bundle", ui: "both", cost: "medium", freshness: "accepted-shared-head-when-connected" }),
  define("context effective", { summary: "Resolve the complete accepted context for an exact coordinate.", arguments: [...TARGET, PROVIDER, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, useWhen: ["The agent needs the final accepted context for one project, worktree, folder, and provider."], doNotUseWhen: ["The agent needs the full application chain of one resource; use context trace.", "The agent needs every proven consumer of one resource; use context impact."], tags: ["context", "effective", "instructions", "skills", "hooks", "documents", "provider"], requiredContext: ["project-or-location", "folder", "provider"], freshness: "accepted-shared-head-required", cost: "medium", handlerKey: "context.effective", ui: "both" }),
  define("context graph", { summary: "Expose proven context resources, applications, and relations.", arguments: [...TARGET, PROVIDER, ...PAGE, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, handlerKey: "context.graph", ui: "diagnostic", exposure: "internal", replacement: "context effective --include graph" }),
  define("context explain", { summary: "Explain the effective state of one context resource.", arguments: [positional("selector"), ...TARGET, PROVIDER, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, handlerKey: "context.explain", ui: "both" }),
  define("context trace", { summary: "Trace the ordered application chain for a context resource.", arguments: [positional("selector"), ...TARGET, PROVIDER, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, useWhen: ["The agent needs the complete ordered chain that produced a resource's effective state."], doNotUseWhen: ["Only the final effective context is needed; use context effective."], tags: ["trace", "why", "order", "override", "provenance"], requiredContext: ["selector", "project-or-location", "folder", "provider"], freshness: "accepted-shared-head-required", handlerKey: "context.trace", ui: "both", exposure: "compatibility", replacement: "context explain" }),
  define("context impact", { summary: "List the proven consumers of a context resource.", arguments: [positional("selector"), ...TARGET, PROVIDER, option("--shared"), ...PAGE, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, useWhen: ["The agent needs every registered project, worktree, folder scope, provider, destination, or review provably affected by a resource."], doNotUseWhen: ["The agent needs only the application order for one target; use context trace."], tags: ["impact", "consumers", "projects", "worktrees", "providers", "destinations"], requiredContext: ["selector"], freshness: "accepted-shared-head-required", cost: "medium", handlerKey: "context.impact", ui: "both" }),
  define("context snapshot", { summary: "Create a content-addressed metadata-only context snapshot.", arguments: [...TARGET, PROVIDER], scopes: PROVIDER_SCOPES, handlerKey: "context.snapshot", ui: "diagnostic" }),
  define("context diff", { summary: "Compare two compatible context snapshots.", arguments: [option("--from", { required: true }), option("--to")], scopes: PROVIDER_SCOPES, handlerKey: "context.diff", ui: "diagnostic" }),

  define("docs search", { summary: "Search accepted documentation deterministically.", arguments: [positional("query"), ...TARGET, option("--repository"), option("--shared-project"), option("--status"), option("--kind"), option("--limit", { value: "integer" }), option("--budget", { value: "integer" }), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.search", ui: "both" }),
  define("docs read", { summary: "Read one accepted document or section.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--section"), option("--budget", { value: "integer" }), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.read", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs related", { summary: "List deterministic documentation relations.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.related", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs trace", { summary: "Trace documentation provenance.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--section"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.trace", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs inspect", { summary: "Inspect one document, its metadata, relations, diagrams, health, and review state.", arguments: [positional("selector"), ...TARGET, option("--repository"), option("--shared-project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.inspect", ui: "both" }),
  define("docs metadata", { summary: "Read raw and interpreted metadata for one document.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.metadata", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs links", { summary: "List outgoing document links with provenance.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.links", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs backlinks", { summary: "List incoming document links with provenance.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.backlinks", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs dependencies", { summary: "List declared dependency relations for one document.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.dependencies", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs diagrams", { summary: "List diagram relations and safe render information for one document.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.diagrams", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs validate", { summary: "Validate one document against active metadata profiles and health rules.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.validate", ui: "both", exposure: "internal", replacement: "docs inspect" }),
  define("docs edit", { summary: "Open a bounded local or shared documentation change and return its change handle.", arguments: [option("--task", { required: true }), option("--document"), option("--scope", { value: "local|shared" }), option("--description"), option("--session"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], mutation: "mutating", protocol: "direct", humanDecision: "file-review-remains-human", authority: "documentation-change", effect: "reversible-local", handlerKey: "docs.edit", ui: "both", exposure: "compatibility", replacement: "edit" }),
  define("docs publish", { summary: "Legacy transport for pushing an existing documentation proposal branch.", arguments: [option("--change", { required: true }), option("--summary"), option("--description")], scopes: ["shared", ...PROJECT_SCOPES], mutation: "mutating", protocol: "direct", humanDecision: "file-review-remains-human", authority: "documentation-change", effect: "proposal-only", freshness: "fresh-before-publish", handlerKey: "docs.publish", ui: "diagnostic", exposure: "internal" }),

  define("review list", { summary: "List file reviews without changing decisions.", arguments: [...TARGET, option("--reason"), option("--severity"), ...PAGE], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.list", ui: "both" }),
  define("review show", { summary: "Show one review item without changing its decision.", arguments: [positional("selector"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.show", ui: "both" }),
  define("review diff", { summary: "Show the diff or current version for one review item.", arguments: [positional("selector"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.diff", ui: "both", exposure: "compatibility", replacement: "review show" }),
  define("review open", { summary: "Open one review item in Context Room.", arguments: [positional("selector"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.open", ui: "both", exposure: "compatibility", replacement: "ui open" }),
  define("review annotate", { summary: "Add a human-facing annotation to a review item.", arguments: [positional("selector"), ...TARGET, option("--note", { required: true }), ...APPLY], scopes: ["shared", ...PROJECT_SCOPES], mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", handlerKey: "review.annotate", ui: "both", exposure: "compatibility", replacement: "note add" }),

  define("proposal context-impact", { summary: "Preview the exact context impact of a proposal head.", arguments: [positional("selector"), option("--repository", { required: true }), ...PAGE], scopes: ["shared"], useWhen: ["The agent must explain how an unaccepted proposal would change accepted context without applying it."], tags: ["proposal", "impact", "preview", "review"], requiredContext: ["proposal-selector", "repository"], freshness: "accepted-shared-head-required", cost: "high", humanDecision: "file-review-remains-human", handlerKey: "proposal.context-impact", ui: "both", exposure: "compatibility", replacement: "proposal impact" }),
  define("proposal list", { summary: "List shared proposals relevant to the selected project.", arguments: [...TARGET, option("--shared"), option("--session"), ...PAGE], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "proposal.list", ui: "both" }),
  define("proposal impact", { summary: "Preview the exact context impact of one proposal head.", arguments: [positional("selector"), option("--repository"), ...TARGET, ...PAGE], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", freshness: "accepted-shared-head-required", cost: "high", handlerKey: "proposal.impact", ui: "both" }),

  define("shared skills status", { summary: "Show shared skill collections, assignments, mounts, and diagnostics.", arguments: [option("--root"), option("--fresh", { value: "boolean" }), ...PAGE], scopes: SHARED_SCOPES, outputSchema: "legacy-json", handlerKey: "shared.skills.status", ui: "both" }),
  define("shared skills effective", { summary: "Show the effective Shared Skills projection.", arguments: [...TARGET, PROVIDER, ...PAGE], scopes: SHARED_SCOPES, handlerKey: "shared.skills.effective", ui: "both" }),
  define("shared skills explain", { summary: "Explain a collection, assignment, skill, destination, or override.", arguments: [positional("selector"), ...TARGET, PROVIDER], scopes: SHARED_SCOPES, handlerKey: "shared.skills.explain", ui: "both" }),
  define("shared skills assign", { summary: "Plan or apply a shared assignment proposal.", arguments: [option("--collection", { required: true }), option("--assignment"), option("--scope"), option("--projects"), option("--projects-file"), option("--providers"), option("--include"), option("--exclude"), option("--title"), option("--description"), option("--session"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", handlerKey: "shared.skills.assign", ui: "both" }),
  define("shared skills unassign", { summary: "Plan or apply removal of a shared assignment through a proposal.", arguments: [option("--assignment", { required: true }), option("--title"), option("--description"), option("--session"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", handlerKey: "shared.skills.unassign", ui: "both" }),
  define("shared skills import", { summary: "Plan or apply a selective import through a shared proposal.", arguments: [option("--source", { required: true }), option("--collection", { required: true }), option("--collection-title"), option("--collection-path"), option("--skills"), option("--scope"), option("--projects"), option("--projects-file"), option("--providers"), option("--destination"), option("--include"), option("--exclude"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", handlerKey: "shared.skills.import", ui: "both" }),
  define("shared skills link", { summary: "Plan or apply a managed local destination for an accepted assignment.", arguments: [option("--assignment", { required: true }), option("--collection"), PROVIDER, option("--scope"), option("--destination", { required: true }), option("--include"), option("--exclude"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "shared.skills.link", ui: "both" }),
  define("shared skills unlink", { summary: "Plan or apply removal of a managed local destination.", arguments: [option("--id", { required: true }), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "shared.skills.unlink", ui: "both" }),
  define("shared skills reconcile", { summary: "Plan or apply managed-link reconciliation.", arguments: [...TARGET, PROVIDER, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "shared.skills.reconcile", ui: "both" }),
  define("shared skills override", { summary: "Plan or apply local assignment and skill exclusions.", arguments: [option("--assignment", { required: true }), option("--enabled"), option("--include"), option("--exclude"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "shared.skills.override", ui: "both" }),
  define("shared instructions status", { summary: "Show accepted shared instruction collections, assignments, managed links, and conflicts.", arguments: [option("--root"), option("--fresh", { value: "boolean" }), ...PAGE], scopes: SHARED_SCOPES, handlerKey: "shared.instructions.status", ui: "both" }),
  define("shared instructions assign", { summary: "Plan or apply an instruction assignment proposal using explicit file mappings.", arguments: [option("--collection", { required: true }), option("--assignment"), option("--scope"), option("--projects"), option("--projects-file"), option("--files", { required: true, description: "JSON file containing source, target, and providers mappings." }), option("--title"), option("--description"), option("--session"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", handlerKey: "shared.instructions.assign", ui: "both" }),
  define("shared instructions unassign", { summary: "Plan or apply removal of an instruction assignment through a proposal.", arguments: [option("--assignment", { required: true }), option("--title"), option("--description"), option("--session"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", handlerKey: "shared.instructions.unassign", ui: "both" }),
  define("shared instructions import", { summary: "Plan or apply an atomic import of selected Markdown instructions and mappings.", arguments: [option("--collection", { required: true }), option("--collection-title"), option("--collection-path"), option("--scope"), option("--projects"), option("--projects-file"), option("--files", { required: true, description: "JSON file containing localPath, source, target, and providers mappings." }), option("--title"), option("--description"), option("--session"), ...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", handlerKey: "shared.instructions.import", ui: "both" }),
  define("shared instructions reconcile", { summary: "Plan or apply managed instruction-link reconciliation from accepted main.", arguments: [...TARGET, PROVIDER, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "shared.instructions.reconcile", ui: "both" }),

  define("shared connect", { summary: "Connect one registered project to an explicit shared context and synchronize accepted main.", arguments: [option("--repository", { required: true }), option("--shared-project"), ...TARGET, option("--dry-run", { value: "boolean" })], scopes: ["shared", "project"], mutation: "mutating", protocol: "direct", effect: "reversible-local", handlerKey: "shared.connect", ui: "both" }),
  define("shared assign", { summary: "Assign an accepted shared skill or instruction collection through a proposal.", arguments: [option("--resource", { value: "skills|instructions", required: true }), option("--collection", { required: true }), option("--assignment"), option("--scope"), option("--projects"), option("--projects-file"), option("--providers"), option("--files"), option("--include"), option("--exclude"), option("--title"), option("--description"), option("--session"), option("--idempotency-key"), ...TARGET], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "direct", effect: "proposal-only", authority: "shared-proposal", humanDecision: "file-review-remains-human", handlerKey: "shared.assign", ui: "both" }),
  define("shared unassign", { summary: "Remove an accepted shared skill or instruction assignment through a proposal.", arguments: [option("--resource", { value: "skills|instructions", required: true }), option("--assignment", { required: true }), option("--title"), option("--description"), option("--session"), option("--idempotency-key"), ...TARGET], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "direct", effect: "proposal-only", authority: "shared-proposal", humanDecision: "file-review-remains-human", handlerKey: "shared.unassign", ui: "both" }),
  define("shared local skill", { summary: "Manage one accepted Shared Skill assignment on this device.", arguments: [option("--action", { value: "link|unlink|override", required: true }), option("--assignment"), option("--id"), PROVIDER, option("--destination"), option("--enabled"), option("--include"), option("--exclude"), option("--idempotency-key"), ...TARGET, option("--dry-run", { value: "boolean" }), option("--apply")], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "effect-aware", effect: "reversible-local", handlerKey: "shared.local.skill", ui: "both" }),
  define("shared reconcile", { summary: "Reconcile accepted shared skills and instructions into registered local destinations.", arguments: [option("--resource", { value: "skills|instructions|all" }), ...TARGET, PROVIDER, option("--idempotency-key"), option("--dry-run", { value: "boolean" })], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "direct", effect: "reversible-local", handlerKey: "shared.reconcile", ui: "both" }),
  define("shared security", { summary: "Inspect shared repository protections or return an exact protected repair plan.", arguments: [...TARGET, option("--apply")], scopes: ["shared", "project"], protocol: "effect-aware", effect: "protected", handlerKey: "shared.security", ui: "diagnostic" }),

  define("settings get", { summary: "Read one or all typed context-management settings.", arguments: [positional("key", { required: false }), ...TARGET], scopes: PROVIDER_SCOPES, handlerKey: "settings.get", ui: "both" }),
  define("settings explain", { summary: "Explain one context-management setting and its scope.", arguments: [positional("key"), ...TARGET], scopes: PROVIDER_SCOPES, handlerKey: "settings.explain", ui: "both", exposure: "internal", replacement: "settings get" }),
  define("settings set", { summary: "Set typed context-management settings through an exact non-stale plan.", arguments: [option("--set", { required: true, repeatable: true }), ...TARGET, option("--apply")], scopes: PROVIDER_SCOPES, mutation: "mutating", protocol: "plan-apply", effect: "protected", handlerKey: "settings.set", ui: "both" }),
  define("settings plan", { summary: "Plan a typed context-management setting change.", arguments: [option("--set", { required: true, repeatable: true }), ...TARGET], scopes: PROVIDER_SCOPES, mutation: "read-only", protocol: "preview", handlerKey: "settings.plan", ui: "both", exposure: "compatibility", replacement: "settings set" }),
  define("settings apply", { summary: "Apply an exact non-stale context settings plan.", arguments: [positional("plan-id")], scopes: PROVIDER_SCOPES, mutation: "mutating", protocol: "apply-existing-plan", handlerKey: "settings.apply", ui: "both", exposure: "compatibility", replacement: "settings set --apply" }),

  define("doctor", { summary: "Diagnose Context Room with structured target filters.", arguments: [...TARGET, PROVIDER, option("--shared"), option("--all-projects", { value: "boolean" }), option("--only"), option("--strict", { value: "boolean" }), ...PAGE], scopes: PROVIDER_SCOPES, formats: ["human", "json", "jsonl"], handlerKey: "doctor", ui: "both" }),
  define("doctor explain", { summary: "Explain one existing Context Health issue.", arguments: [positional("issue-key"), ...TARGET], scopes: PROVIDER_SCOPES, handlerKey: "doctor.explain", ui: "both" }),
  define("doctor plan", { summary: "Preview a deterministic safe repair for one issue.", arguments: [positional("issue-key", { required: false }), ...TARGET], scopes: PROVIDER_SCOPES, protocol: "preview", handlerKey: "doctor.plan", ui: "both" }),

  define("hub", { summary: "Start or focus the single global Context Room.", arguments: [option("--root"), option("--port", { value: "integer" })], scopes: ["device"], mutation: "mutating", handlerKey: "hub.start", ui: "both" }),
  define("hub status", { summary: "Show the running global Hub and registered project catalog.", arguments: PAGE, scopes: ["device"], handlerKey: "hub.status", ui: "both" }),
  define("hub list", { summary: "List the Hub runtime, registry, and projects.", arguments: PAGE, scopes: ["device"], outputSchema: "legacy-json", handlerKey: "hub.list", ui: "both", exposure: "compatibility", replacement: "hub status" }),
  define("hub add-shared", { summary: "Register a shared repository in the Hub.", arguments: [option("--repository", { required: true })], scopes: ["device", "shared"], mutation: "mutating", handlerKey: "hub.add-shared", ui: "both" }),
  define("hub proposals", { summary: "List shared proposals in the Hub.", arguments: [option("--project"), option("--session"), ...PAGE], scopes: ["device", "shared", "project"], outputSchema: "legacy-json", handlerKey: "hub.proposals", ui: "both", exposure: "compatibility", replacement: "proposal list" }),
  define("hub open", { summary: "Open a Hub project or proposal.", arguments: [option("--project"), option("--session"), option("--proposal")], scopes: ["device", "shared", "project"], handlerKey: "hub.open", ui: "both", exposure: "compatibility", replacement: "ui open" }),

  define("shared init-repository", { summary: "Initialize a shared context repository.", arguments: [option("--root"), option("--name"), option("--title")], scopes: ["shared"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.init-repository", ui: "both" }),
  define("shared bind", { summary: "Bind a local project without synchronizing it.", arguments: [option("--root"), option("--repository", { required: true }), option("--project")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.bind", ui: "both" }),
  define("shared setup", { summary: "Connect and synchronize a local shared project.", arguments: [option("--root"), option("--repository", { required: true }), option("--project")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.setup", ui: "both" }),
  define("shared sync", { summary: "Synchronize accepted shared context.", arguments: TARGET, scopes: ["shared", "project", "worktree"], mutation: "mutating", protocol: "direct", effect: "reversible-local", handlerKey: "shared.sync", ui: "both" }),
  define("shared status", { summary: "Inspect a shared context connection.", arguments: TARGET, scopes: ["shared", "project", "worktree"], handlerKey: "shared.status", ui: "both" }),
  define("shared proposals", { summary: "List shared proposals.", arguments: [option("--root"), option("--project"), option("--session"), ...PAGE], scopes: ["shared", "project"], outputSchema: "legacy-json", handlerKey: "shared.proposals", ui: "both" }),
  define("shared propose", { summary: "Create or reuse a shared proposal branch.", arguments: [option("--root"), option("--title"), option("--description", { required: true }), option("--scope"), option("--branch"), option("--session")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", humanDecision: "file-review-remains-human", authority: "shared-proposal", outputSchema: "legacy-json", handlerKey: "shared.propose", ui: "both", exposure: "compatibility", replacement: "edit" }),
  define("shared publish", { summary: "Legacy transport for pushing a shared proposal branch.", arguments: [option("--root"), option("--proposal", { required: true }), option("--message"), option("--title"), option("--description")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", humanDecision: "file-review-remains-human", authority: "shared-proposal", outputSchema: "legacy-json", handlerKey: "shared.publish", ui: "diagnostic", exposure: "internal" }),
  define("shared review", { summary: "Open a proposal file-review workspace.", arguments: [option("--root"), option("--proposal", { required: true }), option("--port", { value: "integer" })], scopes: ["shared", "project"], mutation: "mutating", humanDecision: "file-review-remains-human", outputSchema: "text/plain", handlerKey: "shared.review", ui: "both" }),
  define("shared secure-github", { summary: "Configure supported shared repository protections.", arguments: [option("--root")], scopes: ["shared"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.secure-github", ui: "diagnostic" }),
  define("shared security-check", { summary: "Check shared GitHub repository protection.", arguments: [option("--root")], scopes: ["shared"], outputSchema: "legacy-json", handlerKey: "shared.security-check", ui: "diagnostic" }),

  define("init", { summary: "Initialize Context Room project configuration.", arguments: [option("--root"), option("--title"), option("--allow"), option("--watch")], scopes: ["project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "init", ui: "both" }),
  define("setup", { summary: "Initialize a project, register it, and open it in the global Context Room.", arguments: [option("--root"), option("--title"), option("--allow"), option("--watch"), option("--port", { value: "integer" })], scopes: ["project", "device"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "setup", ui: "both" }),
  define("start", { summary: "Register and focus a project in the global Context Room.", arguments: [option("--root"), option("--port", { value: "integer" })], scopes: ["project", "device"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "start", ui: "both" }),
  define("guard", { summary: "Evaluate the existing human review gate.", arguments: [option("--root"), option("--profile"), option("--operation"), option("--strict", { value: "boolean" }), option("--advisory", { value: "boolean" }), option("--hook", { value: "boolean" })], scopes: ["project"], humanDecision: "file-review-remains-human", outputSchema: "text/plain", handlerKey: "guard", ui: "both", exposure: "internal" }),
  define("hooks sync", { summary: "Synchronize configured local Context Room Git hooks.", arguments: [...TARGET, option("--dry-run", { value: "boolean" }), option("--apply")], scopes: ["project"], mutation: "mutating", protocol: "effect-aware", effect: "protected", handlerKey: "hooks.sync", ui: "both" }),
  define("install-hooks", { summary: "Install configured Context Room Git hooks.", arguments: [option("--root")], scopes: ["project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "install-hooks", ui: "both", exposure: "compatibility", replacement: "hooks sync" }),
  define("update-all", { summary: "Update explicitly registered Context Room installations.", arguments: [option("--dry-run", { value: "boolean" }), option("--no-restart", { value: "boolean" }), option("--exclude")], scopes: ["device"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "update-all", ui: "diagnostic" }),
]);

const REGISTRY_BY_PATH = new Map();
const REGISTRY_BY_ALIAS = new Map();
for (const entry of CLI_COMMAND_REGISTRY) {
  if (REGISTRY_BY_PATH.has(entry.path)) throw new TypeError(`Duplicate CLI command path: ${entry.path}`);
  REGISTRY_BY_PATH.set(entry.path, entry);
  for (const alias of entry.aliases) {
    if (REGISTRY_BY_PATH.has(alias) || REGISTRY_BY_ALIAS.has(alias)) throw new TypeError(`Duplicate CLI command alias: ${alias}`);
    REGISTRY_BY_ALIAS.set(alias, entry);
  }
}

function normalizeInclude(include = "canonical") {
  const normalized = String(include || "canonical").trim().toLowerCase();
  if (!["canonical", "compatibility", "all"].includes(normalized)) throw new TypeError(`Unknown capability exposure: ${normalized}`);
  return normalized;
}

function normalizeProfile(profile = "worker") {
  const normalized = String(profile || "worker").trim().toLowerCase();
  if (!CLI_PROFILES.includes(normalized)) throw new TypeError(`Unknown capability profile: ${normalized}`);
  return normalized;
}

function normalizeDetail(detail = "compact") {
  const normalized = String(detail || "compact").trim().toLowerCase();
  if (!CLI_DETAIL_LEVELS.includes(normalized)) throw new TypeError(`Unknown capability detail: ${normalized}`);
  return normalized;
}

function includedExposure(entry, include = "canonical") {
  const normalized = normalizeInclude(include);
  if (normalized === "all") return true;
  if (normalized === "compatibility") return CLI_CANONICAL_COMMANDS.has(entry.path) || entry.exposure === "compatibility";
  return CLI_CANONICAL_COMMANDS.has(entry.path);
}

export function listCliCommands({ installedOnly = false, include = "all" } = {}) {
  return CLI_COMMAND_REGISTRY.filter((entry) => (!installedOnly || entry.lifecycle === "current") && includedExposure(entry, include));
}

export function getCliCommand(path, { includeAliases = true } = {}) {
  const normalized = String(path || "").trim().replace(/\s+/g, " ");
  return REGISTRY_BY_PATH.get(normalized) || (includeAliases ? REGISTRY_BY_ALIAS.get(normalized) : null) || null;
}

export function cliCommandArgumentNames(entryOrPath) {
  const entry = typeof entryOrPath === "string" ? getCliCommand(entryOrPath) : entryOrPath;
  return entry ? entry.arguments.map((argument) => typeof argument === "string" ? argument : argument.name) : [];
}

export function cliRegistryDocument() {
  return {
    schemaVersion: CLI_REGISTRY_SCHEMA_VERSION,
    commands: CLI_COMMAND_REGISTRY.map((entry) => ({ ...entry })),
    uiCliParity: UI_CLI_PARITY_MATRIX.map((entry) => ({ ...entry })),
  };
}

function commandUsage(entry) {
  const args = entry.arguments.map((argument) => argument.kind === "positional"
    ? (argument.required ? `<${argument.name}>` : `[${argument.name}]`)
    : argument.required ? `${argument.name} <${argument.value || "value"}>` : `[${argument.name} <${argument.value || "value"}>]`).join(" ");
  return `context-room ${entry.path}${args ? ` ${args}` : ""}`;
}

function capabilityArgument(argument) {
  return {
    name: argument.name,
    kind: argument.kind,
    value: argument.value,
    required: argument.required,
    ...(argument.repeatable ? { repeatable: true } : {}),
    ...(argument.description ? { description: argument.description } : {}),
  };
}

function capabilityDescriptor(entry, detail = "compact") {
  const compact = {
    path: entry.path,
    summary: entry.summary,
    mutation: entry.mutation,
    cost: entry.cost,
    ...(entry.replacement ? { replacement: entry.replacement } : {}),
  };
  if (detail === "compact") return compact;
  const standard = {
    ...compact,
    usage: commandUsage(entry),
    arguments: entry.arguments.map(capabilityArgument),
    scopes: entry.scopes,
    formats: entry.formats,
    effect: entry.effect,
    authority: entry.authority,
    protocol: entry.protocol,
    humanDecision: entry.humanDecision,
    outputSchema: entry.outputSchema,
    freshness: entry.freshness,
  };
  if (detail === "standard") return standard;
  return {
    ...standard,
    exposure: entry.exposure,
    ...(entry.aliases.length ? { aliases: entry.aliases } : {}),
    handlerKey: entry.handlerKey,
    compatibilityOf: entry.compatibilityOf,
    useWhen: entry.useWhen,
    doNotUseWhen: entry.doNotUseWhen,
    tags: entry.tags,
    requiredContext: entry.requiredContext,
    lifecycle: entry.lifecycle,
  };
}

function namespaceDescriptors(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const name = entry.path.split(" ")[0];
    const group = grouped.get(name) || { name, commands: 0, costs: new Set(), authorities: new Set(), mutating: false };
    group.commands += 1;
    group.costs.add(entry.cost);
    group.authorities.add(entry.authority);
    group.mutating ||= entry.mutates;
    grouped.set(name, group);
  }
  return [...grouped.values()].map((group) => ({
    name: group.name,
    commands: group.commands,
    costs: [...group.costs].sort(),
    authorities: [...group.authorities].sort(),
    mutating: group.mutating,
  }));
}

function capabilitySections() {
  return Object.entries(CLI_CAPABILITY_SECTIONS).map(([id, section]) => ({
    id,
    summary: section.summary,
    inspect: `context-room capabilities --include ${id}`,
  }));
}

export function cliCapabilitiesFromRegistry({ version = "", installedPaths = null, include = "canonical", namespace = "", command = "", profile = "", detail = "compact", expand = false } = {}) {
  const installed = installedPaths ? new Set(installedPaths.map(String)) : null;
  const selectedProfile = profile ? normalizeProfile(profile) : "";
  const selectedDetail = normalizeDetail(detail);
  const available = CLI_COMMAND_REGISTRY
    .filter((entry) => (installed ? installed.has(entry.path) : entry.lifecycle === "current") && includedExposure(entry, expand ? "all" : include));
  const selectedNamespace = String(namespace || "").trim();
  const selectedCommand = String(command || "").trim().replace(/\s+/g, " ");
  const selectedSection = selectedNamespace && CLI_CAPABILITY_SECTIONS[selectedNamespace] ? selectedNamespace : "";
  if (selectedNamespace && !selectedSection && !available.some((entry) => entry.path === selectedNamespace || entry.path.startsWith(`${selectedNamespace} `))) {
    throw new TypeError(`Unknown capability section or namespace: ${selectedNamespace}`);
  }
  const commandEntry = selectedCommand ? getCliCommand(selectedCommand) : null;
  if (selectedCommand && (!commandEntry || commandEntry.lifecycle !== "current" || (!expand && commandEntry.exposure !== "canonical"))) throw new TypeError(`Unknown capability command: ${selectedCommand}`);
  if (!selectedNamespace && !selectedCommand && !selectedProfile && !expand) {
    return {
      schemaVersion: CLI_MACHINE_SCHEMA_VERSION_V2,
      version: String(version || ""),
      contractAudience: "ai-agent",
      detail: selectedDetail,
      view: "sections",
      primaryCommands: CLI_PRIMARY_COMMANDS.filter((path) => path !== "capabilities").map((path) => {
        const entry = getCliCommand(path);
        return { path: entry.path, summary: entry.summary };
      }),
      sections: capabilitySections(),
      humanOwned: ["accept-file-review", "reject-file-review"],
    };
  }
  const exposed = selectedCommand
    ? [commandEntry]
    : expand
      ? available
      : selectedSection
        ? CLI_CAPABILITY_SECTIONS[selectedSection].commands.map((path) => available.find((entry) => entry.path === path)).filter(Boolean)
      : selectedNamespace
        ? available.filter((entry) => entry.path === selectedNamespace || entry.path.startsWith(`${selectedNamespace} `))
        : selectedProfile
          ? CLI_PROFILE_COMMANDS[selectedProfile].map((path) => available.find((entry) => entry.path === path)).filter(Boolean)
          : available;
  const descriptorDetail = selectedCommand && selectedDetail === "compact" ? "standard" : selectedDetail;
  const commands = exposed.map((entry) => capabilityDescriptor(entry, descriptorDetail));
  const compact = {
    schemaVersion: CLI_MACHINE_SCHEMA_VERSION_V2,
    version: String(version || ""),
    contractAudience: "ai-agent",
    ...(selectedProfile ? { profile: selectedProfile } : {}),
    detail: descriptorDetail,
    view: selectedCommand ? "command" : expand ? "expanded" : selectedSection ? "section" : selectedNamespace ? "namespace" : selectedProfile ? "profile" : "catalog",
    ...(selectedSection ? { section: { id: selectedSection, summary: CLI_CAPABILITY_SECTIONS[selectedSection].summary } } : selectedNamespace ? { namespace: selectedNamespace } : {}),
    ...(selectedCommand ? { selectedCommand } : {}),
    ...(selectedProfile ? { profiles: Object.fromEntries(CLI_PROFILES.map((name) => [name, CLI_PROFILE_COMMANDS[name].length])) } : {}),
    ...(expand ? { namespaces: namespaceDescriptors(available) } : {}),
    commands,
    humanOwned: ["accept-file-review", "reject-file-review"],
  };
  if (selectedDetail === "compact") return compact;
  const standard = {
    ...compact,
    registrySchemaVersion: CLI_REGISTRY_SCHEMA_VERSION,
    outputFormats: [...CLI_OUTPUT_FORMATS],
    globalOptions: [...CLI_GLOBAL_OPTIONS],
    providers: ["auto", "codex", "claude-code", "opencode", "all"],
    defaultOutput: "json when --format is omitted",
    mutationProtocol: {
      preview: "--dry-run is optional; protected operations return an exact plan",
      apply: "repeat the same protected command with --apply <plan-id>",
      staleError: "stale-plan",
      legacyPlanFlag: "compatibility-only",
    },
  };
  if (selectedDetail === "standard") return standard;
  return expand ? { ...standard, registry: cliRegistryDocument() } : standard;
}

export function renderCliHelpFromRegistry({ installedOnly = true, include = "canonical", namespace = "", all = false } = {}) {
  const selectedNamespace = String(namespace || "").trim();
  const available = listCliCommands({ installedOnly, include });
  const entriesToRender = all
    ? available
    : selectedNamespace
      ? available.filter((entry) => entry.path === selectedNamespace || entry.path.startsWith(`${selectedNamespace} `))
      : CLI_PRIMARY_COMMANDS.map((path) => available.find((entry) => entry.path === path)).filter(Boolean);
  if (selectedNamespace && !entriesToRender.length) throw new TypeError(`Unknown command namespace: ${selectedNamespace}`);
  const groups = new Map();
  for (const entry of entriesToRender) {
    const group = entry.path.split(" ")[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  const lines = [selectedNamespace ? `Context Room · ${selectedNamespace}` : "Context Room", "", "Commands:"];
  for (const [group, entries] of groups) {
    lines.push(`  ${group}`);
    for (const entry of entries) {
      const args = entry.arguments.map((argument) => argument.kind === "positional"
        ? (argument.required ? `<${argument.name}>` : `[${argument.name}]`)
        : argument.required ? `${argument.name} <value>` : `[${argument.name}]`).join(" ");
      lines.push(`    context-room ${entry.path}${args ? ` ${args}` : ""}`);
      lines.push(`      ${entry.summary}`);
    }
  }
  if (!all && !selectedNamespace) {
    lines.push("", "More capabilities:", "  context-room capabilities", "  context-room capabilities \"<command>\"", "  context-room <namespace> --help", "  context-room --help --all");
  }
  return lines.join("\n") + "\n";
}

export function renderCliCompletionFromRegistry(shell = "zsh", { installedOnly = true } = {}) {
  const normalized = String(shell || "zsh").trim().toLowerCase();
  if (!["zsh", "bash", "fish"].includes(normalized)) throw new TypeError(`Unknown completion shell: ${normalized}`);
  const entries = listCliCommands({ installedOnly, include: "canonical" });
  const topLevel = [...new Set(entries.map((entry) => entry.path.split(" ")[0]))];
  const subcommands = Object.fromEntries(topLevel.map((top) => [top, [...new Set(entries
    .map((entry) => entry.path.split(" "))
    .filter((parts) => parts[0] === top && parts[1])
    .map((parts) => parts[1]))]]));
  const nested = new Map();
  for (const entry of entries) {
    const parts = entry.path.split(" ");
    if (parts.length < 3) continue;
    const prefix = `${parts[0]} ${parts[1]}`;
    if (!nested.has(prefix)) nested.set(prefix, new Set());
    nested.get(prefix).add(parts[2]);
  }
  const options = [...new Set([...CLI_GLOBAL_OPTIONS, ...entries.flatMap(cliCommandArgumentNames).filter((name) => name.startsWith("--"))])];
  if (normalized === "fish") {
    return [
      ...topLevel.map((command) => `complete -c context-room -f -n '__fish_use_subcommand' -a '${command}'`),
      ...Object.entries(subcommands).flatMap(([command, values]) => values.map((value) => `complete -c context-room -f -n '__fish_seen_subcommand_from ${command}' -a '${value}'`)),
      ...[...nested.entries()].flatMap(([prefix, values]) => {
        const [top, second] = prefix.split(" ");
        return [...values].map((value) => `complete -c context-room -f -n '__fish_seen_subcommand_from ${top}; and __fish_seen_subcommand_from ${second}' -a '${value}'`);
      }),
      ...options.map((name) => `complete -c context-room -l '${name.slice(2)}'`),
    ].join("\n") + "\n";
  }
  if (normalized === "bash") {
    const cases = Object.entries(subcommands).filter(([, values]) => values.length)
      .map(([command, values]) => `    ${command}) choices='${values.join(" ")} ${options.join(" ")}' ;;`).join("\n");
    const nestedCases = [...nested.entries()].map(([prefix, values]) => `    '${prefix}') choices='${[...values].join(" ")} ${options.join(" ")}' ;;`).join("\n");
    return `_context_room_complete() {\n  local current="${"${COMP_WORDS[COMP_CWORD]}"}" choices='${topLevel.join(" ")} ${options.join(" ")}'\n  if [[ $COMP_CWORD -ge 3 ]]; then\n    case "${"${COMP_WORDS[1]} ${COMP_WORDS[2]}"}" in\n${nestedCases}\n    esac\n  elif [[ $COMP_CWORD -ge 2 ]]; then\n    case "${"${COMP_WORDS[1]}"}" in\n${cases}\n    esac\n  fi\n  COMPREPLY=( $(compgen -W "$choices" -- "$current") )\n}\ncomplete -F _context_room_complete context-room\n`;
  }
  const cases = Object.entries(subcommands).filter(([, values]) => values.length)
    .map(([command, values]) => `  ${command}) _values 'subcommand' ${values.join(" ")} ${options.map((value) => `'${value}'`).join(" ")} ;;`).join("\n");
  const nestedCases = [...nested.entries()].map(([prefix, values]) => `  '${prefix}') _values 'subcommand' ${[...values].join(" ")} ${options.map((value) => `'${value}'`).join(" ")} ;;`).join("\n");
  return `#compdef context-room\n_arguments '1:command:(${topLevel.join(" ")})' '*::argument:->args'\nif (( CURRENT >= 4 )); then\n  case "$words[2] $words[3]" in\n${nestedCases}\n  esac\nelse\n  case $words[2] in\n${cases}\n  esac\nfi\n`;
}

export const UI_CLI_PARITY_MATRIX = freeze([
  { capability: "Effective context", ui: "Startup environment and folder inspection", cli: "context effective", classification: "both" },
  { capability: "Context application trace", ui: "Trace resource", cli: "context explain", classification: "both" },
  { capability: "Context consumer impact", ui: "Show impact", cli: "context impact", classification: "both" },
  { capability: "Structural Context Graph", ui: "Document graph", cli: null, classification: "internal-engine" },
  { capability: "Context snapshots and diffs", ui: null, cli: "context snapshot; context diff", classification: "cli-machine-diagnostic" },
  { capability: "Proposal context impact", ui: "Proposal Context Impact panel", cli: "proposal impact", classification: "both" },
  { capability: "Shared resources management", ui: "Shared skills and instructions Settings", cli: "shared assign|unassign|local skill|reconcile", classification: "both" },
  { capability: "Context settings", ui: "Context Settings", cli: "settings get|set", classification: "both" },
  { capability: "Context diagnostics", ui: "Context Health", cli: "doctor", classification: "both" },
  { capability: "Documentation changes", ui: "Document editor and proposal review", cli: "edit", classification: "both" },
  { capability: "Accept or reject file review", ui: "Review decision controls", cli: null, classification: "human-decision-ui-only" },
]);

function normalizeCommandDescriptor(value) {
  if (typeof value === "string") return { path: value };
  return value && typeof value === "object" ? value : { path: "" };
}

function commandFromExample(example) {
  const source = typeof example === "string" ? example : example?.command;
  const tokens = String(source || "").trim().split(/\s+/);
  const executable = tokens.lastIndexOf("context-room");
  if (executable === -1) return null;
  const tail = tokens.slice(executable + 1).filter((token) => !token.startsWith("--"));
  for (let size = Math.min(3, tail.length); size > 0; size -= 1) {
    const candidate = tail.slice(0, size).join(" ");
    const entry = getCliCommand(candidate);
    if (entry) return entry;
  }
  return null;
}

/**
 * Validate independently collected dispatcher/capabilities/completion/docs
 * evidence. Integrators should feed parsed descriptors from their own layer;
 * this module deliberately does not scrape the dispatcher source.
 */
export function validateCliParity({
  dispatcherCommands = [],
  capabilityCommands = [],
  completionCommands = [],
  documentedArguments = {},
  documentationExamples = [],
} = {}) {
  const errors = [];
  const dispatcher = dispatcherCommands.map(normalizeCommandDescriptor);
  const capabilities = capabilityCommands.map(normalizeCommandDescriptor);
  const completion = new Set(completionCommands.map((item) => normalizeCommandDescriptor(item).path));
  const capabilityPaths = new Set(capabilities.map((item) => item.path));
  for (const descriptor of dispatcher) {
    const entry = getCliCommand(descriptor.path, { includeAliases: false });
    if (!entry) {
      errors.push({ code: "dispatcher-command-unregistered", path: descriptor.path });
      continue;
    }
    if (!capabilityPaths.has(entry.path)) errors.push({ code: "dispatcher-command-missing-capability", path: entry.path });
    if (!completion.has(entry.path)) errors.push({ code: "dispatcher-command-missing-completion", path: entry.path });
    if (typeof descriptor.mutates === "boolean" && descriptor.mutates !== entry.mutates) {
      errors.push({ code: "dispatcher-mutation-mismatch", path: entry.path, registryMutates: entry.mutates, dispatcherMutates: descriptor.mutates });
    }
    const accepted = new Set(cliCommandArgumentNames(entry));
    for (const argument of descriptor.arguments || []) {
      if (!accepted.has(argument)) errors.push({ code: "dispatcher-argument-unregistered", path: entry.path, argument });
    }
  }
  for (const descriptor of capabilities) {
    const entry = getCliCommand(descriptor.path, { includeAliases: false });
    if (!entry) errors.push({ code: "capability-command-unregistered", path: descriptor.path });
    else {
      if (!dispatcher.some((item) => item.path === entry.path)) errors.push({ code: "capability-command-not-dispatched", path: entry.path });
      if (typeof descriptor.mutates === "boolean" && descriptor.mutates !== entry.mutates) {
        errors.push({ code: "capability-mutation-mismatch", path: entry.path, registryMutates: entry.mutates, capabilityMutates: descriptor.mutates });
      }
      const accepted = new Set(cliCommandArgumentNames(entry));
      for (const argument of descriptor.arguments || []) {
        if (!accepted.has(argument)) errors.push({ code: "capability-argument-unregistered", path: entry.path, argument });
      }
    }
  }
  for (const [commandPath, args] of Object.entries(documentedArguments)) {
    const entry = getCliCommand(commandPath);
    if (!entry) {
      errors.push({ code: "documented-command-unregistered", path: commandPath });
      continue;
    }
    const accepted = new Set(cliCommandArgumentNames(entry));
    for (const argument of args) {
      if (!accepted.has(argument) && !CLI_GLOBAL_OPTIONS.includes(argument)) errors.push({ code: "documented-argument-not-accepted", path: entry.path, argument });
    }
  }
  for (const example of documentationExamples) {
    if (!commandFromExample(example)) errors.push({ code: "documentation-example-obsolete", example: typeof example === "string" ? example : example?.command || "" });
  }
  return { ok: errors.length === 0, errors };
}
