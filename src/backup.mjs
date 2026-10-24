import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { notebookHash, readNotebookBytes, writeNotebookBytes } from './notebook_io.mjs';
import { listNotebooks, NOTEBOOK_STORE } from './notebooks.mjs';
import { assertProjectWriter } from './writer_authority.mjs';
import { contextHubHome, contextHubRuntimeAlive } from './context_hub.mjs';
import { reviewAuthorityHome } from './review_authority.mjs';
import { assistantStorageRoot } from './assistant_runtime.mjs';

export const BACKUP_VERSION = 1;
export const BACKUP_MEDIA_TYPE = 'application/vnd.context-room.backup+json';
export const BACKUP_SECTIONS = Object.freeze(['registry', 'review', 'conversations', 'recordings', 'notebooks']);
const MAX_TOTAL_BYTES = 2 * 1024 ** 3, MAX_FILE_BYTES = 256 * 1024 ** 2, LIST_LIMIT = 20, ATTEMPTS = 3;
const HOMES = { '@hub': contextHubHome, '@review': reviewAuthorityHome, '@assistant': assistantStorageRoot };
const ASSISTANT_DIRS = {
  conversations: ['conversations', 'legacy-history', 'legacy-history-sources', 'annotations'],
  recordings: ['legacy-recordings'],
};
const SECRET_NAMES = new Set(['authority.key']);
const SHA = /^[a-f0-9]{64}$/;
const transient = name => /\.(lock|tmp)$/.test(name);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
function realOrSelf(target) {
  // The nearest existing ancestor decides: a new directory still lives where its parent really is.
  const rest = [];
  let current = path.resolve(target);
  while (true) {
    try { return path.join(fs.realpathSync(current), ...rest.reverse()); }
    catch (error) { if (error.code !== 'ENOENT' || current === path.dirname(current)) throw error; rest.push(path.basename(current)); current = path.dirname(current); }
  }
}
function homeDirectory(token) { return realOrSelf(HOMES[token]()); }
function rootDirectory(root) { return root in HOMES ? homeDirectory(root) : root; }
function selectSections(only) {
  const wanted = only === undefined || only === null || only === true ? [...BACKUP_SECTIONS]
    : (Array.isArray(only) ? only : String(only).split(',')).map(item => item.trim()).filter(Boolean);
  if (!wanted.length) fail('backup_sections', 'Name at least one section.');
  for (const name of wanted) if (!BACKUP_SECTIONS.includes(name)) fail('backup_sections', `Unknown section "${name}". Choose from ${BACKUP_SECTIONS.join(', ')}.`);
  return BACKUP_SECTIONS.filter(name => wanted.includes(name));
}

/** Project roots whose notebooks are saved. Registry only; the free Carnets space is a registry entry too. */
export function backupNotebookRoots() {
  let registry;
  try { registry = JSON.parse(readNotebookBytes(homeDirectory('@hub'), 'registry.json', MAX_FILE_BYTES)?.toString('utf8') || 'null'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return registryRoots(registry);
}
function registryRoots(registry) {
  const roots = new Set();
  for (const project of Array.isArray(registry?.projects) ? registry.projects : []) {
    for (const candidate of [project?.root, ...(Array.isArray(project?.projectGroup) ? project.projectGroup.map(item => item?.root) : [])]) {
      if (typeof candidate === 'string' && candidate) roots.add(path.resolve(candidate));
    }
  }
  return [...roots].sort();
}

function storeIsPlain(root) {
  let current = root;
  for (const part of NOTEBOOK_STORE.split('/')) {
    current = path.join(current, part);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stats) return true;
    if (!stats.isDirectory()) return false;
  }
  return true;
}
function walk(root, rel, files, warnings) {
  const directory = rel ? path.join(root, rel) : root;
  let names;
  try { names = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  for (const item of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (transient(item.name)) continue;
    const child = rel ? `${rel}/${item.name}` : item.name;
    if (item.isDirectory()) walk(root, child, files, warnings);
    else if (item.isFile()) files.push(child);
    else warnings.push(`Skipped a link or special file: ${path.join(root, child)}`);
  }
}

/** The saved files of the chosen sections as `{section, root, path}`, sorted. No file is read here. */
function enumerate(sections, { notebookRoots = backupNotebookRoots(), warnings = [] } = {}) {
  const refs = [];
  const homeFiles = (section, token, dirs) => {
    const root = homeDirectory(token), files = [];
    for (const dir of dirs) walk(root, dir, files, warnings);
    for (const file of files) refs.push({ section, root: token, path: file });
  };
  if (sections.includes('registry')) {
    const stats = fs.lstatSync(path.join(homeDirectory('@hub'), 'registry.json'), { throwIfNoEntry: false });
    if (stats?.isFile()) refs.push({ section: 'registry', root: '@hub', path: 'registry.json' });
  }
  if (sections.includes('review')) homeFiles('review', '@review', ['']);
  for (const section of ['conversations', 'recordings']) if (sections.includes(section)) homeFiles(section, '@assistant', ASSISTANT_DIRS[section]);
  if (sections.includes('notebooks')) {
    for (const root of notebookRoots) {
      let canonical = false;
      try { canonical = fs.realpathSync(root) === root && fs.statSync(root).isDirectory(); } catch {}
      if (!canonical) { warnings.push(`Skipped an unavailable project folder: ${root}`); continue; }
      const files = [];
      try {
        for (const notebook of listNotebooks(root)) if (fs.lstatSync(path.join(root, notebook.path), { throwIfNoEntry: false })?.isFile()) files.push(notebook.path);
      } catch (error) { warnings.push(`Could not list the notebooks of ${root}: ${error.message}`); }
      if (storeIsPlain(root)) walk(root, NOTEBOOK_STORE, files, warnings);
      else warnings.push(`Skipped the notebook store of ${root}: .context-room is a link or not a plain folder.`);
      for (const file of new Set(files)) refs.push({ section: 'notebooks', root, path: file });
    }
  }
  return refs.sort(compareRefs);
}
const compareRefs = (a, b) => (a.section + '\0' + a.root + '\0' + a.path < b.section + '\0' + b.root + '\0' + b.path ? -1 : 1);
const refKey = ref => `${ref.section}\0${ref.root}\0${ref.path}`;
const secretsOf = entries => [...new Set(entries.filter(entry => SECRET_NAMES.has(path.posix.basename(entry.path))).map(entry => `${entry.section}/${entry.path}`))].sort();

function readRef(ref) {
  const bytes = readNotebookBytes(rootDirectory(ref.root), ref.path, MAX_FILE_BYTES);
  if (bytes === null) fail('backup_changed', `A saved file disappeared during the backup: ${ref.path}`);
  return bytes;
}
/** Read and hash every file once; keep objects only when a destination is given. */
const SKIPPABLE = { notebook_path_scope: 'a symbolic link or hard link', notebook_size: `larger than ${MAX_FILE_BYTES / 1024 ** 2} MiB or hard-linked`, ELOOP: 'a symbolic link' };
function collect(refs, objects) {
  const entries = [], skipped = []; let total = 0;
  for (const ref of refs) {
    let bytes;
    try { bytes = readRef(ref); }
    catch (error) {
      if (!(error.code in SKIPPABLE)) throw error;
      skipped.push({ section: ref.section, root: ref.root, path: ref.path, reason: SKIPPABLE[error.code] });
      continue;
    }
    const hash = sha256(bytes);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('backup_too_large', 'The data exceeds the 2 GiB backup limit. Choose fewer sections with --only.');
    if (objects) { try { fs.writeFileSync(path.join(objects, hash), bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    entries.push({ section: ref.section, root: ref.root, path: ref.path, sha256: hash, bytes: bytes.length });
  }
  return { entries, skipped };
}
const skippedWarnings = skipped => [...skipped.slice(0, LIST_LIMIT).map(item => `Not saved (${item.reason}): ${item.root}/${item.path}`),
  ...(skipped.length > LIST_LIMIT ? [`…and ${skipped.length - LIST_LIMIT} more files not saved (see "skipped" in manifest.json).`] : [])];
const summarize = (entries, sections) => Object.fromEntries(sections.map(name => {
  const own = entries.filter(entry => entry.section === name);
  return [name, { files: own.length, bytes: own.reduce((sum, entry) => sum + entry.bytes, 0) }];
}));

/** Counts and sizes of what a backup would save. Writes nothing. */
export function planBackup({ only } = {}) {
  const sections = selectSections(only), warnings = [];
  const { entries, skipped } = collect(enumerate(sections, { warnings }));
  return { applied: false, sections: summarize(entries, sections), files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    contentRevision: notebookHash(entries), containsSecrets: secretsOf(entries), skipped: skipped.length, warnings: [...new Set([...warnings, ...skippedWarnings(skipped)])] };
}

const sharedHomePath = () => (process.env.CONTEXT_ROOM_SHARED_HOME ? path.resolve(process.env.CONTEXT_ROOM_SHARED_HOME) : path.join(process.env.HOME || os.homedir(), '.context-room', 'shared'));
function sourceDirectories() {
  const directories = ['@hub', '@review', '@assistant'].map(homeDirectory);
  directories.push(realOrSelf(sharedHomePath()));
  for (const root of backupNotebookRoots()) directories.push(path.join(root, '.context-room'));
  return directories;
}
function buildBackup(output, enumerateRefs, sections, { checkpoint = () => {}, now = () => new Date() } = {}) {
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(fs.realpathSync(parent), `.${path.basename(output)}.${randomUUID()}.partial`);
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(path.join(staging, 'objects'), { mode: 0o700 });
  try {
    let entries = null, skipped = [];
    for (let attempt = 1; attempt <= ATTEMPTS && !entries; attempt += 1) {
      const first = collect(enumerateRefs(), path.join(staging, 'objects'));
      checkpoint('objects-written', attempt);
      const second = collect(enumerateRefs());
      if (JSON.stringify(first) === JSON.stringify(second)) ({ entries, skipped } = first);
    }
    if (!entries) fail('backup_changed', 'Data changed while the backup was running. Try again.');
    const used = new Set(entries.map(entry => entry.sha256));
    for (const name of fs.readdirSync(path.join(staging, 'objects'))) if (!used.has(name)) fs.unlinkSync(path.join(staging, 'objects', name));
    const manifest = { version: BACKUP_VERSION, mediaType: BACKUP_MEDIA_TYPE, createdAt: now().toISOString(), contentRevision: notebookHash(entries),
      sections, containsSecrets: secretsOf(entries), skipped, entries };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(staging, output);
    return manifest;
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
}

/** Write a new private backup directory. Refuses an existing output or one inside a source. */
export function writeBackup({ output, only } = {}, options = {}) {
  if (typeof output !== 'string' || !output) fail('backup_output', 'Name a new backup folder with --output.');
  output = path.resolve(output);
  if (fs.lstatSync(output, { throwIfNoEntry: false })) fail('backup_output_exists', 'The backup folder already exists. Choose a new name.');
  const real = realOrSelf(output);
  if (sourceDirectories().some(source => inside(source, real) || inside(source, output))) fail('backup_output_inside_source', 'The backup folder must be outside the Context Room data it saves.');
  const sections = selectSections(only), warnings = [];
  const manifest = buildBackup(output, () => enumerate(sections, { warnings }), sections, options);
  const gitTree = (() => { for (let dir = path.dirname(real); ; dir = path.dirname(dir)) { if (fs.existsSync(path.join(dir, '.git'))) return true; if (dir === path.dirname(dir)) return false; } })();
  if (gitTree && manifest.containsSecrets.length) warnings.push('The backup folder sits inside a Git work tree and holds the review signing key: do not commit or push it.');
  return { applied: true, output, createdAt: manifest.createdAt, sections: summarize(manifest.entries, sections), files: manifest.entries.length,
    bytes: manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0), contentRevision: manifest.contentRevision, containsSecrets: manifest.containsSecrets, skipped: manifest.skipped.length, warnings: [...new Set([...warnings, ...skippedWarnings(manifest.skipped)])] };
}

const SAFE_PART = /^[^\x00-\x1f\\]+$/;
function checkRelative(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || !SAFE_PART.test(rel) || rel.split('/').some(part => !part || part === '.' || part === '..')) fail('restore_manifest', `Unsafe path in the backup: ${String(rel).slice(0, 80)}`);
}
function checkEntry(entry) {
  if (!entry || typeof entry !== 'object' || !BACKUP_SECTIONS.includes(entry.section)) fail('restore_manifest', 'The backup names an unknown section.');
  checkRelative(entry.path);
  if (typeof entry.root !== 'string' || !SHA.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail('restore_manifest', 'A backup entry is malformed.');
  const first = entry.path.split('/')[0];
  const homeToken = { registry: '@hub', review: '@review', conversations: '@assistant', recordings: '@assistant' }[entry.section];
  if (homeToken) {
    if (entry.root !== homeToken) fail('restore_manifest', `A ${entry.section} entry must use ${homeToken}.`);
    if (entry.section === 'registry' && entry.path !== 'registry.json') fail('restore_manifest', 'The registry section holds registry.json only.');
    if (ASSISTANT_DIRS[entry.section] && !ASSISTANT_DIRS[entry.section].includes(first)) fail('restore_manifest', `Unexpected path in ${entry.section}: ${entry.path}`);
  } else {
    if (!path.isAbsolute(entry.root) || path.resolve(entry.root) !== entry.root || entry.root === path.parse(entry.root).root) fail('restore_manifest', 'A notebook entry needs an exact absolute project folder.');
    if (!entry.path.startsWith(`${NOTEBOOK_STORE}/`) && !(entry.path.endsWith('.crnb') && first !== '.context-room')) fail('restore_manifest', `Unexpected notebook path: ${entry.path}`);
  }
  if (transient(entry.path)) fail('restore_manifest', 'Lock and temporary files are never part of a backup.');
}

/** Read manifest.json and verify its shape, its revision and every object. */
export function loadBackup(directory) {
  if (typeof directory !== 'string' || !directory) fail('restore_manifest', 'Name the backup folder to restore.');
  let root;
  try { root = fs.realpathSync(path.resolve(directory)); if (!fs.statSync(root).isDirectory()) throw new Error('not a directory'); }
  catch { fail('restore_manifest', 'The backup folder was not found.'); }
  let manifest;
  try { manifest = JSON.parse(readNotebookBytes(root, 'manifest.json', MAX_FILE_BYTES)?.toString('utf8') || 'null'); }
  catch (error) { fail('restore_manifest', `The backup manifest is unreadable: ${error.message}`); }
  if (!manifest || manifest.version !== BACKUP_VERSION || manifest.mediaType !== BACKUP_MEDIA_TYPE || !Array.isArray(manifest.entries) || !Array.isArray(manifest.sections)) fail('restore_manifest', 'This folder is not a Context Room backup (manifest.json).');
  for (const name of manifest.sections) if (!BACKUP_SECTIONS.includes(name)) fail('restore_manifest', 'The backup names an unknown section.');
  const seen = new Set(); let total = 0;
  for (const entry of manifest.entries) {
    checkEntry(entry);
    if (!manifest.sections.includes(entry.section)) fail('restore_manifest', 'An entry belongs to a section the backup does not declare.');
    if (seen.has(refKey(entry))) fail('restore_manifest', 'The backup lists a file twice.');
    seen.add(refKey(entry)); total += entry.bytes;
  }
  if (total > MAX_TOTAL_BYTES) fail('restore_manifest', 'The backup exceeds the 2 GiB limit.');
  if (manifest.contentRevision !== notebookHash(manifest.entries)) fail('restore_manifest', 'The backup manifest does not match its own revision.');
  const sizes = new Map(manifest.entries.map(entry => [entry.sha256, new Set()]));
  for (const entry of manifest.entries) sizes.get(entry.sha256).add(entry.bytes);
  for (const [sha, expected] of sizes) {
    let bytes;
    try { bytes = readNotebookBytes(root, `objects/${sha}`, MAX_FILE_BYTES); } catch (error) { fail('restore_damaged', `A backup object is unsafe or unreadable (${sha.slice(0, 12)}): ${error.message}`); }
    if (!bytes || sha256(bytes) !== sha || expected.size !== 1 || !expected.has(bytes.length)) fail('restore_damaged', `A backup object is missing or damaged (${sha.slice(0, 12)}).`);
  }
  return { root, manifest };
}

function projectRootUsable(root, cache) {
  if (!cache.has(root)) {
    let usable = false;
    try { usable = fs.realpathSync(root) === root && fs.statSync(root).isDirectory(); } catch {}
    cache.set(root, usable);
  }
  return cache.get(root);
}
function classify(entry, cache, allowed) {
  if (!(entry.root in HOMES) && !allowed.has(entry.root)) return { state: 'blocked', reason: 'project folder is not in the registry' };
  if (!(entry.root in HOMES) && !projectRootUsable(entry.root, cache)) return { state: 'blocked', reason: 'project folder missing or replaced' };
  const base = entry.root in HOMES ? homeDirectory(entry.root) : entry.root;
  if (entry.root in HOMES && !fs.existsSync(base)) return { state: 'create' };
  try {
    const current = readNotebookBytes(base, entry.path, MAX_FILE_BYTES);
    return { state: current === null ? 'create' : sha256(current) === entry.sha256 ? 'same' : 'conflict', ...(current === null ? {} : { currentSha256: sha256(current) }) };
  } catch (error) { return { state: 'blocked', reason: error.message }; }
}

/** Compare a backup with the current data. Read-only; the revision binds the exact plan. */
export function planRestore(directory, { only, replace = false } = {}) {
  const { root, manifest } = loadBackup(directory);
  const sections = selectSections(only === undefined ? manifest.sections : only);
  for (const name of sections) if (!manifest.sections.includes(name)) fail('backup_sections', `This backup has no "${name}" section.`);
  const entries = manifest.entries.filter(entry => sections.includes(entry.section)), cache = new Map();
  const allowed = new Set(); try { for (const item of backupNotebookRoots()) allowed.add(item); } catch {}
  const saved = sections.includes('registry') && manifest.entries.find(entry => entry.section === 'registry');
  if (saved) { try { for (const item of registryRoots(JSON.parse(readNotebookBytes(root, `objects/${saved.sha256}`, MAX_FILE_BYTES).toString('utf8')))) allowed.add(item); } catch {} }
  const actions = entries.map(entry => ({ entry, ...classify(entry, cache, allowed) }));
  const known = new Set(entries.map(refKey)), warnings = [];
  const kept = enumerate(sections, { notebookRoots: [...new Set(entries.filter(entry => entry.section === 'notebooks').map(entry => entry.root))].filter(item => projectRootUsable(item, cache)), warnings })
    .filter(ref => !known.has(refKey(ref))).length;
  const counts = Object.fromEntries(sections.map(name => [name, { create: 0, same: 0, conflict: 0, blocked: 0 }]));
  for (const action of actions) counts[action.entry.section][action.state] += 1;
  const total = state => actions.filter(action => action.state === state).length;
  const list = state => actions.filter(action => action.state === state).slice(0, LIST_LIMIT).map(action => ({ section: action.entry.section, root: action.entry.root, path: action.entry.path, ...(action.reason ? { reason: action.reason } : {}) }));
  const revision = notebookHash({ backup: manifest.contentRevision, sections, replace: Boolean(replace), homes: ['@hub', '@review', '@assistant'].map(homeDirectory),
    actions: actions.map(action => [action.entry.section, action.entry.root, action.entry.path, action.entry.sha256, action.state, action.currentSha256 || null]) });
  return { applied: false, backup: root, createdAt: manifest.createdAt, sections: counts, create: total('create'), same: total('same'), conflict: total('conflict'), blocked: total('blocked'), kept,
    conflicts: list('conflict'), blockedFiles: list('blocked'), replace: Boolean(replace), containsSecrets: manifest.containsSecrets, revision, _actions: actions, _root: root, _selected: sections };
}
const publicPlan = ({ _actions, _root, _selected, ...plan }) => plan;
export const previewRestore = (directory, options) => publicPlan(planRestore(directory, options));

const fileMode = entry => (entry.section === 'notebooks' && !entry.path.startsWith('.context-room/') ? 0o644 : 0o600);
function writeEntry(entry, bytes, expectedHash) {
  const base = entry.root in HOMES ? homeDirectory(entry.root) : entry.root;
  if (entry.root in HOMES) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  writeNotebookBytes(base, entry.path, bytes, { mode: fileMode(entry), ...(expectedHash === undefined ? {} : { expectedHash }) });
}
function removeCreated(entry) {
  const base = entry.root in HOMES ? homeDirectory(entry.root) : entry.root;
  // Remove only what this restore wrote: a file changed since then stays. The file first
  // leaves its name, so a write that lands before the check is seen and nothing new is lost.
  const file = path.join(base, entry.path), held = path.join(path.dirname(file), `.${path.basename(file)}.restore-undo-${randomUUID()}`);
  try { fs.renameSync(file, held); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const stats = fs.lstatSync(held);
  if (stats.isFile() && stats.size <= MAX_FILE_BYTES && sha256(fs.readFileSync(held)) === entry.sha256) { fs.unlinkSync(held); return; }
  // link refuses a name taken in the meantime, so a newer file is never replaced.
  try { fs.linkSync(held, file); } catch (error) { throw new Error(`it changed after the restore wrote it; it is kept as ${held} (${error.code || error.message})`); }
  fs.unlinkSync(held);
  throw new Error('it changed after the restore wrote it');
}
function undoDirectory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), parent = path.join(path.dirname(homeDirectory('@hub')), 'backups');
  let candidate = path.join(parent, `before-restore-${stamp}`);
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = path.join(parent, `before-restore-${stamp}-${index}`);
  return candidate;
}

/** Restore the exact previewed plan. Never deletes; saves every replaced file first. */
export function applyRestore(directory, { only, replace = false, expectedRevision } = {}, { checkpoint = () => {} } = {}) {
  if (contextHubRuntimeAlive()) fail('restore_hub_running', 'Stop the Hub first: launchctl bootout gui/$(id -u)/app.contextroom.local');
  if (!expectedRevision) fail('restore_revision_required', 'Preview the restore, then run it again with --apply --revision <revision>.');
  const plan = planRestore(directory, { only, replace });
  if (plan.revision !== expectedRevision) fail('restore_stale', 'The backup or the current data changed after the preview. Preview again; nothing was restored.');
  if (plan.conflict && !replace) fail('restore_conflicts', `${plan.conflict} file${plan.conflict === 1 ? '' : 's'} differ from the backup. Nothing was restored. Use --replace to overwrite them (they are saved first), or choose sections with --only.`);
  const writes = plan._actions.filter(action => action.state === 'create' || action.state === 'conflict');
  for (const project of new Set(writes.map(action => action.entry.root).filter(item => !(item in HOMES)))) assertProjectWriter(project);
  const conflicts = writes.filter(action => action.state === 'conflict');
  let undo = null;
  if (conflicts.length) {
    undo = undoDirectory();
    const saved = buildBackup(undo, () => conflicts.map(action => ({ section: action.entry.section, root: action.entry.root, path: action.entry.path })).sort(compareRefs), BACKUP_SECTIONS.filter(name => conflicts.some(action => action.entry.section === name)), { checkpoint });
    const savedSha = new Map(saved.entries.map(entry => [refKey(entry), entry.sha256]));
    const moved = conflicts.filter(action => savedSha.get(refKey(action.entry)) !== action.currentSha256);
    if (moved.length) {
      fs.rmSync(undo, { recursive: true, force: true });
      fail('restore_stale', `${moved.length} file${moved.length === 1 ? '' : 's'} changed after the preview (${moved[0].entry.path}). Preview again; nothing was restored.`);
    }
  }
  const written = [];
  try {
    for (const action of writes) {
      checkpoint('before-write', written.length);
      const bytes = readNotebookBytes(plan._root, `objects/${action.entry.sha256}`, MAX_FILE_BYTES);
      if (!bytes || sha256(bytes) !== action.entry.sha256) fail('restore_damaged', `A backup object changed during the restore (${action.entry.path}).`);
      writeEntry(action.entry, bytes, action.state === 'create' ? null : action.currentSha256);
      written.push(action);
    }
  } catch (error) {
    const stuck = [];
    for (const action of written.reverse()) {
      try {
        if (action.state === 'create') removeCreated(action.entry);
        else {
          const before = readNotebookBytes(undo, `objects/${action.currentSha256}`, MAX_FILE_BYTES);
          if (!before) throw new Error('the saved copy is missing');
          writeEntry(action.entry, before, action.entry.sha256);
        }
      } catch (rollbackError) { stuck.push(`${action.entry.path} (${rollbackError.message})`); }
    }
    const saved = undo ? ` The files it replaced are saved in ${undo}.` : '';
    throw Object.assign(new Error(stuck.length
      ? `The restore stopped (${error.message}). These files could not be put back: ${stuck.join('; ')}.${saved}`
      : `The restore stopped (${error.message}). Files already written were put back.${saved}`), { code: error.code || 'restore_failed' });
  }
  return { ...publicPlan(plan), applied: true, written: written.length, created: written.filter(action => action.state === 'create').length, replaced: conflicts.length, undoBackup: undo };
}
