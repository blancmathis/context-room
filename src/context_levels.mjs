// What agents load in one project, level by level (R3b, decision 11): global (device and folders above the project),
// the project root, then each subfolder that adds its own instructions or skills. Each file carries its token cost.
import fs from "node:fs";
import path from "node:path";
import { contextProviderProfile, listContextProviderProfiles } from "./provider_profiles.mjs";
import { frontmatterField } from "./context_losses.mjs";
import { estimateTokens } from "./documentation.mjs";
import { markdownFilesBelow } from "./context_inventory.mjs";

const MAX_LEVEL_FOLDERS = 12;
const MAX_VISITED = 400;
const MAX_DEPTH = 6;

/** The paths, relative to one folder, that make that folder a level for this provider. */
export function agentFileMarkers(provider) {
  const profiles = provider === "all" ? listContextProviderProfiles() : [contextProviderProfile(provider)];
  return [...new Set(profiles.flatMap((profile) => [...profile.instructions.projectFiles, ...(profile.instructions.rules?.project ? [profile.instructions.rules.project] : []), ...(profile.skills.project || [])]))];
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

const EXTRA_DOCUMENTS = ["PLAN.md", "CONTEXT.md"];
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const tokensOf = (text) => text ? estimateTokens(text) : 0;
const withoutFrontmatter = (text) => String(text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/**
 * One walk for everything the root's effective context does not hold: the agent files of each subfolder
 * (instruction files and skills, with the same token estimate as the cost of the root) and PLAN.md / CONTEXT.md
 * at the root. No inventory per folder. Rows are `{ level, kind, name, absolutePath, startupTokens, onDemandTokens }`.
 */
export function subfolderAgentRows(root, provider, { skip, limit = MAX_LEVEL_FOLDERS, instructions = true, skills = true, managedOnly = false } = {}) {
  const profiles = provider === "all" ? listContextProviderProfiles() : [contextProviderProfile(provider)];
  const rows = [];
  for (const rel of agentLevelFolders(root, provider, { skip, limit })) {
    const folder = path.join(root, rel);
    const seen = new Set();
    const push = (row) => { if (!seen.has(row.absolutePath)) { seen.add(row.absolutePath); rows.push({ level: rel, ...row }); } };
    for (const profile of profiles) {
      // Same rules as the inventory: one file per folder where the provider takes only one; Claude managed-only drops project files.
      if (instructions && !(profile.id === "claude-code" && managedOnly)) {
        for (const name of profile.instructions.projectFiles) {
          const file = path.join(folder, name);
          const text = readText(file);
          if (text == null) continue;
          push({ kind: "instruction", name: path.basename(name), absolutePath: file, startupTokens: tokensOf(text), onDemandTokens: null });
          if (profile.instructions.onePerDirectory) break;
        }
        if (profile.instructions.rules?.project) {
          for (const file of markdownFilesBelow(path.join(folder, profile.instructions.rules.project))) {
            const text = readText(file);
            if (text != null) push({ kind: "instruction", name: path.basename(file), absolutePath: file, startupTokens: tokensOf(text), onDemandTokens: null });
          }
        }
      }
      if (!skills) continue;
      for (const dir of profile.skills.project || []) {
        let entries = [];
        try { entries = fs.readdirSync(path.join(folder, dir), { withFileTypes: true }); } catch { continue; }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const file = path.join(folder, dir, entry.name, "SKILL.md");
          const text = readText(file);
          if (text == null) continue;
          const name = frontmatterField(text, "name") || entry.name;
          push({ kind: "skill", name: entry.name, absolutePath: file, startupTokens: tokensOf(`${name}: ${frontmatterField(text, "description") || ""}`), onDemandTokens: tokensOf(withoutFrontmatter(text).trim()) });
        }
      }
    }
  }
  for (const name of EXTRA_DOCUMENTS) {
    const file = path.join(root, name);
    const text = readText(file);
    if (text != null) rows.push({ level: "root", kind: "document", name, absolutePath: file, startupTokens: null, onDemandTokens: tokensOf(text) });
  }
  return rows;
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
export function groupAgentLevels(results, { root = "", extra = [] } = {}) {
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
  // Rows found by the single walk (see subfolderAgentRows): skip a file the root context already listed.
  const seenFiles = new Set(results.flatMap(({ effective }) => ["instructions", "skills"].flatMap((kind) => (effective?.[kind] || []).map(({ resource }) => String(resource.metadata?.absolutePath || "")))));
  for (const row of extra) {
    let absolute = row.absolutePath;
    try { absolute = fs.realpathSync(absolute); } catch {}
    if (seenFiles.has(absolute)) continue;
    seenFiles.add(absolute);
    const relPath = base ? path.relative(base, absolute).replaceAll("\\", "/") : "";
    if (!levels.has(row.level)) levels.set(row.level, []);
    levels.get(row.level).push({
      kind: row.kind,
      name: row.name,
      locator: absolute,
      path: relPath && !relPath.startsWith("../") && !path.isAbsolute(relPath) ? relPath : "",
      startupTokens: row.startupTokens,
      onDemandTokens: row.onDemandTokens,
    });
  }
  const order = (name) => name === "global" ? 0 : name === "root" ? 1 : 2;
  return [...levels]
    .filter(([name, files]) => files.length || name !== "global")
    .sort(([left], [right]) => order(left) - order(right) || left.localeCompare(right))
    .map(([name, files]) => ({
      level: name,
      files,
      startupTokens: files.reduce((sum, file) => sum + (file.startupTokens || 0), 0),
      // PLAN.md / CONTEXT.md are read on request, not loaded by the agent: counted apart from skill bodies.
      onDemandTokens: files.reduce((sum, file) => sum + (file.kind === "document" ? 0 : file.onDemandTokens || 0), 0),
      documentTokens: files.reduce((sum, file) => sum + (file.kind === "document" ? file.onDemandTokens || 0 : 0), 0),
    }));
}
