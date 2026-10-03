import fs from "node:fs";
import path from "node:path";

// Records keep their project root as "rootIdentity": "dev:ino" (notebook
// headers, local proposals, workflow state and journals, conversations).
const STRING_IDENTITY = /"rootIdentity"\s*:\s*"(\d+):(\d+)"/g;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function regularFile(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && stats.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

function childDirectories(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function jsonFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

/**
 * Lists the dev:ino identities that this location's own records were written
 * under, restricted to the current root inode. Read-only and bounded: it never
 * follows links and ignores unreadable or oversized files. The result is only
 * a candidate list for an explicit human confirmation.
 */
export function legacyRootIdentities(root, { ino, conversationRoot = "" } = {}) {
  const control = path.join(root, ".context-room");
  const projectFiles = [
    ...childDirectories(path.join(control, "notebooks", "v1", "resources")).map((directory) => path.join(directory, "header.json")),
    ...jsonFiles(path.join(control, "local-proposals", "proposals")),
    path.join(control, "workflow-state.json"),
    ...childDirectories(path.join(control, "migrations")).map((directory) => path.join(directory, "journal.json")),
  ];
  const conversationFiles = conversationRoot ? jsonFiles(path.join(conversationRoot, "conversations")) : [];
  const found = new Set();
  let scanned = 0;
  for (const [filePath, conversation] of [
    ...projectFiles.map((filePath) => [filePath, false]),
    ...conversationFiles.map((filePath) => [filePath, true]),
  ]) {
    if (scanned >= MAX_FILES) break;
    if (!regularFile(filePath)) continue;
    scanned += 1;
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    if (conversation) {
      try {
        const origin = JSON.parse(text)?.origin;
        if (origin?.root === root && /^\d+:\d+$/.test(origin.rootIdentity || "")) text = JSON.stringify({ rootIdentity: origin.rootIdentity });
        else continue;
      } catch {
        continue;
      }
    }
    for (const [, dev, matchIno] of text.matchAll(STRING_IDENTITY)) {
      if (matchIno === String(ino)) found.add(`${dev}:${matchIno}`);
    }
  }
  return [...found].sort();
}
