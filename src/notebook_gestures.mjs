import { cloneNotebook, notebookId } from './notebook_protocol.mjs';

/** Keep the first before-image and exact last revision for each object, never a whole-scene undo. */
export function recordNotebookGesture(metadata, gestureId, changes) {
  if (!gestureId) return metadata;
  notebookId(gestureId);
  const history = cloneNotebook(metadata.gestureHistory || { undo: [], redo: [], archived: 0 });
  let gesture = history.undo.at(-1);
  if (gesture?.id !== gestureId) { gesture = { id: gestureId, changes: [] }; history.undo.push(gesture); }
  for (const change of changes) {
    const existing = gesture.changes.find(item => item.id === change.id);
    if (existing) { existing.after = change.after; existing.revision = change.revision; }
    else gesture.changes.push(cloneNotebook(change));
  }
  history.redo = [];
  // The canonical journal is unbounded; this is only a bounded interactive undo index.
  if (history.undo.length > 500) { history.archived += history.undo.length - 500; history.undo = history.undo.slice(-500); }
  return { ...metadata, gestureHistory: history };
}
const withoutVersion = object => Object.fromEntries(Object.entries(object).filter(([key]) => !['revision', 'updatedBy', 'locked'].includes(key)));
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
export function notebookGestureEdits(gesture, direction) {
  return gesture.changes.map(change => {
    const desired = direction === 'undo' ? change.before : change.after, previous = direction === 'undo' ? change.after : change.before;
    if (desired && previous?.locked && !desired.locked && stable(withoutVersion(previous)) === stable(withoutVersion(desired))) return { kind: 'patch', id: change.id, expectedRevision: change.revision, patch: { locked: false } };
    return desired ? { kind: 'put', id: change.id, expectedRevision: change.revision, object: desired } : { kind: 'delete', id: change.id, expectedRevision: change.revision };
  });
}

/** A gesture can span many durable operations. Stopping keeps the reached part; no replay animation. */
export class NotebookStroke {
  constructor({ enqueue, id = () => globalThis.crypto.randomUUID(), color = '#000000', width = 3, segmentPoints = 4096, gestureId = id() }) {
    this.enqueue = enqueue; this.newId = id; this.color = color; this.width = width; this.gestureId = gestureId;
    this.segmentPoints = Math.max(2, Math.min(4096, segmentPoints)); this.tail = Promise.resolve(); this.strokeId = null;
    this.revision = 0; this.count = 0; this.last = null; this.closed = false; this.unsaved = []; this.error = null;
  }
  append(points) {
    if (this.closed) return Promise.reject(new Error('This stroke has ended.'));
    const samples = cloneNotebook(points); if (!samples.length) return this.tail;
    const pending = { points: samples, offset: 0 }; this.unsaved.push(pending);
    const work = this.tail.then(async () => {
      if (this.error) throw this.error;
      let offset = 0;
      while (offset < samples.length) {
        if (!this.strokeId || this.count >= this.segmentPoints) {
          this.strokeId = this.newId(); this.count = 0; this.revision = 0;
          const first = this.last ? [this.last, samples[offset++]] : [samples[offset++]];
          await this.enqueue([{ kind: 'put', id: this.strokeId, expectedRevision: 0, object: { id: this.strokeId, type: 'ink', points: first, color: this.color, strokeWidth: this.width } }], { gestureId: this.gestureId });
          this.count = first.length; this.revision = 1; this.last = first.at(-1);
        } else {
          const batch = samples.slice(offset, offset + Math.min(256, this.segmentPoints - this.count));
          await this.enqueue([{ kind: 'append', id: this.strokeId, expectedRevision: this.revision, points: batch }], { gestureId: this.gestureId });
          offset += batch.length; this.count += batch.length; this.revision++; this.last = batch.at(-1);
        }
        pending.offset = offset;
      }
      this.unsaved.shift();
    });
    this.tail = work.catch(error => { this.error = error; }); return work;
  }
  async finish() { this.closed = true; await this.tail; if (this.error) throw this.error; }
  recovery() { return { gestureId: this.gestureId, color: this.color, strokeWidth: this.width, strokeId: this.strokeId, revision: this.revision, unsavedSamples: this.unsaved.map(item => cloneNotebook(item.points.slice(item.offset))), error: this.error?.message || '' }; }
}
