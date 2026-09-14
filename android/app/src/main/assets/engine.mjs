import './compat.mjs';
import { IndexedNotebookStorage, NotebookClient, notebookHttpTransport } from './core/notebook_client.mjs';
import { notebookNativeObject, notebookNativeEdits } from './core/notebook_native.mjs';

const storage = new IndexedNotebookStorage();
const emit = (type, value = {}) => NativeEvents.emit(JSON.stringify({ type, ...value }));
const requests = new Map();
let publicSession, client, projectId, poll, generation = 0, serial = Promise.resolve();
const request = (path, options = {}, project = projectId) => new Promise((resolve, reject) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => { requests.delete(id); reject(Object.assign(new Error('Connexion interrompue. Le travail local est conservé.'), { code: 'device_timeout' })); }, 18000);
  requests.set(id, { resolve, reject, timer });
  NativeTransport.request(id, project || '', path, options.method || 'GET', options.body || '');
});
const sameScope = (record, project) => {
  try { const scope = JSON.parse(record.key); return scope[0] === publicSession.serverId && scope[1] === `device:${publicSession.device.id}:project:${project}` && scope[2] === publicSession.device.id; }
  catch { return false; }
};
const reportError = error => emit('error', { code: error.code || 'notebook_native', message: error.message });

async function catalogue(session) {
  const run = ++generation;
  clearTimeout(poll); client?.close(); client = null;
  publicSession = session;
  const cached = await storage.list(), notebooks = [];
  let offline = false;
  for (const grant of session.device.grants) {
    let items = [];
    try { items = (await request('/api/notebooks', {}, grant.projectId)).notebooks; }
    catch { offline = true; }
    const byPath = new Map(items.map(item => [item.path, { ...item, projectId: grant.projectId }]));
    for (const record of cached.filter(item => sameScope(item, grant.projectId))) {
      const scene = record.snapshot;
      if (grant.paths.includes(scene.locator.path) && !byPath.has(scene.locator.path)) byPath.set(scene.locator.path, {
        id: scene.resourceId, resourceId: scene.resourceId, path: scene.locator.path, title: scene.document.title, projectId: grant.projectId, cached: true });
    }
    for (const path of grant.paths) if (!byPath.has(path)) byPath.set(path, { path, projectId: grant.projectId, unavailable: offline });
    notebooks.push(...byPath.values());
  }
  if (run === generation) emit('catalogue', { notebooks, offline });
}

async function open(item) {
  const run = ++generation;
  clearTimeout(poll); client?.close(); client = null;
  projectId = item.projectId;
  const grant = publicSession.device.grants.find(g => g.projectId === projectId && g.paths.includes(item.path));
  if (!grant) throw new Error('Ce carnet ne fait pas partie de cette connexion.');
  const selectedProject = projectId, actor = { kind: 'human', id: `device-${publicSession.device.id}` };
  const cached = (await storage.list()).find(record => sameScope(record, selectedProject) && record.snapshot.locator.path === item.path);
  let capabilities;
  try { capabilities = await request('/api/notebooks/capabilities', {}, selectedProject); }
  catch (error) { if (!cached) throw error; capabilities = cached.metadata.capabilities; }
  if (capabilities && (capabilities.serverId !== publicSession.serverId || capabilities.deviceId !== publicSession.device.id || capabilities.projectId !== selectedProject)) throw new Error('Le protocole appartient à une autre connexion.');
  const transport = notebookHttpTransport((path, options) => request(path, options, selectedProject), actor, { batch: capabilities?.operations?.includes('batch') });
  let scene, offline = false;
  try { scene = await transport.open({ protocolVersion: 1, path: item.path, id: cached?.snapshot.resourceId || crypto.randomUUID() }); }
  catch (error) { if (!cached) throw error; scene = cached.snapshot; offline = true; }
  if (run !== generation) return;
  const scope = { serverId: publicSession.serverId, accountId: `device:${publicSession.device.id}:project:${selectedProject}`, deviceId: publicSession.device.id, resourceId: scene.resourceId };
  const selected = new NotebookClient({ storage, transport, scope, actor, onChange: async view => {
    if (run !== generation || !view) return;
    const state = await selected.state();
    emit('scene', { resourceId: scope.resourceId, version: view.cacheVersion, objects: view.document.objects.map(notebookNativeObject), assets: view.document.assets,
      path: view.locator.path, title: view.document.title, status: view.status, offline: view.offline, pending: view.pending,
      conflicts: view.conflicts.length, conflictDetails: view.conflicts.map(op => ({ operationId: op.operationId, error: op.error })),
      connectionError: state.metadata.lastError || null, undo: state.metadata.gestureHistory?.undo.length || 0, redo: state.metadata.gestureHistory?.redo.length || 0,
      savedView: state.metadata.view || null });
  } });
  client = selected;
  if (offline) { await selected.change(state => ({ metadata: { ...state.metadata, offline: true } })); await selected.notify(); }
  else await selected.initialize(scene);
  if (capabilities) await selected.change(state => ({ metadata: { ...state.metadata, capabilities } }));
  emit('opened', { scope, path: item.path });
  schedule(run, 0);
}

function schedule(run, delay = 1400) {
  clearTimeout(poll);
  poll = setTimeout(async () => {
    if (run !== generation || !client) return;
    let next = 1400;
    try { await client.flush(); } catch { next = Math.min(30000, Math.max(3000, delay * 2)); }
    if (run === generation) schedule(run, next);
  }, delay);
}

async function command(message) {
  const selected = client;
  if (!selected || ['serverId', 'accountId', 'deviceId', 'resourceId'].some(key => message.scope?.[key] !== selected.scope[key])) throw new Error('Le geste appartient à un autre carnet. Le journal local est conservé.');
  const nativeCommand = { channel: message.channel, sequence: message.sequence, id: message.id };
  if (message.action === 'edit') await selected.enqueue(notebookNativeEdits(message.operations), { gestureId: message.gestureId, nativeCommand });
  else if (['undo', 'redo'].includes(message.action)) await selected.replayGesture(message.action, { nativeCommand });
  else throw new Error('Commande native inconnue.');
  emit('command', { id: message.id, success: true });
  schedule(generation, 0);
}

window.ContextRoomNative = {
  response(id, status, body) {
    const pending = requests.get(id); if (!pending) return;
    clearTimeout(pending.timer); requests.delete(id);
    if (status >= 200 && status < 300) pending.resolve(body);
    else pending.reject(Object.assign(new Error(body.error || 'La connexion au Mac a échoué.'), { status, code: body.code }));
  },
  catalogue: session => catalogue(session).catch(reportError),
  open: item => open(item).catch(reportError),
  command(message) { serial = serial.then(() => command(message)).catch(error => { emit('command', { id: message.id, success: false, message: error.message }); reportError(error); }); },
  view: view => client?.saveView(view).catch(reportError),
  refresh: () => schedule(generation, 0),
  async exportRecovery() { if (client) emit('export', { data: await client.exportRecovery() }); },
  close() { ++generation; clearTimeout(poll); client?.close(); client = null; },
};
storage.ready.then(() => emit('ready')).catch(error => emit('engineStopped', { message: 'Le stockage durable est indisponible. Aucun geste n’est déclaré enregistré. ' + error.message }));
