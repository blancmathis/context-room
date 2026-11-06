// Read-only "Go to" search across every registered local project: file names and file text.
// Not the reviewed-docs engine (documentation.mjs): it must find files that are not reviewed yet.
// Each project keeps an in-memory index (folded text per file). A stale index is served at once and rebuilt
// in the background, so a query never waits for a file scan once the index is warm.
import fs from "node:fs";
import path from "node:path";

const TEXT_FILE = /\.(?:md|mdx|markdown|txt)$/i;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 48 * 1024 * 1024;
const INDEX_TTL_MS = 15_000;
const QUERY_BUDGET_MS = 250;
const SNIPPET_CHARS = 140;

const indexes = new Map();

export function foldSearchText(value = "") {
  return String(value).normalize("NFC").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function insideRoot(root, absolutePath) {
  try {
    const real = fs.realpathSync(absolutePath);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : "";
  } catch { return ""; }
}

function buildProjectIndex(project, listFiles, previous) {
  const files = listFiles(project.root, { readOnly: true });
  const entries = new Map();
  let bytes = 0;
  for (const file of files) {
    const rel = String(file.path || "");
    if (!file.exists || !TEXT_FILE.test(rel) || rel.startsWith("~") || rel.startsWith("/") || rel.split("/").includes("..")) continue;
    const prior = previous?.entries.get(rel);
    if (prior && prior.updatedAt === file.updatedAt && prior.bytes === file.bytes) {
      entries.set(rel, prior);
      bytes += prior.fold.length;
      continue;
    }
    let text = "";
    if (file.bytes <= MAX_FILE_BYTES && bytes < MAX_INDEX_BYTES) {
      const real = insideRoot(project.root, path.join(project.root, rel));
      if (real) { try { text = fs.readFileSync(real, "utf8"); } catch { text = ""; } }
    }
    const name = path.posix.basename(rel);
    const title = String(file.summary || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const fold = foldSearchText(text);
    bytes += fold.length;
    entries.set(rel, {
      path: rel, name, title, updatedAt: file.updatedAt, bytes: file.bytes,
      nameFold: foldSearchText(rel), titleFold: foldSearchText(title), baseFold: foldSearchText(name),
      fold, text: fold.length === text.length ? text : "",
    });
  }
  return { builtAt: Date.now(), entries, refreshing: false };
}

function projectIndex(project, listFiles) {
  const key = project.root;
  const existing = indexes.get(key);
  if (!existing) {
    const built = buildProjectIndex(project, listFiles, null);
    indexes.set(key, built);
    return built;
  }
  if (Date.now() - existing.builtAt > INDEX_TTL_MS && !existing.refreshing) {
    existing.refreshing = true;
    setImmediate(() => {
      try { indexes.set(key, buildProjectIndex(project, listFiles, existing)); } catch { existing.refreshing = false; }
    });
  }
  return existing;
}

export function gotoSearchProjects(projects = []) {
  const seen = new Set();
  const chosen = [];
  const ordered = [...projects].sort((a, b) => Number(Boolean(a.worktree)) - Number(Boolean(b.worktree)));
  for (const project of ordered) {
    if (!project?.root || project.mode === "shared" || project.available === false || project.space) continue;
    const logical = String(project.logicalProjectId || project.id);
    if (seen.has(logical)) continue;
    seen.add(logical);
    chosen.push({
      id: project.id, root: project.root, title: project.title || path.basename(project.root),
      projectKey: `local:${logical}`, worktree: project.worktree,
    });
  }
  return chosen;
}

function snippetFor(entry, index, termLength) {
  const source = entry.text || entry.fold;
  if (!source) return null;
  const start = Math.max(0, index - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(source.length, start + SNIPPET_CHARS);
  const raw = source.slice(start, end);
  const lead = raw.length - raw.replace(/^\s+/, "").length;
  const body = raw.replace(/\s+/g, " ").trim();
  const before = source.slice(start + lead, index).replace(/\s+/g, " ");
  const prefix = start > 0 ? "…" : "";
  const matched = source.slice(index, index + termLength).replace(/\s+/g, " ");
  const text = prefix + body + (end < source.length ? "…" : "");
  const matchStart = prefix.length + Math.max(0, before.replace(/^\s+/, "").length);
  return { snippet: text, matchStart, matchLength: Math.min(matched.length, Math.max(0, text.length - matchStart)) };
}

export function searchGoto(projects, listFiles, query, { limit = 40 } = {}) {
  const startedAt = Date.now();
  const terms = foldSearchText(query).split(/\s+/).filter(Boolean);
  const files = [];
  const text = [];
  let truncated = false;
  if (!terms.length) return { terms, files, text, truncated, searchedProjects: 0 };
  const phrase = terms.join(" ");
  const picked = gotoSearchProjects(projects);
  let searched = 0;
  for (const project of picked) {
    if (Date.now() - startedAt > QUERY_BUDGET_MS) { truncated = true; break; }
    let index;
    try { index = projectIndex(project, listFiles); } catch { continue; }
    searched += 1;
    for (const entry of index.entries.values()) {
      const hay = entry.nameFold + "\n" + entry.titleFold;
      const nameHit = terms.every((term) => hay.includes(term));
      const base = { projectKey: project.projectKey, projectId: project.id, projectTitle: project.title, path: entry.path, name: entry.name };
      if (nameHit) {
        const rank = entry.baseFold === phrase || entry.baseFold.replace(/\.[^.]+$/, "") === phrase ? 0
          : entry.baseFold.startsWith(phrase) ? 1
          : entry.baseFold.includes(phrase) ? 2
          : terms.every((term) => entry.baseFold.includes(term)) ? 3
          : entry.nameFold.includes(phrase) ? 4 : 5;
        files.push({ ...base, title: entry.title, rank, length: entry.path.length });
        continue;
      }
      if (!entry.fold || !terms.every((term) => entry.fold.includes(term))) continue;
      const at = entry.fold.indexOf(phrase);
      const first = at >= 0 ? at : entry.fold.indexOf(terms[0]);
      const matchLength = at >= 0 ? phrase.length : terms[0].length;
      let count = 0;
      for (let from = 0; count < 20; count += 1) { const next = entry.fold.indexOf(terms[0], from); if (next < 0) break; from = next + terms[0].length; }
      const shown = snippetFor(entry, first, matchLength) || { snippet: "", matchStart: 0, matchLength: 0 };
      const line = (entry.text || entry.fold).slice(0, first).split("\n").length;
      text.push({ ...base, ...shown, line, term: terms[0], rank: (at >= 0 ? 0 : 1) * 100 - count, length: entry.path.length });
    }
  }
  const order = (a, b) => a.rank - b.rank || a.length - b.length || a.path.localeCompare(b.path, "en");
  files.sort(order);
  text.sort(order);
  for (const item of [...files, ...text]) delete item.length;
  return { terms, files: files.slice(0, limit), text: text.slice(0, limit), truncated, searchedProjects: searched, filesTotal: files.length, textTotal: text.length };
}

export function warmGotoSearch(projects, listFiles) {
  for (const project of gotoSearchProjects(projects)) {
    try { projectIndex(project, listFiles); } catch { /* skipped */ }
  }
}

export function resetGotoSearchIndexForTests() { indexes.clear(); }
