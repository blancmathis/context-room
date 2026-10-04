// Deterministic link rewriting for a document move. No model calls and no I/O:
// callers pass accepted contents and apply the result inside one proposal.
import path from "node:path";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function normalizeRel(value = "") {
  return path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "");
}

function maskCode(text = "") {
  // Same length, same line breaks: link offsets in the mask match the source.
  return String(text)
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function linkTargets(content) {
  const masked = maskCode(content);
  const targets = [];
  // Inline links [text](target "title") and reference definitions [id]: target.
  for (const match of masked.matchAll(/\]\(\s*<?([^)\s>]+)/dg)) targets.push({ start: match.indices[1][0], value: match[1] });
  for (const match of masked.matchAll(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)/dgm)) targets.push({ start: match.indices[1][0], value: match[1] });
  return targets.sort((left, right) => left.start - right.start);
}

function splitTarget(value) {
  const hashIndex = value.indexOf("#");
  const file = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const anchor = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = file.indexOf("?");
  return { file: queryIndex >= 0 ? file.slice(0, queryIndex) : file, suffix: (queryIndex >= 0 ? file.slice(queryIndex) : "") + anchor };
}

function relativeTarget(fromDirectory, targetPath, original) {
  let value = path.posix.relative(fromDirectory || ".", targetPath) || path.posix.basename(targetPath);
  if (original.startsWith("./") && !value.startsWith(".")) value = "./" + value;
  return /%[0-9a-f]{2}/i.test(original) || /\s/.test(value) ? encodeURI(value) : value;
}

function rewrite(content, replace) {
  let output = "";
  let cursor = 0;
  let count = 0;
  for (const target of linkTargets(content)) {
    const value = content.slice(target.start, target.start + target.value.length);
    const next = replace(value);
    if (next == null || next === value) continue;
    output += content.slice(cursor, target.start) + next;
    cursor = target.start + value.length;
    count += 1;
  }
  return { content: count ? output + content.slice(cursor) : content, count };
}

function resolveLink(docPath, value) {
  if (!value || SCHEME.test(value) || value.startsWith("//") || value.startsWith("#") || value.startsWith("/")) return null;
  const { file, suffix } = splitTarget(value);
  if (!file) return null;
  const resolved = normalizeRel(path.posix.join(path.posix.dirname(docPath), safeDecode(file)));
  return resolved.startsWith("../") ? null : { resolved, suffix };
}

// docs: [{ path, content }] of accepted Markdown documents, including `from`.
export function planDocumentMove({ docs = [], from, to } = {}) {
  const source = normalizeRel(from);
  const destination = normalizeRel(to);
  const edits = [];
  let moved = null;
  for (const doc of docs) {
    const docPath = normalizeRel(doc.path);
    if (typeof doc.content !== "string") continue;
    if (docPath === source) {
      // Rebase the moved document's own relative links on its new folder.
      const result = rewrite(doc.content, (value) => {
        const link = resolveLink(source, value);
        if (!link) return null;
        const target = link.resolved === source ? destination : link.resolved;
        return relativeTarget(path.posix.dirname(destination), target, value) + link.suffix;
      });
      moved = { path: destination, content: result.content, links: result.count };
      continue;
    }
    if (!/\.(md|markdown)$/i.test(docPath)) continue;
    const result = rewrite(doc.content, (value) => {
      const link = resolveLink(docPath, value);
      if (!link || link.resolved !== source) return null;
      return relativeTarget(path.posix.dirname(docPath), destination, value) + link.suffix;
    });
    if (result.count) edits.push({ path: docPath, content: result.content, links: result.count });
  }
  return { from: source, to: destination, moved, edits };
}

// Paths whose content links to `from`, for documents outside the proposal.
export function documentsLinkingTo(docs = [], from) {
  const source = normalizeRel(from);
  return docs
    .filter((doc) => typeof doc.content === "string" && normalizeRel(doc.path) !== source)
    .filter((doc) => linkTargets(doc.content).some((target) => resolveLink(normalizeRel(doc.path), target.value)?.resolved === source))
    .map((doc) => normalizeRel(doc.path));
}
