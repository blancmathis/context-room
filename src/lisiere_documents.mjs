import path from 'node:path';
import fs from 'node:fs';
import { readLisiereSnapshot, decodeLisiereObject, recoverLisiereDraft, legacyError } from './lisiere_archive.mjs';
import { lisiereRecordSelector } from './lisiere_inventory.mjs';
import { retainLisiereRecoveryBytes } from './lisiere_migration.mjs';
import { beginLocalProposal } from './local_proposals.mjs';
import { canonicalNotebookRoot, notebookHash, stableNotebookJson, safeNotebookPath, readNotebookBytes, readNotebookJson, withNotebookLock } from './notebook_io.mjs';

const LIMIT = 16 * 1024 * 1024;
const STORE = '.context-room/migrations/lisiere-v1';
const bytes = value => Buffer.from(stableNotebookJson(value) + '\n');
const check = (value, message) => { if (!value) throw legacyError(message); };
function configHash(root) { const current = readNotebookBytes(root, '.context-room/config.json', 8 * 1024 * 1024); return current === null ? null : notebookHash(current); }

function archivedRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    Buffer.isBuffer(value) ? { base64: value.toString('base64') } : typeof value === 'bigint' ? { integer: String(value) } : value]));
}

function selectedDraft(archive, selector) {
  if (archive.manifest.kind === 'mac-workspace') {
    let row;
    for (const candidate of archive.rows('drafts')) if (lisiereRecordSelector('drafts', candidate) === selector) {
      check(!row, 'This retained draft identity is duplicated.'); row = candidate;
    }
    check(row && ['project', 'path', 'device'].every(key => typeof row[key] === 'string' && row[key].length > 0)
      && Number.isSafeInteger(row.version) && row.version >= 0 && typeof row.content === 'string'
      && (row.base === null || typeof row.base === 'string'), 'The selected versioned draft is absent or malformed.');
    return { row, original: bytes(row), source: { project: row.project, path: row.path, device: row.device, version: row.version } };
  }
  let selected;
  for (const row of archive.rows('cache')) if (lisiereRecordSelector('drafts', row) === selector) {
    check(!selected, 'This retained draft identity is duplicated.'); selected = row;
  }
  check(selected && typeof selected.key === 'string' && /^(?:draftmeta|dirtydraft):/.test(selected.key),
    'Choose the tablet draft journal or earlier pending record from the inventory. A text seed alone has no delivery or version authority.');
  const key = selected.key.slice(selected.key.indexOf(':') + 1), selectedValue = decodeLisiereObject(selected.value);
  const prefix = selected.key.startsWith('draftmeta:') && typeof selectedValue.epoch === 'string' && selectedValue.epoch && !selectedValue.epoch.includes(':')
    ? `draftdelta:${selectedValue.epoch}:` : null;
  const keys = new Set(['draftmeta:', 'dirtydraft:', 'draftdoc:', 'draftclock:', 'draftmerge:', 'draftmerge-backup:'].map(name => name + key));
  const cache = new Map(), records = []; let size = 0;
  for (const row of archive.rows('cache')) if (keys.has(row.key) || prefix && row.key.startsWith(prefix)) {
    check(!cache.has(row.key), 'The tablet draft journal contains duplicate records.');
    const original = archivedRow(row); size += bytes(original).length;
    check(size <= 32 * 1024 * 1024 && records.length < 100000, 'The selected tablet journal exceeds the bounded recovery copy.');
    cache.set(row.key, row.value); records.push(original);
  }
  check(!selected.key.startsWith('dirtydraft:') || !cache.has(`draftmeta:${key}`),
    'A newer tablet journal exists. Select its exact draftmeta record; an older pending value cannot replace it.');
  const recovered = recoverLisiereDraft(cache, key);
  check(recovered.project.length > 0 && recovered.path.length > 0, 'The original tablet document identity is empty.');
  check(recovered.base == null || typeof recovered.base === 'string', 'The original tablet document base is invalid.');
  // A local ack can also be an accepted-baseline marker. It never proves which
  // Mac request arrived, and recovery never sends or acknowledges that request.
  const source = { kind: 'android-workspace', project: recovered.project, path: recovered.path, device: null,
    sourceKey: key, epoch: recovered.epoch, version: recovered.version,
    acknowledgedVersion: recovered.acknowledgedVersion, pending: recovered.pending, changed: recovered.changed,
    delivery: 'not-inferred', pendingReconciliation: cache.has(`draftmerge:${key}`) };
  records.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { row: { ...recovered, base: recovered.baseKnown ? recovered.base : null }, source,
    original: bytes({ version: 1, kind: 'lisiere-tablet-draft', selectedKey: selected.key, source, records,
      reconstructed: { content: recovered.content, consumedDeltas: recovered.consumedDeltas } }) };
}

function prepare(root, options, { canWrite, acceptedBase }) {
  const rootIdentity = canonicalNotebookRoot(root), target = options?.path;
  check(typeof target === 'string' && target.length <= 1024 && /\.(?:md|markdown|txt|html?)$/i.test(target)
    && target.split('/').every(part => part && !part.startsWith('.') && part !== 'node_modules'), 'Choose an ordinary text-document destination.');
  safeNotebookPath(root, target);
  check(canWrite(target), 'The recovered draft destination is outside the editable document scope.');
  check(typeof options?.selector === 'string' && /^[a-f0-9]{64}$/.test(options.selector), 'Choose the exact draft selector from the recovery inventory.');
  const archive = readLisiereSnapshot(options.snapshot);
  const { row, original, source } = selectedDraft(archive, options.selector), content = Buffer.from(row.content);
  check(content.length <= LIMIT && content.toString('utf8') === row.content && original.length <= 32 * 1024 * 1024,
    'This retained text is oversized or has unfinished UTF-16 composition. Keep its exact original for reconciliation.');
  const requestId = `draft-${notebookHash({ rootIdentity, selector: options.selector, path: target })}`, recovery = `${STORE}/${requestId}`;
  const identity = { version: 1, kind: 'lisiere-document-import', rootIdentity, requestId, selector: options.selector, path: target,
    source, contentHash: notebookHash(content), accepted: false };
  let intent = readNotebookJson(root, `${recovery}/intent.json`);
  if (intent !== null) check(intent && typeof intent === 'object' && intent.identity && notebookHash(intent.identity) === notebookHash(identity), 'The retained draft preparation belongs to different source data.');
  else {
    const current = readNotebookBytes(root, target, LIMIT), before = acceptedBase(target);
    check(!current || typeof row.base === 'string' && notebookHash(current) === row.base, 'The original document changed since this draft. Choose an unused path or reconcile the retained versions.');
    check(!current || before, 'The existing original has no accepted review base. Review it first or choose an unused destination.');
    check(current || !before, 'This accepted document is now missing. Reconcile its deletion or choose an unused destination.');
    check(!before || Buffer.isBuffer(before.bytes) && before.bytes.length <= LIMIT && Number.isInteger(before.mode) && before.mode >= 0 && before.mode <= 0o777,
      'The accepted base is unavailable or outside the supported recovery size.');
    intent = { identity, originalTargetHash: current ? notebookHash(current) : null,
      workingMode: current ? fs.lstatSync(safeNotebookPath(root, target)).mode & 0o777 : 0o644,
      before: before ? { hash: notebookHash(before.bytes), data: before.bytes.toString('base64'), mode: before.mode } : null };
  }
  check(Number.isInteger(intent.workingMode) && intent.workingMode >= 0 && intent.workingMode <= 0o777, 'The retained working file mode is invalid.');
  if (intent.before) {
    check(typeof intent.before.data === 'string', 'The retained accepted base is damaged.');
    const base = Buffer.from(intent.before.data, 'base64');
    check(base.length <= LIMIT && base.toString('base64') === intent.before.data && notebookHash(base) === intent.before.hash
      && Number.isInteger(intent.before.mode) && intent.before.mode >= 0 && intent.before.mode <= 0o777, 'The retained accepted base is damaged.');
  }
  const configuration = configHash(root), revision = notebookHash({ intent, sourceRevision: archive.manifest.revision, configuration });
  return { identity, intent, recovery, configuration, revision, original, content, sourceRevision: archive.manifest.revision,
    summary: { kind: identity.kind, revision, selector: options.selector, sourceRevision: archive.manifest.revision,
      source: identity.source, path: target, requestId, recovery, bytes: content.length, accepted: false, effect: 'local-working-proposal' } };
}

/** Retain original text as an editing proposal. Submission and exact human
 * acceptance remain the existing Local workflow's separate actions. */
export function migrateLisiereDocument(root, options, { canWrite = () => false, acceptedBase = () => null, beforeWrite = () => {} } = {}) {
  const prepared = prepare(root, options, { canWrite, acceptedBase });
  if (!options.apply) return { ...prepared.summary, applied: false };
  check(options.expectedRevision === prepared.revision, 'The draft source, destination or configuration changed after preview. Use its exact revision.');
  return withNotebookLock(root, `${STORE}/migration.lock`, () => {
    const { identity, intent, recovery, content } = prepared;
    const recheck = () => check(canonicalNotebookRoot(root) === identity.rootIdentity && configHash(root) === prepared.configuration && canWrite(identity.path),
      'The project or editable scope changed during draft recovery. Retained data remains available.');
    recheck(); beforeWrite(); recheck();
    const receipt = bytes({ version: 1, identityHash: notebookHash(identity), requestId: identity.requestId, accepted: false });
    const applied = readNotebookBytes(root, `${recovery}/applied.json`);
    check(applied === null || applied.equals(receipt), 'The draft recovery receipt changed. Reconcile it without replacing working data.');
    retainLisiereRecoveryBytes(root, `${recovery}/intent.json`, bytes(intent));
    retainLisiereRecoveryBytes(root, `${recovery}/source-draft.json`, prepared.original);
    retainLisiereRecoveryBytes(root, `${recovery}/sources/${prepared.sourceRevision}.json`, bytes({ sourceRevision: prepared.sourceRevision, selector: identity.selector }));
    recheck();
    const before = intent.before;
    const proposal = beginLocalProposal(root, { requestId: identity.requestId, title: `Recovered draft · ${path.posix.basename(identity.path)}`,
      description: 'Recovered original Lisière text. The source snapshot is retained. Submission and human review remain separate.',
      allowedPaths: [identity.path], files: before ? [{ path: identity.path, content: Buffer.from(before.data, 'base64'), mode: before.mode }] : [],
      initialFiles: [{ path: identity.path, content, mode: intent.workingMode }] });
    retainLisiereRecoveryBytes(root, `${recovery}/applied.json`, receipt);
    return { ...prepared.summary, applied: true, replayed: applied !== null, proposalId: proposal.id, status: proposal.status,
      editRoot: proposal.editRoot, receipt: `${recovery}/applied.json` };
  });
}
