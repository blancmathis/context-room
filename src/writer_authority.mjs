import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const WRITER_AUTHORITY = '.context-room/migrations/writer-v1/authority.json';
const fail = message => { throw Object.assign(new Error(message), { code: 'migration_writer_paused', statusCode: 409 }); };
const identity = stat => `${stat.dev}:${stat.ino}`;
function read(root, rel) {
  let file = root;
  for (const part of rel.split('/')) {
    file = path.join(file, part); const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('Unsafe writer authority path; retain it for recovery.');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) fail('Invalid writer authority record.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function projectWriterAuthority(root) {
  root = fs.realpathSync(root);
  const bytes = read(root, WRITER_AUTHORITY);
  if (!bytes) {
    const directory = path.join(root, path.dirname(WRITER_AUTHORITY));
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => /^[a-f0-9]{64}\.json$/.test(name)))
      fail('The cutover journal exists but writer authority is missing. Restore its exact record; writing stays blocked.');
    return { mode: 'unmanaged', enrolled: false };
  }
  let state; try { state = JSON.parse(bytes); } catch { fail('Damaged writer authority; no mutation is authorized.'); }
  if (state.version !== 1 || state.rootIdentity !== identity(fs.statSync(root)) || !/^[a-f0-9]{64}$/.test(state.migrationId || '')
    || !['transition', 'context-room', 'paused'].includes(state.mode) || !Number.isSafeInteger(state.generation) || state.generation < 1)
    fail('Unsupported or replaced writer authority; no mutation is authorized.');
  return { ...state, enrolled: true };
}

/** Older data paths remain fenced. Removing the fence never silently re-enables
 * two writers: every enrolled mutation fails closed until explicit recovery. */
export function assertProjectWriter(root) {
  const state = projectWriterAuthority(root);
  if (!state.enrolled) return state;
  if (state.mode !== 'context-room') fail('This migration has paused writing. Existing drafts and operations are retained; inspect the cutover journal.');
  const fence = state.fence;
  if (!fence || typeof fence.source !== 'string' || !path.isAbsolute(fence.source)) fail('The original writer fence is unavailable.');
  const stat = fs.lstatSync(fence.source, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(fence.source) !== fence.source || identity(stat) !== fence.identity)
    fail('The original writer fence was removed or replaced. Writing stays blocked.');
  const blocked = fs.lstatSync(path.join(fence.source, 'workspace.sqlite'), { throwIfNoEntry: false });
  const marker = read(fence.source, 'CONTEXT_ROOM_RETIRED.json');
  if (!blocked?.isDirectory() || blocked.isSymbolicLink() || !marker
    || createHash('sha256').update(marker).digest('hex') !== fence.markerHash) fail('The legacy database fence changed. Writing stays blocked.');
  return state;
}

/** Deterministic read-only diagnostics; never repairs or starts a service. */
export function inspectProjectWriter(root) {
  try {
    const state = projectWriterAuthority(root);
    if (state.mode === 'context-room') assertProjectWriter(root);
    return { mode: state.mode, enrolled: state.enrolled, writable: !state.enrolled || state.mode === 'context-room',
      ...(state.enrolled ? { migrationId: state.migrationId, generation: state.generation } : {}), checked: true };
  } catch (error) { return { mode: 'recovery-required', writable: false, checked: true, error: error.message }; }
}
