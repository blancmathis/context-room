import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { listContextHubProjects } from "./context_hub.mjs";
import {
  buildAgentReviewQueue,
  buildContextRoomDoctorReport,
  listMemoryFiles,
  listStartupContextFiles,
  listStartupHookFiles,
  listStartupSkillFolders,
  parseDocMetadata,
  readDocReviewState,
  readGlobalReviewLedger,
  readMemoryFile,
  readMemoryWebappSettings,
} from "./context_room.mjs";
import { contextProviderProfile } from "./provider_profiles.mjs";
import {
  listSharedProposals,
  readSharedMainRevision,
  readSharedProjectConnection,
  sharedContextStatus,
  sharedInstructionLocationsStatus,
  sharedSkillEffectiveProjection,
} from "./shared_context.mjs";

const PROVIDERS = new Set(["codex", "claude-code", "opencode"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".html"]);

function sha256(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stablePath(value) {
  const resolved = path.resolve(String(value || "."));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function unixPath(value = "") {
  return String(value || "").replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function displayPath(value = "") {
  const absolute = stablePath(value);
  const home = stablePath(os.homedir());
  return absolute === home ? "~" : absolute.startsWith(`${home}${path.sep}`) ? `~/${unixPath(path.relative(home, absolute))}` : absolute;
}

function isWithin(root, candidate) {
  const relative = path.relative(stablePath(root), stablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function folderChain(root, folder) {
  const resolvedRoot = stablePath(root);
  const resolvedFolder = stablePath(folder || root);
  if (!isWithin(resolvedRoot, resolvedFolder)) throw inventoryError("folder-outside-location", "The selected folder is outside the project location.", { root: resolvedRoot, folder: resolvedFolder });
  const directories = [];
  let current = resolvedFolder;
  while (true) {
    directories.unshift(current);
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
  return directories;
}

function expandHome(value = "") {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function inventoryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function resourceIdForFile(absolutePath) {
  return `file://${stablePath(absolutePath)}`;
}

function resourceIdForShared(repository, gitPath) {
  return `git:${String(repository)}#${unixPath(gitPath)}`;
}

function coordinateId(coordinate) {
  return `coordinate:${coordinate.projectId}:${coordinate.locationId || "shared-only"}:${coordinate.provider}:${coordinate.folder}`;
}

function providersForFile(fileName = "", providerHint = "") {
  if (PROVIDERS.has(providerHint)) return [providerHint];
  if (/^AGENTS(?:\.override)?\.md$/i.test(fileName)) return ["codex", "opencode"];
  if (/^CLAUDE(?:\.local)?\.md$/i.test(fileName)) return ["claude-code", "opencode"];
  return ["all"];
}

function providerApplies(providers, selectedProvider) {
  return selectedProvider === "all" || providers.includes("all") || providers.includes(selectedProvider);
}

function reviewIndex(queue = []) {
  const index = new Map();
  for (const item of queue) {
    for (const candidate of [item.path, item.absolutePath, item.startupContext?.absolutePath, item.startupHook?.absolutePath]) {
      if (candidate) index.set(String(candidate), item);
    }
  }
  return index;
}

function currentVerifiedReview({ root, relPath, absolutePath, contentHash, reviewState, globalLedger }) {
  const local = reviewState?.reviews?.[relPath];
  if (local?.status === "verified" && local.contentHash === contentHash) return { ...local, current: true, source: "project-review" };
  for (const item of Object.values(globalLedger?.reviews || {})) {
    if (item?.status !== "verified" || item.contentHash !== contentHash) continue;
    if (item.absolutePath && stablePath(item.absolutePath) === stablePath(absolutePath)) return { ...item, current: true, source: "global-review" };
    if (item.root && item.relPath && stablePath(item.root) === stablePath(root) && unixPath(item.relPath) === relPath) return { ...item, current: true, source: "global-review" };
  }
  return null;
}

function normalizeHealthIssue(issue = {}, resources = []) {
  let resourceId = String(issue.resourceId || "");
  const absolutePath = issue.absolutePath || (issue.path && path.isAbsolute(issue.path) ? issue.path : "");
  if (!resourceId && absolutePath) resourceId = resourceIdForFile(absolutePath);
  if (!resourceId && issue.path) {
    const matches = resources.filter((resource) => resource.locator === issue.path || resource.metadata?.relativePath === issue.path);
    if (matches.length === 1) resourceId = matches[0].id;
  }
  return {
    ...issue,
    ...(resourceId ? { resourceId } : {}),
    scope: issue.scope || "project",
    provider: issue.provider || "all",
    ...(absolutePath ? { absolutePath: stablePath(absolutePath) } : {}),
  };
}

function defaultReadSharedDocuments(main, { projectId }) {
  if (!main?.checkout || !main?.revision || !projectId) return [];
  const prefix = `${main.repositoryConfig.projectsPath}/${projectId}/docs`;
  let names = "";
  try {
    names = execFileSync("git", ["ls-tree", "-r", "--name-only", main.revision, "--", prefix], {
      cwd: main.checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return names.split("\n").filter(Boolean).filter((name) => DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())).flatMap((gitPath) => {
    try {
      const content = execFileSync("git", ["show", `${main.revision}:${gitPath}`], {
        cwd: main.checkout,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
      });
      return [{ path: gitPath, content, contentHash: sha256(content), metadata: parseDocMetadata(content, gitPath) }];
    } catch {
      return [];
    }
  });
}

function directSkillNames(folder) {
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => !entry.name.startsWith(".")).flatMap((entry) => {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const manifest = path.join(folder, entry.name, "SKILL.md");
      try { return fs.statSync(manifest).isFile() ? [entry.name] : []; } catch { return []; }
    }
    return [];
  }).sort((left, right) => left.localeCompare(right, "en"));
}

function defaultListProviderInstructions(root, folder, provider) {
  if (provider === "all") return [];
  const profile = contextProviderProfile(provider);
  const chain = folderChain(root, folder);
  const globalRoot = provider === "codex"
    ? expandHome(process.env.CODEX_HOME || "~/.codex")
    : provider === "claude-code"
      ? expandHome("~/.claude")
      : expandHome("~/.config/opencode");
  const discovered = [];
  const add = (absolutePath, source, order, evidence) => {
    try { if (!fs.statSync(absolutePath).isFile()) return false; } catch { return false; }
    discovered.push({
      label: path.basename(absolutePath),
      startupContext: {
        absolutePath: stablePath(absolutePath),
        displayPath: displayPath(absolutePath),
        source,
        provider,
        profileOrder: order,
        activationProven: true,
        evidence,
      },
    });
    return true;
  };
  for (const [index, fileName] of (profile.instructions?.globalFiles || []).entries()) {
    if (add(path.join(globalRoot, fileName), "global", index, { profile: provider, discovery: "provider-global-instructions" }) && profile.instructions?.onePerDirectory) break;
  }
  let order = discovered.length;
  for (const directory of chain) {
    for (const fileName of profile.instructions?.projectFiles || []) {
      if (add(path.join(directory, fileName), "provider-profile", order++, { profile: provider, discovery: "exact-instruction-chain", directory: stablePath(directory) }) && profile.instructions?.onePerDirectory) break;
    }
  }
  return discovered;
}

function exactProviderSkillLocations(provider, root, folder) {
  const chain = folderChain(root, folder);
  const profile = contextProviderProfile(provider);
  const global = [...(Array.isArray(profile.skills?.global) ? profile.skills.global : [profile.skills?.global].filter(Boolean)), ...(Array.isArray(profile.skills?.admin) ? profile.skills.admin : [profile.skills?.admin].filter(Boolean))].map(expandHome);
  const projectLocations = Array.isArray(profile.skills?.project) ? profile.skills.project : [profile.skills?.project].filter(Boolean);
  return {
    global,
    project: chain.flatMap((directory) => projectLocations.map((relative) => ({ directory, relative }))),
  };
}

function defaultListProviderSkillFolders(root, folder, provider) {
  if (provider === "all") return [];
  const locations = exactProviderSkillLocations(provider, root, folder);
  const candidates = [
    ...locations.global.map((absolutePath, index) => ({ absolutePath, scope: "device", subtree: ".", precedence: index })),
    ...locations.project.map((item, index) => ({
      absolutePath: path.join(item.directory, item.relative),
      scope: stablePath(item.directory) === stablePath(root) ? "project" : "subtree",
      subtree: unixPath(path.relative(root, item.directory)) || ".",
      precedence: locations.global.length + index,
    })),
  ];
  const seen = new Set();
  return candidates.flatMap((candidate) => {
    let absolutePath;
    try {
      if (!fs.statSync(candidate.absolutePath).isDirectory()) return [];
      absolutePath = stablePath(candidate.absolutePath);
      fs.accessSync(absolutePath, fs.constants.R_OK);
    } catch {
      return [];
    }
    if (seen.has(absolutePath)) return [];
    seen.add(absolutePath);
    const skills = directSkillNames(absolutePath);
    if (!skills.length) return [];
    return [{
      absolutePath,
      displayPath: displayPath(absolutePath),
      folderName: path.basename(path.dirname(absolutePath)) + "/skills",
      skills,
      providers: [provider],
      source: "provider-profile",
      scope: candidate.scope,
      subtree: candidate.subtree,
      precedence: candidate.precedence,
      activationProven: true,
      evidence: { profile: provider, discovery: "exact-skill-location" },
      readOnly: false,
    }];
  });
}

function objectHasConfiguredHooks(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).some((item) => Array.isArray(item) ? item.length > 0 : Boolean(item)));
}

function defaultListProviderHookSources(root, _folder, provider) {
  if (provider === "all") return [];
  const profile = contextProviderProfile(provider);
  const seen = new Set();
  const results = [];
  const configuredSources = Array.isArray(profile.hooks) ? profile.hooks : (profile.hooks?.sources || []);
  for (const configuredSource of configuredSources) {
    const [configuredPath, virtualSource = ""] = String(configuredSource).split(":", 2);
    const absolutePath = configuredPath.startsWith("~") ? expandHome(configuredPath) : path.join(root, configuredPath);
    let stats;
    try { stats = fs.statSync(absolutePath); } catch { continue; }
    if (virtualSource) {
      if (!stats.isFile()) continue;
      const candidate = stablePath(absolutePath);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      results.push({
        absolutePath: candidate,
        provider,
        source: "provider-profile",
        sourceLabel: `${profile.label} ${virtualSource}`,
        label: `${path.basename(candidate)} · ${virtualSource}`,
        executable: false,
        activationProven: false,
        evidence: null,
      });
      continue;
    }
    if (stats.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(absolutePath, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
        const candidate = stablePath(path.join(absolutePath, entry.name));
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        results.push({
          absolutePath: candidate,
          provider,
          source: "provider-profile",
          sourceLabel: `${profile.label} plugin directory`,
          label: entry.name,
          executable: Boolean(fs.statSync(candidate).mode & 0o111),
          activationProven: true,
          evidence: { profile: provider, configuredPath, discovery: "recognized-plugin-directory" },
        });
      }
      continue;
    }
    if (!stats.isFile()) continue;
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")); } catch {}
    if (!objectHasConfiguredHooks(parsed?.hooks)) continue;
    const candidate = stablePath(absolutePath);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    results.push({
      absolutePath: candidate,
      provider,
      source: "provider-profile",
      sourceLabel: `${profile.label} hook configuration`,
      label: path.basename(candidate),
      event: Object.keys(parsed.hooks).sort().join(", "),
      executable: false,
      activationProven: true,
      evidence: { profile: provider, configuredPath, discovery: "parsed-hooks-configuration" },
    });
  }
  return results;
}

export function createContextInventoryReaders(overrides = {}) {
  return Object.freeze({
    listProjects: (options) => listContextHubProjects(options),
    readSettings: (root) => readMemoryWebappSettings(root),
    listInstructions: (root, settings) => listStartupContextFiles(root, settings),
    listProviderInstructions: (root, folder, provider) => defaultListProviderInstructions(root, folder, provider),
    listSkillFolders: (root, settings) => listStartupSkillFolders(root, settings),
    listProviderSkillFolders: (root, folder, provider) => defaultListProviderSkillFolders(root, folder, provider),
    listHooks: (root, settings) => listStartupHookFiles(root, settings),
    listProviderHookSources: (root, folder, provider) => defaultListProviderHookSources(root, folder, provider),
    listDocuments: (root) => listMemoryFiles(root, { readOnly: true }),
    readDocument: (root, relPath) => readMemoryFile(root, relPath, { readOnly: true }),
    readReviewState: (root) => readDocReviewState(root, { readOnly: true }),
    readGlobalReviewLedger: (root) => readGlobalReviewLedger(root, { readOnly: true }),
    readReviewQueue: (root) => buildAgentReviewQueue(root, { readOnly: true }),
    readDoctor: (root) => buildContextRoomDoctorReport(root, { readOnly: true }),
    readSharedConnection: (root) => readSharedProjectConnection(root),
    readSharedStatus: (root) => sharedContextStatus(root),
    verifySharedMain: (repository, options) => readSharedMainRevision(repository, options),
    readSharedDocuments: defaultReadSharedDocuments,
    readSharedSkills: (root, options) => sharedSkillEffectiveProjection(root, options),
    readSharedInstructions: (root, options) => sharedInstructionLocationsStatus(root, options),
    listProposals: (root, options) => listSharedProposals(root, options),
    ...overrides,
  });
}

function normalizeTarget(target, readers) {
  const source = typeof target === "string" ? { root: target } : (target || {});
  const root = source.root || source.location?.root || "";
  const resolvedRoot = root ? stablePath(root) : "";
  const projects = readers.listProjects({ refreshGit: false }) || [];
  const registered = projects.filter((item) => item.available !== false && resolvedRoot && stablePath(item.root) === resolvedRoot);
  const selected = registered[0] || null;
  const folderAbsolute = resolvedRoot
    ? stablePath(source.folderAbsolute || source.folder?.absolutePath || path.join(resolvedRoot, typeof source.folder === "string" ? source.folder : source.folder?.path || "."))
    : "";
  if (resolvedRoot) folderChain(resolvedRoot, folderAbsolute);
  const projectId = String(source.projectId || source.project?.id || selected?.logicalProjectId || selected?.id || source.shared?.projectId || "").trim();
  if (!projectId) throw inventoryError("context-target-missing", "Context inventory requires a project identity.");
  const locationId = String(source.locationId || source.location?.id || selected?.id || "").trim();
  return {
    root: resolvedRoot,
    projectId,
    locationId,
    folder: resolvedRoot ? (unixPath(path.relative(resolvedRoot, folderAbsolute)) || ".") : ".",
    folderAbsolute,
    sharedProjectId: String(source.sharedProjectId || source.project?.sharedProjectId || source.shared?.projectId || selected?.shared?.projectId || "").trim(),
    registered: Boolean(selected || source.registered),
    projects,
  };
}

function registeredTargetsFor(target, provider) {
  const selected = target.projects.find((item) => item.id === target.locationId);
  const registeredLogicalProjectId = selected?.logicalProjectId || target.projectId;
  return target.projects.map((item) => ({
    projectId: item.logicalProjectId === registeredLogicalProjectId ? target.projectId : (item.logicalProjectId || item.id),
    locationId: item.id,
    folder: ".",
    provider,
  }));
}

function addResource(inventory, resource, application = null) {
  const existing = inventory.resourceIds.get(resource.id);
  if (!existing) {
    inventory.resourceIds.set(resource.id, resource);
    inventory.resources.push(resource);
  }
  if (application) {
    const applicationId = [resource.id, coordinateId(application.coordinate), application.scope || "project", application.destination || "", application.subtree || ""].join("\0");
    if (!inventory.applicationIds.has(applicationId)) {
      inventory.applicationIds.add(applicationId);
      inventory.applications.push({ ...application, resourceId: resource.id });
      inventory.relations.push({ from: resource.id, to: coordinateId(application.coordinate), type: "applies-to", evidence: application.evidence || null });
    }
  }
  return existing || resource;
}

function expandProvenDeviceApplications(inventory) {
  const resources = new Map(inventory.resources.map((resource) => [resource.id, resource]));
  const originals = [...inventory.applications];
  for (const application of originals) {
    if (application.scope !== "device" || !application.evidence || application.status === "uncertain" || application.evidence.consumerSource === "accepted-assignment-consumers") continue;
    const resource = resources.get(application.resourceId);
    if (!resource) continue;
    for (const registeredTarget of inventory.registeredTargets) {
      if (registeredTarget.locationId === application.coordinate.locationId) continue;
      addResource(inventory, resource, {
        ...application,
        coordinate: { ...registeredTarget, provider: application.coordinate.provider },
        reason: `${application.reason} This device-scoped resource also applies to this explicitly registered location.`,
        evidence: { ...application.evidence, consumerSource: "context-hub-registry" },
      });
    }
  }
}

function localFileVersion(absolutePath) {
  try { return sha256(fs.readFileSync(absolutePath)); } catch { return "missing"; }
}

function applicationStatus({ providers, provider, enabled = true, review = null, uncertain = false }) {
  if (!enabled) return "disabled";
  if (!providerApplies(providers, provider)) return "inactive";
  if (review?.required) return "unverified";
  if (uncertain) return "uncertain";
  return "active";
}

function addLocalInstructions(inventory, target, coordinate, settings, queue, reviewState, globalLedger, readers) {
  const chain = new Set(folderChain(target.root, target.folderAbsolute));
  const exact = readers.listProviderInstructions(target.root, target.folderAbsolute, coordinate.provider) || [];
  const legacy = readers.listInstructions(target.root, settings) || [];
  const seen = new Set();
  const accepted = [...exact, ...legacy].filter((item) => {
    const absolutePath = item.startupContext?.absolutePath;
    if (!absolutePath || (item.startupContext?.source !== "global" && !chain.has(stablePath(path.dirname(absolutePath))))) return false;
    const identity = stablePath(absolutePath);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((left, right) => {
    const leftPath = left.startupContext?.absolutePath || "";
    const rightPath = right.startupContext?.absolutePath || "";
    const leftGlobal = left.startupContext?.source === "global" ? 0 : 1;
    const rightGlobal = right.startupContext?.source === "global" ? 0 : 1;
    return leftGlobal - rightGlobal || leftPath.split(path.sep).length - rightPath.split(path.sep).length || leftPath.localeCompare(rightPath);
  });
  let previous = null;
  accepted.forEach((item, index) => {
    const details = item.startupContext || {};
    const absolutePath = stablePath(details.absolutePath);
    const relPath = isWithin(target.root, absolutePath) ? unixPath(path.relative(target.root, absolutePath)) : displayPath(absolutePath);
    const providers = providersForFile(path.basename(absolutePath), details.provider || "");
    const version = localFileVersion(absolutePath);
    const verified = currentVerifiedReview({ root: target.root, relPath, absolutePath, contentHash: version, reviewState, globalLedger });
    const pending = queue.get(relPath) || queue.get(details.displayPath) || queue.get(absolutePath) || null;
    const review = verified
      ? { required: false, status: "verified", reviewedAt: verified.reviewedAt || null }
      : { required: true, status: pending?.review?.status || "unverified", reason: pending?.reviewReason || "unverified-current" };
    const resource = {
      id: resourceIdForFile(absolutePath),
      kind: "instruction",
      source: details.source === "global" ? "device" : "local",
      locator: displayPath(absolutePath),
      providers,
      version,
      truthState: review.required ? "unverified" : "accepted",
      review,
      metadata: { name: path.basename(absolutePath), absolutePath, relativePath: relPath },
    };
    addResource(inventory, resource, {
      coordinate,
      status: applicationStatus({ providers, provider: coordinate.provider, enabled: settings.startupContext?.enabled !== false }),
      scope: details.source === "global" ? "device" : path.dirname(absolutePath) === target.root ? "project" : "subtree",
      subtree: details.source === "global" ? "." : (unixPath(path.relative(target.root, path.dirname(absolutePath))) || "."),
      order: index,
      reason: details.source === "global" ? "Configured global instruction applies before project instructions." : "Instruction is in the selected folder ancestor chain.",
      evidence: details.evidence || { scanner: "startup-context", source: details.source || "ancestor" },
    });
    if (previous) inventory.relations.push({ from: previous.id, to: resource.id, type: /override/i.test(path.basename(absolutePath)) ? "overridden-by" : "precedes", evidence: { order: index } });
    previous = resource;
  });
}

function addLocalSkills(inventory, target, coordinate, settings, queue, readers) {
  let order = 1000;
  const legacy = (readers.listSkillFolders(target.root, settings) || []).map((folder) => ({
    ...folder,
    providers: coordinate.provider === "all" ? ["all"] : [coordinate.provider],
    source: folder.readOnly ? "local-managed" : "local",
    activationProven: false,
  }));
  const exact = readers.listProviderSkillFolders(target.root, target.folderAbsolute, coordinate.provider) || [];
  for (const folder of [...exact, ...legacy]) {
    for (const skillName of folder.skills || []) {
      const directoryCandidate = path.join(folder.absolutePath, skillName, "SKILL.md");
      const fileCandidate = path.join(folder.absolutePath, `${skillName}.md`);
      const absolutePath = fs.existsSync(directoryCandidate) ? directoryCandidate : fileCandidate;
      const providers = folder.providers || ["all"];
      const version = localFileVersion(absolutePath);
      const relPath = isWithin(target.root, absolutePath) ? unixPath(path.relative(target.root, absolutePath)) : displayPath(absolutePath);
      const pending = queue.get(relPath) || queue.get(displayPath(absolutePath)) || queue.get(absolutePath) || null;
      const review = pending ? { required: true, status: pending.review?.status || "unverified", reason: pending.reviewReason || "unverified-current" } : null;
      addResource(inventory, {
        id: resourceIdForFile(absolutePath),
        kind: "skill",
        source: folder.source || (folder.readOnly ? "local-managed" : "local"),
        locator: displayPath(absolutePath),
        providers,
        version,
        truthState: review?.required ? "unverified" : "accepted",
        review,
        metadata: { name: skillName, absolutePath: stablePath(absolutePath), folder: folder.displayPath, readOnly: Boolean(folder.readOnly) },
      }, {
        coordinate,
        status: applicationStatus({ providers, provider: coordinate.provider, enabled: settings.startupSkills?.enabled !== false, uncertain: folder.activationProven !== true }),
        scope: folder.scope || (isWithin(target.root, folder.absolutePath) ? "project" : "device"),
        subtree: folder.subtree || ".",
        order: order++,
        reason: folder.activationProven ? `Discovered in an exact ${coordinate.provider} skill location.` : `Skill exists in a legacy configured folder, but ${coordinate.provider} activation is not proven by the provider profile.`,
        evidence: folder.activationProven ? folder.evidence : null,
      });
    }
  }
}

function addHooks(inventory, target, coordinate, settings, readers) {
  let order = 2000;
  const legacy = readers.listHooks(target.root, settings) || [];
  const exact = readers.listProviderHookSources(target.root, target.folderAbsolute, coordinate.provider) || [];
  for (const item of [...exact, ...legacy]) {
    const hook = item.startupHook || item;
    if (!hook.absolutePath) continue;
    const absolutePath = stablePath(hook.absolutePath);
    const providers = providersForFile(path.basename(absolutePath), hook.provider || "");
    const proven = hook.activationProven === true
      || (["git-hooks", "core-hooks-path"].includes(hook.source) && hook.executable === true);
    addResource(inventory, {
      id: resourceIdForFile(absolutePath),
      kind: "hook",
      source: "local",
      locator: displayPath(absolutePath),
      providers,
      version: localFileVersion(absolutePath),
      truthState: "discovered",
      metadata: { name: hook.label || path.basename(absolutePath), absolutePath, event: hook.event || "", executable: Boolean(hook.executable), tracked: Boolean(hook.tracked) },
    }, {
      coordinate,
      status: applicationStatus({ providers, provider: coordinate.provider, enabled: settings.startupHooks?.enabled !== false, uncertain: !proven }),
      scope: isWithin(target.root, absolutePath) ? "project" : "device",
      order: order++,
      reason: proven ? `${hook.sourceLabel || hook.source || "Configured"} hook is linked to a recognized provider or Git hook source.` : "Hook source was discovered, but activation is not proven.",
      evidence: proven ? (hook.evidence || { scanner: "startup-hooks", source: hook.source || "", event: hook.event || "" }) : null,
    });
  }
}

function addProviderConfigs(inventory, target, coordinate) {
  if (coordinate.provider === "all") return;
  const profile = contextProviderProfile(coordinate.provider);
  let order = 3000;
  for (const configuredPath of profile.configuration || []) {
    const absolutePath = configuredPath.startsWith("~") ? expandHome(configuredPath) : path.join(target.root, configuredPath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    addResource(inventory, {
      id: resourceIdForFile(absolutePath),
      kind: "provider-config",
      source: configuredPath.startsWith("~") ? "device" : "local",
      locator: displayPath(absolutePath),
      providers: [coordinate.provider],
      version: localFileVersion(absolutePath),
      truthState: "accepted",
      metadata: { name: path.basename(absolutePath), absolutePath: stablePath(absolutePath) },
    }, {
      coordinate,
      status: "active",
      scope: configuredPath.startsWith("~") ? "device" : "project",
      order: order++,
      reason: `Recognized ${profile.label} configuration location.`,
      evidence: { profile: profile.id, profileVersion: profile.version, source: configuredPath },
    });
  }
}

function addAcceptedLocalDocuments(inventory, target, coordinate, readers, queue = new Map()) {
  const reviewState = readers.readReviewState(target.root) || { reviews: {} };
  const globalLedger = readers.readGlobalReviewLedger(target.root) || { reviews: {} };
  const managedPaths = new Set((readers.listDocuments(target.root) || []).filter((item) => item.exists !== false).map((item) => unixPath(item.path)));
  const candidates = new Set([
    ...managedPaths,
    ...Object.keys(reviewState.reviews || {}),
    ...Object.values(globalLedger.reviews || {}).filter((item) => item?.root && stablePath(item.root) === target.root).map((item) => unixPath(item.relPath || "")),
  ]);
  let order = 4000;
  for (const relPath of candidates) {
    if (!relPath || !managedPaths.has(relPath)) continue;
    let file;
    try { file = readers.readDocument(target.root, relPath); } catch { continue; }
    if (!file?.exists) continue;
    const absolutePath = path.isAbsolute(relPath) ? relPath : path.join(target.root, relPath);
    const metadata = parseDocMetadata(file.content || "", relPath);
    if (!metadata.present || metadata.status !== "current") continue;
    const exactReview = currentVerifiedReview({ root: target.root, relPath, absolutePath, contentHash: file.contentHash || sha256(file.content || ""), reviewState, globalLedger });
    const queuedReview = queue.get(relPath) || queue.get(absolutePath) || null;
    const dependencyReviewRequired = queuedReview?.reviewReason === "dependency-changed";
    const verified = exactReview;
    const resource = {
      id: resourceIdForFile(absolutePath),
      kind: "document",
      source: "local",
      locator: relPath,
      providers: ["all"],
      version: file.contentHash || sha256(file.content || ""),
      truthState: verified ? "accepted" : "unverified",
      review: verified ? {
        status: "verified",
        reviewedAt: verified.reviewedAt || null,
        current: true,
        dependencyFreshness: dependencyReviewRequired ? "needs-review" : "current",
      } : { status: "unverified", current: true, dependencyFreshness: dependencyReviewRequired ? "needs-review" : "unknown" },
      metadata: {
        ...metadata,
        documentStatus: metadata.status,
        managed: true,
        absolutePath: stablePath(absolutePath),
        relativePath: relPath,
        dependencyReviewRequired,
        dependencyFreshness: dependencyReviewRequired ? "needs-review" : verified ? "current" : "unknown",
        ...(queuedReview?.dependencyChanges?.length ? { dependencyChanges: queuedReview.dependencyChanges } : {}),
      },
    };
    addResource(inventory, resource, {
      coordinate,
      status: verified ? "active" : "unverified",
      scope: metadata.scope || "project",
      order: order++,
      reason: verified
        ? dependencyReviewRequired
          ? "The current content hash remains human-verified; a declared dependency changed and its freshness needs review."
          : "Current managed document hash and its direct dependency versions were explicitly verified by a human."
        : "Current managed document hash has not been verified by a human.",
      evidence: verified ? { reviewSource: verified.source, contentHash: resource.version } : null,
    });
  }
}

function addSharedDocuments(inventory, main, sharedProjectId, coordinate, readers) {
  let order = 5000;
  for (const item of readers.readSharedDocuments(main, { projectId: sharedProjectId }) || []) {
    const metadata = item.metadata || parseDocMetadata(item.content || "", item.path);
    if (!metadata.present || metadata.status !== "current") continue;
    const resource = {
      id: resourceIdForShared(main.repository, item.path),
      kind: "document",
      source: "shared-main",
      locator: `shared://${main.repository}/${unixPath(item.path)}`,
      providers: ["all"],
      version: `${main.revision}:${item.contentHash || sha256(item.content || "")}`,
      truthState: "accepted",
      review: { status: "accepted", revision: main.revision },
      metadata: { ...metadata, documentStatus: metadata.status, managed: true, repository: main.repository, gitPath: unixPath(item.path), revision: main.revision },
    };
    addResource(inventory, resource, {
      coordinate,
      status: "active",
      scope: metadata.scope || "project",
      order: order++,
      reason: `Document is current at accepted ${main.defaultBranch} revision ${main.revision}.`,
      evidence: { repository: main.repository, revision: main.revision, defaultBranch: main.defaultBranch, gitPath: item.path },
    });
  }
}

function addSharedSkills(inventory, projection, coordinate, acceptedRevision, target) {
  if (!projection?.connected || !projection.revision || projection.revision !== acceptedRevision) return;
  const collections = new Map((projection.collections || []).map((item) => [item.id, item]));
  let order = 6000;
  for (const destination of projection.destinations || []) {
    const collection = collections.get(destination.collectionId) || {};
    for (const skill of destination.skills || []) {
      const gitPath = `${collection.path || destination.collectionId}/${skill}/SKILL.md`;
      const target = (destination.target || []).find((item) => item.skill === skill)?.target || "";
      const skillFile = target && fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, "SKILL.md") : target;
      const blob = skillFile && fs.existsSync(skillFile) && fs.statSync(skillFile).isFile() ? localFileVersion(skillFile) : "unknown";
      const providers = destination.provider === "custom" ? ["all"] : [destination.provider];
      const status = destination.status === "ready" ? "active"
        : destination.status === "provider-disabled" ? "disabled"
          : destination.status === "shadowed" ? "shadowed"
            : destination.status === "disabled" ? "disabled" : "uncertain";
      const resource = {
        id: resourceIdForShared(projection.repository, gitPath),
        kind: "skill",
        source: "shared-main",
        locator: `shared://${projection.repository}/${gitPath}`,
        providers,
        version: `${acceptedRevision}:${blob}`,
        truthState: "accepted",
        metadata: { name: skill, repository: projection.repository, gitPath, revision: acceptedRevision, collectionId: destination.collectionId },
      };
      const provider = destination.provider === "custom" ? coordinate.provider : destination.provider;
      const registeredByRoot = new Map(target.projects.map((item) => [stablePath(item.root), item]));
      const consumerTargets = destination.scope === "device"
        ? inventory.registeredTargets.map((item) => ({ ...item, provider }))
        : (destination.consumers || []).flatMap((consumer) => {
          if (!consumer.projectRoot) return [];
          const project = registeredByRoot.get(stablePath(consumer.projectRoot));
          if (!project) return [];
          const registered = inventory.registeredTargets.find((item) => item.locationId === project.id);
          return registered ? [{ ...registered, provider }] : [];
        });
      const applications = consumerTargets.length ? consumerTargets : [{ ...coordinate, provider }];
      for (const consumerCoordinate of applications) {
        addResource(inventory, resource, {
          coordinate: consumerCoordinate,
          status,
          scope: destination.scope || "project",
          order: order++,
          destination: destination.destination,
          reason: destination.reason || destination.message || "Accepted Shared Skills assignment exposes this skill through a managed destination.",
          evidence: { assignmentId: destination.assignmentId || "", collectionId: destination.collectionId, revision: acceptedRevision, managed: true, consumerSource: consumerTargets.length ? "accepted-assignment-consumers" : "selected-coordinate" },
        });
      }
      if (destination.assignmentId) inventory.relations.push({ from: resource.id, to: `assignment:${destination.assignmentId}`, type: "assigned-by", evidence: { revision: acceptedRevision } });
    }
  }
}

function addSharedInstructions(inventory, projection, coordinate, acceptedRevision, target) {
  if (!projection?.connected || projection.revision !== acceptedRevision) return;
  const collections = new Map((projection.collections || []).map((item) => [item.id, item]));
  let order = 5000;
  for (const link of projection.links || []) {
    const collection = collections.get(link.collectionId) || {};
    const providers = [link.provider];
    const targetDirectory = link.scope === "device" ? "" : path.dirname(link.destination || "");
    const appliesToFolder = link.scope === "device" || (targetDirectory && isWithin(targetDirectory, target.folderAbsolute));
    const materializationStatus = link.materializationStatus || (link.status === "ready" ? "installed" : link.status);
    const activationStatus = link.activationStatus || "uncertain";
    const status = !providerApplies(providers, coordinate.provider) || !appliesToFolder ? "inactive"
      : link.status === "provider-disabled" || link.status === "provider-unavailable" ? "disabled"
        : ["conflict", "collision", "unmanaged-conflict"].includes(materializationStatus) ? "shadowed"
          : materializationStatus === "installed" && ["active", "configured"].includes(activationStatus) ? "active"
            : materializationStatus === "installed" && activationStatus === "inactive" ? "inactive" : "uncertain";
    const gitPath = `${collection.path || link.collectionId}/${link.source}`;
    const resource = {
      id: resourceIdForShared(projection.repository, gitPath),
      kind: "instruction",
      source: "shared-main",
      locator: `shared://${projection.repository}/${gitPath}`,
      providers,
      version: `${acceptedRevision}:${localFileVersion(link.target)}`,
      truthState: "accepted",
      review: { required: false, status: "accepted-main" },
      metadata: {
        name: path.basename(link.relativeTarget || link.destination || link.source),
        repository: projection.repository,
        gitPath,
        revision: acceptedRevision,
        collectionId: link.collectionId,
        assignmentId: link.assignmentId,
        absolutePath: link.destination,
        relativePath: link.relativeTarget,
        materializationStatus,
        activationStatus,
        activationReason: link.activationReason || "",
      },
    };
    addResource(inventory, resource, {
      coordinate,
      status,
      scope: link.scope || "project",
      subtree: link.scope === "device" ? "." : (unixPath(path.relative(target.root, targetDirectory)) || "."),
      order: order++,
      destination: link.destination,
      reason: link.message || link.activationReason || "Accepted Shared Instructions assignment exposes this instruction through a managed link.",
      evidence: { assignmentId: link.assignmentId, collectionId: link.collectionId, revision: acceptedRevision, managed: true, materializationStatus, activationStatus },
    });
    inventory.relations.push({ from: resource.id, to: `assignment:${link.assignmentId}`, type: "assigned-by", evidence: { revision: acceptedRevision } });
  }
}

function addProposalMetadata(inventory, proposals, coordinate) {
  for (const proposal of proposals || []) {
    const id = `proposal:${proposal.repository || "shared"}:${proposal.branch || proposal.id || proposal.head}`;
    inventory.proposals.push({ id, title: proposal.title || proposal.branch || id, head: proposal.head || "", status: proposal.reviewStatus || proposal.status || "open" });
    inventory.resources.push({
      id,
      kind: "proposal",
      source: "shared-proposal",
      locator: proposal.branch || proposal.id || id,
      providers: ["all"],
      version: proposal.head || "unknown",
      truthState: "proposal",
      review: { status: proposal.reviewStatus || "open" },
      metadata: { title: proposal.title || "", description: proposal.description || "", fileCount: proposal.fileCount || proposal.files?.length || 0, scope: proposal.scope || "project" },
    });
    inventory.resourceIds.set(id, inventory.resources.at(-1));
    inventory.relations.push({ from: id, to: coordinateId(coordinate), type: "proposal-for", evidence: { metadataOnly: true } });
  }
}

/**
 * Convert Context Room's existing read-only scanners and registries into the
 * structural inventory consumed by context_engine.mjs. Readers are injectable
 * so tests and offline callers never need network or mutable reconciliation.
 */
export function buildContextInventory(targetInput, options = {}) {
  const readers = createContextInventoryReaders(options.readers || {});
  const target = normalizeTarget(targetInput, readers);
  const provider = String(options.provider || targetInput?.provider || "codex").trim().toLowerCase();
  if (provider !== "all" && !PROVIDERS.has(provider)) throw inventoryError("unsupported-provider", `Unsupported context provider: ${provider}`);
  const coordinate = { projectId: target.projectId, locationId: target.locationId, folder: options.folder || target.folder, provider };
  const inventory = {
    coordinate,
    resolverVersion: "context-inventory/1",
    localEnvironment: target.root ? "available" : "unavailable",
    freshness: { state: "fresh", verified: true, source: "local" },
    resources: [], applications: [], relations: [], proposals: [], healthIssues: [],
    registeredTargets: registeredTargetsFor(target, provider),
    resourceIds: new Map(),
    applicationIds: new Set(),
  };

  let sharedConnection = target.root ? readers.readSharedConnection(target.root) : null;
  if (!sharedConnection && targetInput?.shared?.repository) sharedConnection = { ...targetInput.shared, projectId: target.sharedProjectId || targetInput.shared.projectId };
  let sharedMain = null;
  if (sharedConnection?.repository) {
    const refreshShared = options.refreshShared !== false;
    try {
      if (refreshShared) {
        sharedMain = readers.verifySharedMain(sharedConnection.repository, { refresh: true });
        inventory.freshness = { state: "fresh", verified: true, source: "shared-main", repository: sharedMain.repository, revision: sharedMain.revision, defaultBranch: sharedMain.defaultBranch };
        for (const review of sharedMain.commit?.dependencyReviewRequired || []) {
          inventory.healthIssues.push({
            type: "dependency_review_required",
            severity: "medium",
            path: review.path,
            resourceId: review.documentId ? `shared-document:${review.documentId}` : "",
            scope: "shared",
            provider: "all",
            message: `${review.path} depends on accepted shared documents that changed without dependency-review proof.`,
            dependencies: review.dependencies || [],
            revision: sharedMain.revision,
          });
        }
      } else {
        const status = target.root ? readers.readSharedStatus(target.root) : null;
        if (status?.revision) {
          sharedMain = {
            repository: sharedConnection.repository,
            revision: status.revision,
            defaultBranch: status.defaultBranch || status.repositoryConfig?.defaultBranch || "",
            repositoryConfig: status.repositoryConfig,
            checkout: status.checkout || "",
          };
        }
        inventory.freshness = { state: status?.online === false ? "offline" : "stale", verified: false, source: "shared-cache", repository: sharedConnection.repository, revision: status?.revision || "" };
        if (!options.allowStale) throw inventoryError("shared-freshness-unverified", "The accepted shared revision was not freshly verified.", { repository: sharedConnection.repository, revision: status?.revision || "" });
      }
    } catch (error) {
      if (!options.allowStale || error?.code === "shared-freshness-unverified") throw error?.code ? error : inventoryError("shared-freshness-unverified", error.message, { repository: sharedConnection.repository });
      const status = target.root ? readers.readSharedStatus(target.root) : null;
      inventory.freshness = { state: status?.online === false ? "offline" : "stale", verified: false, source: "shared-cache", repository: sharedConnection.repository, revision: status?.revision || "", error: error.message };
      if (status?.revision) sharedMain = { repository: sharedConnection.repository, revision: status.revision, defaultBranch: status.defaultBranch || status.repositoryConfig?.defaultBranch || "", repositoryConfig: status.repositoryConfig, checkout: status.checkout || "" };
    }
  }

  if (target.root) {
    const settings = readers.readSettings(target.root);
    const queueReport = readers.readReviewQueue(target.root) || { queue: [] };
    const queue = reviewIndex(queueReport.queue || []);
    const reviewState = readers.readReviewState(target.root) || { reviews: {} };
    const globalLedger = readers.readGlobalReviewLedger(target.root) || { reviews: {} };
    addLocalInstructions(inventory, target, coordinate, settings, queue, reviewState, globalLedger, readers);
    addLocalSkills(inventory, target, coordinate, settings, queue, readers);
    addHooks(inventory, target, coordinate, settings, readers);
    addProviderConfigs(inventory, target, coordinate);
    addAcceptedLocalDocuments(inventory, target, coordinate, readers, queue);
    const doctor = readers.readDoctor(target.root) || { issues: [] };
    inventory.healthIssues.push(...(doctor.issues || []));
  }

  if (sharedMain?.revision && sharedMain.repositoryConfig && sharedConnection?.projectId) {
    addSharedDocuments(inventory, sharedMain, sharedConnection.projectId, coordinate, readers);
    if (target.root) {
      let instructionProjection = null;
      try { instructionProjection = readers.readSharedInstructions(target.root, { refresh: false }); } catch {}
      addSharedInstructions(inventory, instructionProjection, coordinate, sharedMain.revision, target);
      let projection = null;
      try { projection = readers.readSharedSkills(target.root, { refresh: false, provider }); } catch {}
      addSharedSkills(inventory, projection, coordinate, sharedMain.revision, target);
      let proposals = [];
      try { proposals = readers.listProposals(target.root, { allProjects: true, refresh: false }); } catch {}
      addProposalMetadata(inventory, proposals, coordinate);
    }
  }

  inventory.healthIssues = inventory.healthIssues.map((issue) => normalizeHealthIssue(issue, inventory.resources));
  for (const issue of inventory.healthIssues) {
    if (issue.resourceId) inventory.relations.push({ from: issue.resourceId, to: `health:${issue.key || issue.type || sha256(JSON.stringify(issue)).slice(0, 12)}`, type: "has-health-issue", evidence: { severity: issue.severity || "", type: issue.type || "" } });
  }
  expandProvenDeviceApplications(inventory);
  delete inventory.resourceIds;
  delete inventory.applicationIds;
  return inventory;
}

export function createContextInventoryAdapter(options = {}) {
  return (coordinate, runtimeOptions = {}) => buildContextInventory({
    ...(options.target || {}),
    projectId: coordinate.projectId,
    locationId: coordinate.locationId,
    folder: coordinate.folder,
  }, { ...options, ...runtimeOptions, provider: coordinate.provider, folder: coordinate.folder });
}
