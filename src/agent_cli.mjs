import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  appendAgentAnnotation,
  buildContextRoomDoctorReport,
  buildDocQaReport,
  CONFIG_FILE,
  isAllowedMemoryPath,
  listStartupHookFiles,
  listStartupSkillFolders,
  readMemoryFile,
  readMemoryWebappSettings,
  watchStateForPath,
  writeAgentCommand,
  writeMemoryWebappSettings,
} from "./context_room.mjs";
import {
  listContextHubProjects,
  readContextHubRuntime,
  recordContextHubProjectOpened,
  registerContextHubProject,
} from "./context_hub.mjs";
import {
  diffSharedMainRevisions,
  diffSharedProposalRevisions,
  diffSharedSkillLocationsRevisions,
  importSharedSkills,
  importSharedInstructions,
  linkSharedSkillLocation,
  listSharedProposalWorkspaces,
  listSharedProposals,
  listSharedRepositoryProposals,
  publishSharedProposal,
  proposeSharedSkillAssignment,
  proposeSharedSkillUnassignment,
  proposeSharedInstructionAssignment,
  proposeSharedInstructionUnassignment,
  readSharedMainRevision,
  readSharedProjectConnection,
  readSharedSkillLocalState,
  reconcileSharedSkillLocations,
  reconcileSharedInstructionLocations,
  setSharedSkillProviderPreferences,
  setSharedSkillLocationOverride,
  setSharedSkillProviderOverride,
  sharedSkillEffectiveProjection,
  sharedContextStatus,
  sharedSkillProviderPreferences,
  sharedSkillLocationsStatus,
  sharedInstructionLocationsStatus,
  syncSharedContext,
  unlinkSharedSkillLocation,
  previewSharedSkillAssignment,
  previewSharedSkillImport,
  previewSharedSkillLocation,
  previewSharedSkillUnassignment,
  previewSharedInstructionAssignment,
  previewSharedInstructionImport,
  previewSharedInstructionUnassignment,
} from "./shared_context.mjs";
import { searchDocumentation } from "./doc_agent.mjs";
import {
  ContextRoomCliError,
  stableCliOperationId,
  stableCliPlanId,
} from "./cli_contract.mjs";
import { appendContextRoomEvent } from "./event_journal.mjs";
import { buildContextInventory } from "./context_inventory.mjs";
import {
  buildContextGraph,
  impactContext,
  resolveEffectiveContext,
  traceContext,
} from "./context_engine.mjs";
import {
  createContextSnapshot,
  diffStoredContextSnapshots,
} from "./context_snapshots.mjs";
import {
  buildProposalContextImpact,
  explainDoctorIssue,
  filterDoctorIssues,
  normalizeDoctorIssues,
  planDoctorRepair,
} from "./context_diagnostics.mjs";
import {
  applyContextSettingsPlan,
  explainContextSetting,
  getContextSettings,
  planContextSettingsChange,
} from "./context_settings.mjs";

const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".html", ".htm", ".txt", ".csv", ".tsv", ".yaml", ".yml", ".json", ".jsonc", ".toml"]);
const PROVIDERS = new Set(["auto", "codex", "claude-code", "opencode", "all"]);

function stablePath(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function isWithin(parent, candidate) {
  const base = stablePath(parent);
  const target = stablePath(candidate);
  return target === base || target.startsWith(base + path.sep);
}

function displayPath(value) {
  const resolved = path.resolve(value);
  const home = path.resolve(process.env.HOME || os.homedir());
  if (resolved === home) return "~";
  if (resolved.startsWith(home + path.sep)) return `~/${path.relative(home, resolved).replaceAll(path.sep, "/")}`;
  return resolved;
}

function hashId(prefix, value) {
  return `${prefix}-` + createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function gitText(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function projectConfigRoot(start) {
  let current = stablePath(start);
  try { if (!fs.statSync(current).isDirectory()) current = path.dirname(current); } catch {}
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function projectCandidates(projects, selector) {
  const needle = String(selector || "").trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((project) => [
    project.id,
    project.logicalProjectId,
    project.title,
    project.shared?.projectId,
  ].filter(Boolean).some((value) => String(value).toLowerCase() === needle));
}

function publicTarget(target) {
  return {
    project: target.project,
    location: target.location,
    folder: target.folder,
    shared: target.shared,
    registered: target.registered,
    localEnvironment: target.localEnvironment,
  };
}

function cliCacheHome() {
  if (process.env.CONTEXT_ROOM_HUB_HOME) return path.join(path.resolve(process.env.CONTEXT_ROOM_HUB_HOME), "cli-cache");
  return path.join(process.env.HOME || os.homedir(), ".context-room", "hub", "cli-cache");
}

function statFingerprint(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function agentPrepareFingerprint(target, options) {
  const status = gitText(target.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changedContent = gitText(target.root, ["diff", "--binary", "HEAD", "--"]);
  const stateFiles = [
    path.join(target.root, CONFIG_FILE),
    path.join(target.root, ".context-room", "review-state.json"),
    path.join(target.root, ".context-room", "review-ledger.json"),
    ...folderChain(target.root, target.folderAbsolute).flatMap((directory) => ["AGENTS.md", "CLAUDE.md", "OPENCODE.md"].map((name) => path.join(directory, name))),
  ];
  const untrackedStats = status.split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => statFingerprint(path.join(target.root, line.slice(3))));
  return createHash("sha256").update(JSON.stringify({
    target: publicTarget(target),
    options: { task: options.task, sessionId: options.sessionId, provider: options.provider, budget: options.budget },
    head: gitText(target.root, ["rev-parse", "HEAD"]),
    status,
    changedContent,
    files: [...stateFiles.map(statFingerprint), ...untrackedStats],
  })).digest("hex");
}

function readCliCache(cachePath, fingerprint) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cached.fingerprint !== fingerprint || !cached.result) return null;
    return { ...cached.result, freshness: { ...(cached.result.freshness || {}), cache: "warm", cachedAt: cached.createdAt } };
  } catch {
    return null;
  }
}

function writeCliCache(cachePath, fingerprint, result) {
  const directory = path.dirname(cachePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint, createdAt: new Date().toISOString(), result }), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, cachePath);
  try { fs.chmodSync(cachePath, 0o600); } catch {}
  const stale = fs.readdirSync(directory)
    .filter((name) => name.startsWith("prepare-") && name.endsWith(".json"))
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(100);
  for (const entry of stale) {
    try { fs.unlinkSync(path.join(directory, entry.name)); } catch {}
  }
}

export function resolveCliTarget({ cwd = process.cwd(), project = "", location = "", folder = "", requireLocal = true } = {}) {
  const requested = stablePath(cwd);
  const projects = listContextHubProjects({ refreshGit: false });
  let candidates = projects;
  if (location) {
    const locationPath = path.isAbsolute(String(location)) || String(location).startsWith(".") ? stablePath(location) : "";
    candidates = projects.filter((item) => item.id === location || (locationPath && stablePath(item.root) === locationPath));
    if (!candidates.length) throw new ContextRoomCliError("unknown-location", `Unknown registered Context Room location: ${location}`, {
      details: { location },
      retryable: true,
      nextActions: [{ id: "list-locations", command: "context-room project list --format json", mutates: false, requiresHuman: false }],
    });
  }
  if (project) {
    const matches = projectCandidates(projects, project);
    if (!matches.length) throw new ContextRoomCliError("unknown-project", `Unknown registered Context Room project: ${project}`, {
      details: { project },
      retryable: true,
      nextActions: [{ id: "search-projects", command: `context-room project search --query ${JSON.stringify(String(project))} --format json`, mutates: false, requiresHuman: false }],
    });
    const ids = new Set(matches.map((item) => item.id));
    candidates = candidates.filter((item) => ids.has(item.id));
  }
  const containing = candidates.filter((item) => item.available && isWithin(item.root, requested))
    .sort((left, right) => right.root.length - left.root.length);
  let selected = containing[0] || null;
  if (!selected && candidates.length === 1) selected = candidates[0];
  if (!selected && (project || location) && candidates.length > 1) {
    const candidateDetails = candidates.map((item) => ({ id: item.id, title: item.title, root: item.root, branch: item.worktree?.branch || "" }));
    throw new ContextRoomCliError("ambiguous-target", "Several registered worktree locations match this target; pass --location <id|path>.", {
      details: { candidates: candidateDetails },
      retryable: true,
      nextActions: candidateDetails.map((item) => ({
        id: `select-${item.id}`,
        command: `context-room project current --location ${JSON.stringify(item.id)} --format json`,
        mutates: false,
        requiresHuman: false,
      })),
    });
  }

  let root = selected?.root || projectConfigRoot(requested);
  if (!root && requireLocal) {
    throw new ContextRoomCliError("local-environment-unavailable", "No local Context Room project contains the current folder.", {
      details: { cwd: requested },
      nextActions: [{ id: "project-register", label: "Register this location", command: `context-room project register --root ${JSON.stringify(requested)}`, mutates: true, requiresHuman: false }],
    });
  }
  root = root ? stablePath(root) : "";
  const selectedFolder = folder
    ? stablePath(path.isAbsolute(String(folder)) ? String(folder) : path.join(root || requested, String(folder)))
    : (root && (project || location) ? root : requested);
  if (root && !isWithin(root, selectedFolder)) {
    throw new ContextRoomCliError("folder-outside-location", "The selected folder is outside the selected project location.", {
      details: { root, folder: selectedFolder },
    });
  }
  const config = root && fs.existsSync(path.join(root, CONFIG_FILE)) ? readMemoryWebappSettings(root) : null;
  const connection = root ? readSharedProjectConnection(root) : null;
  const locationId = selected?.id || (root ? hashId("location", root) : "");
  const logicalProjectId = selected?.logicalProjectId || (root ? hashId("project", gitText(root, ["rev-parse", "--git-common-dir"]) || root) : String(project || ""));
  const branch = selected?.worktree?.branch || (root ? gitText(root, ["branch", "--show-current"]) : "");
  return {
    root,
    folderAbsolute: selectedFolder,
    project: {
      id: logicalProjectId,
      title: selected?.title || config?.title || (root ? path.basename(root) : String(project || "Shared project")),
      sharedProjectId: selected?.shared?.projectId || connection?.projectId || "",
    },
    location: root ? {
      id: locationId,
      root,
      branch,
      head: selected?.worktree?.head || gitText(root, ["rev-parse", "--short=12", "HEAD"]),
      main: Boolean(selected?.worktree?.main),
    } : null,
    folder: root ? {
      absolutePath: selectedFolder,
      path: path.relative(root, selectedFolder).replaceAll(path.sep, "/") || ".",
    } : null,
    shared: connection ? { repository: connection.repository, projectId: connection.projectId } : selected?.shared || null,
    registered: Boolean(selected),
    localEnvironment: root ? "available" : "unavailable",
  };
}

export function listCliProjects({ query = "", recent = false } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const locations = listContextHubProjects({ refreshGit: false })
    .filter((item) => !needle || [item.title, item.id, item.logicalProjectId, item.root, item.shared?.projectId].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)))
    .sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)));
  const selected = recent ? locations.slice(0, 10) : locations;
  const groups = new Map();
  for (const location of selected) {
    const key = location.logicalProjectId || location.id;
    if (!groups.has(key)) groups.set(key, { id: key, title: location.title, shared: location.shared || null, locations: [] });
    groups.get(key).locations.push({
      id: location.id,
      root: location.root,
      available: location.available,
      branch: location.worktree?.branch || "",
      head: location.worktree?.head || "",
      main: Boolean(location.worktree?.main),
      lastOpenedAt: location.lastOpenedAt,
    });
  }
  return { projects: [...groups.values()], locations: selected.length };
}

export function registerCliProject({ root = process.cwd(), title = "" } = {}) {
  const projectRoot = projectConfigRoot(root) || stablePath(root);
  const connection = readSharedProjectConnection(projectRoot);
  const registered = registerContextHubProject(projectRoot, {
    title,
    shared: connection ? { repository: connection.repository, projectId: connection.projectId } : null,
  });
  appendContextRoomEvent("project.location-registered", {
    projectId: registered.logicalProjectId,
    locationId: registered.id,
    sharedRepository: registered.shared?.repository || "",
    resource: { root: registered.root, branch: registered.worktree?.branch || "" },
  });
  return registered;
}

export function openCliProject(target) {
  const runtime = readContextHubRuntime();
  if (!runtime) throw new ContextRoomCliError("hub-not-running", "Context Room Hub is not running; run context-room hub first.", { retryable: true });
  if (target.location?.id) recordContextHubProjectOpened(target.location.id);
  return { url: `${runtime.url}/?hub=1&project=${encodeURIComponent(target.location?.id || "")}` };
}

function normalizedProvider(value = "auto") {
  const provider = String(value || "auto").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new ContextRoomCliError("invalid-provider", `Unknown provider: ${provider}`, { details: { expected: [...PROVIDERS] }, exitCode: 2 });
  if (provider !== "auto") return provider;
  if (process.env.CODEX_HOME || process.env.CODEX_THREAD_ID) return "codex";
  if (process.env.CLAUDE_CODE || process.env.CLAUDECODE) return "claude-code";
  if (process.env.OPENCODE) return "opencode";
  return "all";
}

function folderChain(root, folder) {
  const chain = [];
  let current = stablePath(folder);
  while (isWithin(root, current)) {
    chain.push(current);
    if (current === stablePath(root)) break;
    current = path.dirname(current);
  }
  return chain.reverse();
}

function instructionProvider(fileName) {
  const lower = String(fileName).toLowerCase();
  if (lower === "claude.md") return "claude-code";
  if (lower.includes("opencode")) return "opencode";
  return "all";
}

function resourceStatusForProvider(resourceProvider, provider, enabled = true) {
  if (!enabled) return "disabled";
  if (provider === "all" || resourceProvider === "all" || !resourceProvider || resourceProvider === provider) return "active";
  return "inactive";
}

function reviewIndex(report) {
  return new Map((report?.queue || []).map((item) => [String(item.path), item]));
}

function buildLegacyAgentEnvironment(target, { provider = "auto", report = null } = {}) {
  if (!target.root) return { selectedProvider: normalizedProvider(provider), localEnvironment: "unavailable", instructions: [], skills: [], hooks: [], summary: { instructions: 0, skills: 0, hooks: 0 } };
  const selectedProvider = normalizedProvider(provider);
  const settings = readMemoryWebappSettings(target.root);
  const queue = reviewIndex(report);
  const instructions = [];
  const startupContext = settings.startupContext || {};
  const configuredNames = [...new Set((startupContext.fileNames || ["AGENTS.md", "CLAUDE.md"]).map(String).filter(Boolean))];
  for (const directory of folderChain(target.root, target.folderAbsolute)) {
    for (const fileName of configuredNames) {
      const absolutePath = path.join(directory, fileName);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
      const relativePath = path.relative(target.root, absolutePath).replaceAll(path.sep, "/");
      const providerId = instructionProvider(fileName);
      const review = queue.get(relativePath) || queue.get(displayPath(absolutePath)) || null;
      instructions.push({
        id: hashId("instruction", absolutePath),
        label: fileName,
        path: relativePath,
        absolutePath,
        provider: providerId,
        scope: directory === target.root ? "project" : "folder",
        source: "ancestor",
        precedence: instructions.length + 1,
        status: resourceStatusForProvider(providerId, selectedProvider, startupContext.enabled !== false),
        reason: directory === target.root ? "Project instruction file applies to every folder in this location." : "Instruction file is in the selected folder's ancestor chain.",
        review: review ? { required: true, reason: review.reviewReason, status: review.review?.status || "unverified" } : { required: false, status: "verified-or-unwatched" },
      });
    }
  }
  if (startupContext.projectOnly !== true) {
    for (const configuredPath of startupContext.globalPaths || []) {
      const absolutePath = configuredPath === "~" ? os.homedir() : String(configuredPath).startsWith("~/") ? path.join(os.homedir(), String(configuredPath).slice(2)) : path.resolve(configuredPath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
      const providerId = instructionProvider(path.basename(absolutePath));
      instructions.unshift({
        id: hashId("instruction", absolutePath),
        label: path.basename(absolutePath),
        path: displayPath(absolutePath),
        absolutePath,
        provider: providerId,
        scope: "device",
        source: "global",
        precedence: 0,
        status: resourceStatusForProvider(providerId, selectedProvider, startupContext.enabled !== false),
        reason: "Configured global instruction path applies before project and folder instructions.",
        review: queue.has(displayPath(absolutePath)) ? { required: true, status: "unverified" } : { required: false, status: "verified-or-unwatched" },
      });
    }
  }

  const skills = [];
  const startupSkills = settings.startupSkills || {};
  for (const folder of listStartupSkillFolders(target.root, settings)) {
    for (const skillName of folder.skills || []) {
      skills.push({
        id: hashId("skill", `${folder.absolutePath}\0${skillName}`),
        label: skillName,
        path: displayPath(path.join(folder.absolutePath, skillName)),
        provider: "all",
        scope: isWithin(target.root, folder.absolutePath) ? "project" : "device",
        source: folder.readOnly ? "managed-or-namespaced" : "local",
        status: resourceStatusForProvider("all", selectedProvider, startupSkills.enabled !== false),
        reason: `Discovered in configured startup skill folder ${folder.displayPath}.`,
        readOnly: Boolean(folder.readOnly),
      });
    }
  }
  let sharedSkills = null;
  try { sharedSkills = sharedSkillLocationsStatus(target.root, { refresh: false }); } catch {}
  if (sharedSkills?.connected) {
    for (const destination of sharedSkills.destinations || []) {
      if (selectedProvider !== "all" && destination.provider !== selectedProvider && destination.provider !== "custom") continue;
      for (const skillName of destination.skills || []) {
        skills.push({
          id: hashId("shared-skill", `${destination.id}\0${skillName}`),
          label: skillName,
          path: destination.destination,
          provider: destination.provider,
          scope: destination.scope,
          source: "shared-managed",
          shared: { repository: sharedSkills.repository, collectionId: destination.collectionId, revision: sharedSkills.revision },
          status: destination.status === "ready" ? "active" : destination.status,
          reason: `Accepted shared assignment ${destination.assignmentId || destination.id} exposes this skill through a managed destination.`,
          readOnly: true,
        });
      }
    }
  }

  const hooks = listStartupHookFiles(target.root, settings).map((item) => {
    const hook = item.startupHook || {};
    const providerId = hook.provider || "all";
    const relativePath = hook.absolutePath && isWithin(target.root, hook.absolutePath) ? path.relative(target.root, hook.absolutePath).replaceAll(path.sep, "/") : hook.displayPath;
    return {
      id: hashId("hook", hook.absolutePath || relativePath),
      label: hook.label || item.label,
      path: relativePath,
      absolutePath: hook.absolutePath || "",
      provider: providerId,
      scope: hook.absolutePath && isWithin(target.root, hook.absolutePath) ? "project" : "device",
      source: hook.source || "hook",
      sourceLabel: hook.sourceLabel || "Hook",
      status: resourceStatusForProvider(providerId, selectedProvider, settings.startupHooks?.enabled !== false),
      reason: item.impact || `${hook.sourceLabel || "Hook"} can affect agent or Git execution.`,
      executable: hook.executable !== false,
      readOnly: settings.startupHooks?.editable !== true,
      review: queue.has(relativePath) ? { required: true, status: "unverified" } : { required: false, status: "verified-or-unwatched" },
    };
  });
  return {
    selectedProvider,
    selectedFolder: target.folder,
    localEnvironment: "available",
    instructions,
    skills,
    hooks,
    summary: {
      instructions: instructions.filter((item) => item.status === "active").length,
      skills: skills.filter((item) => item.status === "active").length,
      hooks: hooks.filter((item) => item.status === "active").length,
      inactive: [...instructions, ...skills, ...hooks].filter((item) => item.status !== "active").length,
    },
  };
}

function cliErrorFrom(error, fallbackCode = "context-operation-failed") {
  if (error instanceof ContextRoomCliError) return error;
  return new ContextRoomCliError(error?.code || fallbackCode, error?.message || String(error), {
    details: error?.details || null,
    retryable: Boolean(error?.retryable),
  });
}

function contextTarget(target, folder = "") {
  return {
    ...target,
    folderAbsolute: folder
      ? stablePath(path.isAbsolute(folder) ? folder : path.join(target.root || process.cwd(), folder))
      : target.folderAbsolute,
    folder: folder
      ? {
          absolutePath: stablePath(path.isAbsolute(folder) ? folder : path.join(target.root || process.cwd(), folder)),
          path: path.isAbsolute(folder) && target.root
            ? path.relative(target.root, folder).replaceAll(path.sep, "/") || "."
            : String(folder).replaceAll(path.sep, "/").replace(/^\.\//, "") || ".",
        }
      : target.folder,
  };
}

function contextBuildOptions(target, options = {}) {
  const provider = normalizedProvider(options.provider || "auto");
  const selectedTarget = contextTarget(target, options.folder || "");
  return {
    target: selectedTarget,
    provider,
    inventory: {
      provider,
      folder: selectedTarget.folder?.path || ".",
      allowStale: Boolean(options.allowStale),
      refreshShared: options.refreshShared !== false,
      ...(options.readers ? { readers: options.readers } : {}),
    },
  };
}

/** Build the structural graph used by the CLI and UI adapters. */
export function buildCliContextGraph(target, options = {}) {
  try {
    const prepared = contextBuildOptions(target, options);
    return buildContextGraph(buildContextInventory(prepared.target, prepared.inventory));
  } catch (error) {
    throw cliErrorFrom(error, "context-graph-failed");
  }
}

/** Resolve only context that is valid for the exact coordinate. */
export function buildCliContextEffective(target, options = {}) {
  try {
    return resolveEffectiveContext(buildCliContextGraph(target, options));
  } catch (error) {
    throw cliErrorFrom(error, "context-effective-failed");
  }
}

export function traceCliContext(target, selector, options = {}) {
  try {
    const result = traceContext(buildCliContextGraph(target, options), selector, options);
    if (result.status === "not-found") throw new ContextRoomCliError("context-resource-not-found", `Context resource not found: ${selector}`);
    if (result.status === "ambiguous") throw new ContextRoomCliError("ambiguous-selector", `Several context resources match ${selector}.`, { details: { candidates: result.candidates } });
    return result;
  } catch (error) {
    throw cliErrorFrom(error, "context-trace-failed");
  }
}

export function impactCliContext(target, selector, options = {}) {
  try {
    const graph = buildCliContextGraph(target, options);
    if (!String(selector || "").trim()) {
      const bounds = pageBounds(options.cursor, options.limit);
      const provider = options.provider && options.provider !== "auto" ? normalizedProvider(options.provider) : "";
      const needle = String(options.query || "").trim().toLowerCase();
      const matches = graph.resources.filter((resource) => {
        if (provider && provider !== "all" && !resource.providers.includes("all") && !resource.providers.includes(provider)) return false;
        if (needle && ![resource.id, resource.locator, resource.metadata?.name, resource.kind].some((value) => String(value || "").toLowerCase().includes(needle))) return false;
        return true;
      });
      const page = matches.slice(bounds.offset, bounds.offset + bounds.limit).map((resource) => impactContext(graph, resource.id, { provider }));
      const nextOffset = bounds.offset + page.length;
      return {
        schemaVersion: "context-room.context-impact-list/1",
        provider: provider || "all",
        impacts: page,
        pagination: { cursor: String(bounds.offset), limit: bounds.limit, nextCursor: nextOffset < matches.length ? String(nextOffset) : null, total: matches.length },
      };
    }
    const result = impactContext(graph, selector, {
      ...options,
      provider: options.provider && options.provider !== "auto" ? normalizedProvider(options.provider) : "",
    });
    if (result.status === "not-found") throw new ContextRoomCliError("context-resource-not-found", `Context resource not found: ${selector}`);
    if (result.status === "ambiguous") throw new ContextRoomCliError("ambiguous-selector", `Several context resources match ${selector}.`, { details: { candidates: result.candidates } });
    return result;
  } catch (error) {
    throw cliErrorFrom(error, "context-impact-failed");
  }
}

function environmentItem(entry) {
  const resource = entry.resource;
  const application = entry.application;
  const metadata = resource.metadata || {};
  return {
    id: resource.id,
    label: metadata.name || path.basename(String(resource.locator || resource.id)),
    path: metadata.relativePath || resource.locator,
    absolutePath: metadata.absolutePath || "",
    provider: resource.providers?.length === 1 ? resource.providers[0] : "all",
    providers: resource.providers || ["all"],
    scope: application.scope,
    source: resource.source,
    precedence: application.order,
    status: application.status,
    reason: application.reason,
    review: resource.review || { required: false, status: "verified-or-unwatched" },
    destination: application.destination || "",
    truthState: resource.truthState,
    readOnly: resource.source === "shared-main" || Boolean(metadata.readOnly),
    metadata,
  };
}

/** Legacy agent-environment projection backed by the same Context Core. */
export function buildAgentEnvironment(target, options = {}) {
  if (!target.root) return buildLegacyAgentEnvironment(target, options);
  const selectedProvider = normalizedProvider(options.provider || "auto");
  try {
    const effective = buildCliContextEffective(target, { ...options, provider: selectedProvider });
    const entries = [
      ...effective.instructions,
      ...effective.skills,
      ...effective.hooks,
      ...effective.providerConfigs,
      ...effective.inactive,
    ];
    const settings = readMemoryWebappSettings(target.root);
    const projectOnlyForKind = {
      instruction: settings.startupContext?.projectOnly === true,
      skill: settings.startupSkills?.projectOnly === true,
      hook: settings.startupHooks?.projectOnly === true,
    };
    const byKind = (kind) => entries
      .filter((entry) => entry.resource.kind === kind)
      .filter((entry) => !(projectOnlyForKind[kind] && entry.application.scope === "device"))
      .sort((left, right) => left.application.order - right.application.order)
      .map(environmentItem);
    const instructions = byKind("instruction");
    const skills = byKind("skill");
    const hooks = byKind("hook");
    const providerConfigs = byKind("provider-config");
    return {
      schemaVersion: "context-room.agent-environment/2",
      selectedProvider,
      selectedFolder: target.folder,
      localEnvironment: effective.localEnvironment,
      freshness: effective.freshness,
      instructions,
      skills,
      hooks,
      providerConfigs,
      documents: effective.documents.map(environmentItem),
      proposals: effective.proposals,
      healthIssues: effective.healthIssues,
      summary: {
        instructions: instructions.filter((item) => item.status === "active").length,
        skills: skills.filter((item) => item.status === "active").length,
        hooks: hooks.filter((item) => item.status === "active").length,
        providerConfigs: providerConfigs.filter((item) => item.status === "active").length,
        inactive: entries.filter((entry) => entry.application.status !== "active").length,
      },
    };
  } catch (error) {
    throw cliErrorFrom(error, "agent-environment-failed");
  }
}

function snapshotInput(effective, target) {
  const graph = effective.graph;
  const sharedRevisions = graph.freshness?.repository && graph.freshness?.revision ? [{
    id: graph.freshness.repository,
    repository: graph.freshness.repository,
    defaultBranch: graph.freshness.defaultBranch || "main",
    projectId: target.shared?.projectId || target.project?.sharedProjectId || "",
    revision: graph.freshness.revision,
  }] : [];
  return {
    coordinate: effective.coordinate,
    resolverVersion: effective.resolverVersion,
    providerProfileVersion: effective.providerProfileVersion,
    resources: graph.resources,
    applications: graph.applications,
    sharedRevisions,
    watermarks: {
      gitHead: target.location?.head || (target.root ? gitText(target.root, ["rev-parse", "HEAD"]) : ""),
      configRevision: target.root ? statFingerprint(path.join(target.root, CONFIG_FILE)) : "",
      review: target.root ? statFingerprint(path.join(target.root, ".context-room", "review-state.json")) : "",
    },
  };
}

export async function createCliContextSnapshot(target, options = {}) {
  try {
    const effective = buildCliContextEffective(target, { ...options, allowStale: false, refreshShared: true });
    const created = await createContextSnapshot(snapshotInput(effective, target), {
      storageRoot: options.storageRoot,
      verifySharedRevision(shared) {
        const verified = readSharedMainRevision(shared.repository, { refresh: true });
        return { revision: verified.revision, verified: verified.revision === shared.revision, online: true };
      },
    });
    return { ...created, freshness: effective.freshness };
  } catch (error) {
    throw cliErrorFrom(error, "context-snapshot-failed");
  }
}

export async function diffCliContextSnapshots({ from, to = "", target = null, ...options } = {}) {
  try {
    let targetSnapshotId = to;
    let created = null;
    if (!targetSnapshotId) {
      if (!target) throw new ContextRoomCliError("snapshot-target-required", "Pass --to <snapshot-id> or a resolved target for the current accepted context.");
      created = await createCliContextSnapshot(target, options);
      targetSnapshotId = created.manifest.snapshotId;
    }
    const diff = await diffStoredContextSnapshots(from, targetSnapshotId, {
      storageRoot: options.storageRoot,
      diffSharedRevisions: (repository, input) => diffSharedMainRevisions(repository, { ...input, refresh: false }),
    });
    return { ...diff, ...(created ? { createdSnapshot: created.manifest.snapshotId } : {}) };
  } catch (error) {
    throw cliErrorFrom(error, "context-diff-failed");
  }
}

function sharedCliHome() {
  return process.env.CONTEXT_ROOM_SHARED_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_SHARED_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "shared");
}

function readJsonFile(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function changedPathsBetweenRevisions(root, fromRevision, toRevision) {
  const raw = gitText(root, ["diff", "--name-status", "-z", "-M", `${fromRevision}..${toRevision}`, "--"]);
  if (!raw) return new Set();
  const records = raw.split("\0").filter(Boolean);
  const changed = new Set();
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = records[index++];
      const nextPath = records[index++];
      if (oldPath) changed.add(oldPath.replaceAll("\\", "/"));
      if (nextPath) changed.add(nextPath.replaceAll("\\", "/"));
    } else {
      const filePath = records[index++];
      if (filePath) changed.add(filePath.replaceAll("\\", "/"));
    }
  }
  return changed;
}

function exactSharedReviewInvalidations({ repository, proposal, headRevision }) {
  const authorityRoot = path.join(sharedCliHome(), "review-authority");
  if (!fs.existsSync(authorityRoot)) return [];
  const invalidated = [];
  for (const name of fs.readdirSync(authorityRoot)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
    const authority = readJsonFile(path.join(authorityRoot, name));
    if (!authority
      || authority.accepted
      || authority.repository !== repository
      || authority.proposal !== proposal.branch
      || authority.proposalHead === headRevision
      || !authority.reviewRoot
      || !fs.existsSync(authority.reviewRoot)) continue;
    const changedSinceReview = changedPathsBetweenRevisions(authority.reviewRoot, authority.proposalHead, headRevision);
    if (!changedSinceReview.size) continue;
    const reviewState = readJsonFile(path.join(authority.reviewRoot, ".context-room", "review-state.json"), { reviews: {} });
    for (const filePath of authority.proposalFiles || []) {
      const normalized = String(filePath || "").replaceAll("\\", "/");
      if (!normalized || !changedSinceReview.has(normalized)) continue;
      const state = reviewState?.reviews?.[normalized] || null;
      invalidated.push({
        reviewId: String(authority.authorityId || path.basename(name, ".json")),
        path: normalized,
        reviewedRevision: authority.proposalHead,
        expectedRevision: headRevision,
        status: state?.status || "pending",
        ...(state?.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
        reason: "This existing file review targets an earlier proposal revision whose resource changed.",
      });
    }
  }
  return invalidated.sort((left, right) => `${left.path}:${left.reviewId}`.localeCompare(`${right.path}:${right.reviewId}`, "en"));
}

export async function proposalContextImpact({ selector, repository = "", target = null, adapters = {} } = {}) {
  try {
    const repositoryId = repository || target?.shared?.repository || "";
    let selectedProposal = null;
    let exactProposalDiff = null;
    const state = repositoryId ? listSharedRepositoryProposals(repositoryId, { allowOffline: false, refresh: true }) : null;
    if (state) selectedProposal = state.proposals.find((item) => item.branch === selector || item.head === selector || item.title === selector) || null;
    const realAdapters = {
      readProposal: async ({ selector: wanted, repository: wantedRepository }) => {
        if (selectedProposal && wantedRepository === repositoryId) return selectedProposal;
        const current = listSharedRepositoryProposals(wantedRepository, { allowOffline: false, refresh: true });
        return current.proposals.find((item) => item.branch === wanted || item.head === wanted || item.title === wanted) || null;
      },
      readAcceptedRevision: async ({ repository: wantedRepository }) => readSharedMainRevision(wantedRepository, { refresh: true }),
      findMergeBase: async ({ repository: wantedRepository, fromRevision, toRevision }) => {
        exactProposalDiff ||= diffSharedProposalRevisions(wantedRepository, { fromRevision, toRevision, refresh: true });
        return exactProposalDiff.mergeBase;
      },
      diffRevisions: async ({ repository: wantedRepository, fromRevision, toRevision }) => {
        exactProposalDiff ||= diffSharedProposalRevisions(wantedRepository, { fromRevision, toRevision, refresh: true });
        const statuses = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "unmerged" };
        return exactProposalDiff.changes.map((change) => ({
          path: change.path,
          ...(change.fromPath ? { oldPath: change.fromPath } : {}),
          status: statuses[change.status] || String(change.status || "modified").toLowerCase(),
          rawStatus: change.status,
          ...(change.score === null || change.score === undefined ? {} : { score: change.score }),
        }));
      },
      listRegisteredConsumers: async () => listContextHubProjects({ refreshGit: false })
        .filter((item) => item.available !== false && item.shared?.repository === repositoryId)
        .filter((item) => !selectedProposal?.projectId || ["global", "skills", selectedProposal.projectId].includes(selectedProposal.projectId) || item.shared?.projectId === selectedProposal.projectId)
        .map((item) => ({ projectId: item.logicalProjectId || item.id, locationId: item.id, sharedProjectId: item.shared?.projectId || "", folder: ".", provider: "all" })),
      detectGitConflicts: async ({ repository: wantedRepository, baseRevision, headRevision }) => {
        exactProposalDiff ||= diffSharedProposalRevisions(wantedRepository, { fromRevision: baseRevision, toRevision: headRevision, refresh: true });
        return exactProposalDiff.hasConflict ? [{ kind: "merge", paths: exactProposalDiff.files }] : [];
      },
      analyzeSharedSkills: async ({ repository: wantedRepository, baseRevision, headRevision, changedFiles }) => {
        if (!changedFiles?.length) return { collections: [], assignments: [], providers: [], destinations: [], collisions: [] };
        const delta = diffSharedSkillLocationsRevisions(wantedRepository, {
          fromRevision: baseRevision,
          toRevision: headRevision,
          refresh: true,
        });
        return {
          collections: delta.collectionChanges,
          assignments: delta.assignmentChanges,
          providers: delta.providersAffected,
          destinations: delta.logicalDestinations,
          collisions: [],
        };
      },
      listExactReviewInvalidations: async ({ headRevision }) => exactSharedReviewInvalidations({
        repository: repositoryId,
        proposal: selectedProposal,
        headRevision,
      }),
      ...adapters,
    };
    return await buildProposalContextImpact({ selector, repository: repositoryId, adapters: realAdapters });
  } catch (error) {
    throw cliErrorFrom(error, "proposal-context-impact-failed");
  }
}

function publicReviewReport(report) {
  return {
    generatedAt: report.generatedAt,
    summary: report.summary,
    queue: report.queue.map((item) => ({
      id: hashId("review", `${item.path}\0${item.resourceVersion || item.review?.contentHash || ""}`),
      path: item.path,
      oldPath: item.oldPath || null,
      label: item.label,
      gitStatus: item.gitStatus,
      reason: item.reviewReason || (item.reviewRequired ? "unverified-current" : "changed"),
      riskScore: item.riskScore,
      issues: item.issues,
      review: item.review || null,
      resourceState: item.resourceState || "present",
      startupContext: item.startupContext || null,
    })),
    humanOwned: true,
  };
}

function sharedFreshness(target, { fresh = false } = {}) {
  if (!target.shared || !target.root) return { status: "fresh", source: "local", checkedAt: new Date().toISOString() };
  let status;
  if (fresh) {
    const synced = syncSharedContext(target.root, { allowOffline: false });
    status = { ...sharedContextStatus(target.root), revision: synced.revision, online: true, syncedAt: new Date().toISOString() };
  } else {
    status = sharedContextStatus(target.root);
  }
  return {
    status: fresh ? "fresh" : status.online === false ? "offline" : "stale",
    source: fresh ? "shared-refresh" : "accepted-shared-snapshot",
    revision: status.revision || "",
    checkedAt: fresh ? new Date().toISOString() : status.syncedAt || null,
    online: status.online !== false,
    fetchError: status.fetchError || "",
  };
}

export function buildAgentPrepare(target, { task = "", sessionId = "", provider = "auto", fresh = false, budget = 1200 } = {}) {
  if (!target.root) throw new ContextRoomCliError("local-environment-unavailable", "Agent prepare requires a registered local project location.");
  const freshness = sharedFreshness(target, { fresh });
  const report = buildDocQaReport(target.root);
  const doctor = buildContextRoomDoctorReport(target.root, { docqa: report });
  const environment = buildAgentEnvironment(target, { provider, report });
  let documentation = { query: String(task || ""), results: [], revision: null };
  if (String(task || "").trim()) {
    documentation = searchDocumentation(target.root, task, { limit: 8, budget, sessionId });
  }
  let proposals = [];
  try {
    proposals = listSharedProposals(target.root, { allProjects: true, refresh: false })
      .filter((proposal) => !sessionId || proposal.sessionId === sessionId)
      .map((proposal) => ({ branch: proposal.branch, title: proposal.title, description: proposal.description, scope: proposal.scope, projectId: proposal.projectId, head: proposal.head, reviewStatus: proposal.reviewStatus, hasConflict: proposal.hasConflict }));
  } catch {}
  const review = publicReviewReport(report);
  const nextActions = [
    review.queue.length ? { id: "open-review", label: "Open the review queue", command: `context-room review list --location ${JSON.stringify(target.location.id)} --format json`, mutates: false, requiresHuman: false } : null,
    freshness.status === "stale" ? { id: "refresh-shared", label: "Refresh the accepted shared snapshot", command: `context-room agent prepare --location ${JSON.stringify(target.location.id)} --fresh --task ${JSON.stringify(task || "current task")} --format json`, mutates: false, requiresHuman: false } : null,
    { id: "classify-changes", label: "Classify documentation changes", command: `context-room agent changes --location ${JSON.stringify(target.location.id)} --format json`, mutates: false, requiresHuman: false },
  ].filter(Boolean);
  return {
    target: publicTarget(target),
    freshness,
    data: {
      task: String(task || ""),
      sessionId: String(sessionId || ""),
      environment,
      documentation: {
        query: documentation.query,
        revision: documentation.revision,
        accepted: (documentation.results || []).filter((item) => item.source !== "session-proposal"),
        pendingSession: proposals.map((proposal) => ({ source: "session-proposal", ...proposal })),
      },
      review: { summary: review.summary, items: review.queue.slice(0, 20), humanOwned: true },
      proposals,
      health: { issues: doctor.issues.length, critical: doctor.issues.filter((item) => item.severity === "critical").length, high: doctor.issues.filter((item) => item.severity === "high").length, items: doctor.issues.slice(0, 20) },
    },
    warnings: [freshness.status === "stale" ? "Shared evidence comes from the last accepted local snapshot. Use --fresh before a mutation or high-stakes decision." : ""].filter(Boolean),
    nextActions,
  };
}

export function buildAgentPrepareCached(target, options = {}) {
  if (options.fresh) return buildAgentPrepare(target, options);
  const fingerprint = agentPrepareFingerprint(target, options);
  const cachePath = path.join(cliCacheHome(), `prepare-${fingerprint.slice(0, 24)}.json`);
  const cached = readCliCache(cachePath, fingerprint);
  if (cached) return cached;
  const result = buildAgentPrepare(target, options);
  writeCliCache(cachePath, fingerprint, result);
  return { ...result, freshness: { ...(result.freshness || {}), cache: "cold" } };
}

export function buildSharedOnlyAgentPrepare({ repository, projectId, task = "", sessionId = "", provider = "auto", fresh = false, budget = 1200 } = {}) {
  const target = {
    project: { id: String(projectId), title: String(projectId), sharedProjectId: String(projectId) },
    location: null,
    folder: null,
    shared: { repository: String(repository), projectId: String(projectId) },
    registered: false,
    localEnvironment: "unavailable",
  };
  const common = { repository, projectId, sessionId, budget, allowOffline: !fresh };
  const accepted = searchDocumentation(process.cwd(), task, { ...common, limit: 8 });
  let pending = { results: [] };
  try { pending = searchDocumentation(process.cwd(), task, { ...common, status: "proposal", limit: 8 }); } catch {}
  return {
    target,
    freshness: {
      status: fresh ? "fresh" : "stale",
      source: "accepted-shared-snapshot",
      revision: accepted.revision || "",
      localEnvironment: "unavailable",
    },
    data: {
      task: String(task || ""),
      sessionId: String(sessionId || ""),
      environment: { selectedProvider: normalizedProvider(provider), localEnvironment: "unavailable", instructions: [], skills: [], hooks: [], summary: { instructions: 0, skills: 0, hooks: 0, inactive: 0 } },
      documentation: { query: String(task || ""), revision: accepted.revision, accepted: accepted.results || [], pendingSession: pending.results || [] },
      review: { summary: null, items: [], humanOwned: true, unavailable: "A local registered location is required to inspect file reviews." },
      proposals: [],
      health: { issues: 0, critical: 0, high: 0, items: [], unavailable: "A local registered location is required to calculate Context Health." },
    },
    warnings: ["This shared project has no selected local location. Accepted documents are available, but local instructions, skills, hooks, reviews, and health are unavailable."],
    nextActions: [{ id: "register-location", label: "Register a local project or worktree location", command: "context-room project register --root . --format json", mutates: true, requiresHuman: false }],
  };
}

export function explainAgentSelector(target, { selector = "", kind = "", provider = "auto" } = {}) {
  const needle = String(selector || "").trim();
  if (!needle) throw new ContextRoomCliError("missing-selector", "A context explanation requires a path, resource id, label, review id, or proposal branch.", { exitCode: 2 });
  const report = buildDocQaReport(target.root);
  const environment = buildAgentEnvironment(target, { provider, report });
  const resources = [
    ...environment.instructions.map((item) => ({ kind: "instruction", ...item })),
    ...environment.skills.map((item) => ({ kind: "skill", ...item })),
    ...environment.hooks.map((item) => ({ kind: "hook", ...item })),
  ].filter((item) => !kind || item.kind === kind);
  const resourceMatches = resources.filter((item) => [item.id, item.path, item.absolutePath, item.label].filter(Boolean).some((value) => String(value) === needle || String(value).toLowerCase().includes(needle.toLowerCase())));
  const review = publicReviewReport(report).queue.find((item) => item.id === needle || item.path === needle);
  let proposals = [];
  try { proposals = listSharedProposals(target.root, { refresh: false }).filter((item) => item.branch === needle); } catch {}
  const matches = [...resourceMatches, ...(review ? [{ kind: "review", ...review }] : []), ...proposals.map((item) => ({ kind: "proposal", ...item }))];
  if (matches.length > 1) throw new ContextRoomCliError("ambiguous-selector", `Several resources match ${needle}.`, { details: { candidates: matches.map((item) => ({ kind: item.kind, id: item.id || item.branch, path: item.path || "", label: item.label || item.title || "" })) } });
  if (matches.length === 1) return { selector: needle, match: matches[0] };
  const normalizedPath = needle.replaceAll("\\", "/").replace(/^\.\//, "");
  const settings = readMemoryWebappSettings(target.root);
  return {
    selector: needle,
    match: {
      kind: "path",
      path: normalizedPath,
      exists: fs.existsSync(path.resolve(target.root, normalizedPath)),
      allowed: isAllowedMemoryPath(normalizedPath, settings),
      watched: watchStateForPath(normalizedPath, settings) || null,
      review: publicReviewReport(report).queue.find((item) => item.path === normalizedPath) || null,
      reason: isAllowedMemoryPath(normalizedPath, settings)
        ? "The path is covered by this project's allowed paths. Its watch state determines whether each content hash requires human review."
        : "The path is outside this project's allowed paths and is not editable through Context Room.",
    },
  };
}

export function agentInstructions(target, { provider = "auto" } = {}) {
  const selectedProvider = normalizedProvider(provider);
  return {
    provider: selectedProvider,
    prompt: `Use context-room context ask "<question>" --root ${JSON.stringify(target.root)} for accepted project documentation. context-room capabilities only lists the static installed contract; it never interprets an objective or chooses a command. Only the human can accept or reject files awaiting review. Never write directly to shared main and never discover unregistered worktrees.`,
  };
}

function parseGitStatus(root) {
  let raw = "";
  try { raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return []; }
  const records = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    let filePath = record.slice(3).replaceAll("\\", "/");
    let oldPath = "";
    if (status.includes("R") || status.includes("C")) {
      oldPath = filePath;
      filePath = String(records[index + 1] || "").replaceAll("\\", "/");
      index += 1;
    }
    changes.push({ status, path: filePath, oldPath: oldPath || null });
  }
  return changes;
}

function documentationPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return DOCUMENT_EXTENSIONS.has(path.extname(lower)) || /(^|\/)(?:agents|claude)\.md$/.test(lower) || /(^|\/)skill\.md$/.test(lower);
}

export function classifyAgentChanges(target, { sessionId = "" } = {}) {
  const settings = readMemoryWebappSettings(target.root);
  const local = parseGitStatus(target.root).map((change) => {
    const watched = watchStateForPath(change.path, settings);
    const allowed = isAllowedMemoryPath(change.path, settings);
    const category = watched ? "local-review" : documentationPath(change.path) ? (allowed ? "unwatched-document" : "unmanaged-document") : "non-documentation";
    return { ...change, category, watched: watched || null, allowed };
  });
  const proposals = listSharedProposalWorkspaces(target.root, { sessionId }).map((proposal) => ({
    branch: proposal.branch,
    root: proposal.root,
    scope: proposal.scope,
    projectId: proposal.projectId,
    sessionId: proposal.sessionId,
    dirty: proposal.dirty,
    conflict: proposal.conflict,
    head: proposal.head,
    lastPublishedHead: proposal.lastPublishedHead || "",
    category: proposal.scope === "global" ? "shared-global-proposal" : proposal.scope === "skills" ? "shared-skills-proposal" : "shared-project-proposal",
  }));
  return {
    local,
    proposals,
    summary: {
      localReview: local.filter((item) => item.category === "local-review").length,
      unwatchedDocuments: local.filter((item) => item.category === "unwatched-document").length,
      unmanagedDocuments: local.filter((item) => item.category === "unmanaged-document").length,
      nonDocumentation: local.filter((item) => item.category === "non-documentation").length,
      proposals: proposals.length,
      proposalsToPublish: proposals.filter((item) => item.dirty || item.head !== item.lastPublishedHead).length,
    },
  };
}

function handoffRevision(target, changes) {
  return createHash("sha256").update(JSON.stringify({
    head: gitText(target.root, ["rev-parse", "HEAD"]),
    status: gitText(target.root, ["status", "--porcelain=v1"]),
    proposals: changes.proposals.map((item) => [item.branch, item.head, item.dirty, item.conflict, item.lastPublishedHead]),
    shared: sharedContextStatus(target.root).revision || "",
  })).digest("hex");
}

function operationsHome() {
  if (process.env.CONTEXT_ROOM_HUB_HOME) return path.join(path.resolve(process.env.CONTEXT_ROOM_HUB_HOME), "operations");
  return path.join(process.env.HOME || os.homedir(), ".context-room", "operations");
}

function operationReceiptPath(operationId) {
  return path.join(operationsHome(), `${operationId}.json`);
}

function writeOperationReceipt(operationId, value) {
  fs.mkdirSync(operationsHome(), { recursive: true, mode: 0o700 });
  const target = operationReceiptPath(operationId);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return value;
}

export function planAgentHandoff(target, { task = "", description = "", sessionId = "", idempotencyKey = "" } = {}) {
  const changes = classifyAgentChanges(target, { sessionId });
  const revision = handoffRevision(target, changes);
  const input = { task: String(task || ""), description: String(description || task || ""), sessionId: String(sessionId || ""), idempotencyKey: String(idempotencyKey || "") };
  const planId = stableCliPlanId({ command: "agent.handoff", target: publicTarget(target), input, revision });
  return {
    planId,
    revision,
    target: publicTarget(target),
    input,
    changes,
    actions: [
      !target.registered ? { type: "register-location", root: target.root } : null,
      ...changes.proposals.filter((item) => item.dirty || item.head !== item.lastPublishedHead).map((proposal) => ({ type: "sync-rebase-publish-proposal", proposal: proposal.branch, scope: proposal.scope, conflict: proposal.conflict })),
      ...changes.local.filter((item) => item.category === "local-review").map((item) => ({ type: "leave-in-local-review", path: item.path })),
    ].filter(Boolean),
    untouched: changes.local.filter((item) => item.category !== "local-review").map((item) => ({ path: item.path, reason: item.category })),
    humanOwned: "Each file review must still be accepted or rejected by a human.",
  };
}

export function applyAgentHandoff(target, { planId, task = "", description = "", sessionId = "", idempotencyKey = "" } = {}) {
  const current = planAgentHandoff(target, { task, description, sessionId, idempotencyKey });
  if (!planId || current.planId !== planId) {
    throw new ContextRoomCliError("stale-plan", "The project, proposal, or shared revision changed after this handoff was planned.", {
      details: { expectedPlanId: current.planId, suppliedPlanId: planId || "" },
      retryable: true,
      nextActions: [{ id: "replan", label: "Rebuild the handoff plan", command: `context-room agent handoff --root ${JSON.stringify(target.root)} --task ${JSON.stringify(task || "documentation handoff")} --session ${JSON.stringify(sessionId)} --format json`, mutates: false, requiresHuman: false }],
    });
  }
  const operationId = stableCliOperationId({ planId, idempotencyKey });
  const receiptPath = operationReceiptPath(operationId);
  if (fs.existsSync(receiptPath)) return { ...JSON.parse(fs.readFileSync(receiptPath, "utf8")), idempotentReplay: true };
  let registered = null;
  if (!target.registered) registered = registerCliProject({ root: target.root });
  const published = [];
  for (const proposal of current.changes.proposals.filter((item) => item.dirty || item.head !== item.lastPublishedHead)) {
    if (proposal.conflict) throw new ContextRoomCliError("proposal-conflict", `Proposal ${proposal.branch} has a persistent rebase conflict.`, { details: { proposal } });
    published.push(publishSharedProposal(target.root, {
      proposal: proposal.branch,
      title: task || undefined,
      description: description || task || "Update shared documentation for the current task.",
      message: task || "Publish Context Room handoff",
    }));
  }
  const receipt = {
    operationId,
    planId,
    appliedAt: new Date().toISOString(),
    target: publicTarget(target),
    registered,
    published,
    localReviews: current.changes.local.filter((item) => item.category === "local-review").map((item) => item.path),
    humanOwned: "Only the human can accept or reject these file reviews.",
  };
  writeOperationReceipt(operationId, receipt);
  for (const reviewPath of receipt.localReviews) {
    appendContextRoomEvent("review.added", {
      projectId: target.project.id,
      locationId: target.location.id,
      sharedRepository: target.shared?.repository || "",
      resource: { path: reviewPath },
      data: { source: "agent.handoff", operationId },
    });
  }
  appendContextRoomEvent("agent.handoff-applied", {
    projectId: target.project.id,
    locationId: target.location.id,
    sharedRepository: target.shared?.repository || "",
    resource: { operationId, proposals: published.map((item) => item.branch), localReviews: receipt.localReviews },
  });
  return receipt;
}

export function listCliReviews(target, { query = "", reason = "", severity = "" } = {}) {
  const report = publicReviewReport(buildDocQaReport(target.root));
  const needle = String(query || "").trim().toLowerCase();
  const queue = report.queue.filter((item) => {
    if (needle && ![item.path, item.label, item.id].some((value) => String(value || "").toLowerCase().includes(needle))) return false;
    if (reason && item.reason !== reason) return false;
    if (severity && !(item.issues || []).some((issue) => issue.severity === severity)) return false;
    return true;
  });
  return { ...report, queue };
}

export function showCliReview(target, selector) {
  const review = listCliReviews(target).queue.find((item) => item.id === selector || item.path === selector);
  if (!review) throw new ContextRoomCliError("review-not-found", `Review item not found: ${selector}`);
  return review;
}

export function diffCliReview(target, selector) {
  const review = showCliReview(target, selector);
  const gitDiff = gitText(target.root, ["diff", "--no-ext-diff", "--", review.path]);
  if (gitDiff) return { review, mode: "git-diff", diff: gitDiff };
  if (review.resourceState === "absent") {
    return { review, mode: "deleted-current", content: gitText(target.root, ["show", `HEAD:${review.path}`]) };
  }
  const file = readMemoryFile(target.root, review.path);
  return { review, mode: "current-version", content: file.content, contentHash: file.contentHash };
}

export function openCliReview(target, selector) {
  const review = showCliReview(target, selector);
  const command = writeAgentCommand(target.root, { action: "navigate", view: "diff", path: review.path, source: "agent-cli" });
  return { review, command };
}

export function annotateCliReview(target, selector, note) {
  const review = showCliReview(target, selector);
  const annotation = appendAgentAnnotation(target.root, { path: review.path, note, targetType: "file", source: "agent-cli" });
  appendContextRoomEvent("review.annotated", { projectId: target.project.id, locationId: target.location.id, resource: { path: review.path, annotationId: annotation.id } });
  return { review, annotation };
}

export function planCliReviewAnnotation(target, selector, note) {
  const review = showCliReview(target, selector);
  const input = { selector: review.id, path: review.path, note: String(note || "") };
  const revision = review.review?.contentHash || review.id;
  return {
    planId: stableCliPlanId({ command: "review.annotate", target: publicTarget(target), input, revision }),
    revision,
    review,
    annotation: { path: review.path, note: input.note, targetType: "file" },
    humanDecisionChanged: false,
  };
}

export function applyCliReviewAnnotation(target, { selector, note, planId } = {}) {
  const current = planCliReviewAnnotation(target, selector, note);
  if (!planId || current.planId !== planId) {
    throw new ContextRoomCliError("stale-plan", "The review item changed after this annotation was planned.", {
      details: { expectedPlanId: current.planId, suppliedPlanId: planId || "" },
      retryable: true,
    });
  }
  return { planId, ...annotateCliReview(target, selector, note), humanDecisionChanged: false };
}

function privateStatePath(kind, id) {
  const safe = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(operationsHome(), kind, `${safe}.json`);
}

function writePrivateState(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function readPrivateState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function settingsRevision(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sharedSkillsProjectSettings(root) {
  const state = readSharedSkillLocalState(root);
  const projectId = state.projectId || "";
  return {
    sharedSkills: {
      providerOverrides: Object.fromEntries((state.providerOverrides || []).filter((item) => item.projectId === projectId).map((item) => [item.provider, item.state])),
      assignmentOverrides: Object.fromEntries((state.overrides || []).filter((item) => !item.projectId || item.projectId === projectId).map((item) => [item.assignmentId, { disabled: Boolean(item.disabled), exclude: item.exclude || [] }])),
    },
  };
}

function filesystemContextSettingsAdapter(target) {
  const adapterTarget = { projectId: target.project?.id || "", locationId: target.location?.id || "", root: target.root };
  const readStore = (store) => {
    if (store === "project") {
      const settings = readMemoryWebappSettings(target.root);
      return { settings, revision: settingsRevision(settings) };
    }
    if (store === "shared-skills-device") {
      const settings = { sharedSkills: { providers: sharedSkillProviderPreferences().providers } };
      return { settings, revision: settingsRevision(settings) };
    }
    if (store === "shared-skills-project") {
      const settings = sharedSkillsProjectSettings(target.root);
      return { settings, revision: settingsRevision(settings) };
    }
    throw new ContextRoomCliError("unknown-settings-store", `Unknown context settings store: ${store}`);
  };
  return {
    read(storeTarget) { return readStore(storeTarget.store); },
    write(storeTarget, { settings, expectedRevision }) {
      const current = readStore(storeTarget.store);
      if (current.revision !== expectedRevision) throw new ContextRoomCliError("stale-plan", "Settings changed before they could be written.", { retryable: true });
      if (storeTarget.store === "project") {
        const written = writeMemoryWebappSettings(target.root, settings, { migrateLegacyReview: true });
        return { settings: written, revision: settingsRevision(written) };
      }
      if (storeTarget.store === "shared-skills-device") {
        const applied = setSharedSkillProviderPreferences(target.root, { providers: settings.sharedSkills?.providers || {} });
        const written = applied.preferences;
        const normalized = { sharedSkills: { providers: written.providers } };
        return { settings: normalized, revision: settingsRevision(normalized) };
      }
      const before = current.settings.sharedSkills || {};
      const after = settings.sharedSkills || {};
      const providers = new Set([...Object.keys(before.providerOverrides || {}), ...Object.keys(after.providerOverrides || {})]);
      for (const provider of providers) {
        const state = after.providerOverrides?.[provider] || "inherit";
        if ((before.providerOverrides?.[provider] || "inherit") !== state) setSharedSkillProviderOverride(target.root, { provider, state });
      }
      const assignments = new Set([...Object.keys(before.assignmentOverrides || {}), ...Object.keys(after.assignmentOverrides || {})]);
      for (const assignmentId of assignments) {
        const previous = before.assignmentOverrides?.[assignmentId] || { disabled: false, exclude: [] };
        const next = after.assignmentOverrides?.[assignmentId] || { disabled: false, exclude: [] };
        if (JSON.stringify(previous) !== JSON.stringify(next)) setSharedSkillLocationOverride(target.root, { assignmentId, disabled: Boolean(next.disabled), exclude: next.exclude || [] });
      }
      const normalized = sharedSkillsProjectSettings(target.root);
      return { settings: normalized, revision: settingsRevision(normalized) };
    },
    savePlan(plan) { writePrivateState(privateStatePath("settings-plans", plan.planId), plan); },
    readPlan(planId) { return readPrivateState(privateStatePath("settings-plans", planId)); },
    saveReceipt(receipt) { writePrivateState(privateStatePath("settings-receipts", receipt.operationId), receipt); },
    readReceipt(operationId) { return readPrivateState(privateStatePath("settings-receipts", operationId)); },
    target: adapterTarget,
  };
}

export function getCliContextSettings(target, { key = "" } = {}) {
  try {
    const adapter = filesystemContextSettingsAdapter(target);
    return getContextSettings(adapter, { key, target: adapter.target });
  } catch (error) {
    throw cliErrorFrom(error, "settings-get-failed");
  }
}

export function explainCliContextSetting(key) {
  try { return explainContextSetting(key); } catch (error) { throw cliErrorFrom(error, "settings-explain-failed"); }
}

export function planCliContextSettings(target, { set, expectedRevision = "" } = {}) {
  try {
    const adapter = filesystemContextSettingsAdapter(target);
    return planContextSettingsChange(adapter, { set, expectedRevision, target: adapter.target });
  } catch (error) {
    throw cliErrorFrom(error, "settings-plan-failed");
  }
}

export function applyCliContextSettings(target, { planId, idempotencyKey = "" } = {}) {
  try {
    const adapter = filesystemContextSettingsAdapter(target);
    const receipt = applyContextSettingsPlan(adapter, planId, { idempotencyKey });
    if (!receipt.idempotentReplay) {
      appendContextRoomEvent("settings.changed", {
        projectId: target.project?.id || "",
        locationId: target.location?.id || "",
        sharedProjectId: target.shared?.projectId || "",
        sharedRepository: target.shared?.repository || "",
        resource: { planId, store: readPrivateState(privateStatePath("settings-plans", planId))?.store || "" },
        data: { operationId: receipt.operationId, revision: receipt.revision, changes: receipt.changes },
      });
    }
    return receipt;
  } catch (error) {
    throw cliErrorFrom(error, "settings-apply-failed");
  }
}

export function effectiveSharedSkills(target, { provider = "all" } = {}) {
  const selectedProvider = normalizedProvider(provider);
  const status = sharedSkillLocationsStatus(target.root, { refresh: false });
  const destinations = (status.destinations || []).filter((destination) => selectedProvider === "all" || destination.provider === selectedProvider || destination.provider === "custom");
  return { ...status, selectedProvider, destinations, effectiveSkills: destinations.flatMap((destination) => (destination.skills || []).map((skill) => ({ skill, destinationId: destination.id, collectionId: destination.collectionId, provider: destination.provider, scope: destination.scope, status: destination.status, path: destination.destination }))) };
}

export function explainSharedSkill(target, selector) {
  const status = effectiveSharedSkills(target);
  const candidates = [
    ...(status.collections || []).filter((item) => item.id === selector || item.title === selector).map((item) => ({ kind: "collection", ...item })),
    ...(status.assignments || []).filter((item) => item.id === selector).map((item) => ({ kind: "assignment", ...item })),
    ...(status.destinations || []).filter((item) => item.id === selector || item.destination === selector).map((item) => ({ kind: "destination", ...item })),
    ...(status.effectiveSkills || []).filter((item) => item.skill === selector).map((item) => ({ kind: "skill", ...item })),
  ];
  if (!candidates.length) throw new ContextRoomCliError("shared-skill-not-found", `Shared skill resource not found: ${selector}`);
  if (candidates.length > 1) throw new ContextRoomCliError("ambiguous-selector", `Several shared skill resources match ${selector}.`, { details: { candidates } });
  return candidates[0];
}

function projectIdsFromOptions(options = {}) {
  const rawProjects = options.projectIds || options.projects || [];
  const values = Array.isArray(rawProjects) ? [...rawProjects] : String(rawProjects).split(",");
  if (options.projectsFile) {
    const raw = fs.readFileSync(path.resolve(options.projectsFile), "utf8").trim();
    if (raw) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
      if (!Array.isArray(parsed)) throw new ContextRoomCliError("invalid-projects-file", "--projects-file must contain a JSON array or one project ID per line.", { exitCode: 2 });
      values.push(...parsed);
    }
  }
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function sharedSkillOperationPreview(target, action, rawOptions = {}) {
  const options = { ...rawOptions };
  delete options.planId;
  delete options.idempotencyKey;
  if (["assign", "import"].includes(action)) options.projectIds = projectIdsFromOptions(options);
  if (action === "assign") return { options, preview: previewSharedSkillAssignment(target.root, options) };
  if (action === "unassign") return { options, preview: previewSharedSkillUnassignment(target.root, options) };
  if (action === "import") return { options, preview: previewSharedSkillImport(target.root, options) };
  if (action === "link") return { options, preview: previewSharedSkillLocation(target.root, options) };
  if (action === "unlink") {
    const local = readSharedSkillLocalState(target.root);
    const mount = (local.mounts || []).find((item) => item.id === options.id);
    if (!mount) throw new ContextRoomCliError("shared-skill-mount-not-found", `Unknown local skill mount: ${options.id}`);
    return { options, preview: { action: "unlink", mount, unmanagedContentPreserved: true } };
  }
  if (action === "override") {
    const status = sharedSkillLocationsStatus(target.root, { refresh: false });
    const assignment = (status.assignments || []).find((item) => item.id === options.assignmentId);
    if (!assignment) throw new ContextRoomCliError("shared-skill-assignment-not-found", `Unknown shared skill assignment: ${options.assignmentId}`);
    return { options, preview: { action: "override", assignment, disabled: Boolean(options.disabled), exclude: options.exclude || [], sharedIntentChanged: false } };
  }
  if (action === "reconcile") {
    const provider = normalizedProvider(options.provider || "all");
    const projection = sharedSkillEffectiveProjection(target.root, { refresh: false, provider });
    return {
      options: { ...options, provider },
      preview: {
        action: "reconcile",
        revision: projection.revision,
        destinations: (projection.destinations || []).filter((item) => provider === "all" || item.provider === provider || item.provider === "custom"),
        conflicts: projection.conflicts || [],
        unmanagedContentPreserved: true,
      },
    };
  }
  throw new ContextRoomCliError("unknown-shared-skill-operation", `Unknown Shared Skills operation: ${action}`, { exitCode: 2 });
}

export function planSharedSkillOperation(target, { action, ...rawOptions } = {}) {
  try {
    const operation = String(action || "").trim();
    const { options, preview } = sharedSkillOperationPreview(target, operation, rawOptions);
    const status = sharedSkillLocationsStatus(target.root, { refresh: false });
    const revision = settingsRevision({ revision: status.revision || "", local: readSharedSkillLocalState(target.root), preview });
    const planId = stableCliPlanId({ command: `shared.skills.${operation}`, target: publicTarget(target), input: options, revision });
    const plan = {
      planId,
      action: operation,
      revision,
      target: publicTarget(target),
      input: options,
      preview,
      proposalRequired: ["assign", "unassign", "import"].includes(operation),
      localOnly: ["link", "unlink", "override", "reconcile"].includes(operation),
      untouchedUnmanaged: true,
    };
    writePrivateState(privateStatePath("shared-skill-plans", planId), plan);
    return plan;
  } catch (error) {
    throw cliErrorFrom(error, "shared-skill-plan-failed");
  }
}

export function applySharedSkillOperation(target, { action = "", planId, idempotencyKey = "" } = {}) {
  try {
    const stored = readPrivateState(privateStatePath("shared-skill-plans", planId));
    if (!stored) throw new ContextRoomCliError("unknown-plan", `Unknown Shared Skills plan: ${planId}`);
    if (action && action !== stored.action) throw new ContextRoomCliError("plan-action-mismatch", `Plan ${planId} belongs to ${stored.action}, not ${action}.`);
    const current = planSharedSkillOperation(target, { action: stored.action, ...stored.input });
    if (current.planId !== planId) throw new ContextRoomCliError("stale-plan", "Shared Skills state changed after this operation was planned.", { details: { expectedPlanId: current.planId, suppliedPlanId: planId }, retryable: true });
    const operationId = stableCliOperationId({ planId, idempotencyKey });
    const receiptPath = privateStatePath("shared-skill-receipts", operationId);
    const previous = readPrivateState(receiptPath);
    if (previous) return { ...previous, idempotentReplay: true };
    const input = stored.input;
    let result;
    if (stored.action === "assign") result = proposeSharedSkillAssignment(target.root, input);
    else if (stored.action === "unassign") result = proposeSharedSkillUnassignment(target.root, input);
    else if (stored.action === "import") result = importSharedSkills(target.root, input);
    else if (stored.action === "link") result = linkSharedSkillLocation(target.root, input);
    else if (stored.action === "unlink") result = unlinkSharedSkillLocation(target.root, input);
    else if (stored.action === "override") result = setSharedSkillLocationOverride(target.root, input);
    else if (stored.action === "reconcile") result = reconcileSharedSkillLocations(target.root, { provider: input.provider || "all", allowOffline: false });
    const receipt = { operationId, planId, action: stored.action, appliedAt: new Date().toISOString(), result, untouchedUnmanaged: true };
    writePrivateState(receiptPath, receipt);
    return receipt;
  } catch (error) {
    throw cliErrorFrom(error, "shared-skill-apply-failed");
  }
}

export function planSharedSkillReconcile(target, { provider = "all" } = {}) {
  return planSharedSkillOperation(target, { action: "reconcile", provider });
}

export function applySharedSkillReconcile(target, { planId, provider = "all", idempotencyKey = "" } = {}) {
  return applySharedSkillOperation(target, { action: "reconcile", planId, provider, idempotencyKey });
}

function sharedInstructionOperationPreview(target, action, rawOptions = {}) {
  const options = { ...rawOptions };
  delete options.planId;
  delete options.idempotencyKey;
  if (["assign", "import"].includes(action)) options.projectIds = projectIdsFromOptions(options);
  if (action === "assign") return { options, preview: previewSharedInstructionAssignment(target.root, options) };
  if (action === "unassign") return { options, preview: previewSharedInstructionUnassignment(target.root, options) };
  if (action === "import") return { options, preview: previewSharedInstructionImport(target.root, options) };
  if (action === "reconcile") {
    const status = sharedInstructionLocationsStatus(target.root, { refresh: false });
    return { options, preview: { action: "reconcile", revision: status.revision, links: status.links || [], conflicts: status.conflicts || [], unmanagedContentPreserved: true } };
  }
  throw new ContextRoomCliError("unknown-shared-instruction-operation", `Unknown Shared Instructions operation: ${action}`, { exitCode: 2 });
}

export function planSharedInstructionOperation(target, { action, ...rawOptions } = {}) {
  try {
    const operation = String(action || "").trim();
    const { options, preview } = sharedInstructionOperationPreview(target, operation, rawOptions);
    const status = sharedInstructionLocationsStatus(target.root, { refresh: false });
    const revision = settingsRevision({ revision: status.revision || "", preview });
    const planId = stableCliPlanId({ command: `shared.instructions.${operation}`, target: publicTarget(target), input: options, revision });
    const plan = { planId, action: operation, revision, target: publicTarget(target), input: options, preview, proposalRequired: ["assign", "unassign", "import"].includes(operation), localOnly: operation === "reconcile", untouchedUnmanaged: true };
    writePrivateState(privateStatePath("shared-instruction-plans", planId), plan);
    return plan;
  } catch (error) {
    throw cliErrorFrom(error, "shared-instruction-plan-failed");
  }
}

export function applySharedInstructionOperation(target, { action = "", planId, idempotencyKey = "" } = {}) {
  try {
    const stored = readPrivateState(privateStatePath("shared-instruction-plans", planId));
    if (!stored) throw new ContextRoomCliError("unknown-plan", `Unknown Shared Instructions plan: ${planId}`);
    if (action && action !== stored.action) throw new ContextRoomCliError("plan-action-mismatch", `Plan ${planId} belongs to ${stored.action}, not ${action}.`);
    const current = planSharedInstructionOperation(target, { action: stored.action, ...stored.input });
    if (current.planId !== planId) throw new ContextRoomCliError("stale-plan", "Shared Instructions state changed after this operation was planned.", { details: { expectedPlanId: current.planId, suppliedPlanId: planId }, retryable: true });
    const operationId = stableCliOperationId({ planId, idempotencyKey });
    const receiptPath = privateStatePath("shared-instruction-receipts", operationId);
    const previous = readPrivateState(receiptPath);
    if (previous) return { ...previous, idempotentReplay: true };
    let result;
    if (stored.action === "assign") result = proposeSharedInstructionAssignment(target.root, stored.input);
    else if (stored.action === "unassign") result = proposeSharedInstructionUnassignment(target.root, stored.input);
    else if (stored.action === "import") result = importSharedInstructions(target.root, stored.input);
    else if (stored.action === "reconcile") result = reconcileSharedInstructionLocations(target.root, { allowOffline: false });
    const receipt = { operationId, planId, action: stored.action, appliedAt: new Date().toISOString(), result, untouchedUnmanaged: true };
    writePrivateState(receiptPath, receipt);
    return receipt;
  } catch (error) {
    throw cliErrorFrom(error, "shared-instruction-apply-failed");
  }
}

function pageBounds(cursor = "", limit = 25) {
  const offset = cursor === "" || cursor == null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ContextRoomCliError("invalid-cursor", "Cursor must be a non-negative integer offset.", { exitCode: 2 });
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));
  return { offset, limit: pageSize };
}

function doctorDefaults(target) {
  return {
    root: target.root,
    projectId: target.project?.id || "",
    locationId: target.location?.id || "",
    sharedProjectId: target.shared?.projectId || target.project?.sharedProjectId || "",
  };
}

export function buildCliDoctorReport(target, filters = {}) {
  try {
    const report = buildContextRoomDoctorReport(target.root);
    const defaults = doctorDefaults(target);
    const issues = filterDoctorIssues(normalizeDoctorIssues(report.issues || [], defaults), {
      defaults,
      projectId: filters.project || filters.projectId || "",
      locationId: filters.location || filters.locationId || "",
      sharedProjectId: filters.shared || filters.sharedProjectId || "",
      folder: filters.folder || "",
      provider: filters.provider || "",
      severity: filters.severity || "",
    });
    return {
      ...report,
      target: publicTarget(target),
      issues,
      summary: {
        ...(report.summary || {}),
        issues: issues.length,
        critical: issues.filter((item) => item.severity === "critical").length,
        high: issues.filter((item) => item.severity === "high").length,
      },
    };
  } catch (error) {
    throw cliErrorFrom(error, "doctor-failed");
  }
}

export function explainCliDoctorIssue(target, issueKey, filters = {}) {
  try {
    const report = buildCliDoctorReport(target, filters);
    return explainDoctorIssue(issueKey, { issues: report.issues, defaults: doctorDefaults(target) });
  } catch (error) {
    throw cliErrorFrom(error, "doctor-explain-failed");
  }
}

export function planCliDoctorIssue(target, issueKey, filters = {}) {
  try {
    const report = buildCliDoctorReport(target, filters);
    return planDoctorRepair(issueKey, {
      issues: report.issues,
      defaults: doctorDefaults(target),
      context: { expectedRevision: statFingerprint(path.join(target.root, CONFIG_FILE)) },
    });
  } catch (error) {
    throw cliErrorFrom(error, "doctor-plan-failed");
  }
}

export function doctorAllProjects({
  onlyActionable = false,
  cursor = "",
  limit = 25,
  query = "",
  project = "",
  location = "",
  shared = "",
  provider = "",
  folder = "",
} = {}) {
  const bounds = pageBounds(cursor, limit);
  const needle = String(query || "").trim().toLowerCase();
  const catalog = listContextHubProjects({ refreshGit: false }).filter((item) => {
    if (project && ![item.id, item.logicalProjectId, item.title, item.shared?.projectId].some((value) => String(value || "") === String(project))) return false;
    if (location && item.id !== location && stablePath(item.root) !== stablePath(location)) return false;
    if (shared && item.shared?.repository !== shared && item.shared?.projectId !== shared) return false;
    if (needle && ![item.title, item.id, item.logicalProjectId, item.root, item.shared?.projectId].some((value) => String(value || "").toLowerCase().includes(needle))) return false;
    return true;
  });
  const selected = catalog.slice(bounds.offset, bounds.offset + bounds.limit);
  const results = [];
  for (const projectItem of selected) {
    const project = projectItem;
    if (!project.available) {
      const issues = normalizeDoctorIssues([{ type: "location_unavailable", severity: "high", message: "Registered project location is unavailable." }], { projectId: project.logicalProjectId, locationId: project.id, sharedProjectId: project.shared?.projectId || "" });
      results.push({ projectId: project.logicalProjectId, locationId: project.id, title: project.title, root: project.root, available: false, issues });
      continue;
    }
    try {
      const target = resolveCliTarget({ cwd: project.root, location: project.id });
      const report = buildCliDoctorReport(target, { provider, folder });
      if (!onlyActionable || report.issues.length) results.push({ projectId: project.logicalProjectId, locationId: project.id, title: project.title, root: project.root, available: true, generatedAt: report.generatedAt, issues: report.issues, summary: { issues: report.issues.length, critical: report.issues.filter((item) => item.severity === "critical").length, high: report.issues.filter((item) => item.severity === "high").length } });
    } catch (error) {
      results.push({ projectId: project.logicalProjectId, locationId: project.id, title: project.title, root: project.root, available: true, issues: normalizeDoctorIssues([{ type: "doctor_failed", severity: "critical", message: error.message }], { projectId: project.logicalProjectId, locationId: project.id }) });
    }
  }
  const nextOffset = bounds.offset + selected.length;
  return {
    projects: results,
    summary: { projects: results.length, issues: results.reduce((sum, item) => sum + item.issues.length, 0), matchedProjects: catalog.length },
    pagination: { cursor: String(bounds.offset), limit: bounds.limit, nextCursor: nextOffset < catalog.length ? String(nextOffset) : null },
  };
}

export function doctorSafePlan(target) {
  const report = buildCliDoctorReport(target);
  return {
    target: publicTarget(target),
    issues: report.issues,
    actions: [],
    note: "No deterministic repair is inferred from message text. Use doctor plan <issue-key>; protected settings, watch rules, review decisions, unmanaged destinations, and hooks are never changed automatically.",
  };
}

export function renderAgentCliHuman(command, payload) {
  const data = payload?.data ?? payload;
  if (command === "project.list" || command === "project.search" || command === "project.recent") {
    return (data.projects || []).map((project) => `${project.title} · ${project.locations.length} location${project.locations.length === 1 ? "" : "s"}\n${project.locations.map((item) => `  ${item.branch || "no branch"} · ${item.root}`).join("\n")}`).join("\n\n") + "\n";
  }
  if (command === "agent.instructions") return String(data.prompt || "") + "\n";
  if (command === "review.list") return `${data.queue.length} file review${data.queue.length === 1 ? "" : "s"} awaiting a human decision\n` + data.queue.map((item) => `- ${item.reason} ${item.path}`).join("\n") + "\n";
  if (command === "events") return (data.events || []).map((event) => `${event.occurredAt} ${event.type} ${event.resource?.path || event.resource?.proposal || ""}`.trim()).join("\n") + "\n";
  return JSON.stringify(data, null, 2) + "\n";
}
