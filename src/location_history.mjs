import fs from "node:fs";
import { readNotebookBytes, safeNotebookPath } from "./notebook_io.mjs";

const LEGACY = /^\d+:\d+$/;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// Names in a directory reached without links; children of another kind are ignored.
function names(root, rel, kind) {
  try {
    return fs.readdirSync(safeNotebookPath(root, rel), { withFileTypes: true })
      .filter((entry) => kind === "directory" ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `${rel}/${entry.name}`);
  } catch {
    return [];
  }
}

// Where each record kind keeps the project root identity it was written under.
const fields = {
  notebook: (value) => value?.rootIdentity,
  proposal: (value) => value?.rootIdentity,
  workflow: (value) => value?.rootIdentity,
  migration: (value) => value?.plan?.rootIdentity,
  conversation: (value, root) => value?.origin?.root === root ? value.origin.rootIdentity : undefined,
};

/**
 * Lists the dev:ino identities that this location's own records were written
 * under, restricted to the current root inode. Read-only and bounded: every
 * path component is checked for links, each file is read once as a stable,
 * independent regular file, and only the known field of each record kind
 * counts. The result is only a candidate list for an explicit human confirmation.
 */
export function legacyRootIdentities(root, { ino, conversationRoot = "" } = {}) {
  const records = [
    ...names(root, ".context-room/notebooks/v1/resources", "directory").map((rel) => [root, `${rel}/header.json`, "notebook"]),
    ...names(root, ".context-room/local-proposals/proposals", "file").map((rel) => [root, rel, "proposal"]),
    [root, ".context-room/workflow-state.json", "workflow"],
    ...names(root, ".context-room/migrations", "directory").map((rel) => [root, `${rel}/journal.json`, "migration"]),
    ...(conversationRoot ? names(conversationRoot, "conversations", "file").map((rel) => [conversationRoot, rel, "conversation"]) : []),
  ];
  const found = new Set();
  let files = 0, bytes = 0;
  for (const [base, rel, kind] of records) {
    if (files >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) break;
    let value;
    try {
      const content = readNotebookBytes(base, rel, MAX_FILE_BYTES);
      if (!content) continue;
      files += 1; bytes += content.length;
      value = JSON.parse(content.toString("utf8"));
    } catch {
      continue;
    }
    const identity = fields[kind](value, root);
    if (typeof identity === "string" && LEGACY.test(identity) && identity.split(":")[1] === String(ino)) found.add(identity);
  }
  return [...found].sort();
}
