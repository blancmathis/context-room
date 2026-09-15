import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireFilesystemLock } from './filesystem_lock.mjs';
import { readLisiereSnapshot, legacyError } from './lisiere_archive.mjs';
import { exportLisiereSnapshot } from './lisiere_snapshot.mjs';
import { canonicalNotebookRoot, makeNotebookDirectory, readNotebookJson, writeNotebookJson, readNotebookBytes, writeNotebookBytes, notebookHash, stableNotebookJson, syncNotebookDirectory } from './notebook_io.mjs';
import { WRITER_AUTHORITY, projectWriterAuthority, assertProjectWriter } from './writer_authority.mjs';

const BASE = '.context-room/migrations/writer-v1';
const check = (ok, message) => { if (!ok) throw legacyError(message); };
const encoded = value => Buffer.from(stableNotebookJson(value) + '\n');
const helper = fileURLToPath(new URL('./mac_legacy_quiescence.py', import.meta.url));
function python(file, args) {
  try { return execFileSync('python3', ['-B', file, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw legacyError(String(error.stderr || 'The local migration helper is unavailable.').trim().slice(0, 600)); }
}
function agent(action, options, revision) {
  return JSON.parse(python(helper, [action, '--source', options.legacySource, '--plist', options.legacyPlist,
    ...(revision ? ['--revision', revision] : [])]));
}
const closedFiles = source => JSON.parse(python(helper, ['closed-files', '--source', source]));
const rename = (source, destination) => python(fileURLToPath(new URL('./exclusive_rename.py', import.meta.url)), [source, destination]);
const statIdentity = file => canonicalNotebookRoot(file);
function checkedSource(source, root) {
  check(typeof source === 'string' && path.resolve(source) === source && source !== root
    && !root.startsWith(source + path.sep) && !source.startsWith(root + path.sep), 'Choose a separate exact legacy directory, not the project or one of its ancestors.');
  canonicalNotebookRoot(source);
  const stat = fs.statSync(source);
  check(!(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid()), 'The legacy workspace must be private and owned by this account.');
}
function readJournal(root, id) {
  const journal = readNotebookJson(root, `${BASE}/${id}.json`);
  if (!journal) return null;
  check(journal.version === 1 && notebookHash(journal.plan) === id, 'The cutover journal no longer matches its immutable plan.');
  return journal;
}

/** Snapshot integrity and a live-source revision are both required. A downloaded
 * snapshot is not evidence that the old process has stopped. */
export async function planLisiereCutover(root, options, { inspectLegacy = args => agent('inspect', args) } = {}) {
  const rootIdentity = canonicalNotebookRoot(root), authority = projectWriterAuthority(root);
  let supersedes = null;
  if (authority.enrolled) {
    const journal = readJournal(root, authority.migrationId);
    check(journal && journal.plan.legacySource === options.legacySource
      && journal.plan.legacyPlist === options.legacyPlist, 'This project is already bound to another cutover. Inspect its existing journal.');
    const newer = authority.mode === 'transition' && !fs.existsSync(journal.backup)
      && readLisiereSnapshot(options.macSnapshot).manifest.revision !== journal.plan.snapshotRevision;
    if (newer) supersedes = authority.migrationId;
    else {
      check(journal.plan.macSnapshot === options.macSnapshot, 'Use the snapshot bound to this retired source. A different snapshot cannot silently replace its provenance.');
      return { ...journal.plan, revision: authority.migrationId, phase: journal.phase, mode: authority.mode,
      completed: authority.mode === 'context-room', accepted: false };
    }
  }
  checkedSource(options.legacySource, root);
  const snapshot = readLisiereSnapshot(options.macSnapshot);
  check(snapshot.manifest.kind === 'mac-workspace' && !options.macSnapshot.startsWith(options.legacySource + path.sep), 'Choose a completed canonical Mac snapshot outside the original workspace.');
  const live = await exportLisiereSnapshot({ source: options.legacySource, output: options.macSnapshot });
  check(live.revision === snapshot.manifest.revision, 'The live legacy source changed after export. Export and reconcile its newer work first.');
  const service = await inspectLegacy(options);
  check(service.label === 'fr.lisiere.companion' && /^[a-f0-9]{64}$/.test(service.plistSha256 || ''), 'Unrecognized legacy service identity.');
  const plan = { version: 1, root, rootIdentity, legacySource: options.legacySource, sourceIdentity: statIdentity(options.legacySource),
    legacyPlist: options.legacyPlist, service, macSnapshot: options.macSnapshot, snapshotRevision: snapshot.manifest.revision,
    ...(supersedes ? { supersedes } : {}), effect: 'retire-original-workspace-and-enable-context-room-only', rollback: 'pause-writes-retain-all-data-no-legacy-restart' };
  return { ...plan, revision: notebookHash(plan), completed: false, mode: 'unmanaged', accepted: false };
}

/** Only --apply may call the local shutdown adapter. No personal action is used
 * by tests: they supply a synthetic adapter and real SQLite fixture directories. */
export async function applyLisiereCutover(root, options, {
  inspectLegacy = args => agent('inspect', args), stopLegacy = (args, revision) => agent('stop', args, revision),
  verifyLegacy = args => agent('verify', args), checkpoint = () => {},
} = {}) {
  check(typeof options.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(options.expectedRevision), 'Apply requires an exact cutover preview.');
  const preview = await planLisiereCutover(root, options, { inspectLegacy });
  check(preview.revision === options.expectedRevision, 'The cutover source or launch-agent definition changed after preview.');
  makeNotebookDirectory(root, BASE);
  const lock = acquireFilesystemLock(path.join(root, BASE, 'transition.lock'), { requireProcessIdentity: true, secureSidecars: true });
  try {
    const id = preview.revision;
    let journal = readJournal(root, id), authority = projectWriterAuthority(root);
    if (authority.enrolled && authority.migrationId !== id) {
      const old = readJournal(root, authority.migrationId);
      check(preview.supersedes === authority.migrationId && authority.mode === 'transition' && old && !fs.existsSync(old.backup), 'Another migration owns this project.');
    }
    if (authority.mode === 'paused') throw legacyError('This cutover was rolled back to a safe pause. Resume it only with a new explicit --resume-cutover preview.');
    if (authority.mode === 'context-room') {
      assertProjectWriter(root);
      if (journal.phase !== 'complete') writeNotebookJson(root, `${BASE}/${id}.json`, { ...journal, phase: 'complete' });
      return { ...preview, phase: 'complete', applied: true, replayed: true };
    }
    if (!journal) {
      const { revision, completed, mode, accepted, ...plan } = preview;
      check(notebookHash(plan) === id, 'Invalid cutover plan.');
      journal = { version: 1, plan, phase: 'prepared', backup: options.legacySource + '.context-room-retired-' + id.slice(0, 16),
        staging: options.legacySource + '.context-room-fence-' + id.slice(0, 16) };
      check(!fs.existsSync(journal.backup) && !fs.existsSync(journal.staging), 'A cutover recovery destination is occupied; nothing was replaced.');
      writeNotebookJson(root, `${BASE}/${id}.json`, journal, { exclusive: true });
    }
    const save = phase => { journal.phase = phase; writeNotebookJson(root, `${BASE}/${id}.json`, journal); checkpoint(phase); };
    const paused = { version: 1, rootIdentity: journal.plan.rootIdentity, migrationId: id, generation: authority.generation || 1, mode: 'transition' };
    writeNotebookJson(root, WRITER_AUTHORITY, paused); checkpoint('writers-paused');
    const stopped = await stopLegacy(options, journal.plan.service.plistSha256);
    check(stopped.disabled === true && stopped.stopped === true, 'The original service has not confirmed durable shutdown.'); lock.assertHeld();
    save('legacy-stopped');
    const marker = encoded({ version: 1, migrationId: id, snapshotRevision: journal.plan.snapshotRevision, backup: journal.backup,
      warning: 'Legacy writing is retired. Do not recreate the database or restart its uncertain operation queue.' });
    if (!fs.existsSync(journal.backup)) {
      check(statIdentity(options.legacySource) === journal.plan.sourceIdentity, 'The original legacy directory was replaced.');
      closedFiles(options.legacySource);
      const live = await exportLisiereSnapshot({ source: options.legacySource, output: options.macSnapshot });
      check(live.revision === journal.plan.snapshotRevision, 'The legacy service saved newer work while stopping. Keep the source; export and reconcile it before a new cutover.');
      check((await verifyLegacy(options)).stopped === true, 'The legacy service is no longer stopped.'); closedFiles(options.legacySource); lock.assertHeld();
      // Both directory moves use the OS no-replace primitive, including an
      // occupied EMPTY directory. No check-then-rename fallback is permitted.
      if (!fs.existsSync(journal.staging)) {
        fs.mkdirSync(journal.staging, { mode: 0o700 });
        fs.mkdirSync(path.join(journal.staging, 'workspace.sqlite'), { mode: 0o500 });
        writeNotebookBytes(journal.staging, 'CONTEXT_ROOM_RETIRED.json', marker, { exclusive: true });
        syncNotebookDirectory(path.dirname(journal.staging));
      }
      check(readNotebookBytes(journal.staging, 'CONTEXT_ROOM_RETIRED.json')?.equals(marker), 'The prepared fence has different contents.');
      rename(options.legacySource, journal.backup); save('source-retired');
    }
    check(statIdentity(journal.backup) === journal.plan.sourceIdentity, 'The retained original directory was replaced.');
    if (!fs.existsSync(options.legacySource)) {
      check(readNotebookBytes(journal.staging, 'CONTEXT_ROOM_RETIRED.json')?.equals(marker), 'The prepared fence is missing or altered.');
      rename(journal.staging, options.legacySource); save('fence-published');
    }
    check(readNotebookBytes(options.legacySource, 'CONTEXT_ROOM_RETIRED.json')?.equals(marker), 'The retired source path is occupied by different content. Writing remains paused.');
    closedFiles(journal.backup); check((await verifyLegacy(options)).stopped === true, 'The legacy service is no longer stopped.');
    const retired = await exportLisiereSnapshot({ source: journal.backup, output: options.macSnapshot });
    check(retired.revision === journal.plan.snapshotRevision, 'The retained legacy source has newer or inconsistent data. Writing stays paused.');
    lock.assertHeld();
    const active = { ...paused, mode: 'context-room', fence: { source: options.legacySource, identity: statIdentity(options.legacySource), markerHash: notebookHash(marker) } };
    writeNotebookJson(root, WRITER_AUTHORITY, active); assertProjectWriter(root); save('complete');
    return { ...preview, applied: true, replayed: false, completed: true, mode: active.mode, backup: journal.backup, legacyQueueResumed: false, accepted: false };
  } finally { lock.release(); }
}

/** Rollback never restores old control files over new work, reopens the legacy
 * SQLite path, or starts an old queue. It leaves an explicit no-writer state. */
export function changeCutoverMode(root, { resume = false, apply = false, expectedRevision } = {}) {
  const authority = projectWriterAuthority(root);
  check(authority.enrolled && ['context-room', 'paused'].includes(authority.mode), 'Complete or explicitly recover the interrupted cutover first.');
  const journal = readJournal(root, authority.migrationId); check(journal, 'The original cutover journal is missing.');
  const targetMode = resume ? 'context-room' : 'paused';
  const revision = notebookHash({ authority, targetMode });
  const summary = { version: 1, kind: resume ? 'cutover-resume' : 'cutover-rollback', revision, mode: authority.mode, targetMode,
    dataRestored: false, recentWorkPreservedInPlace: true, legacyQueueResumed: false, backup: journal.backup, accepted: false };
  if (!apply) return { ...summary, applied: false };
  if (expectedRevision !== revision) {
    check(authority.lastTransition?.revision === expectedRevision && authority.lastTransition?.targetMode === targetMode && authority.mode === targetMode,
      'The current writer generation changed. Review a new rollback/resume preview.');
    if (targetMode === 'context-room') assertProjectWriter(root);
    return { ...summary, revision: expectedRevision, applied: true, replayed: true };
  }
  const lock = acquireFilesystemLock(path.join(root, BASE, 'transition.lock'), { requireProcessIdentity: true, secureSidecars: true });
  try {
    check(notebookHash(projectWriterAuthority(root)) === notebookHash(authority), 'Writer authority changed during the transition.');
    if (targetMode === 'context-room') {
      // Validate the existing fence before enabling the generation. Never repair
      // or re-create an occupied source path implicitly during resume.
      const current = { ...authority, mode: 'context-room' };
      const fence = current.fence, marker = readNotebookBytes(fence?.source, 'CONTEXT_ROOM_RETIRED.json');
      check(marker && notebookHash(marker) === fence.markerHash && statIdentity(fence.source) === fence.identity
        && fs.lstatSync(path.join(fence.source, 'workspace.sqlite')).isDirectory(), 'Restore the original fence explicitly before resuming.');
    }
    const { enrolled, ...current } = authority;
    writeNotebookJson(root, WRITER_AUTHORITY, { ...current, mode: targetMode, generation: current.generation + 1, lastTransition: { revision, targetMode } });
    if (targetMode === 'context-room') assertProjectWriter(root);
    return { ...summary, mode: targetMode, applied: true };
  } finally { lock.release(); }
}
