import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const DOCUMENT_PATH = /\.(?:md|mdx|markdown|html?)$/i;
const DAY_MS = 86400000;
const DEFAULT_RETENTION_DAYS = 30;

export function claudeCodeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
}

// Claude Code keeps a project's sessions in a folder named after its path, every
// character other than a letter or digit replaced by "-".
export function claudeCodeProjectSlug(root) {
  return path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
}

function retentionDays(home) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).cleanupPeriodDays;
    if (Number.isFinite(value) && value > 0) return value;
  } catch {}
  return DEFAULT_RETENTION_DAYS;
}

function sessionFiles(directory, since, found = []) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tool-results") sessionFiles(full, since, found);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try { if (fs.statSync(full).mtimeMs >= since) found.push(full); } catch {}
    }
  }
  return found;
}

// Complete lines only: the last line of a session being written may be cut.
function* completeLines(file) {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(1 << 20);
  const decoder = new StringDecoder("utf8");
  let rest = "";
  try {
    for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      const lines = (rest + decoder.write(chunk.subarray(0, read))).split("\n");
      rest = lines.pop();
      yield* lines;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function tally(map, key, sessionId, at) {
  const item = map.get(key) || { calls: 0, sessions: new Set(), lastUsedAt: "" };
  item.calls += 1;
  item.sessions.add(sessionId);
  if (at > item.lastUsedAt) item.lastUsedAt = at;
  map.set(key, item);
}

function ranked(map, key) {
  return [...map].map(([name, item]) => ({ [key]: name, uses: item.sessions.size, calls: item.calls, lastUsedAt: item.lastUsedAt }))
    .sort((left, right) => right.uses - left.uses || right.calls - left.calls || left[key].localeCompare(right[key]));
}

// Read-only counts of the skills Claude Code invoked and the project documents it read
// (Read tool, or a shell command naming the path) in this project over the last `days` days. A use is a session; calls copied into a
// forked or resumed session count once. "Not used" lists only appear when coverage is
// complete. Nothing is written and nothing leaves the machine.
export function claudeCodeUsage(root, { days = 30, now = Date.now(), home = claudeCodeHome(), documents = [], startup = [], skills = [] } = {}) {
  const roots = new Set([path.resolve(root)]);
  try { roots.add(fs.realpathSync(root)); } catch {}
  const inside = (cwd) => [...roots].some((base) => cwd === base || String(cwd || "").startsWith(`${base}${path.sep}`));
  const since = now - days * DAY_MS;
  const sinceIso = new Date(since).toISOString(), untilIso = new Date(now).toISOString();
  const projectsDir = path.join(home, "projects");
  const slugs = new Set([...roots].map(claudeCodeProjectSlug));
  let folders = [];
  try {
    folders = fs.readdirSync(projectsDir).filter((name) => [...slugs].some((slug) => name === slug || name.startsWith(`${slug}-`)));
  } catch {}
  const files = folders.flatMap((folder) => sessionFiles(path.join(projectsDir, folder), since)).sort();
  const knownSkills = new Set(skills);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A shell command reads a document when it names its path as a whole word, relative or absolute.
  const prefixes = [...roots].map((base) => `${escape(base)}/`).join("|");
  const documentPatterns = documents.map((relPath) => [relPath, new RegExp(`(?:^|[\\s'"=(])(?:${prefixes})?${escape(relPath)}(?=$|[\\s'"):;,|&])`)]);
  const seen = new Set(), sessions = new Set(), skillUse = new Map(), documentUse = new Map();
  let unreadableFiles = 0, unreadableLines = 0;
  for (const file of files) {
    try {
      for (const line of completeLines(file)) {
        if (!line.includes('"tool_use"') && !line.includes("<command-name>")) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { unreadableLines += 1; continue; }
        const at = String(entry.timestamp || "");
        if (!(at >= sinceIso && at <= untilIso) || !inside(entry.cwd)) continue;
        const sessionId = String(entry.sessionId || file);
        const content = entry.message?.content;
        if (entry.type === "assistant" && Array.isArray(content)) {
          for (const block of content) {
            const id = block?.id || `${sessionId}:${at}:${block?.name}`;
            if (block?.type !== "tool_use" || seen.has(id)) continue;
            if (block.name === "Skill" && block.input?.skill) {
              seen.add(id); sessions.add(sessionId);
              tally(skillUse, String(block.input.skill), sessionId, at);
            } else if (block.name === "Bash" && typeof block.input?.command === "string") {
              const named = documentPatterns.filter(([, pattern]) => pattern.test(block.input.command)).map(([relPath]) => relPath);
              if (!named.length) continue;
              seen.add(id); sessions.add(sessionId);
              for (const relPath of named) tally(documentUse, relPath, sessionId, at);
            } else if (block.name === "Read" && typeof block.input?.file_path === "string") {
              const absolute = path.resolve(entry.cwd, block.input.file_path);
              const base = [...roots].find((candidate) => absolute.startsWith(`${candidate}${path.sep}`));
              const relPath = base ? path.relative(base, absolute).split(path.sep).join("/") : "";
              if (!relPath || !DOCUMENT_PATH.test(relPath)) continue;
              seen.add(id); sessions.add(sessionId);
              tally(documentUse, relPath, sessionId, at);
            }
          }
        } else if (entry.type === "user" && !seen.has(entry.uuid)) {
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block?.text || "").join("\n") : "";
          const name = text.match(/<command-name>\/?([^<\s]+)<\/command-name>/)?.[1];
          if (!name || !knownSkills.has(name)) continue;
          seen.add(entry.uuid); sessions.add(sessionId);
          tally(skillUse, name, sessionId, at);
        }
      }
    } catch {
      unreadableFiles += 1;
    }
  }
  const retention = retentionDays(home);
  const reasons = [];
  if (!files.length) reasons.push("no-sessions");
  if (retention < days) reasons.push("retention-shorter-than-window");
  if (unreadableFiles || unreadableLines) reasons.push("unreadable-session-data");
  const complete = reasons.length === 0;
  const skillRows = ranked(skillUse, "name"), documentRows = ranked(documentUse, "path");
  return {
    schemaVersion: "context-room.agent-usage/1",
    provider: "claude-code",
    window: { days, since: sinceIso, until: untilIso },
    coverage: { complete, reasons, sessionFiles: files.length, sessionsWithUse: sessions.size, unreadableFiles, unreadableLines, retentionDays: retention, notCounted: "Codex and other agents" },
    skills: skillRows,
    documents: documentRows,
    // Loaded by the agent at startup: always used, never "not used".
    loadedAtStartup: [...startup].sort(),
    notUsed: complete ? {
      skills: skills.filter((name) => !skillUse.has(name)).sort(),
      documents: documents.filter((relPath) => !documentUse.has(relPath) && !startup.includes(relPath)).sort(),
    } : null,
  };
}
