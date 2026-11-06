// Read-only "Go to" search across every registered local project: file names and file text.
// Not the reviewed-docs engine (documentation.mjs): it must find files that are not reviewed yet.
// The index lives in a worker thread (goto_search_worker.mjs). This module only picks which projects to
// search and forwards the request, so no file is scanned or read on the Hub main thread.
import path from "node:path";
import { Worker } from "node:worker_threads";

export { foldSearchText } from "./goto_search_engine.mjs";

let requestTimeoutMs = 8000;
let backoffBaseMs = 5000;
let worker = null;
let workerUrl = new URL("./goto_search_worker.mjs", import.meta.url);
let nextId = 1;
let spawns = 0;
let failures = 0;
let backoffUntil = 0;
const pending = new Map();

// A worker that cannot start (or keeps dying) is not respawned for every request: wait 5 s, 10 s, ... up to 60 s.
function noteWorkerFailure(created, reason) {
  if (worker === created) worker = null;
  failAll(reason);
  failures += 1;
  backoffUntil = Date.now() + Math.min(12 * backoffBaseMs, backoffBaseMs * 2 ** (failures - 1));
  console.error("[context-room] Go to search worker failed: " + reason);
}

function failAll(reason) {
  for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ failed: reason }); }
  pending.clear();
}

function startWorker() {
  if (worker) return worker;
  spawns += 1;
  const created = new Worker(workerUrl);
  created.on("message", ({ id, result, error, progress }) => {
    // A worker that reports progress is busy, not hung: the silence timer starts again.
    if (progress) { if (worker === created) for (const [pendingId, entry] of pending) { clearTimeout(entry.timer); entry.timer = armTimeout(pendingId); } return; }
    failures = 0;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(error ? { failed: error } : { result });
  });
  created.on("error", (error) => noteWorkerFailure(created, String(error?.message || error)));
  created.on("exit", () => { if (worker === created) noteWorkerFailure(created, "worker exited"); });
  created.unref(); // after the listeners: adding a 'message' listener refs the port again
  worker = created;
  return created;
}

// Only silence counts as a failure: the timer is armed again whenever the worker reports progress.
function armTimeout(id) {
  return setTimeout(() => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.resolve({ failed: "timeout" });
    // A worker that does not answer is hung (sync loop): replace it instead of feeding it more requests.
    const hung = worker;
    if (hung) { noteWorkerFailure(hung, "request timed out"); hung.terminate().catch(() => {}); }
  }, requestTimeoutMs);
}

function request(payload) {
  if (!worker && Date.now() < backoffUntil) return Promise.resolve({ failed: "unavailable" });
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve, timer: armTimeout(id) });
    try { startWorker().postMessage({ id, ...payload }); } catch (error) { clearTimeout(pending.get(id)?.timer); pending.delete(id); resolve({ failed: String(error?.message || error) }); }
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
  if (reply.failed) return { terms: [], files: [], text: [], truncated: true, building: false, failed: true, searchedProjects: 0, filesTotal: 0, textTotal: 0 };
  return reply.result;
}

export function warmGotoSearch(projects) {
  request({ type: "warm", projects: wire(projects) });
}

export async function resetGotoSearchIndexForTests() { if (worker) await request({ type: "reset" }); }
export async function gotoSearchStatsForTests() { return (await request({ type: "stats" })).result; }
export async function stopGotoSearchWorkerForTests() { const current = worker; worker = null; if (current) await current.terminate(); }
export function setGotoWorkerUrlForTests(url) { workerUrl = url || new URL("./goto_search_worker.mjs", import.meta.url); failures = 0; backoffUntil = 0; spawns = 0; }
export function setGotoTimingsForTests({ timeoutMs = 8000, backoffMs = 5000 } = {}) { requestTimeoutMs = timeoutMs; backoffBaseMs = backoffMs; }
export const gotoWorkerSpawnsForTests = () => spawns;
