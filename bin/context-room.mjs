#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateAllContextRooms } from "../scripts/update-context-rooms.mjs";
import {
  applyCliReviewAnnotation,
  applyAgentHandoff,
  applyCliContextSettings,
  applySharedSkillOperation,
  applySharedInstructionOperation,
  buildCliContextEffective,
  buildCliContextGraph,
  buildCliDoctorReport,
  buildAgentPrepareCached,
  buildSharedOnlyAgentPrepare,
  classifyAgentChanges,
  cliGitAuthor,
  createDocumentationChange,
  createSharedDocumentationProposal,
  createCliContextSnapshot,
  diffCliReview,
  diffCliContextSnapshots,
  doctorAllProjects,
  doctorSafePlan,
  effectiveSharedSkills,
  explainCliContextSetting,
  explainAgentSelector,
  explainCliDoctorIssue,
  explainSharedSkill,
  getCliContextSettings,
  impactCliContext,
  listCliProjects,
  listCliReviews,
  listSharedDocumentationProposals,
  openCliProject,
  openCliReview,
  openSharedDocumentationProposalByBranch,
  planCliReviewAnnotation,
  planCliContextSettings,
  planCliDoctorIssue,
  planAgentHandoff,
  planSharedSkillOperation,
  planSharedInstructionOperation,
  publishDocumentationChange,
  registerCliProject,
  renderAgentCliHuman,
  resolveCliProjectReference,
  resolveCliTarget,
  showCliReview,
  proposalContextImpact,
  traceCliContext,
} from "../src/agent_cli.mjs";
import {
  ContextRoomCliError,
  cliCapabilities,
  cliEnvelope,
  cliEnvelopeV2,
  cliErrorEnvelope,
  cliErrorEnvelopeV2,
  cliRequestId,
  normalizeCliFormat,
  projectCliData,
  renderCliCompletion,
  renderCliHelp,
  stableCliPlanId,
} from "../src/cli_contract.mjs";
import {
  checkSharedGitHubSecurity,
  connectSharedContext,
  detectSharedProject,
  ensureSharedProposal,
  initializeSharedRepository,
  listSharedProposals,
  materializeSharedReview,
  publishSharedProposal,
  readSharedProjectConnection,
  secureSharedGitHubRepository,
  sharedContextStatus,
  sharedSkillLocationsStatus,
  sharedInstructionLocationsStatus,
  syncSharedContext,
} from "../src/shared_context.mjs";
import {
  clearContextHubRuntime,
  contextHubHostRoot,
  contextHubRepositoryIdentity,
  listContextHubProjects,
  readContextHubRegistry,
  readContextHubRuntime,
  registerContextHubProject,
  registerContextHubSharedRepository,
  withContextHubProjectSharedRegistration,
  writeContextHubRuntime,
} from "../src/context_hub.mjs";
import {
  backlinksDocumentation,
  dependenciesDocumentation,
  diagramsDocumentation,
  inspectDocumentation,
  linksDocumentation,
  metadataDocumentation,
  readDocumentation,
  relatedDocumentation,
  renderDocumentationPacket,
  resolveDocumentationProjectRoot,
  runDocumentationAgent,
  searchDocumentation,
  traceDocumentation,
  validateDocumentation,
} from "../src/doc_agent.mjs";
import {
  appendAgentAnnotation,
  buildContextRoomDoctorReport,
  buildDocQaReport,
  contextHubUiState,
  createMemoryServer,
  initializeContextRoomProject,
  readAgentAnnotations,
  readCollaborationSessionState,
  readResolvedContextRoomSettings,
  readReviewGateSettings,
  selectAvailableContextRoomPort,
  syncContextRoomGitHooks,
  writeAgentCommand,
  writeFolderWatchRule,
  CONFIG_FILE,
  WATCH_RULE_MODES,
} from "../src/context_room.mjs";

function normalizedWatchPath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "") + "/";
}

function watchModeCovers(previousMode, nextMode) {
  if (nextMode === "recursive-live") return true;
  if (previousMode === nextMode) return true;
  if (nextMode === "direct-live") return ["direct-live", "direct-current"].includes(previousMode);
  if (nextMode === "recursive-current") return ["recursive-current", "direct-current"].includes(previousMode);
  return previousMode === "direct-current" && nextMode === "direct-current";
}

function assertAgentWatchExpansion(root, watchedPath, mode) {
  if (mode === "off") {
    throw new ContextRoomCliError(
      "human-authority-required",
      "Only the human owner may remove a folder from review. Use Context Room Settings.",
      { details: { effect: "review-scope-reduction", path: String(watchedPath) }, exitCode: 4 },
    );
  }
  const settings = readResolvedContextRoomSettings(root);
  const rulePath = normalizedWatchPath(watchedPath);
  const legacyLive = (settings.watchAllow || []).some((item) => normalizedWatchPath(item) === rulePath);
  const previous = (settings.watchRules || []).find((item) => normalizedWatchPath(item.path) === rulePath);
  const previousMode = legacyLive ? "recursive-live" : String(previous?.mode || "");
  if (previousMode && !watchModeCovers(previousMode, mode)) {
    throw new ContextRoomCliError(
      "human-authority-required",
      `Only the human owner may narrow ${rulePath} from ${previousMode} to ${mode}. Use Context Room Settings.`,
      { details: { effect: "review-scope-reduction", path: rulePath, previousMode, mode }, exitCode: 4 },
    );
  }
  const ancestorModes = [
    ...(settings.watchAllow || []).flatMap((item) => {
      const ancestorPath = normalizedWatchPath(item);
      return ancestorPath !== rulePath && rulePath.startsWith(ancestorPath) ? ["recursive-live"] : [];
    }),
    ...(settings.watchRules || []).flatMap((item) => {
      const ancestorPath = normalizedWatchPath(item.path);
      return ancestorPath !== rulePath && rulePath.startsWith(ancestorPath) ? [String(item.mode || "")] : [];
    }),
  ];
  const narrowsAncestor = ancestorModes.some((ancestorMode) => (
    ancestorMode === "recursive-live"
      ? mode !== "recursive-live"
      : ancestorMode === "recursive-current"
        ? !["recursive-current", "recursive-live"].includes(mode)
        : false
  ));
  if (narrowsAncestor) {
    throw new ContextRoomCliError(
      "human-authority-required",
      `Only the human owner may add a narrower child rule at ${rulePath}. Use Context Room Settings.`,
      { details: { effect: "review-scope-reduction", path: rulePath, ancestorModes, mode }, exitCode: 4 },
    );
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const option = arg.slice(2);
    const equalsIndex = option.indexOf("=");
    if (equalsIndex !== -1) {
      const key = option.slice(0, equalsIndex);
      const value = option.slice(equalsIndex + 1);
      if (key === "set") args[key] = [...(Array.isArray(args[key]) ? args[key] : args[key] === undefined ? [] : [args[key]]), value];
      else args[key] = value;
      continue;
    }
    const key = option;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      if (key === "set") args[key] = [...(Array.isArray(args[key]) ? args[key] : args[key] === undefined ? [] : [args[key]]), next];
      else args[key] = next;
      index += 1;
    }
  }
  return args;
}

function splitList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function csvOption(value, fallback = []) {
  return value && value !== true ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

function parsePositiveLimit(value, fallback = 25, maximum = 100) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ContextRoomCliError("invalid-limit", `--limit must be an integer from 1 to ${maximum}.`, { exitCode: 2 });
  }
  return parsed;
}

function parseSettingAssignments(value) {
  const assignments = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return assignments.map((entry) => {
    const source = String(entry || "");
    const separator = source.indexOf("=");
    if (separator < 1) throw new ContextRoomCliError("invalid-setting-assignment", "--set must use key=value.", { details: { value: source }, exitCode: 2 });
    const key = source.slice(0, separator).trim();
    const raw = source.slice(separator + 1).trim();
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch {}
    return { key, value: parsed };
  });
}

function readProjectsFile(filePath) {
  if (!filePath || filePath === true) return [];
  const absolutePath = path.resolve(String(filePath));
  const source = fs.readFileSync(absolutePath, "utf8").trim();
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
    return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch (error) {
    if (source.startsWith("[") || source.startsWith("{")) throw new ContextRoomCliError("invalid-projects-file", `Unable to read --projects-file: ${error.message}`, { exitCode: 2 });
    return source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
}

function readJsonArrayFile(filePath, optionName) {
  if (!filePath || filePath === true) return [];
  const absolutePath = path.resolve(String(filePath));
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")); } catch (error) {
    throw new ContextRoomCliError("invalid-json-file", `Unable to read ${optionName}: ${error.message}`, { exitCode: 2 });
  }
  if (!Array.isArray(parsed)) throw new ContextRoomCliError("invalid-json-file", `${optionName} must point to a JSON array.`, { exitCode: 2 });
  return parsed;
}

function paginateContextGraph(graph, { cursor = "", limit = undefined, query = "" } = {}) {
  const pageSize = parsePositiveLimit(limit);
  const offset = cursor === "" || cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ContextRoomCliError("invalid-cursor", "--cursor must be a non-negative integer offset.", { exitCode: 2 });
  const needle = String(query || "").trim().toLowerCase();
  const matched = (graph.resources || []).filter((resource) => !needle || [resource.id, resource.kind, resource.locator, resource.metadata?.name]
    .some((value) => String(value || "").toLowerCase().includes(needle)));
  const resources = matched.slice(offset, offset + pageSize);
  const ids = new Set(resources.map((resource) => resource.id));
  return {
    ...graph,
    resources,
    applications: (graph.applications || []).filter((application) => ids.has(application.resourceId)),
    relations: (graph.relations || []).filter((relation) => ids.has(relation.from) || ids.has(relation.to)),
    pagination: {
      cursor: String(offset),
      limit: pageSize,
      total: matched.length,
      nextCursor: offset + resources.length < matched.length ? String(offset + resources.length) : null,
    },
  };
}

function paginateList(items, { cursor = "", limit = undefined } = {}) {
  const pageSize = parsePositiveLimit(limit);
  const offset = cursor === "" || cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ContextRoomCliError("invalid-cursor", "--cursor must be a non-negative integer offset.", { exitCode: 2 });
  const page = items.slice(offset, offset + pageSize);
  return { items: page, pagination: { cursor: String(offset), limit: pageSize, total: items.length, nextCursor: offset + page.length < items.length ? String(offset + page.length) : null } };
}

function usage() {
  return renderCliHelp();
}

function writeStdout(value, { newline = true } = {}) {
  const output = String(value);
  fs.writeSync(1, output + (newline && !output.endsWith("\n") ? "\n" : ""));
}

async function flushAndExit(code = 0) {
  process.exitCode = Number(code) || 0;
  await Promise.all([
    new Promise((resolve) => process.stdout.write("", resolve)),
    new Promise((resolve) => process.stderr.write("", resolve)),
  ]);
  process.exit(process.exitCode);
}

const KNOWN_OPTIONS = new Set([
  "action", "actionable", "advisory", "all", "all-projects", "allow", "allow-stale", "apply", "branch", "budget", "contract", "cursor", "cwd", "depth", "description", "detail", "document", "dry-run", "enabled", "exclude", "expand", "fields", "files", "folder", "follow", "format", "fresh", "from", "goal", "h", "heading", "help", "highlight", "hook", "include",
  "assignment", "change", "collection", "collection-path", "collection-title", "destination", "id", "include", "json", "kind", "limit", "message", "mode", "name", "no-restart", "note", "operation", "path", "percent", "port", "profile", "project", "projects", "provider", "providers", "query",
  "expected-revision", "file", "filter", "idempotency-key", "label", "location", "no-color", "no-local", "non-interactive", "only", "plan", "profile", "project", "projects-file", "proposal", "quiet", "reason", "recent", "repository", "resource", "root", "scope", "search", "section", "selector", "session", "set", "settings", "severity", "shared", "shared-project", "shell", "since", "skills", "source", "status", "strict", "summary", "target", "task", "text", "title", "to", "types", "verbose", "version", "view", "watch", "workspace",
]);

function packageVersion() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

function emitAgentFirstResult(commandName, result, { format = "json", compactJson = false } = {}) {
  const normalized = normalizeCliFormat(format, "json");
  const contract = args.contract && args.contract !== true ? String(args.contract).toLowerCase() : "v1";
  if (!["v1", "v2", "context-room.cli/1", "context-room.cli/2"].includes(contract)) throw new ContextRoomCliError("invalid-contract", "--contract must be v1 or v2.", { exitCode: 2 });
  const detail = args.detail && args.detail !== true ? String(args.detail).toLowerCase() : "compact";
  if (!["compact", "standard", "full"].includes(detail)) throw new ContextRoomCliError("invalid-detail", "--detail must be compact, standard, or full.", { exitCode: 2 });
  const envelope = cliEnvelope(commandName, {
    target: result?.target || null,
    freshness: result?.freshness || null,
    data: projectCliData(result?.data === undefined ? result : result.data, {
      fields: args.fields && args.fields !== true ? splitList(args.fields) : [],
      summary: args.summary === true,
      expand: args.expand && args.expand !== true ? splitList(args.expand) : [],
    }),
    warnings: result?.warnings || [],
    nextActions: result?.nextActions || [],
  });
  const machinePayload = contract === "v2" || contract === "context-room.cli/2"
    ? cliEnvelopeV2({ data: envelope.data, target: envelope.target, freshness: envelope.freshness, warnings: envelope.warnings, nextActions: envelope.nextActions, detail })
    : envelope;
  const output = normalized === "human"
    ? renderAgentCliHuman(commandName, envelope)
    : JSON.stringify(machinePayload, null, normalized === "json" && !compactJson ? 2 : 0) + "\n";
  fs.writeSync(1, output);
  return machinePayload;
}

function machineContractRequested() {
  return Boolean(
    (args.contract && args.contract !== true)
    || (args.format && args.format !== true)
    || args.detail
    || args.fields
    || args.summary,
  );
}

function normalizedCliFailure(commandName, error) {
  if (error instanceof ContextRoomCliError) return error;
  const message = String(error?.stderr || error?.message || error || "Context Room command failed").trim();
  const code = String(error?.code || error?.cause?.code || "");
  const retryable = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "shared-git-timeout"].includes(code)
    || /(?:unable to refresh shared context|could not resolve host|failed to connect|connection refused|network is unreachable|timed out|temporary failure|remote end hung up|connection reset|could not read from remote repository|does not appear to be a git repository)/i.test(message);
  const sharedFailure = String(code).startsWith("shared-")
    || /shared context/i.test(message)
    || /^(?:shared|proposal)\./.test(String(commandName || ""))
    || ["edit", "docs.publish"].includes(String(commandName || ""));
  return new ContextRoomCliError(retryable && sharedFailure ? "shared-context-unavailable" : "operation-failed", message, {
    retryable,
    exitCode: retryable ? 3 : 1,
    details: code ? { causeCode: code } : null,
  });
}

function failAgentFirstCommand(commandName, error, { format = "json", target = null, requestId = cliRequestId() } = {}) {
  const failure = normalizedCliFailure(commandName, error);
  const normalized = (() => {
    try { return normalizeCliFormat(format, "json"); } catch { return "json"; }
  })();
  const contract = args?.contract && args.contract !== true ? String(args.contract).toLowerCase() : "v1";
  const detail = args?.detail && args.detail !== true ? String(args.detail).toLowerCase() : "compact";
  const output = normalized === "human"
    ? `${failure.message}\n`
    : JSON.stringify(contract === "v2" || contract === "context-room.cli/2" ? cliErrorEnvelopeV2(failure, { detail }) : cliErrorEnvelope(commandName, failure, { requestId, target }), null, normalized === "json" ? 2 : 0) + "\n";
  fs.writeSync(2, output);
  process.exit(failure.exitCode);
}

function failEarlyCommand(commandName, error, plainMessage = "") {
  if (machineContractRequested()) failAgentFirstCommand(commandName, error, { format: agentFirstFormat });
  console.error(plainMessage || error.message);
  process.exit(error instanceof ContextRoomCliError ? error.exitCode : 1);
}

function previewLegacyMutation(commandName, { root, input = {}, affected = [] } = {}) {
  const configPath = path.join(root, CONFIG_FILE);
  const revision = fs.existsSync(configPath)
    ? fs.statSync(configPath).mtimeMs + ":" + fs.statSync(configPath).size
    : "unconfigured";
  return {
    planId: stableCliPlanId({ command: commandName, target: { root: path.resolve(root) }, input, revision }),
    command: commandName,
    input,
    affected,
    compatibility: "Without --plan, this existing command keeps its current apply behavior in this release.",
  };
}

function quotedCliValue(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const args = parseArgs(process.argv.slice(2));
const invokedCommand = args._[0] || "start";
const agentFirstFormat = args.format && args.format !== true ? String(args.format) : "json";

if (args.version !== undefined) {
  console.log(packageVersion());
  process.exit(0);
}

if (args.help || args.h) {
  const namespace = invokedCommand && !["start", "setup"].includes(invokedCommand) ? String(invokedCommand) : "";
  try {
    writeStdout(renderCliHelp({ namespace, all: Boolean(args.all) }), { newline: false });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  process.exit(0);
}

const primaryAskCommand = invokedCommand === "ask";
const primaryEditCommand = invokedCommand === "edit";
if (primaryAskCommand) args._ = ["context", "ask", ...args._.slice(1)];
if (primaryEditCommand) args._ = ["docs", "edit", ...args._.slice(1)];
const primaryEditOpenByBranch = primaryEditCommand && String(args._[2] || "").trim().toLowerCase() === "open";
const requestedCommand = args._[0] || "start";
const command = ["start", "setup"].includes(requestedCommand) ? "hub" : requestedCommand;
const reportedCommand = primaryAskCommand ? "ask" : primaryEditCommand ? "edit" : command;

const unknownOption = Object.keys(args).find((key) => key !== "_" && !KNOWN_OPTIONS.has(key));
if (unknownOption) {
  failAgentFirstCommand(reportedCommand, new ContextRoomCliError("unknown-option", `Unknown option: --${unknownOption}`, {
    details: { option: `--${unknownOption}` },
    exitCode: 2,
    nextActions: [{ id: "inspect-capabilities", command: "context-room capabilities --format json", mutates: false, requiresHuman: false }],
  }), { format: agentFirstFormat });
}

if (agentFirstFormat.toLowerCase() === "jsonl" && !(command === "doctor" && args["all-projects"])) {
  failAgentFirstCommand(command, new ContextRoomCliError("invalid-format", "--format jsonl is available only for doctor --all-projects.", {
    details: { expected: ["human", "json"], stream: "context-room doctor --all-projects --format jsonl" },
    exitCode: 2,
  }), { format: "json" });
}

if (args.root === true || args.root === "") {
  failAgentFirstCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--root requires a path.", { details: { option: "--root" }, exitCode: 2 }), { format: agentFirstFormat });
}

if (args.title === true || args.title === "") {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--title requires a value.", { details: { option: "--title" }, exitCode: 2 }));
}

if (args.description === true || args.description === "") {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--description requires a value.", { details: { option: "--description" }, exitCode: 2 }));
}

if (args.allow === true || args.allow === "") {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--allow requires a path list.", { details: { option: "--allow" }, exitCode: 2 }));
}

if (args.watch === true || args.watch === "") {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--watch requires a path list.", { details: { option: "--watch" }, exitCode: 2 }));
}

if (["hub", "setup", "start"].includes(requestedCommand) && (args.port === true || args.port === "")) {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--port requires a number.", { details: { option: "--port" }, exitCode: 2 }));
}

if (command === "capabilities") {
  try {
    if (args.include === true) throw new ContextRoomCliError("missing-option-value", "--include requires a namespace.", { exitCode: 2 });
    const namespace = args.include ? String(args.include) : "";
    const selectedCommand = args._.slice(1).join(" ").trim();
    const data = cliCapabilities({
      version: packageVersion(),
      namespace,
      command: selectedCommand,
      profile: args.profile && args.profile !== true ? String(args.profile) : "",
      detail: args.detail && args.detail !== true ? String(args.detail) : "compact",
      expand: Boolean(args.expand),
    });
    emitAgentFirstResult("capabilities", { data }, { format: agentFirstFormat, compactJson: true });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand("capabilities", error, { format: agentFirstFormat });
  }
}

if (command === "completion") {
  try {
    writeStdout(renderCliCompletion(args._[1] || args.shell || "zsh"), { newline: false });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand("completion", error, { format: agentFirstFormat });
  }
}

if (command === "project" && ["list", "search", "recent"].includes(args._[1] || "list")) {
  const action = args._[1] || "list";
  try {
    const query = args.query && args.query !== true ? String(args.query) : action === "search" ? args._.slice(2).join(" ") : "";
    const result = listCliProjects({ query, recent: action === "recent" || Boolean(args.recent) });
    const page = paginateList(result.projects || [], { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
    emitAgentFirstResult(`project.${action}`, { data: { ...result, projects: page.items, pagination: page.pagination } }, { format: agentFirstFormat });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand(`project.${action}`, error, { format: agentFirstFormat });
  }
}

async function requestWorkspaceApi(pathname, options = {}) {
  const runtime = readContextHubRuntime();
  if (!runtime?.url) throw new ContextRoomCliError("workspace-hub-unavailable", "The global Context Room Hub is not running.", { retryable: true, exitCode: 3 });
  let response;
  try {
    response = await fetch(runtime.url + pathname, { ...options, signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    throw new ContextRoomCliError("workspace-hub-unavailable", "The global Context Room Hub could not be reached.", { retryable: true, details: { message: error.message }, exitCode: 3 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ContextRoomCliError(data.code || "workspace-request-failed", data.error || "Workspace request failed.", { details: data.details || null, exitCode: response.status === 404 ? 4 : 1 });
  return { runtime, data };
}

function remoteUiTransport() {
  const url = String(process.env.CONTEXT_ROOM_REMOTE_URL || "").trim().replace(/\/$/, "");
  const token = String(process.env.CONTEXT_ROOM_REMOTE_TOKEN || "").trim();
  if (!url && !token) return null;
  if (!url || !token) throw new ContextRoomCliError("remote-ui-config-invalid", "CONTEXT_ROOM_REMOTE_URL and CONTEXT_ROOM_REMOTE_TOKEN must be configured together.", { exitCode: 2 });
  return { url, token };
}

async function requestRemoteUi(pathname, options = {}) {
  const transport = remoteUiTransport();
  if (!transport) return null;
  let response;
  try {
    response = await fetch(transport.url + pathname, {
      ...options,
      headers: {
        authorization: `Bearer ${transport.token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new ContextRoomCliError("remote-ui-unavailable", "The remote Context Room gateway could not be reached.", { retryable: true, details: { message: error.message }, exitCode: 3 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ContextRoomCliError(data.code || "remote-ui-request-failed", data.error || "Remote Context Room request failed.", {
    retryable: response.status >= 500,
    details: data.details || (data.candidates ? { candidates: data.candidates } : null),
    exitCode: response.status === 404 ? 4 : response.status === 409 ? 5 : 1,
  });
  return data;
}

function resolveContextHubCliProject(state, selector) {
  const requested = String(selector || "").trim();
  const resolution = resolveCliProjectReference(state?.projects || [], requested);
  if (!resolution.matches.length) {
    throw new ContextRoomCliError("unknown-project", `Unknown Context Hub project: ${requested}`, {
      details: { project: requested },
      retryable: true,
      exitCode: 5,
    });
  }
  return { requested, resolution };
}

function contextHubCliProjectKeys(resolution) {
  return new Set(resolution.matches.map((project) => String(project?.projectKey || project?.id || "")).filter(Boolean));
}

function contextHubCliNavigationProject({ requested, resolution }) {
  if (resolution.exact && ["id", "worktree-id"].includes(resolution.matchedBy)) return requested;
  const projectKeys = contextHubCliProjectKeys(resolution);
  if (projectKeys.size !== 1) {
    throw new ContextRoomCliError("ambiguous-target", "Several Context Room projects match this selector; choose an exact project or location.", {
      details: { selector: requested, matchedBy: resolution.matchedBy, projectKeys: [...projectKeys] },
      retryable: true,
      exitCode: 5,
    });
  }
  return [...projectKeys][0];
}

function currentContextHubProjectForPath(candidate) {
  const projectRoot = resolveDocumentationProjectRoot(candidate);
  if (!fs.existsSync(path.join(projectRoot, ".context-room", "config.json"))) return null;
  return registerContextHubProject(projectRoot);
}

if (command === "workspace") {
  const action = args._[1] || "list";
  try {
    if (action === "list") {
      const query = new URLSearchParams();
      if (args.workspace && args.workspace !== true) query.set("workspace", String(args.workspace));
      if (args.project && args.project !== true) query.set("project", String(args.project));
      if (args.location && args.location !== true) query.set("location", String(args.location));
      if (args.query && args.query !== true) query.set("query", String(args.query));
      const { data } = await requestWorkspaceApi("/api/workspaces?" + query.toString());
      const page = paginateList(data.workspaces || [], { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
      emitAgentFirstResult("workspace.list", { data: { workspaces: page.items, pagination: page.pagination, generatedAt: data.generatedAt } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "open") {
      const target = resolveCliTarget({
        cwd: process.cwd(),
        project: args.project && args.project !== true ? String(args.project) : "",
        location: args.location && args.location !== true ? String(args.location) : "",
        folder: args.folder && args.folder !== true ? String(args.folder) : "",
        requireLocal: true,
      });
      const runtime = readContextHubRuntime();
      if (!runtime?.url) throw new ContextRoomCliError("workspace-hub-unavailable", "The global Context Room Hub is not running.", { retryable: true, exitCode: 3 });
      const workspaceId = "ws-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      const url = new URL(runtime.url + "/");
      url.searchParams.set("hub", "1");
      url.searchParams.set("workspace", workspaceId);
      url.searchParams.set("project", target.location?.id || target.project?.id || "");
      if (args.file && args.file !== true) {
        url.searchParams.set("view", "file");
        url.searchParams.set("file", String(args.file));
      }
      emitAgentFirstResult("workspace.open", { target, data: { workspaceId, url: url.toString() }, nextActions: [{ id: "open-url", url: url.toString(), mutates: false, requiresHuman: false }] }, { format: agentFirstFormat });
      process.exit(0);
    }
    throw new ContextRoomCliError("unknown-command", `Unknown workspace command: ${action}`, { exitCode: 2 });
  } catch (error) {
    failAgentFirstCommand(`workspace.${action}`, error, { format: agentFirstFormat });
  }
}

const requestedRoot = path.resolve(args.root || process.cwd());
const documentationCommand = command === "docs" || (command === "context" && (args._[1] || "ask") === "ask");
const documentationAction = documentationCommand ? (command === "docs" ? String(args._[1] || "") : "ask") : "";
const localReadOnlyDocumentationAction = documentationAction === "ask" || new Set([
  "search",
  "read",
  "related",
  "trace",
  "inspect",
  "metadata",
  "links",
  "backlinks",
  "dependencies",
  "diagrams",
  "validate",
]).has(documentationAction);
const agentPrepareCommand = command === "agent" && args._[1] === "prepare";
const contextBundleCommand = command === "context" && args._[1] === "bundle";
const explicitSharedRepository = args.repository && args.repository !== true ? String(args.repository) : "";
const explicitSharedProject = args["shared-project"] && args["shared-project"] !== true ? String(args["shared-project"]) : "";
const documentationResearchBrief = documentationAction === "ask"
  ? (args.task && args.task !== true ? String(args.task) : args._.slice(2).join(" ").trim())
  : "";
if (documentationAction === "ask" && args.session !== undefined) {
  failEarlyCommand(primaryAskCommand ? "ask" : "context.ask", new ContextRoomCliError("unsupported-proposal-overlay", "context ask is accepted-only and does not accept --session or proposal overlays.", {
    details: { option: "--session" },
    exitCode: 2,
  }));
}
if (documentationAction === "ask" && !documentationResearchBrief) {
  const usageText = "Usage: context-room ask \"<complete research brief: task context, questions, constraints, and expected output>\" [--root . | --repository <git-url> --shared-project <project-id>] [--goal \"desired outcome\"] [--files path,...] [--depth quick|standard|exhaustive] [--budget 1200] [--json]";
  failEarlyCommand(primaryAskCommand ? "ask" : "context.ask", new ContextRoomCliError("missing-research-brief", "context ask requires a complete research brief.", {
    details: { usage: usageText },
    exitCode: 2,
  }), usageText);
}
if (documentationCommand && (args.repository === true || args.project === true || args["shared-project"] === true)) {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("missing-option-value", "--repository, --project, and --shared-project each require a value.", {
    details: { options: ["--repository", "--project", "--shared-project"] },
    exitCode: 2,
  }));
}
const legacySharedDocumentationTarget = documentationCommand
  && args.repository && args.repository !== true
  && args.project && args.project !== true
  && !args["shared-project"];
const sharedDocumentationProject = args["shared-project"] && args["shared-project"] !== true
  ? String(args["shared-project"])
  : legacySharedDocumentationTarget ? String(args.project) : "";
const sharedDocumentationTarget = documentationCommand && args.repository && args.repository !== true;
if (documentationCommand && primaryEditOpenByBranch && explicitSharedProject && !explicitSharedRepository) {
  failEarlyCommand("edit", new ContextRoomCliError("shared-target-incomplete", "edit open requires --repository <git-url> when --shared-project is provided.", {
    details: { required: ["--repository"] },
    exitCode: 2,
  }));
}
if (documentationCommand && !primaryEditOpenByBranch && (Boolean(args.repository && args.repository !== true) !== Boolean(sharedDocumentationProject))) {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("shared-target-incomplete", "Shared-only documentation requires both --repository <git-url> and --shared-project <shared-project-id>.", {
    details: { required: ["--repository", "--shared-project"] },
    exitCode: 2,
  }));
}
const sharedAgentProject = args["shared-project"] && args["shared-project"] !== true
  ? String(args["shared-project"])
  : args.repository && args.repository !== true && args.project && args.project !== true ? String(args.project) : "";
if (agentPrepareCommand
  && (args.repository !== undefined || args["shared-project"] !== undefined)
  && (!args.repository || args.repository === true || !sharedAgentProject)) {
  failEarlyCommand("agent.prepare", new ContextRoomCliError("shared-target-incomplete", "Shared-only agent prepare requires both --repository <git-url> and --shared-project <shared-project-id>.", {
    details: { required: ["--repository", "--shared-project"] },
    exitCode: 2,
  }));
}
if (contextBundleCommand
  && (args.repository !== undefined || args["shared-project"] !== undefined)
  && (!explicitSharedRepository || !explicitSharedProject)) {
  failEarlyCommand("context.bundle", new ContextRoomCliError("shared-target-incomplete", "Shared-only context bundle requires both --repository <git-url> and --shared-project <shared-project-id>.", {
    details: { required: ["--repository", "--shared-project"] },
    exitCode: 2,
  }));
}
const explicitLocalDocumentationTarget = documentationCommand && !sharedDocumentationTarget && Boolean(
  (args.project && args.project !== true) || (args.location && args.location !== true),
);
let root = documentationCommand && !primaryEditOpenByBranch && !sharedDocumentationTarget && !explicitLocalDocumentationTarget ? resolveDocumentationProjectRoot(requestedRoot) : requestedRoot;
const documentationTargetOptions = sharedDocumentationTarget
  ? { repository: String(args.repository), projectId: sharedDocumentationProject }
  : {};
const agentFirstAgentActions = new Set(["prepare", "changes", "handoff"]);
const workspaceAgentActions = new Set(["state", "open", "navigate", "scroll", "highlight"]);
const sharedOnlyAgentPrepare = command === "agent" && args._[1] === "prepare" && args.repository && args.repository !== true && sharedAgentProject;
const sharedOnlyContextBundle = contextBundleCommand && explicitSharedRepository && explicitSharedProject;
const remoteUiConfigured = Boolean(
  String(process.env.CONTEXT_ROOM_REMOTE_URL || "").trim()
  || String(process.env.CONTEXT_ROOM_REMOTE_TOKEN || "").trim()
);
const localUiOpenCommand = command === "ui" && (args._[1] || "list") === "open" && !remoteUiConfigured;
const contextAgentFirstTargetCommand = command === "context" && (
  (args._[1] || "") === "bundle"
    ? !sharedOnlyContextBundle
    : ["effective", "explain", "graph", "trace", "impact", "snapshot"].includes(args._[1] || "")
      || ((args._[1] || "") === "diff" && !args.to)
);
const agentFirstTargetCommand = (
  (command === "agent" && agentFirstAgentActions.has(args._[1] || "") && !sharedOnlyAgentPrepare)
  || (command === "agent" && workspaceAgentActions.has(args._[1] || "state")
    && !(args.workspace && args.workspace !== true)
    && !(args.project && args.project !== true)
    && !(args.location && args.location !== true))
  || command === "review"
  || (command === "project" && ["current", "show", "register", "open"].includes(args._[1] || "current"))
  || localUiOpenCommand
  || command === "watch"
  || command === "note"
  || command === "hooks"
  || (documentationCommand
    && documentationAction !== "publish"
    && !sharedDocumentationTarget
    && !primaryEditOpenByBranch
    && !(localReadOnlyDocumentationAction && !explicitLocalDocumentationTarget))
  || (command === "proposal" && ["impact", "context-impact", "list"].includes(args._[1] || "list") && !(args.repository && args.repository !== true))
  || (command === "shared" && ["connect", "status", "sync", "assign", "unassign", "local", "reconcile", "security"].includes(args._[1] || "status"))
  || (command === "shared" && args._[1] === "skills" && args._[2] !== "status")
  || (command === "shared" && args._[1] === "instructions" && args._[2] !== "status")
  || contextAgentFirstTargetCommand
  || command === "settings"
  || (command === "doctor" && !args["all-projects"] && (Boolean(args._[1]) || Boolean(args.format || args.project || args.location || args.folder || args.provider || args.cursor || args.limit)))
);
let agentFirstTarget = null;
if (agentFirstTargetCommand) {
  try {
    const targetOptions = {
      cwd: requestedRoot,
      project: args.project && args.project !== true ? String(args.project) : "",
      location: args.location && args.location !== true ? String(args.location) : "",
      folder: args.folder && args.folder !== true ? String(args.folder) : "",
      requireLocal: true,
    };
    try {
      agentFirstTarget = resolveCliTarget(targetOptions);
    } catch (error) {
      const canUseGlobalHubTarget = localUiOpenCommand
        && !targetOptions.location
        && ["unknown-project", "local-environment-unavailable"].includes(error?.code);
      if (!canUseGlobalHubTarget) throw error;
      if (targetOptions.project) {
        const matches = resolveCliProjectReference(
          contextHubUiState(requestedRoot, { refreshShared: false }).projects,
          targetOptions.project,
        ).matches;
        const selected = matches[0];
        if (!selected) throw error;
        const projectId = selected.projectKey || selected.id;
        agentFirstTarget = {
          root: "",
          folderAbsolute: "",
          project: { id: projectId, title: selected.title, sharedProjectId: selected.shared?.projectId || "" },
          location: null,
          folder: null,
          shared: selected.shared || null,
          registered: true,
          localEnvironment: "unavailable",
          freshness: { git: "unavailable", observedAt: new Date().toISOString() },
        };
      }
    }
    if (agentFirstTarget?.root) root = agentFirstTarget.root;
  } catch (error) {
    failAgentFirstCommand(`${command}.${args._[1] || "current"}`, error, { format: agentFirstFormat });
  }
}
let rootStats;
try {
  rootStats = fs.statSync(root);
} catch {
  rootStats = null;
}
if (!rootStats?.isDirectory()) {
  failEarlyCommand(reportedCommand, new ContextRoomCliError("invalid-root", `Context Room root must be an existing directory: ${root}`, {
    details: { root },
    exitCode: 2,
  }));
}

const nativePlanCommand = (
  (command === "agent" && args._[1] === "handoff")
  || (command === "agent" && ["watch", "unwatch", "open", "navigate", "scroll", "highlight", "annotate"].includes(args._[1]))
  || (command === "review" && args._[1] === "annotate")
  || (command === "shared" && args._[1] === "skills")
  || (command === "shared" && args._[1] === "instructions")
  || (command === "settings" && args._[1] === "plan")
  || (command === "settings" && args._[1] === "set")
  || command === "watch"
  || command === "hooks"
  || (command === "shared" && ["local", "security"].includes(args._[1]))
);
const nativeApplyCommand = (
  (command === "agent" && args._[1] === "handoff")
  || (command === "review" && args._[1] === "annotate")
  || (command === "shared" && args._[1] === "skills")
  || (command === "shared" && args._[1] === "instructions")
  || (command === "settings" && args._[1] === "apply")
  || (command === "settings" && args._[1] === "set")
  || command === "watch"
  || command === "hooks"
  || (command === "shared" && ["local", "security"].includes(args._[1]))
);
if (args.plan && !nativePlanCommand) {
  emitAgentFirstResult(`${command}.${args._.slice(1).join(".") || "run"}`, {
    target: agentFirstTarget,
    data: previewLegacyMutation(`${command}.${args._.slice(1).join(".") || "run"}`, {
      root,
      input: Object.fromEntries(Object.entries(args).filter(([key]) => !["_", "plan", "format"].includes(key))),
      affected: ["existing command-specific local or Git state"],
    }),
  }, { format: agentFirstFormat });
  process.exit(0);
}
if (args.apply && !nativeApplyCommand) {
  failAgentFirstCommand(`${command}.${args._.slice(1).join(".") || "run"}`, new ContextRoomCliError(
    "legacy-apply-unsupported",
    "This existing command keeps its direct behavior in this release. Use --plan to preview, then omit --plan only when you intend to apply it.",
    { exitCode: 2 },
  ), { format: agentFirstFormat, target: agentFirstTarget });
}

if (command === "project") {
  const action = args._[1] || "current";
  try {
    if (action === "current" || action === "show") {
      emitAgentFirstResult(`project.${action}`, { target: agentFirstTarget, data: agentFirstTarget }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "register") {
      const title = args.title && args.title !== true ? String(args.title) : "";
      if (args.apply) throw new ContextRoomCliError("deprecated-option", "project register is reversible and idempotent; use --dry-run for a preview or run it directly.", { exitCode: 2 });
      if (args["dry-run"]) {
        emitAgentFirstResult("project.register", { target: agentFirstTarget, data: { dryRun: true, effect: "reversible-local", root, title } }, { format: agentFirstFormat });
        process.exit(0);
      }
      const registered = registerCliProject({ root, title });
      emitAgentFirstResult("project.register", { data: { effect: "reversible-local", registered } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "open") {
      emitAgentFirstResult("project.open", { target: agentFirstTarget, data: openCliProject(agentFirstTarget) }, { format: agentFirstFormat });
      process.exit(0);
    }
    throw new ContextRoomCliError("unknown-command", `Unknown project command: ${action}`, { exitCode: 2 });
  } catch (error) {
    failAgentFirstCommand(`project.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

if (command === "ui") {
  const action = args._[1] || "list";
  try {
    if (action === "list") {
      const query = new URLSearchParams();
      if (args.project && args.project !== true) query.set("project", String(args.project));
      if (args.location && args.location !== true) query.set("location", String(args.location));
      if (args.query && args.query !== true) query.set("query", String(args.query));
      if (args.session && args.session !== true) query.set("session", String(args.session));
      if (args.all) query.set("all", "1");
      const remote = remoteUiTransport();
      const data = remote
        ? await requestRemoteUi("/api/agent/ui/workspaces?" + query.toString())
        : (await requestWorkspaceApi("/api/workspaces?" + query.toString())).data;
      const page = paginateList(data.workspaces || [], { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
      emitAgentFirstResult("ui.list", { data: { workspaces: page.items, pagination: page.pagination, generatedAt: data.generatedAt } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "open") {
      const workspaceId = args.workspace && args.workspace !== true ? String(args.workspace) : "";
      const file = args.file && args.file !== true ? String(args.file) : args.path && args.path !== true ? String(args.path) : "";
      const view = args.view && args.view !== true ? String(args.view) : file ? "file" : "hub";
      const explicitSessionId = args.session && args.session !== true ? String(args.session) : "";
      const sessionId = explicitSessionId || process.env.CODEX_THREAD_ID || "";
      const requestedUiLocation = args.location && args.location !== true ? String(args.location) : "";
      const requestedUiProject = requestedUiLocation
        ? agentFirstTarget?.location?.id || requestedUiLocation
        : agentFirstTarget?.project?.id || (args.project && args.project !== true ? String(args.project) : "");
      const filters = args.filter && args.filter !== true ? String(args.filter).split(",").map((item) => item.trim()).filter(Boolean) : [];
      const percent = args.percent === undefined || args.percent === true ? null : Number(args.percent);
      if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
        throw new ContextRoomCliError("invalid-percent", "--percent must be a number from 0 to 100.", { exitCode: 2 });
      }
      const navigationTarget = args.heading && args.heading !== true
        ? { heading: String(args.heading) }
        : args.text && args.text !== true
          ? { text: String(args.text) }
          : percent !== null
            ? { percent }
            : null;
      if (remoteUiTransport()) {
        const data = await requestRemoteUi("/api/agent/ui/open", {
          method: "POST",
          body: JSON.stringify({
            workspace: workspaceId,
            ...(explicitSessionId ? { session: explicitSessionId } : {}),
            recent: Boolean(args.recent),
            label: args.label && args.label !== true ? String(args.label) : "",
            navigation: {
              view,
              project: requestedUiProject,
              proposal: args.proposal && args.proposal !== true ? String(args.proposal) : "",
              file,
              settingsSection: args.settings && args.settings !== true ? String(args.settings) : "",
              search: args.search && args.search !== true ? String(args.search) : "",
              filters,
              ...(navigationTarget ? { target: navigationTarget } : {}),
            },
          }),
        });
        emitAgentFirstResult("ui.open", { target: agentFirstTarget, data }, { format: agentFirstFormat });
        process.exit(0);
      }
      let workspace = null;
      if (workspaceId) {
        workspace = await resolveActiveWorkspace(agentFirstTarget, workspaceId);
      } else {
        try {
          workspace = await resolveActiveWorkspace(agentFirstTarget, "", {
            project: requestedUiProject,
            location: requestedUiLocation,
            session: sessionId,
            fallbackWithoutSession: Boolean(sessionId && !(args.session && args.session !== true)),
            recent: Boolean(args.recent),
          });
        } catch (error) {
          if (error?.code !== "workspace-not-found") throw error;
        }
      }
      if (workspace) {
        const browserCommand = await sendWorkspaceCommand(workspace.workspaceId, {
          action: "navigate",
          view,
          projectId: requestedUiProject,
          proposal: args.proposal && args.proposal !== true ? String(args.proposal) : "",
          path: file,
          settingsSection: args.settings && args.settings !== true ? String(args.settings) : "",
          search: args.search && args.search !== true ? String(args.search) : "",
          filters,
          label: args.label && args.label !== true ? String(args.label) : "",
          ...(navigationTarget ? { target: navigationTarget } : {}),
        });
        emitAgentFirstResult("ui.open", { target: agentFirstTarget, data: { workspace, command: browserCommand } }, { format: agentFirstFormat });
        process.exit(0);
      }
      const runtime = readContextHubRuntime();
      if (!runtime?.url) throw new ContextRoomCliError("workspace-hub-unavailable", "The global Context Room Hub is not running.", { retryable: true, exitCode: 3 });
      const nextWorkspaceId = "ws-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      const url = new URL(runtime.url + "/");
      url.searchParams.set("hub", "1");
      url.searchParams.set("workspace", nextWorkspaceId);
      const requestedProject = requestedUiProject;
      if (requestedProject) url.searchParams.set("project", requestedProject);
      url.searchParams.set("view", view);
      if (file) url.searchParams.set("file", file);
      if (args.proposal && args.proposal !== true) url.searchParams.set("proposal", String(args.proposal));
      if (args.settings && args.settings !== true) url.searchParams.set("settings", String(args.settings));
      if (filters[0]) url.searchParams.set("folder", filters[0]);
      if (args.search && args.search !== true) url.searchParams.set("search", String(args.search));
      const fragment = new URLSearchParams();
      if (sessionId) fragment.set("session", sessionId);
      if (args.label && args.label !== true) fragment.set("label", String(args.label));
      if (fragment.size) url.hash = fragment.toString();
      emitAgentFirstResult("ui.open", { target: agentFirstTarget, data: { status: "open_required", workspaceId: nextWorkspaceId, openUrl: url.toString() } }, { format: agentFirstFormat });
      process.exit(0);
    }
    throw new ContextRoomCliError("unknown-command", `Unknown ui command: ${action}`, { exitCode: 2 });
  } catch (error) {
    failAgentFirstCommand(`ui.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

if (command === "watch") {
  const action = args._[1] || "set";
  try {
    if (action !== "set") throw new ContextRoomCliError("unknown-command", `Unknown watch command: ${action}`, { exitCode: 2 });
    if (args.plan) throw new ContextRoomCliError("deprecated-option", "--plan is no longer used. Use --dry-run for an optional preview or --apply <plan-id> for a protected removal.", { exitCode: 2 });
    const watchedPath = args._[2] || args.path || "";
    if (!watchedPath || watchedPath === true) throw new ContextRoomCliError("missing-path", "watch set requires a folder path.", { exitCode: 2 });
    const mode = args.mode && args.mode !== true ? String(args.mode).trim() : "recursive-live";
    if (mode !== "off" && !WATCH_RULE_MODES.includes(mode)) throw new ContextRoomCliError("invalid-watch-mode", `Unknown folder watch mode: ${mode}.`, { details: { expected: [...WATCH_RULE_MODES, "off"] }, exitCode: 2 });
    assertAgentWatchExpansion(root, watchedPath, mode);
    const plan = previewLegacyMutation("watch.set", { root, input: { path: String(watchedPath), mode }, affected: [CONFIG_FILE] });
    if (args["dry-run"]) {
      emitAgentFirstResult("watch.set", { target: agentFirstTarget, data: { ...plan, effect: "reversible-local", dryRun: true } }, { format: agentFirstFormat });
      process.exit(0);
    }
    emitAgentFirstResult("watch.set", { target: agentFirstTarget, data: { result: writeFolderWatchRule(root, { path: String(watchedPath), mode }), effect: "reversible-local" } }, { format: agentFirstFormat });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand(`watch.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

if (command === "note") {
  const action = args._[1] || "list";
  try {
    if (action === "list") {
      const notes = readAgentAnnotations(root, args.path && args.path !== true ? String(args.path) : "");
      const page = paginateList(Array.isArray(notes) ? notes : notes.annotations || [], { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
      emitAgentFirstResult("note.list", { target: agentFirstTarget, data: { notes: page.items, pagination: page.pagination } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "add") {
      if (!args.path || args.path === true || !args.note || args.note === true) throw new ContextRoomCliError("missing-note-input", "note add requires --path and --note.", { exitCode: 2 });
      const input = { path: String(args.path), note: String(args.note), target: args.target && args.target !== true ? String(args.target) : "", targetType: args.target ? "text" : "file", source: "agent-cli" };
      if (args["dry-run"]) {
        emitAgentFirstResult("note.add", { target: agentFirstTarget, data: { dryRun: true, note: input, effect: "reversible-local" } }, { format: agentFirstFormat });
        process.exit(0);
      }
      emitAgentFirstResult("note.add", { target: agentFirstTarget, data: { annotation: appendAgentAnnotation(root, input), effect: "reversible-local" } }, { format: agentFirstFormat });
      process.exit(0);
    }
    throw new ContextRoomCliError("unknown-command", `Unknown note command: ${action}`, { exitCode: 2 });
  } catch (error) {
    failAgentFirstCommand(`note.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

if (command === "hub") {
  const action = args._[1] || "";
  try {
    if (action === "status") {
      const projects = listContextHubProjects({ refreshGit: false });
      const page = paginateList(projects, { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
      emitAgentFirstResult("hub.status", { data: { runtime: readContextHubRuntime(), projects: page.items, pagination: page.pagination } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "list") {
      writeStdout(JSON.stringify({
        runtime: readContextHubRuntime(),
        registry: readContextHubRegistry(),
        projects: listContextHubProjects(),
      }, null, 2));
      process.exit(0);
    }
    if (action === "add-shared") {
      if (!args.repository || args.repository === true) throw new Error("Usage: context-room hub add-shared --repository <git-url>");
      writeStdout(JSON.stringify(registerContextHubSharedRepository(args.repository), null, 2));
      process.exit(0);
    }
    if (action === "proposals") {
      const state = contextHubUiState(root);
      let proposals = state.proposals;
      if (args.project && args.project !== true) {
        const { resolution } = resolveContextHubCliProject(state, args.project);
        const projectKeys = contextHubCliProjectKeys(resolution);
        proposals = proposals.filter((proposal) => {
          const proposalKeys = Array.isArray(proposal.projectKeys) && proposal.projectKeys.length
            ? proposal.projectKeys
            : [proposal.projectKey];
          return proposalKeys.some((projectKey) => projectKeys.has(String(projectKey || "")));
        });
      }
      if (args.session && args.session !== true) proposals = proposals.filter((proposal) => proposal.sessionId === args.session);
      writeStdout(JSON.stringify(proposals, null, 2));
      process.exit(0);
    }
    if (action === "open") {
      const active = readContextHubRuntime();
      if (!active) throw new Error("Context Hub is not running; run context-room hub first");
      const query = new URLSearchParams({ hub: "1" });
      if (args.project && args.project !== true) {
        const selection = resolveContextHubCliProject(contextHubUiState(root), args.project);
        query.set("project", contextHubCliNavigationProject(selection));
      }
      const search = [
        args.session && args.session !== true ? String(args.session) : "",
        args.proposal && args.proposal !== true ? String(args.proposal) : "",
      ].filter(Boolean).join(" ");
      if (search) query.set("q", search);
      console.log(`Context Room Hub: ${active.url}/?${query.toString()}`);
      process.exit(0);
    }
    if (action) throw new Error(`Unknown hub command: ${action}`);
    const preferredPort = args.port === undefined ? 4317 : Number(args.port);
    const selectedPort = await selectAvailableContextRoomPort(preferredPort, { allowFallback: args.port === undefined });
    let focusedProject = null;
    const shouldRegisterRequestedRoot = requestedCommand !== "hub" || (args.root !== undefined && !args["no-local"]);
    if (shouldRegisterRequestedRoot) {
      initializeContextRoomProject(root, {
        title: args.title,
        ...(requestedCommand === "setup" ? {
          allowedPaths: splitList(args.allow),
          watchAllow: splitList(args.watch),
        } : {}),
      });
      focusedProject = registerContextHubProject(root, { title: args.title });
    } else if (!args["no-local"]) {
      focusedProject = currentContextHubProjectForPath(root);
    }
    const runtime = readContextHubRuntime();
    if (runtime) {
      try {
        const response = await fetch(runtime.url + "/api/health", { signal: AbortSignal.timeout(1500) });
        const health = response.ok ? await response.json() : null;
        const expectedRoot = runtime.root ? fs.realpathSync(runtime.root) : "";
        const actualRoot = health?.root ? fs.realpathSync(health.root) : "";
        if (response.ok && health?.ok === true && expectedRoot && actualRoot === expectedRoot) {
          const focus = focusedProject ? `&project=${encodeURIComponent(focusedProject.id)}` : "";
          console.log(`Context Room Hub: ${runtime.url}/?hub=1${focus}`);
          console.log(`Already running since: ${runtime.startedAt || "unknown"}`);
          process.exit(0);
        }
      } catch {}
      clearContextHubRuntime(runtime.pid);
    }
    const hostRoot = contextHubHostRoot();
    fs.mkdirSync(hostRoot, { recursive: true });
    initializeContextRoomProject(hostRoot, {
      title: "Context Room Hub",
      allowedPaths: [],
      watchAllow: [],
    });
    const port = selectedPort;
    const { server } = createMemoryServer({ root: hostRoot, port, registerInHub: false, persistentDocumentGraphLayout: true });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => { server.off("error", onError); resolve(); });
    });
    const url = `http://127.0.0.1:${port}`;
    writeContextHubRuntime({ port, root: hostRoot, url });
    const focus = focusedProject ? `&project=${encodeURIComponent(focusedProject.id)}` : "";
    console.log(`Context Room Hub: ${url}/?hub=1${focus}`);
    console.log(`Projects: ${listContextHubProjects().length}`);
    const close = () => server.close(() => {
      clearContextHubRuntime(process.pid);
      process.exit(0);
    });
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    await new Promise(() => {});
  } catch (error) {
    if (error instanceof ContextRoomCliError) failEarlyCommand(`hub.${action || "start"}`, error, `Context Room Hub failed: ${error.message}`);
    console.error(`Context Room Hub failed: ${error.message}`);
    process.exit(1);
  }
}

if (command !== "shared" && !sharedDocumentationTarget && ["setup", "start", "guard"].includes(command) && readSharedProjectConnection(root)) {
  try {
    const shared = syncSharedContext(root, { allowOffline: true });
    if (!shared.online) console.error(`Shared context offline: using ${shared.revision.slice(0, 12)} (${shared.fetchError})`);
  } catch (error) {
    console.error(`Shared context refresh failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "proposal") {
  const action = args._[1] || "list";
  try {
    if (action === "list") {
      let proposals = listSharedProposals(root, { allProjects: true, refresh: false });
      if (args.session && args.session !== true) proposals = proposals.filter((proposal) => proposal.sessionId === String(args.session));
      if (args.query && args.query !== true) {
        const needle = String(args.query).toLowerCase();
        proposals = proposals.filter((proposal) => [proposal.branch, proposal.title, proposal.description, proposal.projectId].some((value) => String(value || "").toLowerCase().includes(needle)));
      }
      const page = paginateList(proposals, { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
      emitAgentFirstResult("proposal.list", { target: agentFirstTarget, data: { proposals: page.items, pagination: page.pagination } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (!["impact", "context-impact"].includes(action)) throw new ContextRoomCliError("unknown-command", `Unknown proposal command: ${action}`, { exitCode: 2 });
    const selector = args._[2] || args.proposal || args.branch || "";
    const repository = args.repository && args.repository !== true ? String(args.repository) : agentFirstTarget?.shared?.repository || "";
    if (!selector) throw new ContextRoomCliError("missing-selector", "proposal impact requires a proposal selector.", { exitCode: 2 });
    if (!repository) throw new ContextRoomCliError("proposal-repository-required", "proposal impact requires --repository or a selected shared project.", { exitCode: 2 });
    const data = await proposalContextImpact({ selector: String(selector), repository, target: agentFirstTarget });
    emitAgentFirstResult(action === "impact" ? "proposal.impact" : "proposal.context-impact", { target: agentFirstTarget, data }, { format: agentFirstFormat });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand(`proposal.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

function assertSharedBindingCompatible(projectRoot, { repository, projectId }) {
  const current = readSharedProjectConnection(projectRoot);
  if (!current) return null;
  const repositoryChanged = contextHubRepositoryIdentity(current.repository) !== contextHubRepositoryIdentity(repository);
  const requestedProjectId = String(projectId || "");
  const projectChanged = Boolean(requestedProjectId) && String(current.projectId) !== requestedProjectId;
  if (!repositoryChanged && !projectChanged) return current;
  throw new ContextRoomCliError("shared-binding-conflict", "This project is already connected to a different Shared Context. Disconnect it in Context Room Settings before connecting another one.", {
    details: {
      repositoryChanged,
      projectChanged,
      currentProjectId: current.projectId,
      requestedProjectId: requestedProjectId || null,
    },
    exitCode: 5,
    nextActions: [{ id: "open-shared-settings", label: "Open Shared Context settings", command: "context-room ui open --settings shared-context --format json", mutates: false, requiresHuman: true }],
  });
}

function connectSharedContextThroughHubTransaction(projectRoot, {
  repository,
  projectId,
  sync = true,
  title = "",
} = {}) {
  const registered = registerContextHubProject(projectRoot, { title });
  const transaction = withContextHubProjectSharedRegistration(registered.root, {
    shared: { repository, projectId },
    requireSyncedShared: sync,
  }, (pending) => connectSharedContext(registered.root, {
    repository,
    projectId,
    sync,
    ...(sync ? { connectionReceiptId: pending.sharedTransactionId } : {}),
    projectRoots: pending.sharedProjectRoots,
    projectCapabilities: pending.sharedProjectCapabilities,
  }));
  return transaction.result;
}

if (command === "shared") {
  const action = args._[1] || "status";
  try {
    if (action === "connect") {
      if (!args.repository || args.repository === true) throw new ContextRoomCliError("missing-repository", "shared connect requires --repository <git-url>.", { exitCode: 2 });
      if (args["shared-project"] === true) throw new ContextRoomCliError("missing-option-value", "--shared-project requires a project id.", { details: { option: "--shared-project" }, exitCode: 2 });
      const requestedBinding = { repository: String(args.repository), projectId: explicitSharedProject };
      assertSharedBindingCompatible(root, requestedBinding);
      const detected = detectSharedProject(root, requestedBinding);
      assertSharedBindingCompatible(detected.projectRoot, detected);
      if (args["dry-run"]) {
        emitAgentFirstResult("shared.connect", { target: agentFirstTarget, data: { dryRun: true, projectRoot: detected.projectRoot, projectId: detected.projectId, repository: String(args.repository), effect: "reversible-local" } }, { format: agentFirstFormat });
        process.exit(0);
      }
      initializeContextRoomProject(detected.projectRoot);
      const connected = connectSharedContextThroughHubTransaction(detected.projectRoot, {
        repository: String(args.repository),
        projectId: detected.projectId,
        sync: true,
      });
      emitAgentFirstResult("shared.connect", { data: connected }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "assign" || action === "unassign") {
      const resource = args.resource && args.resource !== true ? String(args.resource) : "";
      if (!["skills", "instructions"].includes(resource)) throw new ContextRoomCliError("missing-resource", `shared ${action} requires --resource skills|instructions.`, { exitCode: 2 });
      const projectIds = [...new Set([...csvOption(args.projects), ...readProjectsFile(args["projects-file"])])];
      const common = {
        assignmentId: args.assignment && args.assignment !== true ? String(args.assignment) : "",
        collectionId: args.collection && args.collection !== true ? String(args.collection) : "",
        scope: args.scope && args.scope !== true ? String(args.scope) : "project",
        projectIds,
        title: args.title && args.title !== true ? String(args.title) : "",
        description: args.description && args.description !== true ? String(args.description) : `${action === "assign" ? "Assign" : "Unassign"} shared ${resource}`,
        sessionId: args.session && args.session !== true ? String(args.session) : process.env.CODEX_THREAD_ID || "",
        idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : process.env.CODEX_THREAD_ID || "",
      };
      let result;
      if (resource === "skills") {
        const options = { ...common, providers: csvOption(args.providers, ["codex"]), include: csvOption(args.include, ["*"]), exclude: csvOption(args.exclude) };
        const plan = planSharedSkillOperation(agentFirstTarget, { action, ...options });
        result = applySharedSkillOperation(agentFirstTarget, { action, planId: plan.planId, ...options });
      } else {
        const options = { ...common, files: action === "assign" ? readJsonArrayFile(args.files, "--files") : [] };
        if (action === "assign" && !options.files.length) throw new ContextRoomCliError("missing-instruction-files", "shared assign --resource instructions requires --files <json-array>.", { exitCode: 2 });
        const plan = planSharedInstructionOperation(agentFirstTarget, { action, ...options });
        result = applySharedInstructionOperation(agentFirstTarget, { action, planId: plan.planId, ...options });
      }
      emitAgentFirstResult(`shared.${action}`, { target: agentFirstTarget, data: { resource, effect: "proposal-only", result } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "local" && args._[2] === "skill") {
      const localAction = args.action && args.action !== true ? String(args.action) : "";
      if (!['link', 'unlink', 'override'].includes(localAction)) throw new ContextRoomCliError("invalid-local-skill-action", "shared local skill requires --action link|unlink|override.", { exitCode: 2 });
      const options = {
        assignmentId: args.assignment && args.assignment !== true ? String(args.assignment) : "",
        id: args.id && args.id !== true ? String(args.id) : "",
        provider: args.provider && args.provider !== true ? String(args.provider) : "codex",
        destination: args.destination && args.destination !== true ? String(args.destination) : "",
        include: csvOption(args.include, ["*"]),
        exclude: csvOption(args.exclude),
        disabled: args.enabled === undefined ? undefined : ["false", "0", "disabled"].includes(String(args.enabled).toLowerCase()),
        idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "",
      };
      const plan = planSharedSkillOperation(agentFirstTarget, { action: localAction, ...options });
      if (localAction === "unlink" && !args.apply) {
        emitAgentFirstResult("shared.local.skill", { target: agentFirstTarget, data: { ...plan, effect: "protected" } }, { format: agentFirstFormat });
        process.exit(0);
      }
      if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by shared local skill.", { exitCode: 2 });
      if (args.apply && String(args.apply) !== plan.planId) throw new ContextRoomCliError("stale-plan", "The local Shared Skill state changed after this operation was planned.", { retryable: true, details: { expectedPlanId: plan.planId, suppliedPlanId: String(args.apply) } });
      if (args["dry-run"]) {
        emitAgentFirstResult("shared.local.skill", { target: agentFirstTarget, data: { ...plan, dryRun: true, effect: "reversible-local" } }, { format: agentFirstFormat });
        process.exit(0);
      }
      const result = applySharedSkillOperation(agentFirstTarget, { action: localAction, planId: plan.planId, ...options });
      emitAgentFirstResult("shared.local.skill", { target: agentFirstTarget, data: { effect: localAction === "unlink" ? "protected" : "reversible-local", result } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "reconcile") {
      const resource = args.resource && args.resource !== true ? String(args.resource) : "all";
      if (!["skills", "instructions", "all"].includes(resource)) throw new ContextRoomCliError("invalid-resource", "--resource must be skills, instructions, or all.", { exitCode: 2 });
      const results = {};
      if (["skills", "all"].includes(resource)) {
        const options = { provider: args.provider && args.provider !== true ? String(args.provider) : "all", idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "" };
        const plan = planSharedSkillOperation(agentFirstTarget, { action: "reconcile", ...options });
        results.skills = args["dry-run"] ? plan : applySharedSkillOperation(agentFirstTarget, { action: "reconcile", planId: plan.planId, ...options });
      }
      if (["instructions", "all"].includes(resource)) {
        const options = { provider: args.provider && args.provider !== true ? String(args.provider) : "all", idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "" };
        const plan = planSharedInstructionOperation(agentFirstTarget, { action: "reconcile", ...options });
        results.instructions = args["dry-run"] ? plan : applySharedInstructionOperation(agentFirstTarget, { action: "reconcile", planId: plan.planId, ...options });
      }
      emitAgentFirstResult("shared.reconcile", { target: agentFirstTarget, data: { resource, dryRun: Boolean(args["dry-run"]), effect: "reversible-local", results } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "security") {
      const status = checkSharedGitHubSecurity(root);
      const plan = previewLegacyMutation("shared.security", { root, input: { repository: status.repository || "" }, affected: ["GitHub branch protections for the configured shared repository"] });
      if (!args.apply) {
        emitAgentFirstResult("shared.security", { target: agentFirstTarget, data: { status, ...(status.verified ? {} : { planId: plan.planId }), effect: status.verified ? "none" : "protected" } }, { format: agentFirstFormat });
        process.exit(0);
      }
      if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by shared security.", { exitCode: 2 });
      if (String(args.apply) !== plan.planId) throw new ContextRoomCliError("stale-plan", "Shared repository security changed after this repair was planned.", { retryable: true });
      emitAgentFirstResult("shared.security", { target: agentFirstTarget, data: { planId: plan.planId, result: secureSharedGitHubRepository(root), effect: "protected" } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "init-repository") {
      writeStdout(JSON.stringify(initializeSharedRepository(root, { name: args.name || args.title || path.basename(root) }), null, 2));
      process.exit(0);
    }
    if (action === "bind") {
      if (!args.repository || args.repository === true || args.project === true) {
        throw new Error("Usage: context-room shared bind --root . --repository <git-url> [--project <projectId>]");
      }
      const requestedBinding = { repository: args.repository, projectId: args.project || "" };
      assertSharedBindingCompatible(root, requestedBinding);
      const detected = detectSharedProject(root, requestedBinding);
      const bindingRoot = detected.projectRoot;
      assertSharedBindingCompatible(bindingRoot, detected);
      const result = connectSharedContextThroughHubTransaction(bindingRoot, {
        repository: args.repository,
        projectId: detected.projectId,
        sync: false,
      });
      writeStdout(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    if (action === "setup") {
      if (!args.repository || args.repository === true || args.project === true) {
        throw new Error("Usage: context-room shared setup --root . --repository <git-url> [--project <projectId>]");
      }
      const requestedBinding = { repository: args.repository, projectId: args.project || "" };
      assertSharedBindingCompatible(root, requestedBinding);
      const detected = detectSharedProject(root, requestedBinding);
      const setupRoot = detected.projectRoot;
      assertSharedBindingCompatible(setupRoot, detected);
      initializeContextRoomProject(setupRoot);
      const result = connectSharedContextThroughHubTransaction(setupRoot, {
        repository: args.repository,
        projectId: detected.projectId,
        sync: true,
      });
      writeStdout(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    if (action === "sync") {
      emitAgentFirstResult("shared.sync", { target: agentFirstTarget, data: syncSharedContext(root, { allowOffline: true }) }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "status") {
      emitAgentFirstResult("shared.status", { target: agentFirstTarget, data: sharedContextStatus(root) }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "skills") {
      const skillAction = args._[2] || "status";
      const csv = (value, fallback = []) => value && value !== true ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : fallback;
      if (skillAction === "status") {
        writeStdout(JSON.stringify(sharedSkillLocationsStatus(root, { refresh: Boolean(args.fresh) }), null, 2));
        process.exit(0);
      }
      if (skillAction === "effective") {
        emitAgentFirstResult("shared.skills.effective", { target: agentFirstTarget, data: effectiveSharedSkills(agentFirstTarget, { provider: args.provider || "all" }) }, { format: agentFirstFormat });
        process.exit(0);
      }
      if (skillAction === "explain") {
        const selector = args._[3] || args.id || args.path || args.collection || args.assignment;
        if (!selector || selector === true) throw new ContextRoomCliError("missing-selector", "shared skills explain requires a collection, assignment, destination, path, or skill name.", { exitCode: 2 });
        emitAgentFirstResult("shared.skills.explain", { target: agentFirstTarget, data: explainSharedSkill(agentFirstTarget, String(selector)) }, { format: agentFirstFormat });
        process.exit(0);
      }
      if (skillAction === "reconcile") {
        // handled by the common exact plan/apply path below
      }
      if (["assign", "unassign", "import", "link", "unlink", "reconcile", "override"].includes(skillAction)) {
        if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by the preview.", { exitCode: 2 });
        const projectIds = [...new Set([
          ...csv(args.projects || (skillAction === "assign" || skillAction === "import" ? args.project : "")),
          ...readProjectsFile(args["projects-file"]),
        ])];
        const options = {
          assignmentId: args.assignment && args.assignment !== true ? String(args.assignment) : "",
          collectionId: args.collection && args.collection !== true ? String(args.collection) : "",
          collectionTitle: args["collection-title"] && args["collection-title"] !== true ? String(args["collection-title"]) : "",
          collectionPath: args["collection-path"] && args["collection-path"] !== true ? String(args["collection-path"]) : "",
          sourceDirectory: args.source && args.source !== true ? String(args.source) : "",
          id: args.id && args.id !== true ? String(args.id) : "",
          destination: args.destination && args.destination !== true ? String(args.destination) : "",
          provider: args.provider && args.provider !== true ? String(args.provider) : "all",
          providers: csv(args.providers || (skillAction === "assign" || skillAction === "import" ? args.provider : ""), ["codex"]),
          scope: args.scope && args.scope !== true ? String(args.scope) : "project",
          projectIds,
          skills: csv(args.skills),
          include: csv(args.include, ["*"]),
          exclude: csv(args.exclude),
          disabled: args.enabled === undefined ? undefined : ["false", "0", "disabled"].includes(String(args.enabled).toLowerCase()),
          title: args.title && args.title !== true ? String(args.title) : "",
          description: args.description && args.description !== true ? String(args.description) : "",
          provider: args.provider && args.provider !== true ? String(args.provider) : "all",
          sessionId: args.session && args.session !== true ? String(args.session) : process.env.CODEX_THREAD_ID || "",
          idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "",
          provider: args.provider && args.provider !== true ? String(args.provider) : "all",
        };
        const result = args.apply
          ? applySharedSkillOperation(agentFirstTarget, { action: skillAction, planId: String(args.apply), ...options })
          : planSharedSkillOperation(agentFirstTarget, { action: skillAction, ...options });
        emitAgentFirstResult(`shared.skills.${skillAction}`, { target: agentFirstTarget, data: result }, { format: agentFirstFormat });
        process.exit(0);
      }
      throw new Error(`Unknown shared skills command: ${skillAction}`);
    }
    if (action === "instructions") {
      const instructionAction = args._[2] || "status";
      if (instructionAction === "status") {
        emitAgentFirstResult("shared.instructions.status", { target: agentFirstTarget, data: sharedInstructionLocationsStatus(root, { refresh: Boolean(args.fresh) }) }, { format: agentFirstFormat });
        process.exit(0);
      }
      if (["assign", "unassign", "import", "reconcile"].includes(instructionAction)) {
        if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by the preview.", { exitCode: 2 });
        const files = (() => {
          if (!args.files || args.files === true) return [];
          const parsed = JSON.parse(fs.readFileSync(path.resolve(String(args.files)), "utf8"));
          if (!Array.isArray(parsed)) throw new ContextRoomCliError("invalid-instruction-files", "--files must point to a JSON array.", { exitCode: 2 });
          return parsed;
        })();
        const projectIds = [...new Set([
          ...(args.projects && args.projects !== true ? String(args.projects).split(",").map((item) => item.trim()).filter(Boolean) : []),
          ...readProjectsFile(args["projects-file"]),
        ])];
        const options = {
          assignmentId: args.assignment && args.assignment !== true ? String(args.assignment) : "",
          collectionId: args.collection && args.collection !== true ? String(args.collection) : "",
          collectionTitle: args["collection-title"] && args["collection-title"] !== true ? String(args["collection-title"]) : "",
          collectionPath: args["collection-path"] && args["collection-path"] !== true ? String(args["collection-path"]) : "",
          scope: args.scope && args.scope !== true ? String(args.scope) : "project",
          projectIds,
          files,
          title: args.title && args.title !== true ? String(args.title) : "",
          description: args.description && args.description !== true ? String(args.description) : "",
          provider: args.provider && args.provider !== true ? String(args.provider) : "all",
          sessionId: args.session && args.session !== true ? String(args.session) : process.env.CODEX_THREAD_ID || "",
          idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "",
        };
        const result = args.apply
          ? applySharedInstructionOperation(agentFirstTarget, { action: instructionAction, planId: String(args.apply), ...options })
          : planSharedInstructionOperation(agentFirstTarget, { action: instructionAction, ...options });
        emitAgentFirstResult(`shared.instructions.${instructionAction}`, { target: agentFirstTarget, data: result }, { format: agentFirstFormat });
        process.exit(0);
      }
      throw new Error(`Unknown shared instructions command: ${instructionAction}`);
    }
    if (action === "secure-github") {
      writeStdout(JSON.stringify(secureSharedGitHubRepository(root), null, 2));
      process.exit(0);
    }
    if (action === "security-check") {
      const result = checkSharedGitHubSecurity(root);
      writeStdout(JSON.stringify(result, null, 2));
      process.exit(result.verified ? 0 : 1);
    }
    if (action === "proposals") {
      let proposals = listSharedProposals(root);
      if (args.project && args.project !== true) proposals = proposals.filter((proposal) => proposal.projectId === args.project);
      if (args.session && args.session !== true) proposals = proposals.filter((proposal) => proposal.sessionId === args.session);
      writeStdout(JSON.stringify(proposals, null, 2));
      process.exit(0);
    }
    if (action === "propose") {
      if (!args.description) throw new Error("--description is required when creating a proposal");
      writeStdout(JSON.stringify(ensureSharedProposal(root, {
        title: args.title || args.task || "Shared context change",
        description: args.description,
        scope: args.scope || "project",
        branch: args.branch || "",
        sessionId: args.session || process.env.CODEX_THREAD_ID || "",
      }), null, 2));
      process.exit(0);
    }
    if (action === "publish") {
      if (!args.proposal || args.proposal === true) throw new Error("--proposal requires a proposal/* branch");
      writeStdout(JSON.stringify(publishSharedProposal(root, {
        proposal: args.proposal,
        message: args.message,
        title: args.title,
        description: args.description,
        author: cliGitAuthor(root),
      }), null, 2));
      process.exit(0);
    }
    if (action === "review") {
      if (!args.proposal || args.proposal === true) throw new Error("--proposal requires a proposal/* branch");
      const result = materializeSharedReview(root, { proposal: args.proposal });
      const config = result.repositoryConfig;
      const projectId = result.metadata.projectId;
      const projectPrefix = `${config.projectsPath}/${projectId}`;
      const allowedPaths = projectId === "global"
        ? [`${config.globalSkillsPath}/`]
        : projectId === "skills"
          ? [...(result.metadata.allowedExact || [config.skillLocationsFile]), ...(result.metadata.allowedPrefixes || [])]
          : [`${projectPrefix}/docs/`, `${projectPrefix}/skills/`];
      initializeContextRoomProject(result.reviewRoot, {
        title: `Review · ${args.proposal}`,
        allowedPaths,
        watchAllow: allowedPaths,
      });
      const preferredPort = args.port === undefined ? 4317 : Number(args.port);
      const port = await selectAvailableContextRoomPort(preferredPort, { allowFallback: args.port === undefined });
      const { server } = createMemoryServer({ root: result.reviewRoot, port, persistentDocumentGraphLayout: true });
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => { server.off("error", onError); resolve(); });
      });
      console.log(`Context Room: http://127.0.0.1:${port}`);
      console.log(`Proposal: ${args.proposal}`);
      console.log(`Proposal head: ${result.metadata.proposalHead}`);
      console.log(`Review root: ${result.reviewRoot}`);
      process.on("SIGINT", () => server.close(() => process.exit(0)));
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
      await new Promise(() => {});
    }
    throw new Error(`Unknown shared command: ${action}`);
  } catch (error) {
    const structuredSharedAction = ["connect", "assign", "unassign", "local", "reconcile", "security", "sync", "status"].includes(action)
      || action === "instructions"
      || (action === "skills" && ["effective", "explain", "assign", "unassign", "import", "link", "unlink", "reconcile", "override"].includes(args._[2] || ""));
    if (machineContractRequested() || structuredSharedAction) {
      const commandName = action === "skills" || action === "instructions" ? `shared.${action}.${args._[2] || "status"}` : `shared.${action}`;
      failAgentFirstCommand(commandName, error, { format: agentFirstFormat, target: agentFirstTarget });
    }
    console.error(`Shared context failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "context") {
  const action = args._[1] || "ask";
  if (["bundle", "effective", "explain", "graph", "trace", "impact", "snapshot", "diff"].includes(action)) {
    try {
      const provider = args.provider && args.provider !== true ? String(args.provider) : "codex";
      const common = {
        provider,
        folder: args.folder && args.folder !== true ? String(args.folder) : "",
        allowStale: Boolean(args["allow-stale"]),
        refreshShared: !args["allow-stale"],
        cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "",
        limit: parsePositiveLimit(args.limit),
        query: args.query && args.query !== true ? String(args.query) : "",
        includeGraph: splitList(args.include).includes("graph") || args.detail === "full",
      };
      let data;
      if (action === "bundle") {
        const task = args.task && args.task !== true ? String(args.task) : args._.slice(2).join(" ").trim() || "current task";
        const result = sharedOnlyContextBundle
          ? buildSharedOnlyAgentPrepare({ repository: explicitSharedRepository, projectId: explicitSharedProject, task, provider, fresh: Boolean(args.fresh), budget: args.budget })
          : buildAgentPrepareCached(agentFirstTarget, { task, provider, fresh: Boolean(args.fresh), budget: args.budget });
        emitAgentFirstResult("context.bundle", result, { format: agentFirstFormat });
        process.exit(0);
      } else if (action === "effective") data = buildCliContextEffective(agentFirstTarget, common);
      else if (action === "explain") {
        const selector = args._[2] || args.path || args.id || "";
        if (!selector) throw new ContextRoomCliError("missing-selector", "context explain requires a resource selector.", { exitCode: 2 });
        const kind = args.kind && args.kind !== true ? String(args.kind) : "";
        try {
          data = traceCliContext(agentFirstTarget, String(selector), { ...common, kind });
        } catch (error) {
          if (error?.code !== "context-resource-not-found") throw error;
          data = explainAgentSelector(agentFirstTarget, { selector: String(selector), kind, provider });
        }
      }
      else if (action === "graph") data = paginateContextGraph(buildCliContextGraph(agentFirstTarget, common), common);
      else if (action === "trace") {
        const selector = args._[2] || args.path || args.id || "";
        if (!selector) throw new ContextRoomCliError("missing-selector", "context trace requires a resource selector.", { exitCode: 2 });
        data = traceCliContext(agentFirstTarget, String(selector), { ...common, kind: args.kind && args.kind !== true ? String(args.kind) : "" });
      } else if (action === "impact") {
        const selector = args._[2] || args.path || args.id || "";
        if (!selector && (!args.provider || args.provider === true) && !common.query) throw new ContextRoomCliError("missing-selector", "context impact requires a resource selector, --provider, or --query.", { exitCode: 2 });
        data = impactCliContext(agentFirstTarget, String(selector), common);
      } else if (action === "snapshot") data = await createCliContextSnapshot(agentFirstTarget, common);
      else {
        const from = args.from && args.from !== true ? String(args.from) : "";
        const to = args.to && args.to !== true ? String(args.to) : "";
        if (!from) throw new ContextRoomCliError("missing-snapshot", "context diff requires --from <snapshot-id>.", { exitCode: 2 });
        data = await diffCliContextSnapshots({ from, to, target: agentFirstTarget, ...common });
      }
      emitAgentFirstResult(`context.${action}`, { target: agentFirstTarget, freshness: data?.freshness, data }, { format: agentFirstFormat });
      process.exit(0);
    } catch (error) {
      failAgentFirstCommand(`context.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
    }
  }
  if (action !== "ask") {
    failAgentFirstCommand(`context.${action}`, new ContextRoomCliError("unknown-command", `Unknown context command: ${action}`, { exitCode: 2 }), { format: agentFirstFormat, target: agentFirstTarget });
  }
  const task = documentationResearchBrief;
  try {
    const result = runDocumentationAgent({
      root,
      ...documentationTargetOptions,
      cliPath: fileURLToPath(import.meta.url),
      task,
      goal: args.goal && args.goal !== true ? String(args.goal) : "",
      files: splitList(args.files),
      depth: args.depth && args.depth !== true ? String(args.depth) : "standard",
      budget: args.budget === undefined ? undefined : args.budget,
    });
    if ((args.contract && args.contract !== true && ["v2", "context-room.cli/2"].includes(String(args.contract).toLowerCase())) || (args.format && args.format !== true)) {
      emitAgentFirstResult(primaryAskCommand ? "ask" : "context.ask", { data: result.packet }, { format: agentFirstFormat });
    } else if (args.json) writeStdout(JSON.stringify(result.packet, null, 2));
    else writeStdout(renderDocumentationPacket(result.packet), { newline: false });
    await flushAndExit(0);
  } catch (error) {
    if (machineContractRequested()) failAgentFirstCommand(primaryAskCommand ? "ask" : "context.ask", error, { format: agentFirstFormat });
    console.error(`Context Room documentation agent failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "docs") {
  const action = args._[1] || "";
  const selector = args._[2] || args.path || "";
  const sessionId = args.session && args.session !== true ? String(args.session) : "";
  try {
    if (action === "edit") {
      let data;
      if (primaryEditCommand) {
        const editAction = String(args._[2] || "").trim().toLowerCase();
        if (editAction === "list") {
          data = listSharedDocumentationProposals(agentFirstTarget);
        } else if (editAction === "open") {
          const proposal = args.proposal && args.proposal !== true ? String(args.proposal) : String(args._[3] || "");
          if (!proposal) throw new ContextRoomCliError("missing-proposal", "edit open requires an exact proposal branch.", { exitCode: 2 });
          data = openSharedDocumentationProposalByBranch({
            proposal,
            repository: explicitSharedRepository,
            projectId: explicitSharedProject,
          });
        } else if (editAction === "create") {
          const description = args.description && args.description !== true ? String(args.description) : args._.slice(3).join(" ").trim();
          data = createSharedDocumentationProposal(agentFirstTarget, {
            description,
            title: args.title && args.title !== true ? String(args.title) : "",
            sessionId,
          });
        } else {
          throw new ContextRoomCliError("invalid-edit-action", "edit requires one action: create, open, or list.", { exitCode: 2 });
        }
      } else {
        const task = args.task && args.task !== true ? String(args.task) : args._.slice(2).join(" ").trim();
        data = createDocumentationChange(agentFirstTarget, {
          task,
          document: args.document && args.document !== true ? String(args.document) : "",
          scope: args.scope && args.scope !== true ? String(args.scope) : "local",
          description: args.description && args.description !== true ? String(args.description) : "",
          sessionId,
        });
      }
      emitAgentFirstResult(primaryEditCommand ? "edit" : "docs.edit", { target: agentFirstTarget, data }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "publish") {
      const changeId = args.change && args.change !== true ? String(args.change) : args._[2] || "";
      const data = publishDocumentationChange(changeId, {
        summary: args.summary && args.summary !== true ? String(args.summary) : "",
        description: args.description && args.description !== true ? String(args.description) : "",
      });
      emitAgentFirstResult("docs.publish", { data }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (action === "search") {
      const query = args.query && args.query !== true ? String(args.query) : args._.slice(2).join(" ").trim();
      const data = searchDocumentation(root, query, {
        ...documentationTargetOptions,
        status: args.status && args.status !== true ? String(args.status) : "",
        kind: args.kind && args.kind !== true ? String(args.kind) : "",
        limit: args.limit,
        budget: args.budget,
        sessionId,
      });
      if (machineContractRequested()) emitAgentFirstResult("docs.search", { data }, { format: agentFirstFormat });
      else writeStdout(JSON.stringify(data, null, 2));
      process.exit(0);
    }
    if (action === "read") {
      const data = readDocumentation(root, selector, { ...documentationTargetOptions, section: args.section, budget: args.budget, sessionId });
      if (machineContractRequested()) emitAgentFirstResult("docs.read", { data }, { format: agentFirstFormat });
      else writeStdout(JSON.stringify(data, null, 2));
      process.exit(0);
    }
    if (action === "related") {
      const data = relatedDocumentation(root, selector, { ...documentationTargetOptions, sessionId });
      if (machineContractRequested()) emitAgentFirstResult("docs.related", { data }, { format: agentFirstFormat });
      else writeStdout(JSON.stringify(data, null, 2));
      process.exit(0);
    }
    if (action === "trace") {
      const data = traceDocumentation(root, selector, { ...documentationTargetOptions, section: args.section, sessionId });
      if (machineContractRequested()) emitAgentFirstResult("docs.trace", { data }, { format: agentFirstFormat });
      else writeStdout(JSON.stringify(data, null, 2));
      process.exit(0);
    }
    const inspectOptions = { ...documentationTargetOptions, sessionId };
    let data;
    if (action === "inspect") data = inspectDocumentation(root, selector, inspectOptions);
    else if (action === "metadata") data = metadataDocumentation(root, selector, inspectOptions);
    else if (action === "links") data = linksDocumentation(root, selector, inspectOptions);
    else if (action === "backlinks") data = backlinksDocumentation(root, selector, inspectOptions);
    else if (action === "dependencies") data = dependenciesDocumentation(root, selector, inspectOptions);
    else if (action === "diagrams") data = diagramsDocumentation(root, selector, inspectOptions);
    else if (action === "validate") data = validateDocumentation(root, selector, inspectOptions);
    else throw new Error(`Unknown docs command: ${action}`);
    if (machineContractRequested()) emitAgentFirstResult(`docs.${action}`, { data }, { format: agentFirstFormat });
    else writeStdout(JSON.stringify(data, null, 2));
    process.exit(0);
  } catch (error) {
    if (machineContractRequested() || ["edit", "publish"].includes(action)) failAgentFirstCommand(primaryEditCommand ? "edit" : `docs.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
    console.error(`Context Room docs failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "init") {
  let result;
  try {
    result = initializeContextRoomProject(root, {
      title: args.title,
      allowedPaths: splitList(args.allow),
      watchAllow: splitList(args.watch),
    });
  } catch (error) {
    console.error(`Context Room initialization failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`Context Room initialized: ${result.configPath}`);
  if (result.discoverySkipped) console.log("Documentation discovery skipped: the existing configuration was preserved.");
  else console.log(`Documentation discovered: ${result.documentationPaths.length}`);
  console.log(`Watched paths: ${result.config.watchAllow.length}`);
  console.log(`Hub sections: ${result.config.hubSections.length}`);
  if (!process.env.NODE_TEST_CONTEXT) registerContextHubProject(root, { title: args.title });
  console.log(`Agent setup guide: ${result.agentContextPath}`);
  console.log(`Agent next step: read ${JSON.stringify(result.agentContextPath)} and follow its setup checklist.`);
  console.log(`Run: context-room setup --root ${quotedCliValue(root)}`);
  process.exit(0);
}

if (command === "settings") {
  const action = args._[1] || "get";
  try {
    let data;
    if (action === "get") {
      const key = args._[2] || "";
      data = getCliContextSettings(agentFirstTarget, { key: String(key) });
    } else if (action === "explain") {
      const key = args._[2] || "";
      if (!key) throw new ContextRoomCliError("missing-setting", "settings explain requires a setting key.", { exitCode: 2 });
      data = explainCliContextSetting(String(key));
    } else if (action === "set") {
      if (args.plan) throw new ContextRoomCliError("deprecated-option", "--plan is no longer used. Run settings set to receive the exact plan, then repeat it with --apply <plan-id>.", { exitCode: 2 });
      if (args.apply === true) throw new ContextRoomCliError("missing-plan", "settings set --apply requires a plan id.", { exitCode: 2 });
      if (args.apply) {
        data = applyCliContextSettings(agentFirstTarget, {
          planId: String(args.apply),
          idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "",
        });
      } else {
        const set = parseSettingAssignments(args.set);
        if (!set.length) throw new ContextRoomCliError("empty-settings-plan", "settings set requires at least one --set key=value.", { exitCode: 2 });
        data = planCliContextSettings(agentFirstTarget, {
          set,
          expectedRevision: args["expected-revision"] && args["expected-revision"] !== true ? String(args["expected-revision"]) : "",
        });
      }
    } else if (action === "plan") {
      const set = parseSettingAssignments(args.set);
      if (!set.length) throw new ContextRoomCliError("empty-settings-plan", "settings plan requires at least one --set key=value.", { exitCode: 2 });
      data = planCliContextSettings(agentFirstTarget, {
        set,
        expectedRevision: args["expected-revision"] && args["expected-revision"] !== true ? String(args["expected-revision"]) : "",
      });
    } else if (action === "apply") {
      const planId = args._[2] || (args.apply && args.apply !== true ? String(args.apply) : "");
      if (!planId) throw new ContextRoomCliError("missing-plan", "settings apply requires a plan id.", { exitCode: 2 });
      data = applyCliContextSettings(agentFirstTarget, {
        planId: String(planId),
        idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : "",
      });
    } else throw new ContextRoomCliError("unknown-command", `Unknown settings command: ${action}`, { exitCode: 2 });
    emitAgentFirstResult(`settings.${action}`, { target: agentFirstTarget, data }, { format: agentFirstFormat });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand(`settings.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

if (command === "doctor") {
  if (args["all-projects"]) {
    try {
      const report = doctorAllProjects({
        onlyActionable: Boolean(args.actionable || args.only === "actionable"),
        cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "",
        limit: parsePositiveLimit(args.limit),
        query: args.query && args.query !== true ? String(args.query) : "",
        project: args.project && args.project !== true ? String(args.project) : "",
        location: args.location && args.location !== true ? String(args.location) : "",
        shared: args.shared && args.shared !== true ? String(args.shared) : "",
        provider: args.provider && args.provider !== true ? String(args.provider) : "",
        folder: args.folder && args.folder !== true ? String(args.folder) : "",
      });
      if (agentFirstFormat.toLowerCase() === "jsonl") {
        for (const project of report.projects) emitAgentFirstResult("doctor.all-projects.item", { data: { project } }, { format: "jsonl" });
        emitAgentFirstResult("doctor.all-projects.summary", { data: { summary: report.summary, pagination: report.pagination } }, { format: "jsonl" });
      } else {
        emitAgentFirstResult("doctor.all-projects", { data: report }, { format: agentFirstFormat });
      }
      process.exit(0);
    } catch (error) {
      failAgentFirstCommand("doctor.all-projects", error, { format: agentFirstFormat });
    }
  }
  if (args._[1] === "explain" || args._[1] === "plan") {
    const action = args._[1];
    const issueKey = args._[2] || "";
    try {
      const filters = {
        folder: args.folder && args.folder !== true ? String(args.folder) : "",
        provider: args.provider && args.provider !== true ? String(args.provider) : "",
      };
      const data = action === "explain"
        ? (() => {
            if (!issueKey) throw new ContextRoomCliError("missing-issue-key", "doctor explain requires an issue key.", { exitCode: 2 });
            return explainCliDoctorIssue(agentFirstTarget, String(issueKey), filters);
          })()
        : issueKey
          ? planCliDoctorIssue(agentFirstTarget, String(issueKey), filters)
          : doctorSafePlan(agentFirstTarget);
      emitAgentFirstResult(`doctor.${action}`, { target: agentFirstTarget, data }, { format: agentFirstFormat });
      process.exit(0);
    } catch (error) {
      failAgentFirstCommand(`doctor.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
    }
  }
  let report;
  try {
    report = agentFirstTarget
      ? buildCliDoctorReport(agentFirstTarget, {
          folder: args.folder && args.folder !== true ? String(args.folder) : "",
          provider: args.provider && args.provider !== true ? String(args.provider) : "",
          cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "",
          limit: parsePositiveLimit(args.limit),
        })
      : buildContextRoomDoctorReport(root);
  } catch (error) {
    if (!agentFirstTarget && !args.format) {
      console.error(`Context Room doctor failed: [critical] ${error.message}`);
      process.exit(1);
    }
    failAgentFirstCommand("doctor", error, { format: agentFirstFormat, target: agentFirstTarget });
  }
  if (args.format || args.project || args.location || args.folder || args.provider || args.cursor || args.limit) {
    emitAgentFirstResult("doctor", { target: agentFirstTarget, data: report }, { format: agentFirstFormat });
    if ((args.strict || args.profile === "strict") && report.issues?.some((issue) => ["critical", "high"].includes(issue.severity))) process.exit(1);
    process.exit(0);
  }
  const blocking = report.issues.filter((issue) => ["critical", "high"].includes(issue.severity));
  console.log(blocking.length ? "Context Room needs attention" : "Context Room OK");
  console.log(`Root: ${root}`);
  console.log(`Config: ${path.join(root, CONFIG_FILE)}`);
  console.log(`Allowed paths: ${report.settings.allowedPaths}`);
  console.log(`Watched paths: ${report.settings.watchAllow}`);
  console.log(`Docs in graph: ${report.graph.docs}`);
  console.log(`Missing metadata: ${report.graph.missingMetadata}`);
  console.log(`Health issues: ${report.issues.length}`);
  for (const issue of report.issues.slice(0, 20)) {
    console.log(`- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
  if ((args.strict || args.profile === "strict") && blocking.length) process.exit(1);
  process.exit(0);
}

if (command === "guard") {
  const allowedOperations = new Set(["commit", "push", "pull-request", "merge"]);
  const operation = args.operation ? String(args.operation).trim().toLowerCase() : "";
  if (operation && !allowedOperations.has(operation)) {
    console.error(`Unknown review-gate operation: ${operation}`);
    process.exit(2);
  }
  const requestedProfile = args.strict ? "strict" : args.advisory ? "advisory" : args.profile ? String(args.profile) : "";
  const gateActive = Boolean(operation && !requestedProfile && readReviewGateSettings(root).operations.includes(operation));
  if (args.hook && operation && !gateActive) process.exit(0);
  const profile = requestedProfile || (gateActive ? "review-gate" : "advisory");
  const report = buildDocQaReport(root);
  const doctor = profile === "strict" || profile === "advisory" ? buildContextRoomDoctorReport(root) : null;
  const blockingHealth = doctor ? doctor.issues.filter((issue) => ["critical", "high"].includes(issue.severity)) : [];
  const shouldBlock = gateActive ? report.queue.length > 0 : profile === "strict" && (report.queue.length || blockingHealth.length);
  const operationLabel = operation === "pull-request" ? "pull request" : operation || "commit";
  if (report.queue.length) {
    const write = shouldBlock ? console.error : console.log;
    write(shouldBlock
      ? `Context Room guard blocked this ${operationLabel}: watched documentation changes need human review:`
      : "Context Room guard found watched documentation changes that need human review:");
    for (const item of report.queue) write(`- ${item.gitStatus.trim() || "changed"} ${item.path}`);
  }
  if (blockingHealth.length) {
    console.error("High-impact Context Room health issues:");
    for (const issue of blockingHealth.slice(0, 20)) console.error(`- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
  if (shouldBlock) {
    console.error(
      "\nOpen the Context Room webapp for the user, show the Changed files to review queue, and have the user review each diff before continuing this Git operation. Agents must not mark files verified on the user's behalf.",
    );
    if (blockingHealth.length) console.error("If strict health issues are listed, fix them before asking the user to verify.");
    process.exit(1);
  }
  if (profile !== "strict" && !gateActive && (report.queue.length || blockingHealth.length)) {
    console.log(`Context Room ${profile} guard found issues but did not block.`);
  } else {
    console.log(profile === "strict" ? "Strict Context Room guard passed." : "No unverified watched documentation changes.");
  }
  process.exit(0);
}

if (command === "review") {
  const action = args._[1] || "list";
  const selector = args._[2] || args.path || args.id || "";
  try {
    if (action === "list") {
      const result = listCliReviews(agentFirstTarget, { query: args.query || "", reason: args.reason || "", severity: args.severity || "" });
      const page = paginateList(result.queue || [], { cursor: args.cursor && args.cursor !== true ? String(args.cursor) : "", limit: args.limit });
      emitAgentFirstResult("review.list", { target: agentFirstTarget, data: { ...result, queue: page.items, pagination: page.pagination } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (!selector || selector === true) throw new ContextRoomCliError("missing-selector", `review ${action} requires a path or review id.`, { exitCode: 2 });
    if (action === "show") emitAgentFirstResult("review.show", { target: agentFirstTarget, data: showCliReview(agentFirstTarget, String(selector)) }, { format: agentFirstFormat });
    else if (action === "diff") emitAgentFirstResult("review.diff", { target: agentFirstTarget, data: diffCliReview(agentFirstTarget, String(selector)) }, { format: agentFirstFormat });
    else if (action === "open") emitAgentFirstResult("review.open", { target: agentFirstTarget, data: openCliReview(agentFirstTarget, String(selector)) }, { format: agentFirstFormat });
    else if (action === "annotate") {
      if (!args.note || args.note === true) throw new ContextRoomCliError("missing-note", "review annotate requires --note.", { exitCode: 2 });
      if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by review annotate.", { exitCode: 2 });
      const result = args.apply
        ? applyCliReviewAnnotation(agentFirstTarget, { selector: String(selector), note: String(args.note), planId: String(args.apply) })
        : planCliReviewAnnotation(agentFirstTarget, String(selector), String(args.note));
      emitAgentFirstResult("review.annotate", { target: agentFirstTarget, data: result }, { format: agentFirstFormat });
    } else throw new ContextRoomCliError("unknown-command", `Unknown review command: ${action}`, { exitCode: 2 });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand(`review.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

async function resolveActiveWorkspace(target, explicitWorkspace = "", selectors = {}) {
  const buildQuery = ({ session = selectors.session || "" } = {}) => {
    const query = new URLSearchParams();
    if (explicitWorkspace) query.set("workspace", explicitWorkspace);
    else if (selectors.location) query.set("location", selectors.location);
    else if (selectors.project) query.set("project", selectors.project);
    else if (target?.location?.id) query.set("location", target.location.id);
    else if (target?.project?.id) query.set("project", target.project.id);
    if (!explicitWorkspace && session) query.set("session", session);
    return query;
  };
  let { data } = await requestWorkspaceApi("/api/workspaces?" + buildQuery().toString());
  let candidates = data.workspaces || [];
  if (!candidates.length && selectors.session && selectors.fallbackWithoutSession) {
    ({ data } = await requestWorkspaceApi("/api/workspaces?" + buildQuery({ session: "" }).toString()));
    candidates = data.workspaces || [];
  }
  if (selectors.recent && candidates.length) return [...candidates].sort((left, right) => {
    const focusOrder = String(right.focusedAt || "").localeCompare(String(left.focusedAt || ""));
    return focusOrder || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  })[0];
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new ContextRoomCliError("workspace-not-found", "No active Context Room workspace matches this target.", {
    retryable: true,
    details: { workspace: explicitWorkspace || null, projectId: target?.project?.id || null, locationId: target?.location?.id || null },
    nextActions: [{ id: "open-workspace", command: "context-room workspace open --project " + JSON.stringify(target?.project?.id || ""), mutates: false, requiresHuman: false }],
    exitCode: 4,
  });
  throw new ContextRoomCliError("workspace-ambiguous", "Several active Context Room workspaces match; pass --workspace <id>.", {
    retryable: true,
    details: { candidates: candidates.map(({ workspaceId, projectId, projectTitle, locationId, view, file, visible, focused }) => ({ workspaceId, projectId, projectTitle, locationId, view, file, visible, focused })) },
    nextActions: candidates.map((candidate) => ({ id: "select-" + candidate.workspaceId, command: "context-room agent state --workspace " + candidate.workspaceId, mutates: false, requiresHuman: false })),
    exitCode: 5,
  });
}

async function sendWorkspaceCommand(workspaceId, next) {
  const { data } = await requestWorkspaceApi("/api/workspaces/" + encodeURIComponent(workspaceId) + "/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(next),
  });
  return data.command;
}

if (command === "agent") {
  const action = args._[1] || "state";
  if (agentFirstAgentActions.has(action)) {
    try {
      const sessionId = args.session && args.session !== true ? String(args.session) : process.env.CODEX_THREAD_ID || "";
      const provider = args.provider && args.provider !== true ? String(args.provider) : "auto";
      if (action === "prepare") {
        const task = args.task && args.task !== true ? String(args.task) : args._.slice(2).join(" ").trim();
        if (!task) throw new ContextRoomCliError("missing-task", "agent prepare requires --task or a task argument.", { exitCode: 2 });
        const result = sharedOnlyAgentPrepare
          ? buildSharedOnlyAgentPrepare({ repository: String(args.repository), projectId: sharedAgentProject, task, sessionId, provider, fresh: Boolean(args.fresh), budget: args.budget })
          : buildAgentPrepareCached(agentFirstTarget, { task, sessionId, provider, fresh: Boolean(args.fresh), budget: args.budget });
        emitAgentFirstResult("agent.prepare", result, { format: agentFirstFormat });
        process.exit(0);
      }
      if (action === "changes") {
        emitAgentFirstResult("agent.changes", { target: agentFirstTarget, data: classifyAgentChanges(agentFirstTarget, { sessionId }) }, { format: agentFirstFormat });
        process.exit(0);
      }
      if (action === "handoff") {
        const task = args.task && args.task !== true ? String(args.task) : args._.slice(2).join(" ").trim();
        const options = {
          task,
          description: args.description && args.description !== true ? String(args.description) : task,
          sessionId,
          idempotencyKey: args["idempotency-key"] && args["idempotency-key"] !== true ? String(args["idempotency-key"]) : sessionId,
        };
        if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by agent handoff.", { exitCode: 2 });
        const result = args.apply ? applyAgentHandoff(agentFirstTarget, { ...options, planId: String(args.apply) }) : planAgentHandoff(agentFirstTarget, options);
        emitAgentFirstResult("agent.handoff", { target: agentFirstTarget, data: result }, { format: agentFirstFormat });
        process.exit(0);
      }
    } catch (error) {
      failAgentFirstCommand(`agent.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
    }
  }
  if (action === "state") {
    try {
      const workspace = await resolveActiveWorkspace(agentFirstTarget, args.workspace && args.workspace !== true ? String(args.workspace) : "", {
        project: args.project && args.project !== true ? String(args.project) : "",
        location: args.location && args.location !== true ? String(args.location) : "",
      });
      emitAgentFirstResult("agent.state", { target: agentFirstTarget, data: { workspace } }, { format: agentFirstFormat });
      process.exit(0);
    } catch (error) {
      failAgentFirstCommand("agent.state", error, { format: agentFirstFormat, target: agentFirstTarget });
    }
  }
  if (action === "watch") {
    if (!args.path || args.path === true) {
      console.error("Usage: context-room agent watch --root . --path docs/ [--mode recursive-live|recursive-current|direct-current|direct-live]");
      process.exit(2);
    }
    if (args.mode === true || args.mode === "") {
      console.error("--mode requires a folder watch mode.");
      process.exit(2);
    }
    const mode = args.mode ? String(args.mode).trim() : "recursive-live";
    if (!WATCH_RULE_MODES.includes(mode)) {
      console.error(`Unknown folder watch mode: ${mode}. Expected one of: ${WATCH_RULE_MODES.join(", ")}.`);
      process.exit(2);
    }
    try {
      assertAgentWatchExpansion(root, args.path, mode);
    } catch (error) {
      failAgentFirstCommand("agent.watch", error, { format: agentFirstFormat, target: agentFirstTarget });
    }
    if (args.apply) {
      failAgentFirstCommand("agent.watch", new ContextRoomCliError("legacy-apply-unsupported", "agent watch keeps its existing direct behavior in this release. Use --plan to preview, then omit --plan only when you intend to apply it.", { exitCode: 2 }), { format: agentFirstFormat });
    }
    if (args.plan) {
      emitAgentFirstResult("agent.watch", { data: previewLegacyMutation("agent.watch", { root, input: { path: String(args.path), mode }, affected: [CONFIG_FILE] }) }, { format: agentFirstFormat });
      process.exit(0);
    }
    try {
      writeStdout(JSON.stringify(writeFolderWatchRule(root, { path: args.path, mode }), null, 2));
    } catch (error) {
      console.error(`Unable to watch folder: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (action === "unwatch") {
    if (!args.path || args.path === true) {
      console.error("Usage: context-room agent unwatch --root . --path docs/");
      process.exit(2);
    }
    failAgentFirstCommand("agent.unwatch", new ContextRoomCliError(
      "human-authority-required",
      "Only the human owner may remove a folder from review. Use Context Room Settings.",
      { details: { effect: "review-scope-reduction", path: String(args.path) }, exitCode: 4 },
    ), { format: agentFirstFormat });
  }
  if (action === "open" || action === "scroll" || action === "highlight") {
    const targetType = args.heading ? "heading" : args.text ? "text" : args.percent !== undefined ? "percent" : "";
    const targetValue = args.heading || args.text || args.percent || "";
    if (args.apply) {
      failAgentFirstCommand(`agent.${action}`, new ContextRoomCliError("legacy-apply-unsupported", `agent ${action} keeps its existing direct behavior in this release. Use --plan to preview, then omit --plan only when you intend to apply it.`, { exitCode: 2 }), { format: agentFirstFormat });
    }
    if (args.plan) {
      emitAgentFirstResult(`agent.${action}`, { data: previewLegacyMutation(`agent.${action}`, { root, input: { view: args.view || (args.path ? "file" : "hub"), path: args.path || "", targetType, targetValue }, affected: ["local browser navigation state"] }) }, { format: agentFirstFormat });
      process.exit(0);
    }
    try {
      const workspace = await resolveActiveWorkspace(agentFirstTarget, args.workspace && args.workspace !== true ? String(args.workspace) : "", {
        project: args.project && args.project !== true ? String(args.project) : "",
        location: args.location && args.location !== true ? String(args.location) : "",
      });
      const command = await sendWorkspaceCommand(workspace.workspaceId, {
        action: action === "open" ? "navigate" : action,
        view: args.view || (args.path ? "file" : "hub"),
        path: args.path || "",
        target: {
          heading: args.heading || null,
          text: args.text || null,
          percent: args.percent === undefined ? null : Number(args.percent),
        },
      });
      emitAgentFirstResult(`agent.${action}`, { target: agentFirstTarget, data: { workspace, command } }, { format: agentFirstFormat });
      process.exit(0);
    } catch (error) {
      failAgentFirstCommand(`agent.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
    }
  }
  if (action === "annotate") {
    if (!args.path || !args.note) {
      console.error("Usage: context-room agent annotate --root . --path docs/INDEX.md --note \"Human-facing note\" [--target \"text\"]");
      process.exit(1);
    }
    const annotationInput = {
      path: args.path,
      note: args.note,
      target: args.target || args.heading || args.text || "",
      targetType: args.heading ? "heading" : args.text || args.target ? "text" : "file",
      source: "agent-cli",
    };
    if (args.apply) {
      failAgentFirstCommand("agent.annotate", new ContextRoomCliError("legacy-apply-unsupported", "agent annotate keeps its existing direct behavior in this release. Use --plan to preview, then omit --plan only when you intend to apply it.", { exitCode: 2 }), { format: agentFirstFormat });
    }
    if (args.plan) {
      emitAgentFirstResult("agent.annotate", { data: previewLegacyMutation("agent.annotate", { root, input: annotationInput, affected: ["local human-facing annotations"] }) }, { format: agentFirstFormat });
      process.exit(0);
    }
    const annotation = appendAgentAnnotation(root, annotationInput);
    writeStdout(JSON.stringify({ annotation }, null, 2));
    process.exit(0);
  }
  if (action === "annotations") {
    writeStdout(JSON.stringify(readAgentAnnotations(root, args.path || ""), null, 2));
    process.exit(0);
  }
  console.error(`Unknown agent command: ${action}\n`);
  console.error(usage());
  process.exit(1);
}

if (command === "hooks") {
  const action = args._[1] || "sync";
  try {
    if (action !== "sync") throw new ContextRoomCliError("unknown-command", `Unknown hooks command: ${action}`, { exitCode: 2 });
    if (args.plan) throw new ContextRoomCliError("deprecated-option", "--plan is no longer used. Run hooks sync to receive the exact plan.", { exitCode: 2 });
    const plan = previewLegacyMutation("hooks.sync", { root, input: { root }, affected: ["managed Context Room Git hooks"] });
    if (!args.apply) {
      emitAgentFirstResult("hooks.sync", { target: agentFirstTarget, data: { ...plan, dryRun: Boolean(args["dry-run"]), effect: "protected" } }, { format: agentFirstFormat });
      process.exit(0);
    }
    if (args.apply === true) throw new ContextRoomCliError("missing-plan-id", "--apply requires the exact plan id returned by hooks sync.", { exitCode: 2 });
    if (String(args.apply) !== plan.planId) throw new ContextRoomCliError("stale-plan", "Hook configuration changed after this synchronization was planned.", { retryable: true });
    emitAgentFirstResult("hooks.sync", { target: agentFirstTarget, data: { planId: plan.planId, result: syncContextRoomGitHooks(root, { cliPath: fileURLToPath(import.meta.url) }), effect: "protected" } }, { format: agentFirstFormat });
    process.exit(0);
  } catch (error) {
    failAgentFirstCommand(`hooks.${action}`, error, { format: agentFirstFormat, target: agentFirstTarget });
  }
}

if (command === "install-hooks") {
  const result = syncContextRoomGitHooks(root, { cliPath: fileURLToPath(import.meta.url) });
  if (result.unavailable) {
    console.error(result.unavailable);
    process.exit(1);
  }
  for (const hook of result.installed) console.log(`Context Room ${hook} hook installed.`);
  for (const hook of result.updated) console.log(`Context Room ${hook} hook updated.`);
  for (const hook of result.removed) console.log(`Context Room ${hook} hook removed.`);
  if (result.conflicts.length) {
    console.error(`Context Room did not overwrite custom hooks: ${result.conflicts.join(", ")}`);
    process.exit(1);
  }
  if (result.externalOperations.length) console.log(`Hosted checks still need provider wiring: ${result.externalOperations.join(", ")}.`);
  if (!result.installed.length && !result.removed.length) console.log("No local Context Room Git hooks selected.");
  process.exit(0);
}

if (command === "update-all") {
  const updateArgs = process.argv.slice(3);
  await updateAllContextRooms(updateArgs);
  process.exit(0);
}

if (command !== "hub") {
  console.error(`Unknown command: ${command}\n`);
  console.error(usage());
  process.exit(1);
}
