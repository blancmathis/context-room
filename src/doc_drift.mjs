import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectInlinePathReferences } from "./doc_metadata.mjs";

// Documents are tracked by review dependencies; drift is about the code a document cites.
const DOCUMENT_PATH = /\.(?:md|mdx|markdown|html?|crnb|mmd|mermaid)$/i;

function git(root, args) {
  try {
    return execFileSync("git", ["--literal-pathspecs", ...args], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Existing project paths a document cites (links, `code` paths, line suffixes dropped), documents excluded.
export function citedCodePaths(root, relPath, content) {
  const candidates = new Set(collectInlinePathReferences(content));
  const text = String(content || "").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/`([^`\s]*\/[^`\s]*)`/g)) candidates.add(match[1]);
  const base = path.posix.dirname(relPath);
  const found = new Set();
  for (const raw of candidates) {
    const value = raw.split(/[#?]/, 1)[0].replace(/:\d+(?:[-:]\d+)?$/, "").replace(/\/+$/, "");
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[~/]/.test(value) || /[*{}<>$]/.test(value)) continue;
    const relative = value.startsWith("./") || value.startsWith("../");
    for (const option of relative ? [path.posix.join(base, value)] : [path.posix.normalize(value), path.posix.join(base, value)]) {
      if (!option || option === "." || option.startsWith("../") || option.split("/")[0] === ".context-room" || DOCUMENT_PATH.test(option)) continue;
      if (fs.existsSync(path.join(root, option))) {
        found.add(option);
        break;
      }
    }
  }
  return [...found].sort();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// For each accepted document, count the commits that touched its cited code since a
// reference commit: the last first-parent commit made at or before the acceptance.
// Without git, the answer is unknown, never "unchanged".
export function documentationDrift(root, documents = []) {
  const results = documents.map((document) => ({
    path: document.path,
    acceptedAt: document.acceptedAt || "",
    cited: citedCodePaths(root, document.path, document.content),
  }));
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
  if (!head) {
    return results.map((result) => result.cited.length
      ? { ...result, status: "unknown", reason: "git-unavailable", since: null, commits: null, changedPaths: [], uncommitted: [], message: "No git history: drift is unknown." }
      : { ...result, status: "no-cited-code", since: null, commits: 0, changedPaths: [], uncommitted: [], message: "Cites no code path." });
  }
  const history = (git(root, ["log", "--first-parent", "--format=%H %ct", "HEAD"]) || "").trim().split("\n")
    .filter(Boolean).map((line) => { const [sha, time] = line.split(" "); return { sha, time: Number(time) }; });
  const groups = new Map();
  for (const result of results) {
    const acceptedTime = Date.parse(result.acceptedAt);
    if (!result.cited.length || !Number.isFinite(acceptedTime)) continue;
    // No commit before the acceptance: everything in history came after it.
    const ref = history.find((commit) => commit.time <= Math.floor(acceptedTime / 1000))?.sha || "";
    result.since = ref ? { commit: ref } : { commit: null };
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(result);
  }
  // A cited folder drifts when its code changes, not its documents.
  const covers = (cited, file) => (file === cited || file.startsWith(`${cited}/`)) && !DOCUMENT_PATH.test(file);
  for (const [ref, members] of groups) {
    const paths = [...new Set(members.flatMap((member) => member.cited))];
    const log = git(root, ["log", "--relative", "--format=%x1e%H", "--name-only", ref ? `${ref}..HEAD` : "HEAD", "--", ...paths]) || "";
    const commits = log.split("\x1e").slice(1).map((chunk) => chunk.trim().split("\n").filter(Boolean)).map(([, ...files]) => files);
    for (const member of members) {
      const touched = commits.map((files) => member.cited.filter((cited) => files.some((file) => covers(cited, file))));
      member.commits = touched.filter((hits) => hits.length).length;
      const counts = new Map();
      for (const hits of touched) for (const cited of hits) counts.set(cited, (counts.get(cited) || 0) + 1);
      member.changedPaths = [...counts].map(([citedPath, count]) => ({ path: citedPath, commits: count }))
        .sort((left, right) => right.commits - left.commits || left.path.localeCompare(right.path));
    }
  }
  const allCited = [...new Set(results.flatMap((result) => result.cited))];
  const dirty = allCited.length ? (git(root, ["diff", "--name-only", "--relative", "HEAD", "--", ...allCited]) || "").split("\n").filter(Boolean) : [];
  return results.map((result) => {
    const uncommitted = result.cited.filter((cited) => dirty.some((file) => covers(cited, file)));
    if (!result.cited.length) return { ...result, status: "no-cited-code", since: null, commits: 0, changedPaths: [], uncommitted, message: "Cites no code path." };
    if (!result.since) return { ...result, status: "unknown", reason: "no-acceptance-date", since: null, commits: null, changedPaths: [], uncommitted, message: "No acceptance date: drift is unknown." };
    const changed = result.commits > 0 || uncommitted.length > 0;
    const parts = [];
    if (result.commits) parts.push(`The cited code changed ${result.commits === 1 ? "once" : `${result.commits} times`} since you accepted this document.`);
    if (uncommitted.length) parts.push(`${plural(uncommitted.length, "cited path")} ${uncommitted.length === 1 ? "has" : "have"} uncommitted changes.`);
    return { ...result, status: changed ? "changed" : "unchanged", uncommitted,
      message: changed ? parts.join(" ") : "The cited code has not changed since you accepted this document." };
  });
}
