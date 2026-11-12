// What agents load in one project, level by level (R3b, decision 11): global (device and folders above the project),
// the project root, then each subfolder that adds its own instructions or skills. Each file carries its token cost.
import fs from "node:fs";
import path from "node:path";
import { contextProviderProfile, listContextProviderProfiles } from "./provider_profiles.mjs";

const MAX_LEVEL_FOLDERS = 12;
const MAX_VISITED = 400;
const MAX_DEPTH = 6;

/** The paths, relative to one folder, that make that folder a level for this provider. */
export function agentFileMarkers(provider) {
  const profiles = provider === "all" ? listContextProviderProfiles() : [contextProviderProfile(provider)];
  return [...new Set(profiles.flatMap((profile) => [...profile.instructions.projectFiles, ...(profile.skills.project || [])]))];
}

/** Subfolders (never the root) that hold an agent file or a skill folder. Breadth first, bounded. */
export function agentLevelFolders(root, provider, { skip = (name) => name.startsWith("."), limit = MAX_LEVEL_FOLDERS } = {}) {
  const markers = agentFileMarkers(provider);
  const found = [];
  const queue = [{ rel: "", depth: 0 }];
  let visited = 0;
  while (queue.length && found.length < limit && visited < MAX_VISITED) {
    const { rel, depth } = queue.shift();
    visited += 1;
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    if (rel && markers.some((marker) => fs.existsSync(path.join(root, rel, marker)))) found.push(rel);
    if (depth >= MAX_DEPTH) continue;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !skip(entry.name)) queue.push({ rel: rel ? rel + "/" + entry.name : entry.name, depth: depth + 1 });
    }
  }
  return found;
}

function levelOf(application) {
  if (application.scope === "device") return "global";
  const subtree = String(application.subtree || ".").replaceAll("\\", "/");
  if (subtree === ".." || subtree.startsWith("../")) return "global";
  return application.scope === "subtree" && subtree !== "." ? subtree : "root";
}

/**
 * Groups the instructions and skills of several effective contexts (one per folder, each with its `cost`)
 * into levels. A file seen from many folders is listed once, at its own level.
 */
export function groupAgentLevels(results, { root = "" } = {}) {
  const levels = new Map([["global", []], ["root", []]]);
  const seen = new Set();
  // File paths come from realpath: compare them to the real root too (a root under a link, /var -> /private/var).
  let base = root;
  try { if (root) base = fs.realpathSync(root); } catch {}
  for (const { effective } of results) {
    const entries = effective?.cost?.entries || {};
    for (const kind of ["instructions", "skills"]) {
      for (const { resource, application } of effective?.[kind] || []) {
        if (seen.has(resource.id)) continue;
        seen.add(resource.id);
        const level = levelOf(application);
        const cost = entries[resource.id] || {};
        const absolute = String(resource.metadata?.absolutePath || "");
        const relPath = base && absolute ? path.relative(base, absolute).replaceAll("\\", "/") : "";
        if (!levels.has(level)) levels.set(level, []);
        levels.get(level).push({
          kind: kind === "skills" ? "skill" : "instruction",
          name: String(resource.metadata?.name || path.basename(resource.locator || "")),
          locator: String(resource.locator || ""),
          // Only a file inside the project opens in the Hub.
          path: level !== "global" && relPath && !relPath.startsWith("../") && !path.isAbsolute(relPath) ? relPath : "",
          startupTokens: cost.startupTokens ?? null,
          onDemandTokens: cost.onDemandTokens ?? null,
        });
      }
    }
  }
  const order = (name) => name === "global" ? 0 : name === "root" ? 1 : 2;
  return [...levels]
    .filter(([name, files]) => files.length || name !== "global")
    .sort(([left], [right]) => order(left) - order(right) || left.localeCompare(right))
    .map(([name, files]) => ({
      level: name,
      files,
      startupTokens: files.reduce((sum, file) => sum + (file.startupTokens || 0), 0),
      onDemandTokens: files.reduce((sum, file) => sum + (file.onDemandTokens || 0), 0),
    }));
}
