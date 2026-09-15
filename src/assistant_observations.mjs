import { createHash, randomUUID } from 'node:crypto';
import { notebookImageSize } from './notebook_images.mjs';

export const OBSERVATION_LEASE_MS = 5000, OBSERVATION_IMAGE_BYTES = 1024 * 1024;
const imageContent = Symbol('Context Room authorized observation image');
const hash = value => createHash('sha256').update(value).digest('hex');
const fault = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault('assistant_observation_input', 'Use a bounded original-source observation.', 400);
}
function previewImage(url) {
  if (typeof url !== 'string' || url.length > Math.ceil(OBSERVATION_IMAGE_BYTES / 3) * 4 + 100) throw fault('assistant_observation_image', 'Use a preview of at most one MiB.', 413);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match) throw fault('assistant_observation_image', 'Use a PNG, JPEG or WebP preview.', 400);
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > OBSERVATION_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw fault('assistant_observation_image', 'The preview encoding is invalid.', 400);
  const size = notebookImageSize(bytes, match[1]);
  if (size.width > 1024 || size.height > 1024) throw fault('assistant_observation_image', 'Use a preview no larger than 1024 pixels on either side.', 413);
  return { ...size, mimeType: match[1], bytes: bytes.length, sha256: hash(bytes) };
}

/** Live previews stay only in this runtime's bounded memory and expire without a heartbeat. */
export class AssistantObservations {
  constructor({ resolve, now = () => Date.now(), maxStreams = 8 }) {
    if (typeof resolve !== 'function' || !Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > 8) throw fault('assistant_observation_configuration', 'Use a source resolver and at most eight live previews.', 400);
    this.resolve = resolve; this.now = now; this.maxStreams = maxStreams; this.streams = new Map();
    this.expiry = setInterval(() => this.prune(), 1000); this.expiry.unref?.();
  }
  source(project, conversationId) {
    if (!uuid(conversationId)) throw fault('assistant_observation_identity', 'An exact original conversation is required.', 400);
    const current = this.resolve(project, conversationId), source = current.source;
    if (!source || !['document', 'notebook'].includes(source.kind) || typeof source.path !== 'string'
      || source.kind === 'notebook' && !Number.isSafeInteger(current.currentRevision)
      || source.kind === 'document' && !/^[a-f0-9]{64}$/.test(current.currentHash)) throw fault('assistant_observation_source', 'The original observation source is unavailable.');
    return { ...current, fingerprint: hash(JSON.stringify([project, source.kind, source.path, source.resourceId, source.locationRevision])) };
  }
  prune() { for (const [id, stream] of this.streams) if (stream.expiresAt <= this.now()) this.streams.delete(id); }
  find(project, conversationId, current) {
    this.prune(); const stream = this.streams.get(conversationId);
    if (stream && (stream.project !== project || stream.fingerprint !== current.fingerprint)) throw fault('assistant_observation_scope', 'This preview belongs to a different original source.', 403);
    return stream;
  }
  public(stream) {
    return stream ? { active: true, clientId: stream.clientId, epoch: stream.epoch, expiresAt: stream.expiresAt,
      sequence: stream.sequence, paused: !stream.frame, lastObservedAt: stream.lastObservedAt || null }
      : { active: false, paused: true };
  }
  status(project, conversationId) { const current = this.source(project, conversationId); return this.public(this.find(project, conversationId, current)); }
  control(project, input) {
    keys(input, ['conversationId', 'clientId', 'epoch', 'action', 'takeover', 'sequence']);
    const current = this.source(project, input.conversationId);
    if (!uuid(input.clientId)) throw fault('assistant_observation_identity', 'An exact observation surface is required.', 400);
    const stream = this.find(project, input.conversationId, current);
    if (input.action === 'start') {
      if (stream && (stream.clientId !== input.clientId || stream.epoch !== input.epoch)
        && (input.takeover !== true || input.epoch !== stream.epoch)) throw fault('assistant_observation_owned', 'Another surface is sharing this source. Choose Take over sharing explicitly.');
      if (!stream && this.streams.size >= this.maxStreams) throw fault('assistant_observation_busy', 'Stop another live preview before sharing this source.');
      if (stream && stream.clientId === input.clientId && stream.epoch === input.epoch) { stream.expiresAt = this.now() + OBSERVATION_LEASE_MS; return this.public(stream); }
      const next = { project, fingerprint: current.fingerprint, clientId: input.clientId, epoch: randomUUID(), sequence: 0, expiresAt: this.now() + OBSERVATION_LEASE_MS, frame: null };
      this.streams.set(input.conversationId, next); return this.public(next);
    }
    if (!['stop', 'pause'].includes(input.action)) throw fault('assistant_observation_action', 'Unknown preview sharing action.', 400);
    if (!stream && input.action === 'stop') return this.public(null);
    this.owned(stream, input);
    if (input.action === 'stop') { this.streams.delete(input.conversationId); return this.public(null); }
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= stream.sequence) throw fault('assistant_observation_sequence', 'An older pause cannot replace a newer preview.');
    stream.sequence = input.sequence;
    stream.frame = null; stream.expiresAt = this.now() + OBSERVATION_LEASE_MS; return this.public(stream);
  }
  owned(stream, input) {
    if (!stream || stream.clientId !== input.clientId || stream.epoch !== input.epoch) throw fault('assistant_observation_stale', 'This surface no longer owns the live preview.');
  }
  publish(project, input) {
    keys(input, ['conversationId', 'clientId', 'epoch', 'sequence', 'frame']);
    const current = this.source(project, input.conversationId), stream = this.find(project, input.conversationId, current);
    this.owned(stream, input);
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= stream.sequence) throw fault('assistant_observation_sequence', 'An older preview cannot replace a newer one.');
    const frame = input.frame; let image, metadata;
    if (current.source.kind === 'notebook') {
      keys(frame, ['resourceId', 'locationRevision', 'revision', 'viewport', 'selection', 'image']);
      if (frame.resourceId !== current.source.resourceId || frame.locationRevision !== current.source.locationRevision
        || !Number.isSafeInteger(frame.revision) || frame.revision < 0 || frame.revision > current.currentRevision)
        throw fault('assistant_observation_source', 'Refresh the original notebook before sharing its preview.');
      if (!Array.isArray(frame.viewport) || frame.viewport.length !== 4 || frame.viewport.some((n, i) => !Number.isFinite(n) || (i < 2 ? Math.abs(n) > 1e7 : n <= 0 || n > 1e6))
        || !Array.isArray(frame.selection) || frame.selection.length > 64 || frame.selection.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
        || new Set(frame.selection).size !== frame.selection.length) throw fault('assistant_observation_frame', 'Use a bounded original viewport and selection.', 400);
      image = frame.image; metadata = { kind: 'notebook', resourceId: frame.resourceId, locationRevision: frame.locationRevision, revision: frame.revision,
        viewport: [...frame.viewport], selection: [...frame.selection], image: previewImage(image) };
    } else {
      keys(frame, ['baseHash', 'text', 'offset', 'totalLength', 'selection']);
      if (frame.baseHash !== current.currentHash) throw fault('assistant_observation_source', 'The saved original document changed. Refresh before sharing its draft.');
      if (typeof frame.text !== 'string' || frame.text.length > 20000 || !Number.isSafeInteger(frame.offset) || frame.offset < 0
        || !Number.isSafeInteger(frame.totalLength) || frame.totalLength < frame.offset + frame.text.length || frame.totalLength > 2_000_000)
        throw fault('assistant_observation_frame', 'Use a bounded excerpt of the original draft.', 400);
      if (frame.selection !== null) {
        keys(frame.selection, ['start', 'end']);
        if (!Number.isSafeInteger(frame.selection.start) || !Number.isSafeInteger(frame.selection.end) || frame.selection.start < 0 || frame.selection.end < frame.selection.start || frame.selection.end > frame.totalLength)
          throw fault('assistant_observation_frame', 'Use an exact original draft selection.', 400);
      }
      metadata = { kind: 'document', ...structuredClone(frame) };
    }
    stream.sequence = input.sequence; stream.expiresAt = this.now() + OBSERVATION_LEASE_MS;
    stream.frame = { metadata, image, receivedAt: this.now() }; return this.public(stream);
  }
  read(project, conversationId) {
    const current = this.source(project, conversationId), stream = this.find(project, conversationId, current);
    if (!stream?.frame) return { state: stream ? 'paused' : 'off', accepted: false };
    if (current.source.kind === 'document' && stream.frame.metadata.baseHash !== current.currentHash) {
      stream.frame = null; return { state: 'paused', reason: 'saved-source-changed', accepted: false };
    }
    stream.lastObservedAt = this.now();
    return { state: 'live', accepted: false, working: true, temporary: true, path: current.source.path, sequence: stream.sequence,
      receivedAt: stream.frame.receivedAt, observedAt: stream.lastObservedAt, ...structuredClone(stream.frame.metadata), imageUrl: stream.frame.image };
  }
  close() { clearInterval(this.expiry); this.streams.clear(); }
}

/** Only trusted scoped tool code can attach an image; JSON document content cannot forge this symbol. */
export function withSourceObservation(result, observation) {
  const { imageUrl, ...metadata } = observation;
  const output = { ...result, observation: metadata };
  if (imageUrl) Object.defineProperty(output, imageContent, { value: imageUrl });
  return output;
}
export function codexToolContent(result) {
  const text = JSON.stringify(result), imageUrl = result?.[imageContent];
  if (typeof text !== 'string' || Buffer.byteLength(text) + (imageUrl?.length || 0) > 4 * 1024 * 1024) throw fault('codex_result_limit', 'Inspect the scoped action receipt.');
  if (imageUrl) previewImage(imageUrl);
  return [{ type: 'inputText', text }, ...(imageUrl ? [{ type: 'inputImage', imageUrl }] : [])];
}
