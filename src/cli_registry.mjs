export const CLI_REGISTRY_SCHEMA_VERSION = "context-room.cli-registry/2";
export const CLI_MACHINE_SCHEMA_VERSION = "context-room.cli/1";
export const CLI_OUTPUT_FORMATS = Object.freeze(["human", "json", "jsonl"]);
export const CLI_GLOBAL_OPTIONS = Object.freeze([
  "--format",
  "--quiet",
  "--verbose",
  "--no-color",
  "--non-interactive",
  "--fields",
  "--expand",
  "--summary",
]);

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
  });
}

/**
 * Installed product command inventory. The dispatcher, capabilities, help, and
 * completions consume this same registry so a command cannot be advertised
 * independently from its executable contract.
 */
export const CLI_COMMAND_REGISTRY = freeze([
  define("capabilities", {
    summary: "List the installed machine-readable CLI contract.",
    arguments: [option("--include", { value: "canonical|all" }), option("--expand")],
    useWhen: ["The agent needs to discover supported operations, arguments, authority, cost, or schemas."],
    tags: ["discovery", "contract", "capabilities"],
    handlerKey: "capabilities",
    ui: "diagnostic",
  }),
  define("completion", { summary: "Generate zsh, bash, or fish completion from the command registry.", arguments: [positional("shell", { required: false })], formats: ["human"], outputSchema: "text/plain", handlerKey: "completion", ui: "diagnostic", exposure: "internal" }),

  define("project current", { summary: "Resolve the current registered project and location.", arguments: TARGET, scopes: PROJECT_SCOPES, handlerKey: "project.current", ui: "both" }),
  define("project list", { summary: "List registered projects and worktree locations.", arguments: PAGE, scopes: ["device"], handlerKey: "project.list", ui: "both" }),
  define("project search", { summary: "Search the registered project catalog.", arguments: PAGE, scopes: ["device"], handlerKey: "project.search", ui: "both" }),
  define("project register", { summary: "Explicitly register a project or worktree location.", arguments: [...TARGET, option("--title"), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "project.register", ui: "both" }),
  define("project open", { summary: "Open a registered project in the running Hub.", arguments: TARGET, scopes: PROJECT_SCOPES, handlerKey: "project.open", ui: "both" }),
  define("project recent", { summary: "List recently used registered locations.", arguments: PAGE, scopes: ["device"], handlerKey: "project.recent", ui: "both" }),

  define("workspace list", { summary: "List active global Context Room workspaces without exposing drafts.", arguments: [...TARGET, ...PAGE], scopes: ["device", ...PROJECT_SCOPES], handlerKey: "workspace.list", ui: "both" }),
  define("workspace open", { summary: "Create a URL for a new independent global Context Room workspace.", arguments: [...TARGET, option("--file")], scopes: ["device", ...PROJECT_SCOPES], handlerKey: "workspace.open", ui: "both" }),

  define("agent prepare", { summary: "Build deterministic task startup context.", arguments: [option("--task", { required: true }), ...TARGET, option("--repository"), PROVIDER, option("--session"), option("--fresh", { value: "boolean" }), option("--budget", { value: "integer" })], scopes: PROVIDER_SCOPES, useWhen: ["An agent is beginning a task and needs the resolved target, accepted context, reviews, proposals, health, and next actions in one response."], doNotUseWhen: ["Only one exact context resource or relation needs inspection."], tags: ["prepare", "task", "startup", "context"], requiredContext: ["task"], freshness: "accepted-shared-head-when-connected", cost: "medium", handlerKey: "agent.prepare", ui: "both" }),
  define("agent instructions", { summary: "Generate provider-specific instructions for a coding agent.", arguments: [...TARGET, PROVIDER], scopes: PROVIDER_SCOPES, handlerKey: "agent.instructions", ui: "diagnostic" }),
  define("agent changes", { summary: "Classify local and shared documentation changes.", arguments: [...TARGET, option("--session")], scopes: PROJECT_SCOPES, handlerKey: "agent.changes", ui: "diagnostic" }),
  define("agent handoff", { summary: "Plan or apply a deterministic documentation handoff.", arguments: [option("--task", { required: true }), option("--description"), option("--session"), option("--idempotency-key"), ...TARGET, ...APPLY], scopes: ["shared", ...PROJECT_SCOPES], mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", authority: "shared-proposal", useWhen: ["The agent has finished documentation work and must route local files to review or shared files to proposals."], tags: ["handoff", "publish", "proposal", "review"], requiredContext: ["task", "project-or-location"], freshness: "fresh-before-apply", cost: "high", handlerKey: "agent.handoff", ui: "both" }),
  define("agent help", { summary: "Show the paste-ready agent workflow.", arguments: [option("--root")], formats: ["human"], outputSchema: "text/plain", handlerKey: "agent.help", ui: "both", exposure: "internal" }),
  define("agent state", { summary: "Inspect one active Context Room workspace.", arguments: [...TARGET, option("--workspace")], scopes: PROJECT_SCOPES, handlerKey: "agent.state", ui: "diagnostic" }),
  define("agent watch", { summary: "Add or replace an explicit folder watch rule.", arguments: [option("--root"), option("--path", { required: true }), option("--mode"), ...APPLY], scopes: ["project", "folder"], mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.watch", ui: "both" }),
  define("agent unwatch", { summary: "Remove an explicit folder watch rule.", arguments: [option("--root"), option("--path", { required: true }), ...APPLY], scopes: ["project", "folder"], mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.unwatch", ui: "both" }),
  define("agent open", { summary: "Navigate one exact running Context Room workspace.", arguments: [...TARGET, option("--workspace"), option("--path"), option("--view"), option("--heading"), option("--text"), option("--percent", { value: "number" }), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.open", ui: "ui-control" }),
  define("agent scroll", { summary: "Scroll one exact running Context Room workspace to a target.", arguments: [...TARGET, option("--workspace"), option("--path"), option("--heading"), option("--text"), option("--percent", { value: "number" }), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.scroll", ui: "ui-control" }),
  define("agent highlight", { summary: "Highlight a target in one exact running Context Room workspace.", arguments: [...TARGET, option("--workspace"), option("--path"), option("--heading"), option("--text"), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", handlerKey: "agent.highlight", ui: "ui-control" }),
  define("agent annotate", { summary: "Attach a human-facing annotation without deciding a review.", arguments: [option("--root"), option("--path", { required: true }), option("--note", { required: true }), option("--target"), ...APPLY], scopes: PROJECT_SCOPES, mutation: "mutating", protocol: "legacy-direct-with-preview", humanDecision: "none", handlerKey: "agent.annotate", ui: "both" }),
  define("agent annotations", { summary: "List human-facing annotations.", arguments: [option("--root"), option("--path")], scopes: PROJECT_SCOPES, handlerKey: "agent.annotations", ui: "both" }),

  define("context ask", { summary: "Run the existing documentation Research Agent.", arguments: [positional("task"), option("--root"), option("--repository"), option("--project"), option("--goal"), option("--files"), option("--depth"), option("--budget", { value: "integer" }), option("--session"), option("--json", { value: "boolean" })], scopes: ["shared", ...PROJECT_SCOPES], formats: ["human", "json"], handlerKey: "context.ask", ui: "both" }),
  define("context effective", { summary: "Resolve the complete accepted context for an exact coordinate.", arguments: [...TARGET, PROVIDER, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, useWhen: ["The agent needs the final accepted context for one project, worktree, folder, and provider."], doNotUseWhen: ["The agent needs the full application chain of one resource; use context trace.", "The agent needs every proven consumer of one resource; use context impact."], tags: ["context", "effective", "instructions", "skills", "hooks", "documents", "provider"], requiredContext: ["project-or-location", "folder", "provider"], freshness: "accepted-shared-head-required", cost: "medium", handlerKey: "context.effective", ui: "both" }),
  define("context graph", { summary: "Expose proven context resources, applications, and relations.", arguments: [...TARGET, PROVIDER, ...PAGE, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, handlerKey: "context.graph", ui: "diagnostic" }),
  define("context trace", { summary: "Trace the ordered application chain for a context resource.", arguments: [positional("selector"), ...TARGET, PROVIDER, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, useWhen: ["The agent needs the complete ordered chain that produced a resource's effective state."], doNotUseWhen: ["Only the final effective context is needed; use context effective."], tags: ["trace", "why", "order", "override", "provenance"], requiredContext: ["selector", "project-or-location", "folder", "provider"], freshness: "accepted-shared-head-required", handlerKey: "context.trace", ui: "both" }),
  define("context impact", { summary: "List the proven consumers of a context resource.", arguments: [positional("selector"), ...TARGET, PROVIDER, option("--shared"), ...PAGE, option("--allow-stale", { value: "boolean" })], scopes: PROVIDER_SCOPES, useWhen: ["The agent needs every registered project, worktree, folder scope, provider, destination, or review provably affected by a resource."], doNotUseWhen: ["The agent needs only the application order for one target; use context trace."], tags: ["impact", "consumers", "projects", "worktrees", "providers", "destinations"], requiredContext: ["selector"], freshness: "accepted-shared-head-required", cost: "medium", handlerKey: "context.impact", ui: "both" }),
  define("context snapshot", { summary: "Create a content-addressed metadata-only context snapshot.", arguments: [...TARGET, PROVIDER], scopes: PROVIDER_SCOPES, handlerKey: "context.snapshot", ui: "diagnostic" }),
  define("context diff", { summary: "Compare two compatible context snapshots.", arguments: [option("--from", { required: true }), option("--to")], scopes: PROVIDER_SCOPES, handlerKey: "context.diff", ui: "diagnostic" }),

  define("docs search", { summary: "Search accepted documentation deterministically.", arguments: [positional("query"), option("--root"), option("--repository"), option("--project"), option("--status"), option("--kind"), option("--limit", { value: "integer" }), option("--budget", { value: "integer" }), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.search", ui: "both" }),
  define("docs read", { summary: "Read one accepted document or section.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--section"), option("--budget", { value: "integer" }), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.read", ui: "both" }),
  define("docs related", { summary: "List deterministic documentation relations.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.related", ui: "both" }),
  define("docs trace", { summary: "Trace documentation provenance.", arguments: [positional("selector"), option("--root"), option("--repository"), option("--project"), option("--section"), option("--session")], scopes: ["shared", ...PROJECT_SCOPES], outputSchema: "legacy-json", handlerKey: "docs.trace", ui: "both" }),

  define("review list", { summary: "List file reviews without changing decisions.", arguments: [...TARGET, option("--reason"), option("--severity"), ...PAGE], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.list", ui: "both" }),
  define("review show", { summary: "Show one review item without changing its decision.", arguments: [positional("selector"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.show", ui: "both" }),
  define("review diff", { summary: "Show the diff or current version for one review item.", arguments: [positional("selector"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.diff", ui: "both" }),
  define("review open", { summary: "Open one review item in Context Room.", arguments: [positional("selector"), ...TARGET], scopes: ["shared", ...PROJECT_SCOPES], humanDecision: "file-review-remains-human", handlerKey: "review.open", ui: "both" }),
  define("review annotate", { summary: "Add a human-facing annotation to a review item.", arguments: [positional("selector"), ...TARGET, option("--note", { required: true }), ...APPLY], scopes: ["shared", ...PROJECT_SCOPES], mutation: "mutating", protocol: "preview-apply", humanDecision: "file-review-remains-human", handlerKey: "review.annotate", ui: "both" }),

  define("proposal context-impact", { summary: "Preview the exact context impact of a proposal head.", arguments: [positional("selector"), option("--repository", { required: true }), ...PAGE], scopes: ["shared"], useWhen: ["The agent must explain how an unaccepted proposal would change accepted context without applying it."], tags: ["proposal", "impact", "preview", "review"], requiredContext: ["proposal-selector", "repository"], freshness: "accepted-shared-head-required", cost: "high", humanDecision: "file-review-remains-human", handlerKey: "proposal.context-impact", ui: "both" }),

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
  define("shared instructions reconcile", { summary: "Plan or apply managed instruction-link reconciliation from accepted main.", arguments: [...TARGET, ...APPLY], scopes: SHARED_SCOPES, mutation: "mutating", protocol: "preview-apply", handlerKey: "shared.instructions.reconcile", ui: "both" }),

  define("settings get", { summary: "Read one or all typed context-management settings.", arguments: [positional("key", { required: false }), ...TARGET], scopes: PROVIDER_SCOPES, handlerKey: "settings.get", ui: "both" }),
  define("settings explain", { summary: "Explain one context-management setting and its scope.", arguments: [positional("key"), ...TARGET], scopes: PROVIDER_SCOPES, handlerKey: "settings.explain", ui: "both" }),
  define("settings plan", { summary: "Plan a typed context-management setting change.", arguments: [option("--set", { required: true, repeatable: true }), ...TARGET], scopes: PROVIDER_SCOPES, mutation: "read-only", protocol: "preview", handlerKey: "settings.plan", ui: "both" }),
  define("settings apply", { summary: "Apply an exact non-stale context settings plan.", arguments: [positional("plan-id")], scopes: PROVIDER_SCOPES, mutation: "mutating", protocol: "apply-existing-plan", handlerKey: "settings.apply", ui: "both" }),

  define("doctor", { summary: "Diagnose Context Room with structured target filters.", arguments: [...TARGET, PROVIDER, option("--shared"), option("--all-projects", { value: "boolean" }), option("--only"), option("--strict", { value: "boolean" }), ...PAGE], scopes: PROVIDER_SCOPES, handlerKey: "doctor", ui: "both" }),
  define("doctor explain", { summary: "Explain one existing Context Health issue.", arguments: [positional("issue-key"), ...TARGET], scopes: PROVIDER_SCOPES, handlerKey: "doctor.explain", ui: "both" }),
  define("doctor plan", { summary: "Preview a deterministic safe repair for one issue.", arguments: [positional("issue-key", { required: false }), ...TARGET], scopes: PROVIDER_SCOPES, protocol: "preview", handlerKey: "doctor.plan", ui: "both" }),

  define("hub", { summary: "Start or focus the single global Context Room.", arguments: [option("--root"), option("--port", { value: "integer" })], scopes: ["device"], mutation: "mutating", handlerKey: "hub.start", ui: "both" }),
  define("hub list", { summary: "List the Hub runtime, registry, and projects.", arguments: PAGE, scopes: ["device"], outputSchema: "legacy-json", handlerKey: "hub.list", ui: "both" }),
  define("hub add-shared", { summary: "Register a shared repository in the Hub.", arguments: [option("--repository", { required: true })], scopes: ["device", "shared"], mutation: "mutating", handlerKey: "hub.add-shared", ui: "both" }),
  define("hub proposals", { summary: "List shared proposals in the Hub.", arguments: [option("--project"), option("--session"), ...PAGE], scopes: ["device", "shared", "project"], outputSchema: "legacy-json", handlerKey: "hub.proposals", ui: "both" }),
  define("hub open", { summary: "Open a Hub project or proposal.", arguments: [option("--project"), option("--session"), option("--proposal")], scopes: ["device", "shared", "project"], handlerKey: "hub.open", ui: "both" }),

  define("shared init-repository", { summary: "Initialize a shared context repository.", arguments: [option("--root"), option("--name"), option("--title")], scopes: ["shared"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.init-repository", ui: "both" }),
  define("shared bind", { summary: "Bind a local project without synchronizing it.", arguments: [option("--root"), option("--repository", { required: true }), option("--project")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.bind", ui: "both" }),
  define("shared setup", { summary: "Connect and synchronize a local shared project.", arguments: [option("--root"), option("--repository", { required: true }), option("--project")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.setup", ui: "both" }),
  define("shared sync", { summary: "Synchronize accepted shared context.", arguments: [option("--root")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.sync", ui: "both" }),
  define("shared status", { summary: "Inspect a shared context connection.", arguments: [option("--root")], scopes: ["shared", "project"], outputSchema: "legacy-json", handlerKey: "shared.status", ui: "both" }),
  define("shared proposals", { summary: "List shared proposals.", arguments: [option("--root"), option("--project"), option("--session"), ...PAGE], scopes: ["shared", "project"], outputSchema: "legacy-json", handlerKey: "shared.proposals", ui: "both" }),
  define("shared propose", { summary: "Create or reuse a shared proposal branch.", arguments: [option("--root"), option("--title"), option("--description", { required: true }), option("--scope"), option("--branch"), option("--session")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", humanDecision: "file-review-remains-human", authority: "shared-proposal", outputSchema: "legacy-json", handlerKey: "shared.propose", ui: "both" }),
  define("shared publish", { summary: "Publish a shared proposal branch.", arguments: [option("--root"), option("--proposal", { required: true }), option("--message"), option("--title"), option("--description")], scopes: ["shared", "project"], mutation: "mutating", protocol: "legacy-direct", humanDecision: "file-review-remains-human", authority: "shared-proposal", outputSchema: "legacy-json", handlerKey: "shared.publish", ui: "both" }),
  define("shared review", { summary: "Open a proposal file-review workspace.", arguments: [option("--root"), option("--proposal", { required: true }), option("--port", { value: "integer" })], scopes: ["shared", "project"], mutation: "mutating", humanDecision: "file-review-remains-human", outputSchema: "text/plain", handlerKey: "shared.review", ui: "both" }),
  define("shared secure-github", { summary: "Configure supported shared repository protections.", arguments: [option("--root")], scopes: ["shared"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "legacy-json", handlerKey: "shared.secure-github", ui: "diagnostic" }),
  define("shared security-check", { summary: "Check shared GitHub repository protection.", arguments: [option("--root")], scopes: ["shared"], outputSchema: "legacy-json", handlerKey: "shared.security-check", ui: "diagnostic" }),

  define("init", { summary: "Initialize Context Room project configuration.", arguments: [option("--root"), option("--title"), option("--allow"), option("--watch")], scopes: ["project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "init", ui: "both" }),
  define("setup", { summary: "Initialize a project, register it, and open it in the global Context Room.", arguments: [option("--root"), option("--title"), option("--allow"), option("--watch"), option("--port", { value: "integer" })], scopes: ["project", "device"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "setup", ui: "both" }),
  define("start", { summary: "Register and focus a project in the global Context Room.", arguments: [option("--root"), option("--port", { value: "integer" })], scopes: ["project", "device"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "start", ui: "both" }),
  define("guard", { summary: "Evaluate the existing human review gate.", arguments: [option("--root"), option("--profile"), option("--operation"), option("--strict", { value: "boolean" }), option("--advisory", { value: "boolean" }), option("--hook", { value: "boolean" })], scopes: ["project"], humanDecision: "file-review-remains-human", outputSchema: "text/plain", handlerKey: "guard", ui: "both" }),
  define("install-hooks", { summary: "Install configured Context Room Git hooks.", arguments: [option("--root")], scopes: ["project"], mutation: "mutating", protocol: "legacy-direct", outputSchema: "text/plain", handlerKey: "install-hooks", ui: "both" }),
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

function includedExposure(entry, include = "canonical") {
  const normalized = normalizeInclude(include);
  if (normalized === "all") return true;
  if (normalized === "compatibility") return entry.exposure === "canonical" || entry.exposure === "compatibility";
  return entry.exposure === "canonical";
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

function capabilityDescriptor(entry) {
  return {
    path: entry.path,
    ...(entry.aliases.length ? { aliases: entry.aliases } : {}),
    summary: entry.summary,
    arguments: entry.arguments.map((argument) => argument.name),
    scopes: entry.scopes,
    formats: entry.formats,
    mutation: entry.mutation,
    mutates: entry.mutates,
    protocol: entry.protocol,
    humanDecision: entry.humanDecision,
    outputSchema: entry.outputSchema,
    handlerKey: entry.handlerKey,
    exposure: entry.exposure,
    compatibilityOf: entry.compatibilityOf,
    useWhen: entry.useWhen,
    doNotUseWhen: entry.doNotUseWhen,
    tags: entry.tags,
    requiredContext: entry.requiredContext,
    freshness: entry.freshness,
    cost: entry.cost,
    authority: entry.authority,
  };
}

export function cliCapabilitiesFromRegistry({ version = "", installedPaths = null, include = "canonical" } = {}) {
  const installed = installedPaths ? new Set(installedPaths.map(String)) : null;
  const commands = CLI_COMMAND_REGISTRY
    .filter((entry) => (installed ? installed.has(entry.path) : entry.lifecycle === "current") && includedExposure(entry, include))
    .map(capabilityDescriptor);
  return {
    schemaVersion: CLI_MACHINE_SCHEMA_VERSION,
    registrySchemaVersion: CLI_REGISTRY_SCHEMA_VERSION,
    version: String(version || ""),
    outputFormats: [...CLI_OUTPUT_FORMATS],
    globalOptions: [...CLI_GLOBAL_OPTIONS],
    providers: ["auto", "codex", "claude-code", "opencode", "all"],
    humanOwned: ["accept-file-review", "reject-file-review"],
    mutationProtocol: {
      preview: "omit --apply or pass --plan",
      apply: "--apply <plan-id>",
      staleError: "stale-plan",
    },
    contractAudience: "ai-agent",
    defaultOutput: "json when --format is omitted",
    commands,
  };
}

export function renderCliHelpFromRegistry({ installedOnly = true, include = "canonical" } = {}) {
  const groups = new Map();
  for (const entry of listCliCommands({ installedOnly, include })) {
    const group = entry.path.split(" ")[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  const lines = ["Context Room", "", "Commands:"];
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
  { capability: "Context application trace", ui: "Trace resource", cli: "context trace", classification: "both" },
  { capability: "Context consumer impact", ui: "Show impact", cli: "context impact", classification: "both" },
  { capability: "Structural Context Graph", ui: null, cli: "context graph", classification: "cli-machine-diagnostic" },
  { capability: "Context snapshots and diffs", ui: null, cli: "context snapshot; context diff", classification: "cli-machine-diagnostic" },
  { capability: "Proposal context impact", ui: "Proposal Context Impact panel", cli: "proposal context-impact", classification: "both" },
  { capability: "Shared Skills management", ui: "Shared skills Settings and wizard", cli: "shared skills status|effective|explain|assign|unassign|import|link|unlink|reconcile|override", classification: "both" },
  { capability: "Shared Instructions management", ui: "Shared resources Settings", cli: "shared instructions status|assign|unassign|import|reconcile", classification: "both" },
  { capability: "Context settings", ui: "Context Settings", cli: "settings get|explain|plan|apply", classification: "both" },
  { capability: "Context diagnostics", ui: "Context Health", cli: "doctor; doctor explain; doctor plan", classification: "both" },
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
