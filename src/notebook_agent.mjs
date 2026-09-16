import { setTimeout as delay } from 'node:timers/promises';
import { canonicalNotebookRoot, notebookHash } from './notebook_io.mjs';
import { notebookId, normalizeNotebookObject, failNotebook } from './notebook_protocol.mjs';
import { readNotebook, mutateNotebook } from './notebooks.mjs';

export const NOTEBOOK_AGENT_TOOL = {
  type: 'function', name: 'context_room_notebook',
  description: 'Read or edit only the notebook originally selected for this conversation. Scene returns exact object revisions; read it before editing existing objects. An edit is {kind:"put",id,expectedRevision:0,object:{id,type,...}} for a new object, {kind:"patch",id,expectedRevision,patch:{...}} or {kind:"delete",id,expectedRevision}. Use a stable unique string id. Object types: rect and ellipse use x,y,width,height; text uses x,y,text,fontSize; line and arrow use x,y,x2,y2; ink uses points [[x,y,pressure],...]. Color and strokeWidth are optional. Draw requires stroke:{id,type:"ink",points,...} and advances a NEW stroke progressively; interruption keeps only reached geometry. Drawings and working changes never accept a document.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['scene', 'edit', 'draw'] },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    edits: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: true } },
    stroke: { type: 'object', additionalProperties: true }, durationMs: { type: 'integer', minimum: 300, maximum: 6000 },
  } },
};

function reachedPath(points, lengths, distance) {
  const reached = [points[0]];
  for (let n = 1; n < points.length; n++) {
    if (lengths[n] <= distance) { reached.push(points[n]); continue; }
    const fraction = (distance - lengths[n - 1]) / (lengths[n] - lengths[n - 1]);
    const before = points[n - 1], after = points[n];
    if (fraction > 0) reached.push(before.slice(0, 3).map((value, index) => value + (after[index] - value) * fraction));
    break;
  }
  return reached;
}

/** Captured exact location. The current browser page is never an input to an agent action. */
export class NotebookAgentContext {
  constructor({ root, resourceId, locationRevision, sessionId, selection = [], canRead = () => false, canWrite = () => false }) {
    this.root = root; this.rootIdentity = canonicalNotebookRoot(root);
    this.resourceId = notebookId(resourceId); this.locationRevision = locationRevision;
    this.actor = { kind: 'agent', id: notebookId(sessionId), sessionId: notebookId(sessionId) };
    this.selection = [...new Set(selection.map(notebookId))]; this.canRead = canRead; this.canWrite = canWrite;
    const scene = this.checkedScene(); this.originalPath = scene.locator.path;
    if (this.selection.some(id => !scene.document.objects.some(object => object.id === id))) failNotebook('notebook_selection_conflict', 'The selected objects changed before this conversation started.');
    this.originalRevision = scene.revision;
  }
  checkedScene() {
    if (canonicalNotebookRoot(this.root) !== this.rootIdentity) failNotebook('notebook_root_conflict', 'The conversation’s original project was replaced.');
    const scene = readNotebook(this.root, this.resourceId);
    if (scene.locator.revision !== this.locationRevision || this.originalPath && scene.locator.path !== this.originalPath) failNotebook('notebook_location_conflict', 'The conversation’s notebook moved. Return to its original scope before acting.');
    if (!this.canRead(scene.locator.path)) failNotebook('notebook_path_scope', 'Access to the original notebook is unavailable.');
    return scene;
  }
  scene({ offset = 0, limit = 80 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) failNotebook('notebook_agent_page', 'Read a bounded page of notebook objects.');
    const scene = this.checkedScene();
    const objects = []; let bytes = 0;
    for (const object of scene.document.objects.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(object));
      if (objects.length && bytes + size > 512 * 1024) break;
      objects.push(object); bytes += size;
    }
    const end = offset + objects.length;
    return { resourceId: scene.resourceId, path: scene.locator.path, locationRevision: scene.locator.revision,
      revision: scene.revision, originalRevision: this.originalRevision, selection: this.selection,
      totalObjects: scene.document.objects.length, nextOffset: end < scene.document.objects.length ? end : null,
      document: { ...scene.document, objects, assets: Object.fromEntries(Object.entries(scene.document.assets).map(([id, asset]) => [id, { mimeType: asset.mimeType }])) },
      tombstones: scene.tombstones, accepted: false };
  }
  edit(edits, operationId, signal) {
    signal?.throwIfAborted(); this.checkedScene();
    return mutateNotebook(this.root, { protocolVersion: 1, resourceId: this.resourceId, locationRevision: this.locationRevision,
      operationId: notebookId(operationId), edits }, { actor: this.actor, canWrite: this.canWrite });
  }
  async draw(input, { operationId, signal, durationMs = 900, onProgress = () => {} }) {
    notebookId(operationId);
    if (!Number.isInteger(durationMs) || durationMs < 300 || durationMs > 6000) failNotebook('notebook_pen_duration', 'Progressive ink takes 300–6000 milliseconds.');
    const stroke = normalizeNotebookObject(input);
    if (stroke.type !== 'ink' || stroke.points.length > 4096) failNotebook('notebook_pen_stroke', 'Use one new ink stroke with at most 4096 points.');
    const lengths = [0];
    for (let n = 1; n < stroke.points.length; n++) lengths.push(lengths[n - 1] + Math.hypot(stroke.points[n][0] - stroke.points[n - 1][0], stroke.points[n][1] - stroke.points[n - 1][1]));
    const started = performance.now(), total = lengths.at(-1);
    let expectedRevision = 0, step = 0, points = [], receipt = null;
    while (!signal?.aborted) {
      const fraction = Math.min(1, (performance.now() - started) / durationMs);
      points = reachedPath(stroke.points, lengths, total * fraction);
      receipt = this.edit([{ kind: 'put', id: stroke.id, expectedRevision, object: { ...stroke, points } }],
        'pen-' + notebookHash({ operationId, step: step++ }), signal);
      expectedRevision = receipt.objectRevisions[stroke.id];
      // The visible head is published only after the reached geometry is durable.
      onProgress({ objectId: stroke.id, point: points.at(-1), revision: receipt.revision, reachedPoints: points.length, reachedLength: total * fraction, completed: fraction === 1 });
      if (fraction === 1) break;
      try { await delay(Math.min(100, durationMs - (performance.now() - started)), undefined, { signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    return { stopped: Boolean(signal?.aborted), reachedPoints: points.length, objectId: stroke.id, receipt, accepted: false };
  }
  async call(name, input, { callId, turnId, signal, onProgress } = {}) {
    if (name !== NOTEBOOK_AGENT_TOOL.name || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['action', 'edits', 'stroke', 'durationMs', 'offset', 'limit'].includes(key))) failNotebook('notebook_agent_scope', 'This action is outside the original notebook.');
    signal?.throwIfAborted();
    if (typeof callId !== 'string' || !callId || callId.length > 160 || typeof turnId !== 'string' || !turnId || turnId.length > 160) failNotebook('notebook_agent_operation', 'An exact Codex turn and tool call are required.');
    const operationId = 'agent-' + notebookHash({ session: this.actor.sessionId, turnId, callId });
    if (input.action === 'scene') return this.scene(input);
    if (input.action === 'edit') return this.edit(input.edits, operationId, signal);
    if (input.action === 'draw') return this.draw(input.stroke, { operationId, signal, durationMs: input.durationMs, onProgress });
    failNotebook('notebook_agent_action', 'Use scene, edit or draw in the original notebook.');
  }
}
