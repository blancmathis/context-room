// Read-only "Go to" search across every registered local project: file names and file text.
// Not the reviewed-docs engine (documentation.mjs): it must find files that are not reviewed yet.
// The index lives in a worker thread (goto_search_worker.mjs). This module only picks which projects to
// search and forwards the request, so no file is scanned or read on the Hub main thread.
import path from "node:path";
import { Worker } from "node:worker_threads";

export { foldSearchText } from "./goto_search_engine.mjs";

const REQUEST_TIMEOUT_MS = 8000;
let worker = null;
let nextId = 1;
const pending = new Map();

function failAll(reason) {
  for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ failed: reason }); }
  pending.clear();
}

function startWorker() {
  if (worker) return worker;
  const created = new Worker(new URL("./goto_search_worker.mjs", import.meta.url));
  created.on("message", ({ id, result, error }) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(error ? { failed: error } : { result });
  });
  created.on("error", (error) => { if (worker === created) worker = null; failAll(String(error?.message || error)); });
  created.on("exit", () => { if (worker === created) worker = null; failAll("worker exited"); });
  created.unref(); // after the listeners: adding a 'message' listener refs the port again
  worker = created;
  return created;
}

function request(payload) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ failed: "timeout" }); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try { startWorker().postMessage({ id, ...payload }); } catch (error) { pending.delete(id); clearTimeout(timer); resolve({ failed: String(error?.message || error) }); }
  });
}

// The project to search for each logical project: its main checkout when it has one, else the first available.
export function gotoSearchProjects(projects = []) {
  const logicalOf = (project) => String(project.logicalProjectId || project.id);
  const usable = projects.filter((project) => project?.root && project.mode !== "shared" && project.available !== false && !project.space);
  const rankOf = (project) => project.worktree?.main === true ? 0 : project.worktree ? 1 : 0;
  const best = new Map();
  for (const project of usable) {
    const key = logicalOf(project);
    const current = best.get(key);
    if (!current || rankOf(project) < rankOf(current)) best.set(key, project);
  }
  return [...best.values()].map((project) => ({
    id: project.id, root: project.root, title: project.title || path.basename(project.root),
    projectKey: `local:${logicalOf(project)}`, worktree: project.worktree,
  }));
}

const wire = (projects) => gotoSearchProjects(projects).map(({ id, root, title, projectKey }) => ({ id, root, title, projectKey }));

export async function searchGoto(projects, query, { limit = 40 } = {}) {
  const reply = await request({ type: "search", projects: wire(projects), query, limit });
  if (reply.failed) return { terms: [], files: [], text: [], truncated: true, building: true, searchedProjects: 0, filesTotal: 0, textTotal: 0 };
  return reply.result;
}

export function warmGotoSearch(projects) {
  request({ type: "warm", projects: wire(projects) });
}

export async function resetGotoSearchIndexForTests() { if (worker) await request({ type: "reset" }); }
export async function gotoSearchStatsForTests() { return (await request({ type: "stats" })).result; }
export async function stopGotoSearchWorkerForTests() { const current = worker; worker = null; if (current) await current.terminate(); }
