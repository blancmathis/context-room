// Worker thread for "Go to": owns the file index. The Hub main thread only forwards requests and answers.
import { parentPort } from "node:worker_threads";
import path from "node:path";
import { effectiveMemoryWebappSettings, listMemoryFiles, resolveMemoryPath } from "./context_room.mjs";
import { createGotoEngine } from "./goto_search_engine.mjs";

// Access settings are re-read at query time, so a path removed from allowedPaths stops being served.
const settingsCache = new Map();
function settingsFor(root) {
  const cached = settingsCache.get(root);
  if (cached && Date.now() - cached.at < 1000) return cached.settings;
  const settings = effectiveMemoryWebappSettings(root, { readOnly: true });
  settingsCache.set(root, { at: Date.now(), settings });
  return settings;
}

const engine = createGotoEngine({
  listFiles: (root) => listMemoryFiles(root, { readOnly: true, metadataOnly: true }),
  resolveFile: (root, rel) => {
    try { return resolveMemoryPath(root, rel, { readOnly: true, settings: settingsFor(root) }); } catch { return ""; }
  },
  onProgress: () => parentPort.postMessage({ progress: true }),
  ...(process.env.CONTEXT_ROOM_GOTO_MAX_BYTES ? { maxTotalBytes: Number(process.env.CONTEXT_ROOM_GOTO_MAX_BYTES) } : {}),
});

parentPort.on("message", async (message) => {
  const { id, type } = message;
  try {
    if (type === "warm") { engine.warm(message.projects); parentPort.postMessage({ id, result: { warmed: true } }); return; }
    if (type === "reset") { engine.reset(); settingsCache.clear(); parentPort.postMessage({ id, result: {} }); return; }
    if (type === "stats") { parentPort.postMessage({ id, result: engine.stats() }); return; }
    parentPort.postMessage({ id, result: await engine.search(message.projects, message.query, { limit: message.limit }) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error), path: path.basename(String(message.type)) });
  }
});
