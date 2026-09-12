import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { withFilesystemLock } from "./filesystem_lock.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function atomicJson(target, value) {
  const temporary = target + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function readObject(store, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid reader content address.");
  const file = path.join(store, "objects", digest);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd);
    if (hash(bytes) !== digest) throw new Error("Reader content snapshot is damaged.");
    return bytes.toString("utf8");
  } finally { fs.closeSync(fd); }
}

function storeObject(store, content) {
  const digest = hash(content);
  try { fs.writeFileSync(path.join(store, "objects", digest), content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  readObject(store, digest);
  return digest;
}

function changedLines(before, after, maxChars) {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const removed = a.slice(start, a.length - end).join("\n");
  const added = b.slice(start, b.length - end).join("\n");
  const removedBudget = Math.min(removed.length, Math.ceil(maxChars / 2));
  const addedBudget = Math.min(added.length, maxChars - removedBudget);
  const availableForRemoved = maxChars - addedBudget;
  return { startLine: start + 1, removed: removed.slice(0, availableForRemoved), added: added.slice(0, addedBudget), truncated: removed.length + added.length > maxChars };
}

/** Record only accepted documents actually returned by this command, per caller-owned reader. */
export function recordDocumentationRead(corpus, paths, { readerToken = "", sessionId = "", storeRoot, maxDiffChars = 4000, completePaths = [] } = {}) {
  const supplied = String(readerToken || process.env.CONTEXT_ROOM_READER_TOKEN || "").trim();
  const conversation = String(sessionId || process.env.CONTEXT_ROOM_CONVERSATION_ID || "").trim();
  if (supplied && !/^reader-[a-f0-9-]{32,64}$/.test(supplied)) throw new Error("Invalid reader token. Reuse the readerToken returned by a previous documentation command.");
  const token = supplied || (conversation ? "reader-" + hash(conversation) : "reader-" + randomUUID());
  const base = storeRoot || path.join(process.env.CONTEXT_ROOM_HUB_HOME || path.join(os.homedir(), ".context-room", "hub"), "documentation-readers");
  const scope = hash(JSON.stringify({ root: corpus.target?.mode === "shared-only" ? "" : corpus.root, target: corpus.target?.repository || "", projectId: corpus.target?.projectId || "" }));
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(base).isSymbolicLink()) throw new Error("The reader store cannot be a symbolic link.");
    const store = fs.realpathSync(base);
    for (const folder of ["objects", "readers"]) {
      fs.mkdirSync(path.join(store, folder), { recursive: true, mode: 0o700 });
      if (fs.lstatSync(path.join(store, folder)).isSymbolicLink()) throw new Error("Reader store directories cannot be symbolic links.");
    }
    return withFilesystemLock(path.join(store, token + ".lock"), () => {
      const file = path.join(store, "readers", token + ".json");
      let state;
      try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { state = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (supplied && !state) throw new Error("This reader token is unknown on this machine. Omit --reader to start a new reader.");
      const continuity = state ? "resumed" : "new";
      state ||= { schemaVersion: 1, scopes: {} };
      if (state.schemaVersion !== 1 || !state.scopes || typeof state.scopes !== "object") throw new Error("Invalid reader state.");
      const previous = state.scopes[scope] || {};
      const accepted = new Map(corpus.documents.filter((document) => document.reviewStatus === "accepted").map((document) => [document.path, document]));
      const updates = [];
      let remaining = Math.max(0, Math.min(32000, Number(maxDiffChars) || 0));
      const incomplete = new Set();
      for (const [rel, old] of Object.entries(previous)) {
        const current = accepted.get(rel);
        if (!current) {
          updates.push({ path: rel, from: old.hash, to: null, availability: "unavailable-in-accepted-snapshot" });
          delete previous[rel];
        } else if (hash(current.rawContent) !== old.hash) {
          const nextHash = storeObject(store, current.rawContent);
          const diff = changedLines(readObject(store, old.hash), current.rawContent, remaining);
          remaining -= diff.removed.length + diff.added.length;
          updates.push({ path: rel, from: old.hash, to: nextHash, diff,
            ...(diff.truncated ? { next: `docs read ${JSON.stringify(rel)} --reader ${token}` } : {}) });
          if (diff.truncated) incomplete.add(rel);
          else previous[rel] = { hash: nextHash };
        }
      }
      for (const rel of new Set(paths)) {
        const current = accepted.get(rel);
        if (current && (!incomplete.has(rel) || completePaths.includes(rel))) previous[rel] = { hash: storeObject(store, current.rawContent) };
      }
      state.scopes[scope] = previous;
      atomicJson(file, state);
      return { readerToken: token, continuity, resumeWith: `--reader ${token}`, updates };
    });
  } catch (error) {
    if (["EACCES", "EROFS", "EPERM"].includes(error.code)) return { readerToken: null, continuity: "unavailable", reason: "The private reader store is not writable.", updates: [] };
    throw error;
  }
}
