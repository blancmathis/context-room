// Deterministic documentation tidiness checks. No model calls: every finding
// cites its rule and the exact source that triggered it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DOC_TIDY_LIMITS = Object.freeze({
  // ≈ 25,000 tokens at 4 characters per token: an agent reads it in several parts.
  agentReadChars: 100_000,
  summaryMinChars: 3_000,
  duplicateBlockMinChars: 280,
  logMinBytes: 32 * 1024,
  logHistoryCommits: 50,
  logMinCommits: 10,
  // Deleted lines below 1/8 of added lines: the file only grows.
  logMaxDeletedRatio: 0.125,
  findingsPerDocument: 20,
  // Likely duplicate document: word 3-grams, Jaccard similarity of the two sets.
  duplicateDocMinShingles: 40,
  duplicateDocMinSimilarity: 0.5,
  // A 3-gram in more documents than this is template text; at least this many other 3-grams are shared.
  duplicateDocMaxOwners: 3,
  duplicateDocMinSharedRare: 20,
});

export const DOC_TIDY_RULES = Object.freeze({
  doc_too_large: "A document longer than 100,000 characters (≈ 25,000 tokens) cannot be read by an agent in one pass.",
  doc_not_in_map: "Every document under docs/ is listed in docs/index.md, directly or through a listed index.",
  dead_link: "A relative Markdown link points to an existing file and, with #section, to an existing heading.",
  duplicate_block: "A block of text lives in one document; other documents link to it.",
  duplicate_doc: "A document that repeats most of another document is likely a duplicate: keep one, link to it.",
  log_in_state_doc: "State is rewritten, a log is appended: a state document that only grows holds a log.",
  missing_summary: "A document longer than 3,000 characters opens with a short summary.",
});

const MAP_ENTRY_FILES = ["docs/index.md", "AGENTS.md", "CLAUDE.md", "README.md"];
const LOG_PATH_PATTERN = /(^|\/)(journal|journals|logs?|history|historique|archive|archives|changelog|records?)(\/|\.md$)|(^|\/)CHANGELOG\.md$/i;

function normalizeRel(value = "") {
  return path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "");
}

function stripFrontMatter(content = "") {
  const text = String(content);
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? { body: text.slice(match[0].length), offsetLines: match[0].split("\n").length - 1 } : { body: text, offsetLines: 0 };
}

function maskCode(text = "") {
  // Keep line positions: replace code with spaces of the same length.
  return String(text)
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function headingSlugs(content = "") {
  const slugs = new Set();
  const counts = new Map();
  const { body } = stripFrontMatter(content);
  for (const match of maskCode(body).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = match[1].trim().toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const seen = counts.get(base) || 0;
    counts.set(base, seen + 1);
    slugs.add(seen ? base + "-" + seen : base);
  }
  for (const match of String(body).matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']|\{#([\w-]+)\}/g)) slugs.add((match[1] || match[2]).toLowerCase());
  return slugs;
}

function markdownLinks(content = "") {
  const { body, offsetLines } = stripFrontMatter(content);
  const masked = maskCode(body);
  const links = [];
  for (const match of masked.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    if (match[0].startsWith("!")) continue;
    links.push({ target: match[1], line: lineAt(masked, match.index) + offsetLines });
  }
  return links;
}

function linkedPaths(docPath, content = "") {
  const paths = new Set();
  const { body } = stripFrontMatter(content);
  for (const { target } of markdownLinks(content)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const file = safeDecode(target.split("#", 1)[0].split("?", 1)[0]);
    if (file) paths.add(normalizeRel(path.posix.join(path.posix.dirname(docPath), file)));
  }
  // Inline code paths count as listing (`docs/foo.md`), relative to the root or the map.
  for (const match of String(body).matchAll(/`([^`\s]+\.md)`/g)) {
    paths.add(normalizeRel(match[1]));
    paths.add(normalizeRel(path.posix.join(path.posix.dirname(docPath), match[1])));
  }
  return paths;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function blocks(content = "") {
  const { body, offsetLines } = stripFrontMatter(content);
  const masked = maskCode(body);
  const result = [];
  let start = 0;
  for (const part of masked.split(/\n[ \t]*\n/)) {
    const line = lineAt(masked, start) + offsetLines;
    start += part.length + 2;
    const trimmed = part.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^\|/.test(trimmed)) continue;
    const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
    if (normalized.length >= DOC_TIDY_LIMITS.duplicateBlockMinChars) result.push({ normalized, line });
  }
  return result;
}

function opensWithSummary(content = "") {
  const { body } = stripFrontMatter(content);
  const lines = maskCode(body).split("\n");
  let index = 0;
  const skipBlank = () => { while (index < lines.length && !lines[index].trim()) index += 1; };
  skipBlank();
  // The title and one section heading may come first.
  for (let headings = 0; headings < 2 && /^#{1,6}\s/.test(lines[index] || ""); headings += 1) { index += 1; skipBlank(); }
  const first = (lines[index] || "").trim();
  if (!first) return false;
  // Prose or a quoted summary counts; a heading, list, table, code or HTML does not.
  return !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||<|---|===)/.test(first) && first.length >= 20;
}

export function readGitDocumentHistory(root, relPath, { commits = DOC_TIDY_LIMITS.logHistoryCommits } = {}) {
  try {
    const output = execFileSync("git", ["log", "-n", String(commits), "--numstat", "--format=%H", "--", relPath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    let commitCount = 0;
    let added = 0;
    let deleted = 0;
    for (const line of output.split("\n")) {
      if (/^[0-9a-f]{40}$/.test(line)) commitCount += 1;
      const stat = line.match(/^(\d+)\t(\d+)\t/);
      if (stat) {
        added += Number(stat[1]);
        deleted += Number(stat[2]);
      }
    }
    return { commits: commitCount, added, deleted };
  } catch {
    return null;
  }
}

// Distinct word 3-grams (hashed, sorted) of the prose: front matter and code are ignored.
export function documentShingles(content = "") {
  const words = maskCode(stripFrontMatter(String(content)).body).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const set = new Set();
  for (let index = 0; index + 2 < words.length; index += 1) {
    let hash = 0x811c9dc5;
    for (const char of words[index] + " " + words[index + 1] + " " + words[index + 2]) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    set.add(hash >>> 0);
  }
  return Uint32Array.from(set).sort();
}

// Calls visit(indexInLeft) for each 3-gram both sorted sets hold; returns how many.
function intersect(left, right, visit) {
  let shared = 0;
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] < right[j]) i += 1;
    else if (left[i] > right[j]) j += 1;
    else { if (visit) visit(i); shared += 1; i += 1; j += 1; }
  }
  return shared;
}

// A 3-gram held by more than duplicateDocMaxOwners documents is template text (ADR, changelog,
// release note skeleton): it never makes two documents duplicates. Similarity = Jaccard of the
// two sets without the shared template 3-grams.
function duplicateSimilarity(left, right, shared, sharedCommon) {
  const rare = shared - sharedCommon;
  if (rare < DOC_TIDY_LIMITS.duplicateDocMinSharedRare) return 0;
  return rare / (left.length + right.length - shared - sharedCommon);
}

function duplicateFinding(docPath, other, similarity) {
  return finding("duplicate_doc", docPath, 1, other, "Likely duplicate of " + other + " (" + Math.round(similarity * 100) + "% of word sequences shared). Keep one document and link to it.");
}

// docs: [{ path, content }]. One finding per likely duplicate, on the smaller document
// (later path on a tie), naming the most similar other document.
export function likelyDuplicateDocuments(docs = []) {
  const entries = docs
    .filter((doc) => /\.md$/i.test(doc.path || "") && typeof doc.content === "string")
    .map((doc) => ({ path: normalizeRel(doc.path), set: documentShingles(doc.content) }))
    .filter((entry) => entry.set.length >= DOC_TIDY_LIMITS.duplicateDocMinShingles);
  const owners = new Map();
  for (const entry of entries) for (const hash of entry.set) owners.set(hash, (owners.get(hash) || 0) + 1);
  // Inverted index over rare 3-grams only: template text does not create candidates.
  const postings = new Map();
  entries.forEach((entry, index) => { for (const hash of entry.set) if (owners.get(hash) <= DOC_TIDY_LIMITS.duplicateDocMaxOwners) { const list = postings.get(hash); if (list) list.push(index); else postings.set(hash, [index]); } });
  const best = new Map();
  entries.forEach((entry, index) => {
    const counts = new Map();
    for (const hash of entry.set) for (const other of postings.get(hash) || []) if (other > index) counts.set(other, (counts.get(other) || 0) + 1);
    for (const [other, rare] of counts) {
      if (rare < DOC_TIDY_LIMITS.duplicateDocMinSharedRare) continue;
      const candidate = entries[other];
      let sharedCommon = 0;
      const shared = intersect(entry.set, candidate.set, (at) => { if (owners.get(entry.set[at]) > DOC_TIDY_LIMITS.duplicateDocMaxOwners) sharedCommon += 1; });
      const similarity = duplicateSimilarity(entry.set, candidate.set, shared, sharedCommon);
      if (similarity < DOC_TIDY_LIMITS.duplicateDocMinSimilarity) continue;
      const reported = entry.set.length === candidate.set.length ? (entry.path.localeCompare(candidate.path, "en") > 0 ? entry : candidate)
        : entry.set.length < candidate.set.length ? entry : candidate;
      const current = best.get(reported.path);
      if (!current || similarity > current.similarity) best.set(reported.path, { other: (reported === entry ? candidate : entry).path, similarity });
    }
  });
  return [...best].sort(([left], [right]) => left.localeCompare(right, "en")).map(([docPath, { other, similarity }]) => duplicateFinding(docPath, other, similarity));
}

// The most similar document to one focus document, with the same rule as likelyDuplicateDocuments.
// others: iterable of { path, hashes } (from documentShingles) or { path, content }. Two linear
// passes over sorted sets: no corpus-wide index, cost proportional to the corpus size.
export function likelyDuplicateOf(focusPath, content, others = []) {
  const rel = normalizeRel(focusPath);
  const focus = documentShingles(content);
  if (focus.length < DOC_TIDY_LIMITS.duplicateDocMinShingles) return null;
  const owners = new Uint32Array(focus.length).fill(1);
  // A 2^20-bit filter of the focus 3-grams: most 3-grams of other documents miss it with one array read.
  const filter = new Uint32Array(1 << 15), position = new Map();
  focus.forEach((hash, at) => { filter[(hash >>> 5) & 0x7fff] |= 1 << (hash & 31); position.set(hash, at); });
  const candidates = [];
  for (const doc of others) {
    const docPath = normalizeRel(doc.path || "");
    if (docPath === rel || !/\.md$/i.test(docPath)) continue;
    const hashes = doc.hashes || (typeof doc.content === "string" ? documentShingles(doc.content) : null);
    if (!hashes || hashes.length < DOC_TIDY_LIMITS.duplicateDocMinShingles) continue;
    let shared = 0;
    for (let index = 0; index < hashes.length; index += 1) {
      const hash = hashes[index];
      if (!(filter[(hash >>> 5) & 0x7fff] & (1 << (hash & 31)))) continue;
      const at = position.get(hash);
      if (at !== undefined) { owners[at] += 1; shared += 1; }
    }
    if (shared >= DOC_TIDY_LIMITS.duplicateDocMinSharedRare) candidates.push({ path: docPath, hashes, shared });
  }
  let best = null;
  for (const candidate of candidates) {
    let sharedCommon = 0;
    intersect(focus, candidate.hashes, (at) => { if (owners[at] > DOC_TIDY_LIMITS.duplicateDocMaxOwners) sharedCommon += 1; });
    const similarity = duplicateSimilarity(focus, candidate.hashes, candidate.shared, sharedCommon);
    if (similarity >= DOC_TIDY_LIMITS.duplicateDocMinSimilarity && (!best || similarity > best.similarity
      || similarity === best.similarity && candidate.path.localeCompare(best.path, "en") < 0)) best = { path: candidate.path, similarity };
  }
  return best ? duplicateFinding(rel, best.path, best.similarity) : null;
}

function finding(type, docPath, line, evidence, message, severity = "low") {
  return { type, severity, path: docPath, line, rule: DOC_TIDY_RULES[type], evidence, message };
}

// docs: [{ path, content, metadataPresent? }]; exists(relPath) and history(relPath) are injectable.
export function analyzeDocumentTidiness({
  root = process.cwd(),
  docs = [],
  exists = (relPath) => fs.existsSync(path.join(root, relPath)),
  readText = (relPath) => fs.readFileSync(path.join(root, relPath), "utf8"),
  history = (relPath) => readGitDocumentHistory(root, relPath),
} = {}) {
  const markdown = docs
    .filter((doc) => /\.md$/i.test(doc.path) && typeof doc.content === "string")
    .map((doc) => ({ ...doc, path: normalizeRel(doc.path) }));
  const byPath = new Map(markdown.map((doc) => [doc.path, doc]));
  const findings = [];
  const counts = new Map();
  const add = (item) => {
    const count = counts.get(item.path) || 0;
    if (count >= DOC_TIDY_LIMITS.findingsPerDocument) return;
    counts.set(item.path, count + 1);
    findings.push(item);
  };
  const textFor = (relPath) => {
    if (byPath.has(relPath)) return byPath.get(relPath).content;
    try { return readText(relPath); } catch { return ""; }
  };
  let historyAvailable = null;

  // Map: docs/index.md, root agent files, and indexes they list (one level).
  const hasMap = exists("docs/index.md");
  const mapped = new Set(MAP_ENTRY_FILES);
  if (hasMap) {
    const entries = MAP_ENTRY_FILES.filter((relPath) => exists(relPath));
    for (const entry of entries) for (const target of linkedPaths(entry, textFor(entry))) mapped.add(target);
    for (const target of [...mapped]) {
      if (!/(^|\/)(index|README)\.md$/i.test(target) || MAP_ENTRY_FILES.includes(target) || !exists(target)) continue;
      for (const nested of linkedPaths(target, textFor(target))) mapped.add(nested);
    }
  }

  const duplicateDocs = likelyDuplicateDocuments(markdown);
  const blockOwners = new Map();
  for (const doc of [...markdown].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const size = doc.content.length;
    if (size > DOC_TIDY_LIMITS.agentReadChars) {
      add(finding("doc_too_large", doc.path, 1, size + " characters",
        "Too large for one agent read: " + size.toLocaleString("en") + " characters (≈ " + Math.round(size / 4).toLocaleString("en") + " tokens). Split it by topic."));
    }
    if (hasMap && doc.path.startsWith("docs/") && !mapped.has(doc.path)) {
      add(finding("doc_not_in_map", doc.path, 1, "docs/index.md", "Not listed in docs/index.md. Add one line for it, or move it out of docs/."));
    }
    for (const link of markdownLinks(doc.content)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link.target) || link.target.startsWith("//")) continue;
      const [rawFile, anchor = ""] = link.target.split("#", 2);
      let file = safeDecode(rawFile.split("?", 1)[0]);
      if (path.isAbsolute(file)) {
        // Absolute links are checked only inside this project.
        const relative = path.relative(root, file).replaceAll("\\", "/");
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        file = "/" + relative;
      }
      const target = !file ? doc.path : file.startsWith("/") ? normalizeRel(file.slice(1)) : normalizeRel(path.posix.join(path.posix.dirname(doc.path), file));
      if (target.startsWith("../")) continue;
      if (file && !exists(target)) {
        if (!doc.metadataPresent) add(finding("dead_link", doc.path, link.line, link.target, "Dead link: " + link.target + " does not exist.", "medium"));
        continue;
      }
      if (anchor && /\.md$/i.test(target) && !headingSlugs(textFor(target)).has(safeDecode(anchor).toLowerCase())) {
        add(finding("dead_link", doc.path, link.line, link.target, "Dead anchor: " + link.target + " has no matching heading.", "medium"));
      }
    }
    const duplicates = new Map();
    for (const block of blocks(doc.content)) {
      const owner = blockOwners.get(block.normalized);
      if (!owner) blockOwners.set(block.normalized, { path: doc.path, line: block.line });
      else if (owner.path !== doc.path) {
        if (!duplicates.has(owner.path)) duplicates.set(owner.path, { count: 0, line: block.line, ownerLine: owner.line });
        duplicates.get(owner.path).count += 1;
      }
    }
    for (const item of duplicateDocs) if (item.path === doc.path) add(item);
    for (const [ownerPath, duplicate] of duplicates) {
      add(finding("duplicate_block", doc.path, duplicate.line, ownerPath + ":" + duplicate.ownerLine,
        duplicate.count + " block" + (duplicate.count === 1 ? "" : "s") + " duplicated from " + ownerPath + " (first at line " + duplicate.ownerLine + "). Keep one copy and link to it."));
    }
    if (size > DOC_TIDY_LIMITS.summaryMinChars && !opensWithSummary(doc.content)) {
      add(finding("missing_summary", doc.path, 1, "first block", "No summary at the top. Start with two or three sentences on what this document holds."));
    }
    if (Buffer.byteLength(doc.content) >= DOC_TIDY_LIMITS.logMinBytes && !LOG_PATH_PATTERN.test(doc.path)) {
      const stats = history(doc.path);
      if (stats) {
        historyAvailable = true;
        if (stats.commits >= DOC_TIDY_LIMITS.logMinCommits && stats.added > 0 && stats.deleted / stats.added < DOC_TIDY_LIMITS.logMaxDeletedRatio) {
          add(finding("log_in_state_doc", doc.path, 1, "git: last " + stats.commits + " commits, +" + stats.added + " / -" + stats.deleted + " lines",
            "Only grows: last " + stats.commits + " commits added " + stats.added + " lines and removed " + stats.deleted + ". Move the log to a journal file and keep the current state here."));
        }
      } else if (historyAvailable === null) {
        historyAvailable = false;
      }
    }
  }
  return {
    findings,
    summary: {
      documents: markdown.length,
      map: hasMap ? "docs/index.md" : null,
      // null: no document was large enough to need history; false: git unavailable (shown as —).
      history: historyAvailable,
    },
  };
}

export const PRE_REVIEW_CHECKS = Object.freeze(["doc_not_in_map", "dead_link", "doc_too_large"]);

// Before review, only for the documents a change touches: outside the map, dead link,
// over the size budget. Advisory: it never blocks or decides a review.
export function preReviewDocumentChecks(options = {}) {
  const changed = new Set((options.docs || []).map((doc) => normalizeRel(doc.path)));
  if (!changed.size) return [];
  const { findings } = analyzeDocumentTidiness({ ...options, history: () => null });
  return findings.filter((finding) => PRE_REVIEW_CHECKS.includes(finding.type) && changed.has(finding.path));
}

// While a human reviews one version of a document: the dead links this version adds
// (compared with the version it replaces) and a likely duplicate among the other documents.
// others: iterable of { path, content } or { path, hashes } (documentShingles). Advisory only: it never blocks or decides a review.
export function reviewVersionChecks({ root = process.cwd(), path: docPath = "", before = null, after = null, others = [], exists, readText } = {}) {
  const rel = normalizeRel(docPath);
  if (!/\.md$/i.test(rel) || typeof after !== "string") return [];
  const options = { root, history: () => null, ...(exists ? { exists } : {}), ...(readText ? { readText } : {}) };
  const deadLinks = (content) => typeof content === "string"
    ? analyzeDocumentTidiness({ ...options, docs: [{ path: rel, content }] }).findings.filter((item) => item.type === "dead_link" && item.path === rel)
    : [];
  const previous = new Map();
  for (const item of deadLinks(before)) previous.set(item.message, (previous.get(item.message) || 0) + 1);
  const added = deadLinks(after).filter((item) => {
    const count = previous.get(item.message) || 0;
    if (count) previous.set(item.message, count - 1);
    return !count;
  });
  const duplicate = likelyDuplicateOf(rel, after, others);
  return [...added, ...(duplicate ? [duplicate] : [])];
}
