import fs from 'node:fs';
import path from 'node:path';
import { readLisiereSnapshot, legacyError } from './lisiere_archive.mjs';
import { retainLisiereRecoveryBytes } from './lisiere_migration.mjs';
import { pcm16Wave } from './local_audio.mjs';
import { canonicalNotebookRoot, safeNotebookPath, readNotebookJson, readNotebookBytes, notebookHash, stableNotebookJson, withNotebookLock } from './notebook_io.mjs';

const STORE = 'legacy-recordings/v1', LIMIT = 16000 * 2 * 120;
const check = (value, message) => { if (!value) throw legacyError(message); };
const json = value => Buffer.from(stableNotebookJson(value) + '\n');
const linkPath = id => { check(/^[a-f0-9]{64}$/.test(id || ''), 'Choose an exact recording link.'); return `${STORE}/links/${id}.json`; };
const objectPath = hash => { check(/^[a-f0-9]{64}$/.test(hash || ''), 'Invalid recording content address.'); return `${STORE}/objects/${hash}.pcm`; };

/** A recovery recording never belongs in the ordinary or public document tree. */
export function privateRecordingStore(storageRoot, project) {
  check(typeof storageRoot === 'string' && path.resolve(storageRoot) === storageRoot, 'Choose an exact absolute private recording store.');
  check(storageRoot !== project && !storageRoot.startsWith(project + path.sep), 'Keep recordings outside the project and public repository.');
  let ancestor = storageRoot;
  while (!fs.existsSync(ancestor)) {
    check(!fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink(), 'The private recording store must not use symbolic links.');
    ancestor = path.dirname(ancestor);
  }
  check(fs.realpathSync(ancestor) === ancestor, 'The private recording store must use its exact original location.');
  if (ancestor === storageRoot) {
    canonicalNotebookRoot(storageRoot); const stat = fs.statSync(storageRoot);
    check(!(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid()), 'Recordings require a private directory owned by this account.');
  }
}

export function recordingSourceIdentity(source) {
  check(source && ['document', 'notebook'].includes(source.kind) && typeof source.path === 'string', 'Choose an explicit original document or notebook.');
  return { kind: source.kind, path: source.path, ...(source.kind === 'notebook' ? { resourceId: source.resourceId, locationRevision: source.locationRevision } : {}) };
}

/** Strip document excerpts from link metadata; retain the original version, not its text. */
export function recordingTargetFromResolved(resolved, conversationId = null) {
  const context = resolved.context();
  return { source: recordingSourceIdentity(resolved.source), conversationId,
    version: resolved.source.kind === 'notebook' ? { revision: context.currentRevision } : { hash: context.currentHash } };
}

function readLink(storageRoot, id) {
  const link = readNotebookJson(storageRoot, linkPath(id));
  if (!link) return null;
  const { revision, ...content } = link;
  check(link.version === 1 && link.id === id && link.accepted === false && notebookHash(content) === revision
    && link.recording?.bytes > 0 && link.recording.bytes <= LIMIT && link.recording.bytes % 2 === 0, 'The immutable recording link is damaged. Nothing was replaced.');
  objectPath(link.recording.sha256);
  return link;
}

function publicLink(link, current) {
  return { id: link.id, revision: link.revision, label: link.label, name: link.recording.name, bytes: link.recording.bytes,
    sha256: link.recording.sha256, sourceRevision: link.sourceRevision, target: link.target,
    durationSeconds: link.recording.bytes / 32000, sourceChanged: notebookHash(link.target.version) !== notebookHash(current.version),
    accepted: false, submitted: false, played: false, transcribed: false };
}

/** resolveTarget must authorize the exact original source on every invocation.
 * Preview, copying and reading never instantiate a provider or transcribe audio. */
export function attachLisiereRecording(project, options, { storageRoot, resolveTarget, checkpoint = () => {} }) {
  const rootIdentity = canonicalNotebookRoot(project);
  privateRecordingStore(storageRoot, project);
  check(typeof resolveTarget === 'function', 'An authorized source resolver is required.');
  check(typeof options?.name === 'string' && /^[a-f0-9]{64}\.pcm$/.test(options.name), 'Select the exact original PCM name from the recovery inventory.');
  const label = options.label ?? 'Recovered recording';
  check(typeof label === 'string' && label.trim() && label.length <= 200, 'Choose a recording label of at most 200 characters.');
  const archive = readLisiereSnapshot(options.snapshot), pcm = archive.recording(options.name);
  check(pcm.length > 0 && pcm.length <= LIMIT && pcm.length % 2 === 0, 'Choose a nonempty bounded original PCM recording.');
  const selected = resolveTarget(project, options), target = { ...selected, source: recordingSourceIdentity(selected.source) };
  const identity = { project, rootIdentity, sourceRevision: archive.manifest.revision, name: options.name,
    source: target.source, conversationId: target.conversationId || null };
  const id = notebookHash(identity), recording = { name: options.name, bytes: pcm.length, sha256: notebookHash(pcm) };
  const payload = { version: 1, id, project, rootIdentity, sourceRevision: archive.manifest.revision, recording,
    target, label: label.trim(), accepted: false };
  const link = { ...payload, revision: notebookHash(payload) };
  const existing = fs.existsSync(storageRoot) ? readLink(storageRoot, id) : null;
  if (existing) {
    check(existing.label === link.label && notebookHash(existing.recording) === notebookHash(recording)
      && notebookHash(existing.target.source) === notebookHash(target.source) && existing.target.conversationId === target.conversationId,
      'This recording is already linked with different metadata. The original association is retained.');
    const retained = readNotebookBytes(storageRoot, objectPath(recording.sha256), LIMIT);
    check(retained?.equals(pcm), 'The retained recording is missing or damaged. Keep the original export for recovery.');
    if (options.apply) check(options.expectedRevision === existing.revision, 'Use the exact existing recording link revision.');
    return { ...publicLink(existing, target), applied: Boolean(options.apply), replayed: true };
  }
  if (!options.apply) return { ...publicLink(link, target), applied: false, replayed: false };
  check(options.expectedRevision === link.revision, 'The selected recording, label or original source changed after preview.');
  privateRecordingStore(storageRoot, project);
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); privateRecordingStore(storageRoot, project);
  return withNotebookLock(storageRoot, `${STORE}/mutation.lock`, () => {
    const verify = () => {
      privateRecordingStore(storageRoot, project);
      check(canonicalNotebookRoot(project) === rootIdentity && notebookHash(resolveTarget(project, options)) === notebookHash(target),
        'The original source or permission changed while attaching the recording.');
    };
    verify();
    retainLisiereRecoveryBytes(storageRoot, objectPath(recording.sha256), pcm); checkpoint('recording-copied'); verify();
    retainLisiereRecoveryBytes(storageRoot, linkPath(id), json(link)); checkpoint('link-published');
    return { ...publicLink(link, target), applied: true, replayed: false };
  });
}

function authorizedLink(project, storageRoot, id, current) {
  const rootIdentity = canonicalNotebookRoot(project); privateRecordingStore(storageRoot, project);
  const link = readLink(storageRoot, id);
  check(link && link.project === project && link.rootIdentity === rootIdentity && notebookHash(link.target.source) === notebookHash(recordingSourceIdentity(current.source))
    && (!link.target.conversationId || link.target.conversationId === current.conversationId), 'This recording belongs to another original source or conversation.');
  return link;
}

/** Listing a source's links discloses metadata only, never audio or another project. */
export function listLinkedRecordings(project, { storageRoot, current }) {
  privateRecordingStore(storageRoot, project); const rootIdentity = canonicalNotebookRoot(project), source = recordingSourceIdentity(current.source);
  if (!fs.existsSync(storageRoot)) return { items: [], accepted: false };
  const folder = safeNotebookPath(storageRoot, `${STORE}/links`);
  if (!fs.existsSync(folder)) return { items: [], accepted: false };
  const names = fs.readdirSync(folder); check(names.length <= 10000, 'The recording catalogue exceeds its bounded size. Retained files were not discarded.');
  const items = [];
  for (const name of names) {
    check(/^[a-f0-9]{64}\.json$/.test(name), 'An unknown recording link needs explicit recovery.');
    const link = readLink(storageRoot, name.slice(0, -5));
    if (link.project !== project || link.rootIdentity !== rootIdentity || notebookHash(link.target.source) !== notebookHash(source)
      || link.target.conversationId && link.target.conversationId !== current.conversationId) continue;
    items.push(publicLink(link, current));
  }
  return { items, accepted: false };
}

export function readLinkedRecording(project, id, { storageRoot, current, format = 'pcm' }) {
  check(['pcm', 'wav'].includes(format), 'Choose original PCM or a lossless WAVE envelope.');
  const link = authorizedLink(project, storageRoot, id, current);
  const pcm = readNotebookBytes(storageRoot, objectPath(link.recording.sha256), LIMIT);
  check(pcm && pcm.length === link.recording.bytes && notebookHash(pcm) === link.recording.sha256, 'The retained recording failed its original content hash.');
  const raw = format === 'wav' ? pcm16Wave(pcm) : pcm;
  return { id, revision: link.revision, name: format === 'pcm' ? link.recording.name : `recording-${id.slice(0, 16)}.wav`,
    mimeType: format === 'wav' ? 'audio/wav' : 'application/octet-stream', bytes: raw.length, sha256: notebookHash(raw),
    originalSha256: link.recording.sha256, data: raw.toString('base64'), sampleRate: 16000, channels: 1, played: false, submitted: false };
}
