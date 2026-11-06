// Index and query engine for the "Go to" search. Pure logic: the caller injects file access.
// It runs inside a worker thread (goto_search_worker.mjs) so the Hub main thread never scans files.
// Memory: one folded string per file, one global byte budget, least recently used projects evicted.
import fs from "node:fs";
import path from "node:path";

export const TEXT_FILE = /\.(?:md|mdx|markdown|txt)$/i;
const DEFAULTS = {
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  ttlMs: 15_000,
  hardAgeMs: 5 * 60_000,
  queryBudgetMs: 600,
  snippetChars: 140,
};
const BLOCKED_SEGMENTS = new Set([".git", ".context-room", "node_modules"]);

export function foldSearchText(value = "") {
  return String(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function insideRoot(root, absolutePath) {
  try {
    const real = fs.realpathSync(absolutePath);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : "";
  } catch { return ""; }
}

function titleOf(text) {
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  const first = heading || text.split("\n").find((line) => line.trim()) || "";
  return first.replace(/\s+/g, " ").trim().slice(0, 160);
}

function cleanRel(rel) {
  return typeof rel === "string" && rel && TEXT_FILE.test(rel) && !rel.startsWith("~") && !rel.startsWith("/")
    && !rel.split("/").some((part) => part === ".." || BLOCKED_SEGMENTS.has(part));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

export function createGotoEngine({ listFiles, resolveFile, ...overrides }) {
  const limits = { ...DEFAULTS, ...overrides };
  const indexes = new Map();
  let clock = 0;
  // Projects of the current search/warm: they are never evicted for each other (that would be a cyclic scan).
  let protectedRoots = new Set();
  // Builds run one at a time: each one then sees the real bytes held by the others, so the global cap holds.
  let buildQueue = Promise.resolve();
  const progress = () => { try { limits.onProgress?.(); } catch { /* a progress signal never breaks a build */ } };

  const totalBytes = () => { let sum = 0; for (const index of indexes.values()) sum += index.bytes; return sum; };

  // Drops the least recently used project that can go: outside the current search, or unused within the cache time.
  function evictOne(keepRoot) {
    const now = Date.now();
    let oldest = null;
    for (const [root, index] of indexes) {
      if (root === keepRoot || index.building) continue;
      if (protectedRoots.has(root) && now - index.usedAt < limits.ttlMs) continue;
      if (!oldest || index.used < oldest[1].used) oldest = [root, index];
    }
    if (!oldest) return false;
    indexes.delete(oldest[0]);
    return true;
  }

  function evictFor(keepRoot) {
    while (totalBytes() > limits.maxTotalBytes) if (!evictOne(keepRoot)) return;
  }

  // Reads one file through the access check. Returns null when the file must not be served.
  function readEntry(root, rel, meta, budgetLeft) {
    const abs = resolveFile(root, rel);
    if (!abs) return null;
    const real = insideRoot(root, abs);
    if (!real) return null;
    let text = "";
    let read = false;
    if (meta.bytes <= limits.maxFileBytes && meta.bytes <= budgetLeft) {
      try { text = fs.readFileSync(real, "utf8"); read = true; } catch { return null; }
    }
    const name = path.posix.basename(rel);
    const title = titleOf(text);
    const fold = foldSearchText(text);
    return {
      path: rel, name, title, updatedAt: meta.updatedAt, bytes: meta.bytes, read,
      nameFold: foldSearchText(rel), titleFold: foldSearchText(title), baseFold: foldSearchText(name), fold,
    };
  }

  async function build(root, index) {
    const previous = index.builtAt ? { entries: index.entries } : null;
    progress();
    const files = listFiles(root);
    progress();
    const entries = new Map();
    // Make room first: drop the least recently used other projects until this one fits (or none is left to drop).
    let need = 0;
    for (const file of files) if (file.exists && cleanRel(String(file.path || "")) && file.bytes <= limits.maxFileBytes) need += file.bytes;
    while (totalBytes() - index.bytes + need > limits.maxTotalBytes) if (!evictOne(root)) break;
    const others = totalBytes() - index.bytes;
    let bytes = 0;
    let reads = 0;
    let skipped = false;
    for (const file of files) {
      const rel = String(file.path || "");
      if (!file.exists || !cleanRel(rel)) continue;
      const prior = previous?.entries.get(rel);
      const unchanged = prior && prior.updatedAt === file.updatedAt && prior.bytes === file.bytes;
      if (unchanged && (prior.read || file.bytes > limits.maxFileBytes)) {
        // A kept entry still counts against the budget: when the others grew, drop its text and say so.
        if (prior.fold.length > limits.maxTotalBytes - others - bytes) {
          entries.set(rel, { ...prior, read: false, fold: "", title: prior.title, titleFold: prior.titleFold });
          skipped = true;
          continue;
        }
        entries.set(rel, prior); bytes += prior.fold.length; continue;
      }
      const entry = readEntry(root, rel, file, limits.maxTotalBytes - others - bytes);
      if (!entry) continue;
      if (!entry.read && file.bytes <= limits.maxFileBytes) skipped = true;
      entries.set(rel, entry);
      bytes += entry.fold.length;
      if (++reads % 40 === 0) { progress(); await tick(); }
    }
    index.entries = entries;
    index.bytes = bytes;
    index.truncated = skipped;
    index.builtAt = Date.now();
    return index;
  }

  function ensureBuilt(root) {
    let index = indexes.get(root);
    if (index?.building) return index.building;
    const previous = index || null;
    const holder = previous || { entries: new Map(), bytes: 0, builtAt: 0, used: ++clock, usedAt: Date.now(), building: null };
    if (!previous) indexes.set(root, holder);
    const run = () => build(root, holder);
    const promise = (buildQueue = buildQueue.then(run, run)).then(() => {
      holder.building = null;
      evictFor(root);
      return holder;
    }, (error) => {
      holder.building = null;
      if (!previous) indexes.delete(root);
      throw error;
    });
    holder.building = promise;
    return promise;
  }

  function prune(keepRoots) {
    for (const root of [...indexes.keys()]) if (!keepRoots.has(root)) indexes.delete(root);
  }

  function snippetFor(source, index, termLength) {
    const start = Math.max(0, index - Math.floor(limits.snippetChars / 3));
    const end = Math.min(source.length, start + limits.snippetChars);
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

  function rankOf(entry, phrase, terms) {
    const nameHit = (hay) => terms.every((term) => hay.includes(term));
    if (!nameHit(entry.nameFold + "\n" + entry.titleFold)) return -1;
    return entry.baseFold === phrase || entry.baseFold.replace(/\.[^.]+$/, "") === phrase ? 0
      : entry.baseFold.startsWith(phrase) ? 1
      : entry.baseFold.includes(phrase) ? 2
      : terms.every((term) => entry.baseFold.includes(term)) ? 3
      : entry.nameFold.includes(phrase) ? 4 : 5;
  }

  // Re-checks one candidate against the live file: access rules, realpath, size/mtime. Returns the entry to show.
  function verify(project, entry, kind, phrase, terms) {
    const abs = resolveFile(project.root, entry.path);
    if (!abs) return null;
    const real = insideRoot(project.root, abs);
    if (!real) return null;
    let stat;
    try { stat = fs.statSync(real); } catch { return null; }
    if (!stat.isFile()) return null;
    let current = entry;
    if (stat.mtime.toISOString() !== entry.updatedAt || stat.size !== entry.bytes) {
      const room = limits.maxTotalBytes - (totalBytes() - entry.fold.length);
      current = readEntry(project.root, entry.path, { bytes: stat.size, updatedAt: stat.mtime.toISOString() }, Math.min(limits.maxFileBytes, room));
      if (!current) return null;
      const held = indexes.get(project.root);
      if (held) {
        held.bytes += current.fold.length - entry.fold.length;
        held.entries.set(entry.path, current);
        if (!current.read && stat.size <= limits.maxFileBytes) held.truncated = true;
      }
    }
    if (kind === "file") return rankOf(current, phrase, terms) >= 0 ? { entry: current } : null;
    if (!current.fold || !terms.every((term) => current.fold.includes(term))) return null;
    let text = "";
    try { text = fs.readFileSync(real, "utf8"); } catch { return null; }
    const source = foldSearchText(text).length === text.length ? text : current.fold;
    const at = current.fold.indexOf(phrase);
    const first = at >= 0 ? at : current.fold.indexOf(terms[0]);
    const len = at >= 0 ? phrase.length : terms[0].length;
    return { entry: current, ...snippetFor(source, first, len), line: source.slice(0, first).split("\n").length, term: terms[0] };
  }

  async function search(projects, query, { limit = 40 } = {}) {
    const startedAt = Date.now();
    const terms = foldSearchText(query).split(/\s+/).filter(Boolean);
    const result = { terms, files: [], text: [], truncated: false, building: false, searchedProjects: 0, filesTotal: 0, textTotal: 0 };
    if (!terms.length) return result;
    protectedRoots = new Set(projects.map((project) => project.root));
    prune(protectedRoots);
    const phrase = terms.join(" ");
    const files = [];
    const text = [];
    for (const project of projects) {
      let index = indexes.get(project.root);
      const age = index ? Date.now() - index.builtAt : Infinity;
      if (!index?.builtAt || age > limits.hardAgeMs) {
        const left = limits.queryBudgetMs - (Date.now() - startedAt);
        const built = ensureBuilt(project.root).then(() => true, () => false);
        const done = left > 0 ? await Promise.race([built, new Promise((resolve) => setTimeout(() => resolve(false), left))]) : false;
        if (!done) { result.building = true; result.truncated = true; continue; }
        index = indexes.get(project.root);
        if (!index) continue;
      } else if (age > limits.ttlMs && !index.building) {
        ensureBuilt(project.root).catch(() => {});
      }
      index.used = ++clock;
      index.usedAt = Date.now();
      result.searchedProjects += 1;
      if (index.truncated) result.truncated = true;
      for (const entry of index.entries.values()) {
        const rank = rankOf(entry, phrase, terms);
        if (rank >= 0) { files.push({ project, entry, rank }); continue; }
        if (!entry.fold || !terms.every((term) => entry.fold.includes(term))) continue;
        const at = entry.fold.indexOf(phrase);
        let count = 0;
        for (let from = 0; count < 20; count += 1) { const next = entry.fold.indexOf(terms[0], from); if (next < 0) break; from = next + terms[0].length; }
        text.push({ project, entry, rank: (at >= 0 ? 0 : 1) * 100 - count });
      }
    }
    const order = (a, b) => a.rank - b.rank || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path, "en");
    files.sort(order);
    text.sort(order);
    result.filesTotal = files.length;
    result.textTotal = text.length;
    const pick = (list, kind) => {
      const out = [];
      for (const candidate of list) {
        if (out.length >= limit) break;
        const { project, entry } = candidate;
        const checked = verify(project, entry, kind, phrase, terms);
        if (!checked) continue;
        const shown = checked.entry;
        out.push({
          projectKey: project.projectKey, projectId: project.id, projectTitle: project.title, path: shown.path, name: shown.name,
          ...(kind === "file"
            ? { title: shown.title, rank: candidate.rank }
            : { snippet: checked.snippet, matchStart: checked.matchStart, matchLength: checked.matchLength, line: checked.line, term: checked.term, rank: candidate.rank }),
        });
      }
      return out;
    };
    result.files = pick(files, "file");
    result.text = pick(text, "text");
    return result;
  }

  function warm(projects) {
    protectedRoots = new Set(projects.map((project) => project.root));
    prune(protectedRoots);
    for (const project of projects) {
      const index = indexes.get(project.root);
      if (!index || (!index.building && Date.now() - index.builtAt > limits.ttlMs)) ensureBuilt(project.root).catch(() => {});
    }
  }

  return { search, warm, reset: () => indexes.clear(), stats: () => ({ projects: indexes.size, bytes: totalBytes() }) };
}
