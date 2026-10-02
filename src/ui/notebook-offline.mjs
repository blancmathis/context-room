import { IndexedNotebookStorage } from '../notebook_client.mjs';

/** Only a captured ordinary project route may reconnect a saved working scene. */
export function offlineNotebookRoute(entry, origin = globalThis.location?.origin) {
  const route = entry?.metadata?.reopen;
  if (route?.version !== 1 || typeof route.scopeKey !== 'string') return null;
  let fields, scope;
  try { fields = JSON.parse(route.scopeKey); scope = JSON.parse(entry.key); } catch { return null; }
  if (!Array.isArray(fields) || fields.length !== 4 || fields[0] !== origin || fields[3] !== ''
    || !/^[a-f0-9]{24}$/.test(fields[1]) || fields[2] && !/^[a-f0-9]{24}$/.test(fields[2])
    || !Array.isArray(scope) || scope.length !== 4 || scope.some(v => typeof v !== 'string' || !v)
    || scope[1].startsWith('review:') || scope[3] !== entry.snapshot?.resourceId
    || !['owner', 'drawing'].includes(route.transport)
    || route.browserDeviceId && !/^[a-f0-9-]{36}$/.test(route.browserDeviceId)) return null;
  if (route.capabilities && (route.capabilities.protocolVersion !== 1 || route.capabilities.serverId !== scope[0] || (route.capabilities.accountId || 'local-owner') !== scope[1])) return null;
  return { ...route, projectId: fields[1], targetProjectId: fields[2], serverId: scope[0], accountId: scope[1], resourceId: scope[3] };
}
export async function cachedWorkingNotebooks() {
  const storage = new IndexedNotebookStorage();
  try { return (await storage.list()).filter(entry => offlineNotebookRoute(entry)); }
  finally { await storage.close(); }
}
export async function openCachedNotebook(entry) {
  const route = offlineNotebookRoute(entry);
  if (!route) throw new Error('This cache has no exact reconnectable project route. Keep its recovery data.');
  let nonce = '', validatedAt = 0;
  const headers = () => ({
    'x-context-room-project': route.projectId,
    ...(route.targetProjectId ? { 'x-context-room-target-project': route.targetProjectId } : {}),
    ...(route.transport === 'drawing' ? { 'x-context-room-device-project': route.projectId } : {}),
    ...(route.browserDeviceId ? { 'x-context-room-browser-device': route.browserDeviceId } : {}),
  });
  async function raw(path, options = {}) {
    const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'same-origin', headers: { ...headers(), ...options.headers } });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'The original Mac permission is unavailable.'), { status: response.status, code: result.code });
    return result;
  }
  async function validate() {
    const cap = await raw('/api/notebooks/capabilities');
    if (cap.serverId !== route.serverId || (cap.accountId || 'local-owner') !== route.accountId) {
      throw Object.assign(new Error('A different Mac or pairing answered. The original cache is retained, not sent to this connection.'), { status: 403, code: 'notebook_response_scope' });
    }
    validatedAt = Date.now(); return cap;
  }
  const api = async (path, options = {}) => {
    if (!path.startsWith('/api/')) throw new Error('The original notebook route is required.');
    if (path === '/api/notebooks/capabilities') { nonce = ''; return validate(); }
    if (Date.now() - validatedAt > 1000) await validate();
    if (!['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()) && route.transport === 'owner') {
      if (!nonce) {
        const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw Object.assign(new Error('Reconnect the original owner interface before synchronizing.'), { status: response.status });
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const device = page.querySelector('meta[name="context-room-browser-device"]')?.content || '';
        nonce = page.querySelector('meta[name="context-room-owner-nonce"]')?.content || '';
        if (!nonce || device !== (route.browserDeviceId || '')) { nonce = ''; throw Object.assign(new Error('The original owner pairing is unavailable. Local ink is retained.'), { status: 403 }); }
      }
      options = { ...options, headers: { ...options.headers, 'x-context-room-owner-nonce': nonce } };
    }
    return raw(path, options);
  };
  const { openNotebookEditor } = await import('./notebook-editor.mjs');
  return openNotebookEditor({ api, scopeKey: route.scopeKey, resourceId: route.resourceId, path: entry.snapshot.locator.path,
    title: entry.snapshot.document.title, browserDeviceId: route.browserDeviceId, offlineCapabilities: route.capabilities,
    onConversation: route.transport === 'owner' ? async (source, display) => {
      const { openConversation } = await import('./assistant.mjs');
      return openConversation({ api, scopeKey: route.scopeKey, source, ...display });
    } : undefined });
}
export async function appendCachedNotebooks(container, { opened = () => {} } = {}) {
  const entries = await cachedWorkingNotebooks();
  const list = document.createElement('ul'); list.setAttribute('aria-label', 'Notebooks saved on this device');
  for (const entry of entries) {
    const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button';
    const route = offlineNotebookRoute(entry);
    button.textContent = entry.snapshot.locator.path + ' · ' + (route.targetProjectId || route.projectId).slice(0, 8);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { const notebook = await openCachedNotebook(entry); opened(notebook); }
      catch (error) { button.after(Object.assign(document.createElement('p'), { textContent: error.message })); }
      finally { button.disabled = false; }
    });
    item.append(button); list.append(item);
  }
  container.append(list);
  if (!entries.length) container.append(Object.assign(document.createElement('p'), { textContent: 'No reconnectable working notebook is saved in this browser. Open one while connected first. Other and older recovery caches are not deleted.' }));
  return entries.length;
}
