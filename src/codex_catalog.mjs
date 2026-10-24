import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contextHubRegistryRevision, listContextHubProjects, registerContextHubProject, contextHubRegistrationWarning } from './context_hub.mjs';
import { appendContextRoomEvent } from './event_journal.mjs';
import { readFilesystemIdentity, compareFilesystemIdentity } from './filesystem_identity.mjs';

const run = promisify(execFile);
const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const MAX_PROJECTS = 500;
const fault = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

export const codexHomeDirectory = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));

const real = value => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };

/** Folders the Hub never offers: the home folder, the filesystem root and Codex or SSH private state. */
function refusedRoot(root, codexHome) {
  const home = real(os.homedir()), resolved = real(root);
  const privateDirs = [real(codexHome), real(path.join(home, '.codex')), real(path.join(home, '.ssh'))];
  return resolved === path.parse(resolved).root || resolved === home || privateDirs.some(dir => resolved === dir || resolved.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
}

/** Reads the catalog Codex Desktop keeps: `local-projects` in `project-order`, then the rest. */
export function readCodexDesktopCatalog({ codexHome = codexHomeDirectory() } = {}) {
  const file = path.join(codexHome, '.codex-global-state.json');
  let stats;
  try { stats = fs.statSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return { file, found: false, projects: [] };
    throw fault('codex_catalog_unreadable', 'The Codex Desktop project list cannot be read. Try again in a moment.');
  }
  if (!stats.isFile() || stats.size > MAX_CATALOG_BYTES) throw fault('codex_catalog_unreadable', 'The Codex Desktop project list is missing or too large to read.');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(); }
  catch { throw fault('codex_catalog_unreadable', 'The Codex Desktop project list is being written or is damaged. Try again in a moment.'); }
  const table = state['local-projects'], order = Array.isArray(state['project-order']) ? state['project-order'] : [];
  const entries = table && typeof table === 'object' ? (Array.isArray(table) ? table : Object.values(table)) : [];
  const byId = new Map(entries.filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string').map(entry => [entry.id, entry]));
  const ordered = [...order.map(id => byId.get(id)).filter(Boolean), ...entries.filter(entry => !order.includes(entry?.id))];
  const projects = [], seen = new Set();
  for (const entry of [...new Set(ordered)].slice(0, MAX_PROJECTS)) {
    const roots = Array.isArray(entry?.rootPaths) ? entry.rootPaths.filter(value => typeof value === 'string') : [];
    const name = String(entry?.name || '').trim().slice(0, 160);
    roots.forEach((rootPath, index) => {
      if (!path.isAbsolute(rootPath) || rootPath.includes('\0')) { projects.push({ key: index ? `${entry.id}:${index}` : entry.id, name: name || path.basename(rootPath) || 'Project', root: rootPath, refused: 'The path is not absolute.' }); return; }
      const resolved = path.resolve(rootPath);
      const identity = real(resolved);
      if (seen.has(identity)) return;
      seen.add(identity);
      const base = path.basename(resolved) || resolved;
      projects.push({ key: index ? `${entry.id}:${index}` : entry.id, name: roots.length > 1 ? `${name || base} · ${base}` : name || base, root: resolved });
    });
  }
  return { file, found: true, projects };
}

function folderState(root, codexHome) {
  if (refusedRoot(root, codexHome)) return { status: 'refused', reason: 'Context Room does not offer your home folder, the filesystem root, or Codex and SSH private folders.' };
  let link;
  try { link = fs.lstatSync(root); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'missing', reason: 'This folder no longer exists on this Mac.' };
    return { status: 'refused', reason: 'This folder cannot be read.' };
  }
  if (link.isSymbolicLink()) return { status: 'refused', reason: 'The project folder is a symbolic link.' };
  if (!link.isDirectory()) return { status: 'refused', reason: 'This path is not a folder.' };
  try { fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); }
  catch { return { status: 'refused', reason: 'This folder is not accessible for reading and writing.' }; }
  const control = path.join(root, '.context-room');
  let directory;
  try { directory = fs.lstatSync(control); } catch { return { status: 'needs-init' }; }
  if (directory.isSymbolicLink() || !directory.isDirectory()) return { status: 'refused', reason: '.context-room is not a regular folder.' };
  try { return fs.lstatSync(path.join(control, 'config.json')).isFile() ? { status: 'ready' } : { status: 'refused', reason: '.context-room/config.json is not a regular file.' }; }
  catch { return { status: 'needs-init' }; }
}

/**
 * The registered location a folder already is: by path, else by durable identity
 * (ino + birth time), so a moved folder is never taken for a new one. A legacy entry
 * without a durable identity matches on its exact dev:ino.
 */
function registeredMatch(root, registered, byRoot = new Map(registered.map(entry => [real(entry.root), entry]))) {
  const byPath = byRoot.get(real(root));
  if (byPath) return { entry: byPath, moved: false };
  const live = readFilesystemIdentity(root).identity;
  if (!live) return null;
  let stats = null;
  const entry = registered.find(item => {
    if (item.rootDurableIdentity) return compareFilesystemIdentity(item.rootDurableIdentity, live).status === 'same';
    const stored = item.rootIdentity;
    if (!stored?.ino) return false;
    try { stats ||= fs.lstatSync(root); } catch { return false; }
    return String(stored.ino) === String(stats.ino) && String(stored.dev) === String(stats.dev);
  });
  return entry ? { entry, moved: true } : null;
}

/** One row per folder. Read-only: nothing is written to a folder or to the Hub. */
export function previewCodexProjectImport({ codexHome = codexHomeDirectory(), catalog = readCodexDesktopCatalog({ codexHome }) } = {}) {
  const registered = listContextHubProjects({ readOnly: true });
  const byRoot = new Map(registered.map(entry => [real(entry.root), entry]));
  const rows = catalog.projects.map(project => {
    const base = { key: project.key, name: project.name, root: project.root, repository: fs.existsSync(path.join(project.root, '.git')) };
    if (project.refused) return { ...base, status: 'refused', reason: project.refused };
    const found = refusedRoot(project.root, codexHome) ? null : registeredMatch(project.root, registered, byRoot), match = found?.entry;
    if (match) {
      const reason = found.moved ? `This folder moved. Its registered location is ${match.root}; the project keeps its Shared link there.` : match.unavailableReason || 'This location is unavailable.';
      return { ...base, status: 'registered', projectId: match.id, available: found.moved ? false : Boolean(match.available),
        ...(found.moved ? { moved: true, registeredRoot: match.root } : {}),
        ...(found.moved || !match.available ? { reason } : {}),
        ...(found.moved || match.unavailableReason === 'identity to confirm' ? { needsConfirmation: true } : {}) };
    }
    return { ...base, ...folderState(project.root, codexHome) };
  });
  const revision = createHash('sha256').update(JSON.stringify(rows.map(row => [row.key, row.root, row.status]))).update(contextHubRegistryRevision()).digest('hex');
  return { found: catalog.found, revision, projects: rows,
    counts: Object.fromEntries(['registered', 'ready', 'needs-init', 'missing', 'refused'].map(status => [status, rows.filter(row => row.status === status).length])) };
}

/** Imports only the chosen `ready` or `needs-init` folders. A registered folder is never registered again. */
export async function applyCodexProjectImport({ roots, expectedRevision, codexHome = codexHomeDirectory(), initialize, record = true } = {}) {
  if (!Array.isArray(roots) || !roots.length || roots.some(value => typeof value !== 'string')) throw fault('codex_import_roots', 'Choose at least one folder from the Codex project list.', 400);
  if (typeof expectedRevision !== 'string' || !expectedRevision) throw fault('codex_import_revision', 'Preview the import first and send its revision.', 400);
  const preview = previewCodexProjectImport({ codexHome });
  if (preview.revision !== expectedRevision) throw fault('codex_import_stale', 'The Codex project list or the Hub changed. Preview the import again.', 409);
  const init = initialize || (await import('./context_room.mjs')).initializeContextRoomProject;
  const results = [];
  for (const requested of [...new Set(roots)]) {
    const row = preview.projects.find(item => item.root === path.resolve(requested));
    if (!row) { results.push({ root: requested, outcome: 'failed', reason: 'This folder is not in the Codex project list.' }); continue; }
    if (row.status === 'registered') { results.push({ root: row.root, name: row.name, outcome: 'skipped', reason: 'Already registered; nothing was changed.' }); continue; }
    if (row.status !== 'ready' && row.status !== 'needs-init') { results.push({ root: row.root, name: row.name, outcome: 'failed', reason: row.reason || 'This folder cannot be imported.' }); continue; }
    let initialized = false;
    try {
      // Re-check just before writing: the folder may have changed since the preview.
      const now = folderState(row.root, codexHome);
      if (registeredMatch(row.root, listContextHubProjects({ readOnly: true }))) throw fault('codex_import_changed', 'This folder is already a registered location. Preview the import again.');
      if (now.status !== row.status) throw fault('codex_import_changed', 'The folder changed while importing. Preview the import again.');
      if (row.status === 'needs-init') { init(row.root, { title: row.name }); initialized = true; }
      const registered = registerContextHubProject(row.root, { title: row.name });
      const warning = contextHubRegistrationWarning(registered);
      if (registered.identityUnconfirmed === true) { results.push({ root: row.root, name: row.name, outcome: 'failed', reason: initialized ? `The folder was initialized; its entry needs confirmation. ${warning}`.trim() : warning }); continue; }
      if (record) appendContextRoomEvent('project.location-registered', { projectId: registered.logicalProjectId, locationId: registered.id,
        sharedRepository: registered.shared?.repository || '', resource: { root: registered.root, branch: registered.worktree?.branch || '' } });
      results.push({ root: row.root, name: row.name, outcome: 'imported', projectId: registered.id, initialized: row.status === 'needs-init', ...(warning ? { warning } : {}) });
    } catch (error) { results.push({ root: row.root, name: row.name, outcome: 'failed', reason: `${initialized ? 'The folder was initialized, but it is not registered. ' : ''}${String(error?.message || 'The import failed.')}`.slice(0, 240) }); }
  }
  return { results, imported: results.filter(item => item.outcome === 'imported').length };
}

const git = (cwd, args) => run('git', ['-C', cwd, ...args], { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).then(result => result.stdout);

/**
 * Folders whose Codex tasks belong to this project: the folder itself, plus the live
 * worktrees of the same repository when it is the top of that repository. A subfolder
 * never grants its parent repository. Reading only: no worktree is registered.
 */
async function listSessionRoots(root) {
  const base = real(root), roots = [base];
  try {
    const top = real((await git(base, ['rev-parse', '--show-toplevel'])).trim());
    if (top !== base) return roots;
    const common = real((await git(base, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const listed = (await git(base, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(block => block.split('\0'));
    const candidates = listed.filter(lines => !lines.includes('bare') && !lines.some(line => line.startsWith('prunable')))
      .map(lines => lines.find(line => line.startsWith('worktree '))?.slice(9)).filter(Boolean).map(real).filter(value => value !== base && fs.existsSync(value));
    const checked = await mapLimited(candidates, GIT_CONCURRENCY, async candidate => {
      try { return real((await git(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()) === common ? candidate : null; }
      catch { return null; }
    });
    for (const candidate of checked) if (candidate && !roots.includes(candidate)) roots.push(candidate);
  } catch { /* Not a repository, or Git is slow: the folder alone is still correct. */ }
  return roots;
}

async function mapLimited(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; out[index] = await work(items[index]); } }));
  return out;
}

const ROOTS_TTL_MS = 10_000, ROOTS_CACHE_MAX = 64, GIT_CONCURRENCY = 4;
const rootsCache = new Map();

/** `listSessionRoots`, kept 10 s per folder (64 folders at most); concurrent callers share one run. */
export function codexSessionRoots(root) {
  const key = real(root), hit = rootsCache.get(key);
  if (hit && Date.now() - hit.at < ROOTS_TTL_MS) return hit.promise.then(roots => [...roots]);
  const promise = listSessionRoots(key);
  rootsCache.delete(key);
  rootsCache.set(key, { at: Date.now(), promise });
  while (rootsCache.size > ROOTS_CACHE_MAX) rootsCache.delete(rootsCache.keys().next().value);
  return promise.then(roots => [...roots]);
}

/** Forgets the cached session roots (tests). */
export const clearCodexSessionRootsCache = () => rootsCache.clear();
