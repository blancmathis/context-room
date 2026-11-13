// Skills and MCP servers of one project, level by level and for every provider at once (decision 11, next to the
// agent files of context_levels.mjs): global (this device), the project root, then each subfolder that adds its own.
// Read-only, names and sources only: no value of an MCP configuration (command, arguments, URL, env, headers) leaves here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { listContextProviderProfiles } from "./provider_profiles.mjs";
import { frontmatterField } from "./context_losses.mjs";
import { estimateTokens } from "./documentation.mjs";
import { createContextInventoryReaders } from "./context_inventory.mjs";
import { agentLevelFolders } from "./context_levels.mjs";

const MAX_ROWS = 600;
const MAX_DESCRIPTION = 200;

const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const listed = (read) => { try { return read() || []; } catch { return []; } };
const withoutFrontmatter = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
const projectPaths = (profile) => (profile.mcp || []).map((source) => source.path).filter((item) => !item.startsWith("~"));

/** The paths, relative to one folder, that make that folder a level here: a skills folder or an MCP file of any provider. */
export function toolLevelMarkers() {
  return [...new Set(listContextProviderProfiles().flatMap((profile) => [...(profile.skills.project || []), ...projectPaths(profile)]))];
}

/**
 * `{ providers, skills, mcp, truncated }`. `skills` and `mcp` are levels `{ level, items }`, global first, then the
 * root, then subfolders. One item per file (skills) or per server and file (MCP), with every provider that reads it.
 * `duplicates` lists the other items one provider sees under the same name; `same` tells if their content is equal
 * (null when unknown). Which one wins is not stated: the provider profiles do not prove it.
 */
export function skillAndMcpLevels(root, { skip, readers = createContextInventoryReaders(), home = os.homedir() } = {}) {
  const base = real(root);
  const homeReal = real(home);
  const profiles = listContextProviderProfiles();
  const inProject = (file) => {
    const rel = path.relative(base, file).replaceAll("\\", "/");
    return rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel) ? rel : "";
  };
  const shown = (file) => inProject(file) || (file === homeReal ? "~" : file.startsWith(homeReal + path.sep) ? "~/" + path.relative(homeReal, file).replaceAll("\\", "/") : file);
  const skills = new Map();
  const servers = new Map();
  let truncated = false;
  const row = (rows, key, make) => {
    if (!rows.has(key)) {
      if (rows.size >= MAX_ROWS) return void (truncated = true);
      rows.set(key, { ...make(), providers: [], duplicates: [] });
    }
    return rows.get(key);
  };
  const reads = (item, provider) => { if (item && !item.providers.includes(provider)) item.providers.push(provider); };

  for (const rel of ["", ...agentLevelFolders(root, "all", { skip, markers: toolLevelMarkers() })]) {
    const folder = path.join(root, rel);
    for (const profile of profiles) {
      for (const location of listed(() => readers.listProviderSkillFolders(root, folder, profile.id))) {
        const level = location.scope === "device" ? "global" : location.scope === "subtree" && location.subtree !== "." ? location.subtree : "root";
        for (const name of location.skills || []) {
          const found = path.join(location.absolutePath, name, "SKILL.md");
          const file = real(found);
          reads(row(skills, level + "\n" + file, () => {
            const text = readText(file);
            const description = text == null ? "" : String(frontmatterField(text, "description") || "");
            return {
              level,
              name,
              description: description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION - 1) + "…" : description,
              source: shown(found),
              // Only a file inside the project opens in the Hub.
              path: level === "global" ? "" : inProject(file),
              startupTokens: text == null ? null : estimateTokens(`${frontmatterField(text, "name") || name}: ${description}`),
              onDemandTokens: text == null ? null : estimateTokens(withoutFrontmatter(text).trim()),
              hash: text == null ? "" : sha(text),
            };
          }), profile.id);
        }
      }
      // A subfolder is read for MCP only when it holds an MCP file of this provider: the device files are not parsed again for nothing.
      if (rel && !projectPaths(profile).some((item) => fs.existsSync(path.join(folder, item)))) continue;
      for (const server of listed(() => readers.listProviderMcpServers(folder, profile.id))) {
        const file = real(server.absolutePath);
        const level = server.scope === "device" ? "global" : rel || "root";
        reads(row(servers, level + "\n" + file + "\n" + server.name, () => ({
          level,
          name: String(server.name),
          source: shown(file),
          // A project entry kept in a device file (Claude Code local scope): it never reaches the repository.
          local: server.scope !== "device" && !inProject(file),
          status: server.disabled ? "disabled" : server.approvalRequired ? "approval" : "configured",
          hash: String(server.fingerprint || ""),
        })), profile.id);
      }
    }
  }

  const order = (name) => name === "global" ? 0 : name === "root" ? 1 : 2;
  const levels = (rows) => {
    const items = [...rows.values()];
    const byName = new Map();
    for (const item of items) byName.set(item.name, [...(byName.get(item.name) || []), item]);
    for (const group of byName.values()) {
      for (const item of group) {
        for (const other of group) {
          const shared = other === item ? [] : item.providers.filter((provider) => other.providers.includes(provider));
          if (shared.length) item.duplicates.push({ level: other.level, source: other.source, providers: shared, same: item.hash && other.hash ? item.hash === other.hash : null });
        }
      }
    }
    const names = new Set(["global", "root", ...items.map((item) => item.level)]);
    return [...names].sort((left, right) => order(left) - order(right) || left.localeCompare(right)).map((level) => ({
      level,
      items: items.filter((item) => item.level === level).sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
        .map(({ hash, level: own, ...item }) => item),
    }));
  };
  return { providers: profiles.map(({ id, label }) => ({ id, label })), skills: levels(skills), mcp: levels(servers), truncated };
}
