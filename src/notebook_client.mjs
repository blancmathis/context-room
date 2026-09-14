/** Durable, portable notebook outbox. No optimistic documentary acceptance. */
import { applyNotebookEdits, cloneNotebook, emptyNotebook, notebookActor, notebookId, notebookPath, NOTEBOOK_VERSION } from './notebook_protocol.mjs';

const copy = value => value == null ? value : cloneNotebook(value);
const fault = (code, message) => Object.assign(new Error(message), { code });
export function notebookCacheKey({ serverId, accountId, deviceId, resourceId }) {
  for (const value of [serverId, accountId, deviceId, resourceId]) if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) throw fault('notebook_cache_scope', 'An explicit server, account, device and resource are required.');
  return JSON.stringify([serverId, accountId, deviceId, resourceId]);
}
const blank = () => ({ version: 0, metadata: {}, snapshot: null, operations: [] });

/** Test/reference storage; the browser implementation writes only changed rows. */
export class MemoryNotebookStorage {
  records = new Map();
  async read(key) { return copy(this.records.get(key) || blank()); }
  async commit(key, version, changes) {
    const state = this.records.get(key) || blank();
    if (state.version !== version) throw fault('notebook_cache_conflict', 'Another client changed this local resource.');
    const operations = new Map(state.operations.map(op => [op.operationId, op]));
    for (const id of changes.deleteOperations || []) operations.delete(id);
    for (const op of changes.putOperations || []) operations.set(op.operationId, copy(op));
    this.records.set(key, { version: version + 1, metadata: changes.metadata === undefined ? state.metadata : copy(changes.metadata), snapshot: changes.snapshot === undefined ? state.snapshot : copy(changes.snapshot), operations: [...operations.values()] });
    return version + 1;
  }
}

/** Separate snapshots and operation rows: writing a point does not rewrite prior ink. */
export class IndexedNotebookStorage {
  constructor({ indexedDB = globalThis.indexedDB, name = 'context-room-notebooks-v1' } = {}) {
    if (!indexedDB) throw fault('notebook_storage_unavailable', 'Durable storage is unavailable; drawing has not been enabled.');
    this.ready = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('metadata'); db.createObjectStore('snapshots');
        const operations = db.createObjectStore('operations', { keyPath: ['scope', 'operationId'] });
        operations.createIndex('scope', 'scope');
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(fault('notebook_storage_blocked', 'Close the older Context Room tab to upgrade its cache. Local work is retained.'));
    });
  }
  async read(key) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['metadata', 'snapshots', 'operations'], 'readonly');
      const meta = tx.objectStore('metadata').get(key), snapshot = tx.objectStore('snapshots').get(key), operations = tx.objectStore('operations').index('scope').getAll(key);
      tx.oncomplete = () => resolve({ version: meta.result?.version || 0, metadata: meta.result?.value || {}, snapshot: snapshot.result || null, operations: (operations.result || []).map(({ scope, ...op }) => op) });
      tx.onerror = tx.onabort = () => reject(tx.error || fault('notebook_storage_read', 'The local cache could not be read.'));
    });
  }
  async commit(key, version, changes) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      // strict durability requests disk completion where implemented; older engines use their default.
      let tx;
      try { tx = db.transaction(['metadata', 'snapshots', 'operations'], 'readwrite', { durability: 'strict' }); }
      catch { tx = db.transaction(['metadata', 'snapshots', 'operations'], 'readwrite'); }
      let error;
      const meta = tx.objectStore('metadata').get(key);
      meta.onsuccess = () => {
        if ((meta.result?.version || 0) !== version) { error = fault('notebook_cache_conflict', 'Another tab changed this local resource.'); tx.abort(); return; }
        tx.objectStore('metadata').put({ version: version + 1, value: changes.metadata === undefined ? meta.result?.value || {} : changes.metadata }, key);
        if (changes.snapshot !== undefined) tx.objectStore('snapshots').put(changes.snapshot, key);
        for (const op of changes.putOperations || []) tx.objectStore('operations').put({ ...op, scope: key });
        for (const id of changes.deleteOperations || []) tx.objectStore('operations').delete([key, id]);
      };
      tx.oncomplete = () => resolve(version + 1);
      tx.onerror = tx.onabort = () => reject(error || tx.error || fault('notebook_storage_write', 'Local storage failed. The gesture is not saved.'));
    });
  }
  async close() { (await this.ready).close(); }
}

function visible(state, actor) {
  if (!state.snapshot) return null;
  let document = copy(state.snapshot.document), tombstones = { ...state.snapshot.tombstones };
  const conflicts = [];
  for (const op of [...state.operations].sort((a, b) => a.order - b.order || a.operationId.localeCompare(b.operationId))) {
    if (op.state === 'conflict') { conflicts.push(copy(op)); continue; }
    // A response can be lost after delivery; never apply the same acknowledged change twice.
    if (op.receipt && state.snapshot.sequence >= op.receipt.sequence) continue;
    try {
      const applied = applyNotebookEdits(document, tombstones, op.request.edits, actor);
      document = applied.document;
      for (const change of applied.changes) tombstones[change.id] = change.revision;
    } catch (error) { conflicts.push({ ...copy(op), error: { code: error.code, message: error.message, details: error.details } }); }
  }
  return { ...copy(state.snapshot), document, tombstones, conflicts, pending: state.operations.length, accepted: false,
    status: conflicts.length ? 'conflict' : state.operations.length || state.metadata.pendingCreate ? 'pending' : state.metadata.offline ? 'cached' : 'confirmed',
    offline: Boolean(state.metadata.offline), locallySaved: true, pendingCreate: Boolean(state.metadata.pendingCreate) };
}

export class NotebookClient {
  constructor({ storage, transport, scope, actor, operationId = () => globalThis.crypto.randomUUID(), onChange = () => {} }) {
    this.storage = storage; this.transport = transport; this.scope = { ...scope }; this.key = notebookCacheKey(scope);
    this.actor = notebookActor(actor); this.newId = operationId; this.onChange = onChange; this.serial = Promise.resolve(); this.flushing = null; this.closed = false;
  }
  async state() { return this.storage.read(this.key); }
  async view() { return visible(await this.state(), this.actor); }
  async notify() { const view = await this.view(); if (!this.closed) this.onChange(view); return view; }
  async change(build) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.state(), changes = build(state);
      if (!changes) return state;
      try { await this.storage.commit(this.key, state.version, changes); return this.state(); }
      catch (error) { if (error.code !== 'notebook_cache_conflict') throw error; }
    }
    throw fault('notebook_cache_conflict', 'The local cache is busy; no gesture was discarded.');
  }
  exclusive(work) {
    const result = this.serial.then(work, work); this.serial = result.catch(() => {}); return result;
  }
  async initialize(snapshot) {
    if (snapshot.resourceId !== this.scope.resourceId || snapshot.protocolVersion !== NOTEBOOK_VERSION) throw fault('notebook_response_scope', 'This response belongs to another resource or protocol.');
    await this.adopt(snapshot); return this.notify();
  }
  async createOffline({ path, title }) {
    notebookPath(path); notebookId(this.scope.resourceId);
    await this.change(state => {
      if (state.snapshot) throw fault('notebook_cache_conflict', 'This local notebook already exists.');
      return { metadata: { pendingCreate: { id: this.scope.resourceId, path, title }, offline: true }, snapshot: { protocolVersion: NOTEBOOK_VERSION, resourceId: this.scope.resourceId, locator: { path, revision: null }, revision: 0, sequence: 0, document: emptyNotebook(this.scope.resourceId, title), tombstones: {}, accepted: false } };
    });
    return this.notify();
  }
  async adopt(snapshot) {
    if (!snapshot || snapshot.protocolVersion !== NOTEBOOK_VERSION || snapshot.resourceId !== this.scope.resourceId || !Number.isSafeInteger(snapshot.sequence) || !snapshot.document || !snapshot.locator) throw fault('notebook_response_scope', 'A complete response for the exact resource is required.');
    await this.change(state => {
      if (state.snapshot && snapshot.sequence < state.snapshot.sequence) return null;
      // Equal sequence but different path/revision is inconsistent, not a new source of authority.
      if (state.snapshot && !state.metadata.pendingCreate && snapshot.sequence === state.snapshot.sequence && snapshot.locator.revision !== state.snapshot.locator.revision) throw fault('notebook_response_conflict', 'An inconsistent location response was ignored.');
      const settled = state.operations.filter(op => op.receipt && snapshot.sequence >= op.receipt.sequence).map(op => op.operationId);
      return { snapshot, deleteOperations: settled, metadata: { ...state.metadata, offline: false, confirmedAt: Date.now(), acknowledgements: [...(state.metadata.acknowledgements || []), ...state.operations.filter(op => settled.includes(op.operationId)).map(op => ({ operationId: op.operationId, receipt: op.receipt }))].slice(-200) } };
    });
  }
  async enqueue(edits) {
    return this.exclusive(async () => {
      const operationId = notebookId(this.newId());
      await this.change(state => {
        const view = visible(state, this.actor);
        if (!view) throw fault('notebook_cache_missing', 'Load this notebook before drawing.');
        let conflict;
        try { applyNotebookEdits(view.document, view.tombstones || {}, edits, this.actor); }
        catch (error) { if (Number(error.status || error.statusCode) !== 409) throw error; conflict = { code: error.code, message: error.message, details: error.details }; }
        const operation = { operationId, order: state.version + 1, state: conflict ? 'conflict' : 'queued', request: { protocolVersion: NOTEBOOK_VERSION, resourceId: this.scope.resourceId, operationId, locationRevision: state.snapshot.locator.revision, edits: copy(edits) }, path: state.snapshot.locator.path, createdAt: Date.now(), ...(conflict ? { error: conflict } : {}) };
        return { putOperations: [operation] };
      });
      await this.notify(); return operationId;
    });
  }
  async mark(operationId, fields) {
    await this.change(state => {
      const op = state.operations.find(item => item.operationId === operationId);
      return op ? { putOperations: [{ ...op, ...fields }] } : null;
    });
  }
  async refresh() {
    try { await this.adopt(await this.transport.scene(this.scope.resourceId)); }
    catch (error) { await this.change(state => ({ metadata: { ...state.metadata, offline: true, lastError: { code: error.code || 'network', message: error.message } } })); throw error; }
    return this.notify();
  }
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.performFlush().finally(() => { this.flushing = null; }); return this.flushing;
  }
  async performFlush() {
    try {
      let state = await this.state();
      if (state.metadata.pendingCreate) {
        const created = await this.transport.open({ ...state.metadata.pendingCreate, protocolVersion: NOTEBOOK_VERSION });
        if (created.resourceId !== this.scope.resourceId || created.locator.path !== state.metadata.pendingCreate.path) throw fault('notebook_creation_conflict', 'The destination is occupied. Export or choose another path explicitly; local ink is retained.');
        await this.change(current => ({ snapshot: created, metadata: { ...current.metadata, pendingCreate: null, offline: false }, putOperations: current.operations.map(op => ({ ...op, request: { ...op.request, locationRevision: created.locator.revision } })) }));
      }
      // Bound one flush so long queues cannot monopolize navigation.
      for (let count = 0; count < 64 && !this.closed; count++) {
        state = await this.state();
        const op = [...state.operations].sort((a, b) => a.order - b.order).find(item => item.state !== 'conflict');
        if (!op) break;
        try {
          let receipt = op.receipt;
          if (!receipt && ['sending', 'uncertain'].includes(op.state)) {
            const observed = await this.transport.receipt(this.scope.resourceId, op.operationId);
            if (observed.status !== 'unknown') receipt = observed;
          }
          if (!receipt) {
            await this.mark(op.operationId, { state: 'sending' });
            receipt = await this.transport.mutate(copy(op.request));
          }
          if (receipt?.status !== 'confirmed' || receipt.operationId !== op.operationId || receipt.resourceId !== this.scope.resourceId || !Number.isSafeInteger(receipt.sequence)) throw fault('notebook_receipt_invalid', 'No valid canonical receipt was received. Local work is retained.');
          await this.mark(op.operationId, { state: 'acknowledged', receipt });
          const snapshot = await this.transport.scene(this.scope.resourceId);
          if (snapshot.sequence < receipt.sequence) throw fault('notebook_receipt_stale', 'The scene response predates the confirmed operation.');
          await this.adopt(snapshot);
        } catch (error) {
          const conflict = Number(error.status || error.statusCode) === 409 || /object_conflict|location_conflict|external_conflict|scope|authority|revoked|expired/.test(error.code || '');
          await this.mark(op.operationId, { state: conflict ? 'conflict' : op.receipt ? 'acknowledged' : 'uncertain', error: { code: error.code || 'network', message: error.message, details: error.details } });
          if (conflict) continue;
          throw error;
        }
      }
      await this.refresh();
    } catch (error) {
      await this.change(state => ({ metadata: { ...state.metadata, offline: true, lastError: { code: error.code || 'network', message: error.message } } }));
      await this.notify(); throw error;
    }
    return this.notify();
  }
  /** Explicit reconciliation only. Original requests remain exportable in the recovery log. */
  async resolveConflict(operationId, { discard = false, edits } = {}) {
    return this.exclusive(async () => {
      await this.change(state => {
        const old = state.operations.find(op => op.operationId === operationId);
        if (!old || old.state !== 'conflict') throw fault('notebook_reconciliation', 'Select a conflicted operation first.');
        if (!discard && !Array.isArray(edits)) throw fault('notebook_reconciliation', 'Choose a targeted replacement or explicitly discard the local change.');
        const recovery = [...(state.metadata.recovery || []), old];
        const putOperations = [];
        if (!discard) {
          const current = visible({ ...state, operations: state.operations.filter(op => op.operationId !== operationId) }, this.actor);
          applyNotebookEdits(current.document, current.tombstones || {}, edits, this.actor);
          const id = notebookId(this.newId());
          putOperations.push({ operationId: id, order: state.version + 1, state: 'queued', path: state.snapshot.locator.path, createdAt: Date.now(), request: { protocolVersion: NOTEBOOK_VERSION, resourceId: this.scope.resourceId, operationId: id, locationRevision: state.snapshot.locator.revision, edits: copy(edits) } });
        }
        return { metadata: { ...state.metadata, recovery }, deleteOperations: [operationId], putOperations };
      });
      return this.notify();
    });
  }
  async saveView(view) {
    const clean = { x: Number(view.x), y: Number(view.y), scale: Number(view.scale) };
    if (!Object.values(clean).every(Number.isFinite) || clean.scale < .05 || clean.scale > 20) throw fault('notebook_view', 'Invalid canvas view.');
    await this.change(state => ({ metadata: { ...state.metadata, view: clean } }));
  }
  async exportRecovery() { return { schemaVersion: 1, scope: { ...this.scope }, actor: this.actor, ...await this.state() }; }
  close() { this.closed = true; } // Closing or signing out never deletes the outbox.
}

export function notebookHttpTransport(request, actor) {
  const post = (action, body) => request(`/api/notebooks/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-context-room-notebook-client': actor.id }, body: JSON.stringify(body) });
  return { open: body => post('open', body), mutate: body => post('mutate', body),
    receipt: (resourceId, operationId) => request(`/api/notebooks/receipt?${new URLSearchParams({ resourceId, operationId })}`),
    scene: resourceId => request(`/api/notebooks/scene?${new URLSearchParams({ resourceId })}`), post };
}
