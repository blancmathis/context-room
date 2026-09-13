import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFilesystemLock } from './filesystem_lock.mjs';
import { failNotebook } from './notebook_protocol.mjs';

export function stableNotebookJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableNotebookJson).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stableNotebookJson(value[k])).join(',') + '}';
}
export const notebookHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableNotebookJson(value)).digest('hex');
export const notebookFileIdentity = stats => `${stats.dev}:${stats.ino}`;
export function canonicalNotebookRoot(root) {
  if (typeof root !== 'string' || path.resolve(root) !== root) failNotebook('notebook_root_scope', 'Use the exact absolute filesystem location.');
  const stats = fs.lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || fs.realpathSync(root) !== root) failNotebook('notebook_root_scope', 'The original directory is unavailable.');
  return notebookFileIdentity(stats);
}
export function safeNotebookPath(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') || /[\x00-\x1f]/.test(rel) || rel.split('/').some(p => !p || p === '.' || p === '..')) failNotebook('notebook_path_scope', 'A canonical relative path is required.');
  canonicalNotebookRoot(root);
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory() && (!stats.isFile() || stats.nlink !== 1)) failNotebook('notebook_path_scope', 'Linked and special files are not permitted in notebook storage.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
export function makeNotebookDirectory(root, rel) {
  let prefix = '';
  for (const part of rel.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const target = safeNotebookPath(root, prefix);
    try { fs.mkdirSync(target, { mode: 0o700 }); syncNotebookDirectory(path.dirname(target)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(safeNotebookPath(root, prefix)).isDirectory()) failNotebook('notebook_path_scope', 'A notebook directory was replaced.');
  }
  return safeNotebookPath(root, rel);
}
export function readNotebookBytes(root, rel, maxBytes = 32 * 1024 * 1024) {
  const target = safeNotebookPath(root, rel); let descriptor;
  try { descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) failNotebook('notebook_size', 'Expected a bounded, independent regular file.');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
    const overflow = fs.readSync(descriptor, Buffer.alloc(1), 0, 1, null);
    const after = fs.fstatSync(descriptor, { bigint: true }), visible = fs.lstatSync(safeNotebookPath(root, rel), { bigint: true });
    if (offset !== bytes.length || overflow || notebookFileIdentity(before) !== notebookFileIdentity(after) || notebookFileIdentity(after) !== notebookFileIdentity(visible)
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) failNotebook('notebook_read_conflict', 'The file changed during reading.');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
export function syncNotebookDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
/** Publish complete bytes before acknowledging them. Never truncate an existing file in place. */
export function writeNotebookBytes(root, rel, bytes, { exclusive = false, mode = 0o600, expectedHash } = {}) {
  const rootIdentity = canonicalNotebookRoot(root), parent = path.posix.dirname(rel);
  if (parent !== '.') makeNotebookDirectory(root, parent);
  const target = safeNotebookPath(root, rel), directory = path.dirname(target), parentIdentity = notebookFileIdentity(fs.lstatSync(directory));
  const tempRel = `${parent === '.' ? '' : parent + '/'}.${path.basename(rel)}.${randomUUID()}.tmp`, temp = safeNotebookPath(root, tempRel);
  const descriptor = fs.openSync(temp, 'wx', mode);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  try {
    if (canonicalNotebookRoot(root) !== rootIdentity || notebookFileIdentity(fs.lstatSync(directory)) !== parentIdentity) failNotebook('notebook_root_conflict', 'The storage directory changed before publication.');
    safeNotebookPath(root, rel);
    if (expectedHash !== undefined) { const current = readNotebookBytes(root, rel); if ((current ? notebookHash(current) : null) !== expectedHash) failNotebook('notebook_write_conflict', 'The destination changed before publication.'); }
    if (exclusive) { fs.linkSync(temp, target); fs.unlinkSync(temp); }
    else fs.renameSync(temp, target);
    syncNotebookDirectory(directory);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export const readNotebookJson = (root, rel, fallback = null) => { const bytes = readNotebookBytes(root, rel); return bytes === null ? fallback : JSON.parse(bytes.toString('utf8')); };
export const writeNotebookJson = (root, rel, value, options) => writeNotebookBytes(root, rel, stableNotebookJson(value) + '\n', options);
export function withNotebookLock(root, rel, operation) {
  const identity = canonicalNotebookRoot(root), parent = path.posix.dirname(rel);
  if (parent !== '.') makeNotebookDirectory(root, parent);
  const target = safeNotebookPath(root, rel);
  return withFilesystemLock(target, () => {
    if (canonicalNotebookRoot(root) !== identity) failNotebook('notebook_root_conflict', 'The original directory was replaced.');
    safeNotebookPath(root, rel);
    return operation();
  });
}
