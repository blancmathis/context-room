import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalNotebookRoot, safeNotebookPath, readNotebookBytes, notebookHash } from './notebook_io.mjs';

export const LEGACY_SNAPSHOT_LIMIT = 512 * 1024 * 1024;
const MAX_ROW = 32 * 1024 * 1024;
const MAX_SQLITE_ROW = 48 * 1024 * 1024;
const MAX_WIRE_ROW = MAX_ROW * 6 + 16384;
const shaPattern = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function legacyError(message) { return Object.assign(new Error(message), { code: 'lisiere_recovery_conflict' }); }
function requireValue(condition, message) { if (!condition) throw legacyError(message); }

function entryMetadata(value) {
  requireValue(plain(value) && typeof value.path === 'string' && /^(?:tables\/[a-z_]+\.jsonl|assets\/[a-f0-9]{64}|recordings\/[a-f0-9]{64}\.pcm|derived\/(?:outbox-args\.jsonl|android-export-manifest\.json))$/.test(value.path)
    && shaPattern.test(value.sha256 || '') && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= LEGACY_SNAPSHOT_LIMIT, 'Invalid legacy snapshot file entry.');
  if (value.path.startsWith('assets/')) requireValue(value.sha256 === value.path.slice(7), 'An archived asset changed its content identity.');
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

/** Recheck inode, size, bytes and visible path each time a bounded file is consumed. */
function* chunks(directory, entry) {
  const target = safeNotebookPath(directory, entry.path), fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireValue(before.isFile() && before.nlink === 1n && before.size === BigInt(entry.bytes), 'An archived file is linked, replaced or has a different size.');
    const buffer = Buffer.alloc(64 * 1024), sha = createHash('sha256'); let count = 0;
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null); if (!length) break;
      count += length; requireValue(count <= entry.bytes, 'An archived file grew during reading.');
      const current = buffer.subarray(0, length); sha.update(current); yield current;
    }
    const after = fs.fstatSync(fd, { bigint: true }), visible = fs.lstatSync(safeNotebookPath(directory, entry.path), { bigint: true });
    requireValue(count === entry.bytes && sha.digest('hex') === entry.sha256 && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
      && after.dev === visible.dev && after.ino === visible.ino, 'An archived file changed or failed its snapshot hash.');
  } finally { fs.closeSync(fd); }
}

function cell(value) {
  if (plain(value)) {
    requireValue(Object.keys(value).length === 1, 'Unknown archived SQLite cell encoding.');
    if (typeof value.base64 === 'string') {
      const result = Buffer.from(value.base64, 'base64');
      requireValue(result.toString('base64') === value.base64, 'Invalid archived binary cell.');
      return result;
    }
    if (typeof value.integer === 'string' && /^-?(?:0|[1-9][0-9]{0,18})$/.test(value.integer)) {
      const result = BigInt(value.integer);
      requireValue(result >= -9223372036854775808n && result <= 9223372036854775807n, 'Archived integer exceeds SQLite int64.');
      return result;
    }
    throw legacyError('Unknown archived SQLite cell encoding.');
  }
  requireValue(value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value), 'Invalid archived SQLite value.');
  return value;
}

/** A completed export must be fully checked before a caller publishes imported work. */
export function readLisiereSnapshot(directory) {
  canonicalNotebookRoot(directory);
  const raw = readNotebookBytes(directory, 'manifest.json', 8 * 1024 * 1024);
  requireValue(raw, 'The recovery export is unfinished: its complete manifest is missing.');
  requireValue(raw.equals(Buffer.from(raw.toString('utf8'))), 'The recovery manifest is not UTF-8.');
  let manifest; try { manifest = JSON.parse(raw); } catch { throw legacyError('The recovery manifest is not valid JSON.'); }
  requireValue(plain(manifest), 'A recovery manifest object is required.');
  const { revision, ...unsigned } = manifest;
  requireValue([1, 2, 3].includes(manifest.version) && manifest.mediaType === 'application/vnd.context-room.lisiere-snapshot+json'
    && ['mac-workspace', 'android-workspace'].includes(manifest.kind) && [0, 1].includes(manifest.databaseVersion)
    && manifest.accepted === false && shaPattern.test(revision || '') && notebookHash(unsigned) === revision, 'Unsupported, altered or invalid recovery manifest.');
  const journal = readNotebookBytes(directory, 'export-journal.json', 8 * 1024 * 1024);
  requireValue(journal?.equals(raw), 'The snapshot completion marker does not match its export journal.');
  requireValue(Array.isArray(manifest.files) && manifest.files.length <= 20100 && Array.isArray(manifest.tables) && manifest.tables.length <= 100, 'Invalid recovery inventory.');
  const files = new Map(); let total = 0;
  for (const value of manifest.files) {
    const entry = entryMetadata(value); total += entry.bytes;
    requireValue(!files.has(entry.path) && total <= LEGACY_SNAPSHOT_LIMIT, 'Duplicate or oversized recovery inventory.'); files.set(entry.path, entry);
  }
  const recordings = [...files.keys()].filter(rel => rel.startsWith('recordings/'));
  if (manifest.version === 1) requireValue(recordings.length === 0 && !Object.hasOwn(manifest, 'recordings'), 'Recording recovery requires snapshot version 2.');
  else {
    const description = manifest.recordings;
    requireValue(manifest.kind === 'android-workspace' && plain(description) && description.encoding === 'pcm-s16le'
      && description.sampleRate === 16000 && description.channels === 1 && Array.isArray(description.paths)
      && notebookHash(description.paths) === notebookHash(recordings), 'The original recording format or inventory is inconsistent.');
    for (const rel of recordings) requireValue(files.get(rel).bytes <= 16000 * 2 * 120 && files.get(rel).bytes % 2 === 0, 'A retained recording exceeds its original format limit.');
  }
  const derived = [...files.keys()].filter(rel => rel.startsWith('derived/'));
  if (manifest.version < 3) requireValue(!derived.length && !Object.hasOwn(manifest, 'androidExport'), 'Native Android arguments require snapshot version 3.');
  else {
    const native = manifest.androidExport, verification = native?.verification;
    requireValue(manifest.kind === 'android-workspace' && plain(native) && native.version === 1
      && native.mediaType === 'application/vnd.context-room.lisiere-android-export+json'
      && native.sourcePackage === 'fr.lisiere.android' && shaPattern.test(native.sha256 || '')
      && Number.isSafeInteger(native.bytes) && native.bytes > 0 && native.bytes <= LEGACY_SNAPSHOT_LIMIT + 8 * 1024 * 1024
      && native.delivery === 'not-inferred' && plain(native.queue) && native.queue.encoding === 'android-org-json' && native.queue.delivery === 'not-inferred'
      && ['rows', 'decoded', 'requiresReconciliation'].every(key => Number.isSafeInteger(native.queue[key]) && native.queue[key] >= 0 && native.queue[key] <= 100000)
      && native.queue.decoded + native.queue.requiresReconciliation === native.queue.rows
      && plain(verification) && verification.version === 1 && verification.rowBindings === 'exact-original-cells'
      && verification.arguments === 'typed-roundtrip' && verification.wireBytes === 'retained-not-reconstructed' && verification.delivery === 'not-inferred'
      && Number.isSafeInteger(verification.floatingRows) && verification.floatingRows >= 0 && verification.floatingRows <= native.queue.decoded
      && notebookHash(manifest.sourceIdentity) === notebookHash(['android-export-sha256', native.sha256])
      && notebookHash(manifest.recordings.sourceIdentity) === notebookHash(['android-export-sha256', native.sha256, 'recordings'])
      && derived.length === 2 && files.has('derived/outbox-args.jsonl') && files.has('derived/android-export-manifest.json'),
      'Invalid native Android snapshot provenance or derived inventory.');
  }
  const tables = new Map();
  for (const value of manifest.tables) {
    const entry = entryMetadata(value), listed = files.get(entry.path);
    requireValue(typeof value.name === 'string' && entry.path === `tables/${value.name}.jsonl` && !tables.has(value.name)
      && listed && listed.sha256 === entry.sha256 && listed.bytes === entry.bytes
      && Number.isSafeInteger(value.rows) && value.rows >= 0
      && Array.isArray(value.columns) && value.columns.length > 0 && value.columns.length <= 100
      && value.columns.every(key => typeof key === 'string' && /^[a-z_]+$/.test(key)) && new Set(value.columns).size === value.columns.length, 'Inconsistent archived table inventory.');
    tables.set(value.name, { ...entry, columns: [...value.columns], rows: value.rows });
  }
  requireValue([...files.keys()].every(rel => !rel.startsWith('tables/') || tables.has(rel.slice(7, -6))), 'An archived table is not described in the manifest.');
  const required = manifest.kind === 'mac-workspace' ? ['projects', 'boards', 'objects'] : ['cache', 'outbox'];
  requireValue(required.every(name => tables.has(name)), 'The recovery snapshot is missing a required table.');
  for (const entry of files.values()) {
    let lines = 0, last = null;
    for (const part of chunks(directory, entry)) { for (let at = part.indexOf(10); at !== -1; at = part.indexOf(10, at + 1)) lines++; last = part.at(-1); }
    if (entry.path.startsWith('tables/')) requireValue(lines === tables.get(entry.path.slice(7, -6)).rows && (entry.bytes === 0 || last === 10), 'The archived row count is incomplete.');
  }
  const archive = {
    directory, manifest,
    *rows(name) {
      const entry = tables.get(name); if (!entry) return;
      const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '', count = 0;
      for (const part of chunks(directory, entry)) {
        pending += decoder.decode(part, { stream: true }); let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          requireValue(end <= MAX_SQLITE_ROW, 'An archived row exceeds the bounded import size.');
          let row; try { row = JSON.parse(pending.slice(0, end)); } catch { throw legacyError('An archived table row is invalid JSON.'); }
          pending = pending.slice(end + 1); count++;
          requireValue(Array.isArray(row) && row.length === entry.columns.length, 'An archived row has a different column count.');
          yield Object.fromEntries(entry.columns.map((key, index) => [key, cell(row[index])]));
        }
        requireValue(pending.length <= MAX_SQLITE_ROW, 'An archived row exceeds the bounded import size.');
      }
      pending += decoder.decode();
      requireValue(!pending && count === entry.rows, 'An archived table is incomplete.');
    },
    *androidArguments() {
      if (manifest.version !== 3) return;
      const entry = files.get('derived/outbox-args.jsonl'), original = archive.rows('outbox');
      const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '', count = 0, decoded = 0;
      for (const part of chunks(directory, entry)) {
        pending += decoder.decode(part, { stream: true }); let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          requireValue(end <= MAX_WIRE_ROW, 'A native argument row exceeds its bounded size.');
          let wire; try { wire = JSON.parse(pending.slice(0, end)); } catch { throw legacyError('Invalid retained Android arguments.'); }
          pending = pending.slice(end + 1);
          const next = original.next(), row = next.value;
          requireValue(!next.done && plain(wire) && wire.seq === String(row.seq) && wire.id === row.id && wire.operation === row.operation
            && ['decoded', 'requires-reconciliation'].includes(wire.status), 'A retained Android argument row lost its original identity.');
          const bytes = Buffer.isBuffer(row.args) ? row.args : typeof row.args === 'string' ? Buffer.from(row.args) : null;
          if (bytes) requireValue(wire.sourceEncoding === (Buffer.isBuffer(row.args) ? 'blob' : 'text'), 'The original argument encoding changed.');
          if (Object.hasOwn(wire, 'sourceArgsBytes') || Object.hasOwn(wire, 'sourceArgsSha256')) {
            requireValue(Number.isSafeInteger(wire.sourceArgsBytes) && wire.sourceArgsBytes >= 0 && wire.sourceArgsBytes <= MAX_ROW
              && shaPattern.test(wire.sourceArgsSha256 || '') && (!bytes || bytes.length === wire.sourceArgsBytes && notebookHash(bytes) === wire.sourceArgsSha256),
              'Retained Android arguments do not match their original byte hash.');
          }
          if (wire.status === 'decoded') {
            requireValue(bytes && bytes.length === wire.sourceArgsBytes && notebookHash(bytes) === wire.sourceArgsSha256 && typeof wire.argsJson === 'string',
              'Decoded Android arguments have no exact original binding.');
            decoded++;
          } else requireValue(!Object.hasOwn(wire, 'argsJson'), 'Unreconciled Android arguments cannot be executed.');
          count++;
          yield wire; // argsJson remains the captured string, never a number round trip.
        }
        requireValue(pending.length <= MAX_WIRE_ROW, 'A native argument row exceeds its bounded size.');
      }
      pending += decoder.decode();
      requireValue(!pending && original.next().done && count === manifest.androidExport.queue.rows && decoded === manifest.androidExport.queue.decoded,
        'The retained Android argument inventory is incomplete.');
    },
    asset(hash) {
      requireValue(shaPattern.test(hash || '') && files.has(`assets/${hash}`), 'A legacy image asset is missing.');
      const entry = files.get(`assets/${hash}`);
      requireValue(entry.bytes <= 20 * 1024 * 1024, 'A legacy image exceeds its original size limit.');
      const retained = []; for (const part of chunks(directory, entry)) retained.push(Buffer.from(part)); return Buffer.concat(retained);
    },
    recording(name) {
      requireValue(typeof name === 'string' && /^[a-f0-9]{64}\.pcm$/.test(name) && files.has(`recordings/${name}`), 'The exact original recording is missing.');
      const retained = []; for (const part of chunks(directory, files.get(`recordings/${name}`))) retained.push(Buffer.from(part)); return Buffer.concat(retained);
    },
  };
  if (manifest.version === 3) {
    const entry = files.get('derived/android-export-manifest.json');
    requireValue(entry.bytes <= 8 * 1024 * 1024, 'The retained native manifest is oversized.');
    const parts = []; for (const part of chunks(directory, entry)) parts.push(Buffer.from(part));
    let native; try { native = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw legacyError('Invalid retained native manifest.'); }
    requireValue(plain(native) && native.version === 1 && native.mediaType === manifest.androidExport.mediaType
      && native.accepted === false && native.sourceUnchanged === true && native.sourcePackage === manifest.androidExport.sourcePackage
      && native.exporterVersionCode === manifest.androidExport.exporterVersionCode
      && notebookHash(native.queue) === notebookHash(manifest.androidExport.queue) && Array.isArray(native.files),
      'The native manifest no longer matches the converted snapshot.');
    for (const rel of ['derived/outbox-args.jsonl', ...recordings]) {
      const matches = native.files.filter(file => file.path === rel), retained = files.get(rel);
      requireValue(matches.length === 1 && matches[0].bytes === retained.bytes && matches[0].sha256 === retained.sha256,
        'A native derivative or recording changed during conversion.');
    }
    for (const _ of archive.androidArguments()) { /* Bind the complete inventory before any import can publish. */ }
  }
  return archive;
}

/** Decode the legacy LSJ1 wire format, including exact Java UTF-16 code units. */
export function decodeLisiereObject(value) {
  if (typeof value === 'string') {
    requireValue(Buffer.byteLength(value) <= MAX_ROW, 'The legacy JSON object exceeds the bounded import size.');
    let result; try { result = JSON.parse(value); } catch { throw legacyError('The legacy JSON object is unreadable.'); }
    requireValue(plain(result), 'A legacy object is required.'); return result;
  }
  requireValue(Buffer.isBuffer(value) && value.length >= 5 && value.length <= MAX_ROW && value.readUInt32BE() === 0x4c534a31, 'Unsupported legacy binary JSON version.');
  let offset = 4, nodes = 0;
  const take = count => { requireValue(Number.isSafeInteger(count) && count >= 0 && offset + count <= value.length, 'Truncated legacy binary JSON.'); const start = offset; offset += count; return start; };
  const length = () => { const count = value.readInt32BE(take(4)); requireValue(count >= 0 && count <= MAX_ROW, 'Invalid legacy binary JSON length.'); return count; };
  const text = () => { const count = length(), start = take(count * 2); return Buffer.from(value.subarray(start, start + count * 2)).swap16().toString('utf16le'); };
  function read(depth) {
    requireValue(depth <= 256 && ++nodes <= 2000000, 'Legacy binary JSON nesting or node limit exceeded.');
    const type = value[take(1)];
    if (type === 0) return null;
    if (type === 1 || type === 2) {
      const count = length(); requireValue(count <= value.length - offset, 'Truncated legacy binary JSON collection.');
      const result = type === 1 ? Object.create(null) : [];
      for (let index = 0; index < count; index++) {
        if (type === 2) result.push(read(depth + 1));
        else { const key = text(); requireValue(!Object.hasOwn(result, key), 'Duplicate legacy binary JSON key.'); result[key] = read(depth + 1); }
      }
      return result;
    }
    if (type === 3) return text();
    if (type === 4 || type === 5) return type === 4;
    if (type === 6) { const integer = value.readBigInt64BE(take(8)); return integer >= -9007199254740991n && integer <= 9007199254740991n ? Number(integer) : integer; }
    if (type === 7 || type === 8) { const number = type === 7 ? value.readFloatBE(take(4)) : value.readDoubleBE(take(8)); requireValue(Number.isFinite(number), 'Non-finite legacy binary JSON number.'); return number; }
    throw legacyError('Unknown legacy binary JSON type.');
  }
  const result = read(0); requireValue(plain(result) && offset === value.length, 'Invalid legacy binary JSON envelope.'); return result;
}

/** Reconstruct the retained document journal, without acknowledging or sending it. */
export function recoverLisiereDraft(cache, key) {
  requireValue(cache instanceof Map && typeof key === 'string', 'An exact legacy draft key is required.');
  if (!cache.has(`draftmeta:${key}`)) return recoverPreviousDraft(cache, key);
  const meta = decodeLisiereObject(cache.get(`draftmeta:${key}`));
  requireValue(typeof meta.project === 'string' && typeof meta.path === 'string' && key === `${meta.project}:${meta.path}`
    && typeof meta.epoch === 'string' && meta.epoch && !meta.epoch.includes(':'), 'Legacy draft identity is inconsistent.');
  for (const field of ['version', 'seedVersion', 'ack', 'length']) requireValue(Number.isSafeInteger(meta[field]) && meta[field] >= 0, 'Legacy draft counters are invalid.');
  requireValue(meta.seedVersion <= meta.version && meta.ack <= meta.version && meta.length <= MAX_ROW, 'Legacy draft versions are inconsistent.');
  let content = cache.get(`draftdoc:${key}`);
  requireValue(typeof content === 'string' && content.length <= MAX_ROW, 'The original legacy draft seed is missing or oversized.');
  const prefix = `draftdelta:${meta.epoch}:`, records = [];
  for (const [name, value] of cache) if (name.startsWith(prefix)) {
    const version = name.slice(prefix.length); requireValue(/^[0-9]{20}$/.test(version), 'Invalid legacy draft delta identity.');
    const number = BigInt(version);
    if (number > BigInt(meta.seedVersion) && number <= BigInt(meta.version)) records.push({ name, number, value });
  }
  records.sort((a, b) => a.number < b.number ? -1 : 1);
  if (meta.version > meta.seedVersion) requireValue(records.at(-1)?.number === BigInt(meta.version), 'The latest legacy draft delta is missing.');
  for (const record of records) {
    const saved = decodeLisiereObject(record.value), edits = Object.hasOwn(saved, 'edits') ? saved.edits : [saved];
    requireValue(Array.isArray(edits) && edits.length > 0 && edits.length <= 100000, 'Invalid legacy draft edit batch.');
    for (const edit of edits) {
      requireValue(plain(edit) && Number.isSafeInteger(edit.start) && edit.start >= 0 && Number.isSafeInteger(edit.removed) && edit.removed >= 0
        && edit.start + edit.removed <= content.length && typeof edit.inserted === 'string'
        && content.length - edit.removed + edit.inserted.length <= MAX_ROW, 'A legacy draft edit is outside its original UTF-16 range.');
      content = content.slice(0, edit.start) + edit.inserted + content.slice(edit.start + edit.removed);
    }
  }
  requireValue(content.length === meta.length, 'The legacy draft is incomplete.');
  return { sourceKey: key, epoch: meta.epoch, project: meta.project, path: meta.path, base: meta.base, baseKnown: meta.baseKnown === true,
    version: meta.version, acknowledgedVersion: meta.ack, changed: meta.changed === true, pending: meta.version > meta.ack, accepted: false,
    content, consumedDeltas: records.map(record => record.name) };
}

/** Earlier tablet builds retained one pending value instead of an epoch log.
 * Its delivery state is unknown: recovery must never invent an acknowledgement
 * or choose between conflicting retained texts. */
function recoverPreviousDraft(cache, key) {
  requireValue(cache.has(`dirtydraft:${key}`), 'The legacy draft has no versioned journal or pending record. Retain its seed for explicit reconciliation.');
  const pending = decodeLisiereObject(cache.get(`dirtydraft:${key}`));
  requireValue(typeof pending.project === 'string' && pending.project.length > 0 && typeof pending.path === 'string' && pending.path.length > 0
    && key === `${pending.project}:${pending.path}`, 'Legacy draft identity is inconsistent.');
  requireValue(typeof pending.content === 'string' && pending.content.length <= MAX_ROW
    && Number.isSafeInteger(pending.version) && pending.version >= 0, 'The earlier legacy draft content or version is invalid.');
  requireValue(!Object.hasOwn(pending, 'base') || typeof pending.base === 'string', 'The original legacy draft base is invalid.');
  const seed = cache.get(`draftdoc:${key}`), clock = cache.get(`draftclock:${key}`);
  requireValue(seed === undefined || seed === pending.content, 'The earlier pending text and retained seed disagree. Reconcile both originals before import.');
  requireValue(clock === undefined || typeof clock === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(clock)
    && BigInt(clock) <= 9223372036854775807n && BigInt(clock) >= BigInt(pending.version), 'The earlier legacy draft clock is invalid or older than its pending version.');
  return { sourceKey: key, epoch: null, project: pending.project, path: pending.path, base: pending.base ?? null,
    baseKnown: typeof pending.base === 'string' && pending.base.length > 0, version: pending.version,
    acknowledgedVersion: null, changed: true, pending: true, accepted: false, content: pending.content,
    consumedDeltas: [], legacyClock: clock ?? null };
}
