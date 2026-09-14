import { NotebookClient, IndexedNotebookStorage, notebookBrowserIdentity, notebookHttpTransport } from '../notebook_client.mjs';
import { normalizeNotebookDocument, notebookPath, NOTEBOOK_VERSION } from '../notebook_protocol.mjs';
import { notebookSvg, notebookBounds } from '../notebook_render.mjs';
import { notebookSceneBounds } from '../notebook_geometry.mjs';
import { NotebookCanvas } from './notebook-canvas.mjs';

export function notebookElement(tag, text = '', className = '') { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
export function notebookStyles() { if (document.getElementById('context-room-notebook-style')) return; const link = document.createElement('link'); link.id = 'context-room-notebook-style'; link.rel = 'stylesheet'; link.href = '/assets/ui/notebook.css'; document.head.append(link); }
export function notebookDownload(bytes, filename, type = 'application/json') { const url = URL.createObjectURL(new Blob([bytes], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
export function notebookBase64(bytes) { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(text); }
const button = (label, callback, className = '') => { const node = notebookElement('button', label, className); node.type = 'button'; if (callback) node.addEventListener('click', callback); return node; };
async function metadata(storage, key, update) { for (let n = 0; n < 8; n++) { const state = await storage.read(key); try { await storage.commit(key, state.version, { metadata: update(state.metadata) }); return; } catch (error) { if (error.code !== 'notebook_cache_conflict') throw error; } } throw new Error('The local notebook cache is busy.'); }

/** api and scopeKey must be captured from the exact project/location BEFORE navigation can change. */
export async function openNotebookEditor({ api, path, resourceId, title, scopeKey, fixedSnapshot = null, reviewKey = '', onCorrection, onSubmitted = () => {}, onClosed = () => {}, onInteraction = () => {}, onConversation, initialImage } = {}) {
  notebookStyles(); if (path) notebookPath(path);
  const storage = new IndexedNotebookStorage(), browserId = await notebookBrowserIdentity(storage);
  const request = (url, options = {}) => api(url, { ...options, headers: { ...options.headers, 'x-context-room-notebook-client': browserId } });
  const capKey = '@notebook-capabilities:' + String(scopeKey || location.origin);
  let capabilities, offlineError = null;
  try {
    capabilities = await request('/api/notebooks/capabilities');
    if (capabilities.protocolVersion !== NOTEBOOK_VERSION || !capabilities.serverId) throw new Error('This server does not support the current notebook protocol.');
    await metadata(storage, capKey, () => ({ capabilities }));
  } catch (error) {
    capabilities = (await storage.read(capKey)).metadata.capabilities; offlineError = error;
    if (!capabilities) { await storage.close(); throw new Error('Load this exact location once while connected before using its notebook cache. ' + error.message); }
  }
  const actor = capabilities.actor || { kind: 'human', id: browserId }, transport = notebookHttpTransport(request, actor);
  const accountId = reviewKey ? 'review:' + reviewKey : capabilities.accountId || 'local-owner';
  const matches = (await storage.list()).filter(entry => { try { const [server, account, device] = JSON.parse(entry.key); return server === capabilities.serverId && account === accountId && device === browserId; } catch { return false; } });
  const cached = matches.find(entry => resourceId ? entry.snapshot.resourceId === resourceId : entry.snapshot.locator.path === path);
  let snapshot = fixedSnapshot, createOffline = false;
  if (fixedSnapshot) {
    const document = normalizeNotebookDocument(fixedSnapshot);
    snapshot = { protocolVersion: NOTEBOOK_VERSION, resourceId: document.id, document, locator: { path, revision: reviewKey }, sequence: 0, revision: document.revision, tombstones: {}, accepted: false };
  } else if (!offlineError) {
    try { snapshot = resourceId ? await transport.scene(resourceId) : await transport.open({ protocolVersion: NOTEBOOK_VERSION, id: cached?.snapshot.resourceId || crypto.randomUUID(), path, title: title || path.split('/').pop().replace(/\.crnb$/i, '') }); }
    catch (error) { offlineError = error; }
  }
  if (!snapshot && cached) snapshot = cached.snapshot;
  if (!snapshot) {
    if (!path || offlineError?.status && offlineError.status < 500) { await storage.close(); throw offlineError || new Error('This notebook has not been cached.'); }
    resourceId ||= crypto.randomUUID(); createOffline = true;
  } else { resourceId = snapshot.resourceId; path = snapshot.locator.path; }
  const scope = { serverId: capabilities.serverId, accountId, deviceId: browserId, resourceId };
  const dialog = notebookElement('dialog', '', 'notebook-dialog'); dialog.setAttribute('aria-label', reviewKey ? 'Correct notebook: ' + path : 'Notebook: ' + path);
  const header = notebookElement('header'), heading = notebookElement('div', '', 'notebook-heading'), name = notebookElement('h2', snapshot?.document.title || title || 'Notebook');
  const pathLabel = notebookElement('p', path, 'notebook-path'); heading.append(name, pathLabel); header.append(heading);
  const closeButton = button('Close notebook', () => close()); header.append(closeButton);
  const notice = notebookElement('p', reviewKey ? 'Correction of this frozen review only. Later working gestures are not included. Use the correction, then decide this file in the review.' : 'Working scene — not accepted documentation. Autosave and drawing never accept agent changes.', 'notebook-notice');
  const tools = notebookElement('div', '', 'notebook-toolbar'); tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', 'Notebook tools');
  const actions = notebookElement('div', '', 'notebook-toolbar'); actions.setAttribute('aria-label', 'Notebook actions');
  const workspace = notebookElement('div', '', 'notebook-workspace'), stage = notebookElement('div', '', 'notebook-stage');
  const canvas = notebookElement('canvas', '', 'notebook-canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Notebook drawing canvas. Pen draws; a finger pans. Object list provides keyboard access.'); canvas.setAttribute('role', 'img');
  stage.append(canvas); const inspector = notebookElement('aside', '', 'notebook-inspector'); inspector.setAttribute('aria-label', 'Notebook objects and selection'); inspector.hidden = matchMedia('(max-width: 650px)').matches;
  workspace.append(stage, inspector);
  const statusRow = notebookElement('footer', '', 'notebook-state'), status = notebookElement('p'), zoomLabel = notebookElement('p', '100%'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); statusRow.append(status, zoomLabel);
  const errorBox = notebookElement('p', '', 'notebook-error'); errorBox.setAttribute('role', 'alert'); const conflicts = notebookElement('div', '', 'notebook-conflicts');
  dialog.append(header, notice, tools, actions, workspace, conflicts, errorBox, statusRow); document.body.append(dialog); dialog.showModal();
  let view, client, surface, closed = false, syncing = false, saving = 0, timer, objectsTimer, textForm = null, lastConflictKey = '', authBlocked = false;
  const failedLocalWork = [], cleanup = new AbortController();
  const navigationRequests = new Map();
  const fail = error => { if (!closed) errorBox.textContent = error.message || String(error); };
  const run = work => Promise.resolve(work).catch(fail);
  const enqueue = async (edits, options) => {
    const retained = { edits: structuredClone(edits), options: structuredClone(options || {}) };
    try { const receipt = await client.enqueue(edits, options); void sync(); return receipt; }
    catch (error) { failedLocalWork.push({ ...retained, error: error.message }); throw error; }
  };
  client = new NotebookClient({ storage, transport, scope, actor, onChange: render });
  surface = new NotebookCanvas(canvas, { enqueue, onSelection: () => scheduleObjects(), onText: at => run(editText(at)), onInteraction: () => onInteraction({ resourceId, path }),
    onView: viewport => { zoomLabel.textContent = Math.round(viewport.scale * 100) + '%'; run(client.saveView(viewport)); }, onError: fail,
    onSaving: count => { saving = count; renderStatus(); } });
  const toolButtons = new Map();
  for (const [key, label] of [['ink', 'Pen'], ['eraser', 'Eraser'], ['select', 'Select / lasso'], ['pan', 'Pan'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow'], ['connector', 'Connect'], ['text', 'Text']]) {
    const node = button(label, () => { if (!surface.setTool(key)) return; for (const [id, item] of toolButtons) item.setAttribute('aria-pressed', String(key === id)); }); node.setAttribute('aria-pressed', String(key === 'ink')); tools.append(node); toolButtons.set(key, node);
  }
  const colorLabel = notebookElement('label', 'Ink'), color = document.createElement('input'); color.type = 'color'; color.value = '#000000'; color.setAttribute('aria-label', 'Notebook ink color'); color.addEventListener('input', () => surface.brush.color = color.value); colorLabel.append(color);
  const widthLabel = notebookElement('label', 'Width'), width = document.createElement('input'); width.type = 'range'; width.min = '1'; width.max = '24'; width.value = '3'; width.setAttribute('aria-label', 'Notebook ink width'); width.addEventListener('input', () => surface.brush.width = Number(width.value)); widthLabel.append(width); tools.append(colorLabel, widthLabel);
  async function replayGesture(direction) { await surface.settle(); await client.replayGesture(direction); await sync(); }
  const undo = button('Undo gesture', () => run(replayGesture('undo'))), redo = button('Redo gesture', () => run(replayGesture('redo')));
  actions.append(undo, redo, button('Fit drawing', () => { onInteraction({ resourceId, path }); surface.fit(); }), button('Zoom in', () => surface.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2)), button('Zoom out', () => surface.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2)));
  const objectsButton = button('Objects', () => { inspector.hidden = !inspector.hidden; objectsButton.setAttribute('aria-expanded', String(!inspector.hidden)); }); objectsButton.setAttribute('aria-expanded', String(!inspector.hidden)); actions.append(objectsButton);
  const imageInput = document.createElement('input'); imageInput.type = 'file'; imageInput.accept = 'image/png,image/jpeg,image/webp'; imageInput.hidden = true;
  imageInput.addEventListener('change', () => { const file = imageInput.files[0]; if (file) run(addImage(file)); imageInput.value = ''; }); dialog.append(imageInput); actions.append(button('Image', () => imageInput.click()));
  const exportFormat = document.createElement('select'); exportFormat.setAttribute('aria-label', 'Notebook export format'); for (const [value, label] of [['crnb', 'Editable notebook'], ['svg', 'SVG drawing'], ['png', 'PNG preview']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; exportFormat.append(option); }
  actions.append(exportFormat, button('Export', () => run(exportDrawing(exportFormat.value))), button('Recover local work', () => run(exportRecovery())));
  if (!reviewKey) actions.append(button('Connect tablet', () => run(connectTablet())));
  const eink = button('E-ink contrast', () => { dialog.classList.toggle('notebook-eink'); eink.setAttribute('aria-pressed', String(dialog.classList.contains('notebook-eink'))); run(client.change(state => ({ metadata: { ...state.metadata, eink: dialog.classList.contains('notebook-eink') } }))); }); eink.setAttribute('aria-pressed', 'false'); actions.append(eink);
  const fingerLabel = notebookElement('label', 'Finger draws'), finger = document.createElement('input'); finger.type = 'checkbox'; finger.addEventListener('change', () => surface.fingerInk = finger.checked); fingerLabel.prepend(finger); actions.append(fingerLabel);
  const submitScope = document.createElement('select'); submitScope.setAttribute('aria-label', 'Notebook proposal destination');
  for (const [value, label] of [['local', 'Local proposal'], ['shared', 'Shared proposal']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.disabled = value === 'shared' && !capabilities.sharedSubmission; submitScope.append(option); }
  const destinationNote = notebookElement('p', '', 'notebook-notice'); destinationNote.hidden = true; notice.after(destinationNote);
  let sharedDestination = null;
  async function inspectSharedDestination() {
    sharedDestination = null; destinationNote.hidden = submitScope.value !== 'shared';
    if (destinationNote.hidden) return;
    destinationNote.textContent = 'Loading the connected Shared destination…';
    const response = await request('/api/notebooks/shared-target?resourceId=' + encodeURIComponent(resourceId));
    if (response.resourceId !== resourceId || !response.target?.repositoryIdentity || !response.target?.repositoryPath) throw new Error('The exact Shared destination is unavailable. Your notebook remains local.');
    sharedDestination = response.target;
    destinationNote.textContent = 'Shared: ' + sharedDestination.repositoryName + ' › ' + sharedDestination.projectTitle + ' › ' + sharedDestination.documentPath + '. This publishes a proposal for human review.';
  }
  submitScope.addEventListener('change', () => run(inspectSharedDestination()));
  const submit = button(reviewKey ? 'Use this correction' : 'Submit for review', () => run(submitScene()), 'notebook-primary'); if (!reviewKey) header.append(submitScope); header.insertBefore(submit, closeButton);
  const retry = button('Reconnect', () => run(sync(true))); if (!reviewKey) statusRow.append(retry);
  if (onConversation) actions.append(button('Ask about selection', () => onConversation({ resourceId, path, revision: view?.revision, locationRevision: view?.locator.revision, selection: [...surface.selection], working: true })));
  const objectTitle = notebookElement('h3', 'Objects'), filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = 'Filter objects'; filter.setAttribute('aria-label', 'Filter notebook objects');
  const selectionText = notebookElement('p', 'Nothing selected'), selectionActions = notebookElement('div', '', 'notebook-selection-actions');
  selectionActions.append(button('Delete selected', () => surface.deleteSelection()), button('Lock selected', () => surface.patchSelection({ locked: true })), button('Unlock selected', () => surface.patchSelection({ locked: false })));
  const properties = notebookElement('details'), propertySummary = notebookElement('summary', 'Shape / text properties'); properties.append(propertySummary);
  const propertyInputs = {};
  for (const [key, label] of [['width', 'Width'], ['height', 'Height'], ['rotation', 'Rotation'], ['fontSize', 'Text size']]) { const row = notebookElement('label', label), input = document.createElement('input'); input.type = 'number'; input.step = '1'; input.setAttribute('aria-label', 'Selected object ' + label.toLowerCase()); propertyInputs[key] = input; row.append(input); properties.append(row); }
  properties.append(button('Apply properties', () => { const patch = Object.fromEntries(Object.entries(propertyInputs).filter(([, input]) => input.value !== '').map(([key, input]) => [key, Number(input.value)])); if (Object.keys(patch).length) surface.patchSelection(patch); }));
  const objectList = notebookElement('ul', '', 'notebook-objects'), objectCount = notebookElement('p'), more = button('Show more objects', () => { objectLimit += 100; renderObjects(); }); let objectLimit = 100;
  filter.addEventListener('input', () => { objectLimit = 100; renderObjects(); }); inspector.append(objectTitle, selectionText, selectionActions, properties, filter, objectCount, objectList, more);

  async function connectTablet() {
    const devices = await request('/api/devices');
    if (!devices.enabled) throw new Error('Tablet connection is disabled. Enable the device listener when starting Context Room on the Mac.');
    const sheet = notebookElement('dialog', '', 'notebook-pair-dialog'); sheet.setAttribute('aria-label', 'Connect tablet');
    const heading = notebookElement('h2', 'Connect a tablet to this notebook');
    const scope = notebookElement('p', path + ' · Drawing permission. File review stays on the Mac.');
    const label = notebookElement('label', 'Device name'), input = document.createElement('input'); input.value = 'Tablet'; input.maxLength = 100; label.append(input);
    const result = notebookElement('div'), message = notebookElement('p'); message.setAttribute('role', 'status');
    let ticket = null, dismissed = false;
    const navigationTimers = new Set();
    const create = button('Create pairing code', async () => {
      create.disabled = true; message.textContent = '';
      try {
        if (ticket) await request('/api/devices/cancel-pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId: ticket.pairingId }) });
        ticket = await request('/api/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [path], label: input.value }) });
        if (dismissed) { await request('/api/devices/cancel-pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId: ticket.pairingId }) }); return; }
        const code = document.createElement('textarea'); code.readOnly = true; code.setAttribute('aria-label', 'One-use tablet pairing code'); code.value = JSON.stringify(ticket);
        result.replaceChildren(notebookElement('p', 'Paste this code in Context Room on the tablet within two minutes. It verifies this Mac and grants access to this notebook.'), code,
          button('Copy pairing code', () => navigator.clipboard.writeText(code.value).then(() => { message.textContent = 'Pairing code copied.'; }).catch(() => { code.select(); message.textContent = 'Select and copy the code.'; })));
      } catch (error) { message.textContent = error.message; }
      finally { create.disabled = false; }
    });
    const paired = notebookElement('div');
    for (const device of devices.devices.filter(item => !item.revokedAt && item.grants.some(grant => grant.paths.includes(path)))) {
      const row = notebookElement('div'), label = notebookElement('p', device.label), detail = notebookElement('p', 'Checking tablet…');
      detail.setAttribute('role', 'status'); detail.setAttribute('aria-label', device.label + ' display status');
      let revoked = false, sending = false, inspecting = false, navigationTimer = null;
      const terminal = new Set(['applied', 'cancelled', 'superseded', 'expired', 'unavailable']);
      const display = state => {
        const command = state.command?.target.resourceId === resourceId ? state.command : null;
        if (command && !terminal.has(command.status)) navigationRequests.set(device.id, command.operationId);
        else if (command) navigationRequests.delete(device.id);
        const messages = { requested: 'Opening requested · waiting for the tablet.', deferred: 'Tablet is drawing or editing · opening deferred.',
          applied: 'Displayed on ' + device.label + '.', cancelled: 'Opening cancelled on the tablet.', superseded: 'Replaced by a newer opening request.',
          expired: 'Opening expired. Request it again when the tablet is ready.', unavailable: 'The requested notebook is no longer available.' };
        detail.textContent = command ? messages[command.status] || 'Waiting for the tablet.' : state.online ? 'Tablet connected.' : 'Open Context Room on the tablet to receive this notebook.';
        open.disabled = sending || Boolean(command && !terminal.has(command.status));
      };
      async function inspect() {
        if (dismissed || closed || revoked || inspecting) return;
        inspecting = true;
        if (navigationTimer) { clearTimeout(navigationTimer); navigationTimers.delete(navigationTimer); navigationTimer = null; }
        try {
          const operationId = navigationRequests.get(device.id);
          const state = await request('/api/devices/navigation?deviceId=' + encodeURIComponent(device.id) + (operationId ? '&operationId=' + encodeURIComponent(operationId) : ''));
          if (dismissed || closed || revoked) return;
          display(state);
          if (state.command && terminal.has(state.command.status) && state.command.target.resourceId === resourceId) return;
        } catch (error) { detail.textContent = error.message + ' The display is not confirmed.'; open.disabled = sending; }
        finally { inspecting = false; }
        if (!dismissed && !closed && !revoked) {
          navigationTimer = setTimeout(() => { navigationTimers.delete(navigationTimer); navigationTimer = null; void inspect(); }, 1200); navigationTimers.add(navigationTimer);
        }
      }
      const open = button('Open on ' + device.label, async () => {
        if (sending) return;
        sending = true; open.disabled = true;
        const operationId = navigationRequests.get(device.id) || crypto.randomUUID(); navigationRequests.set(device.id, operationId);
        try {
          const command = await request('/api/devices/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.id, operationId, resourceId }) });
          if (!dismissed && !revoked) display({ command, online: true });
        } catch (error) { detail.textContent = error.message + ' The display is not confirmed.'; open.disabled = false; }
        finally { sending = false; }
        void inspect();
      }); open.disabled = true;
      const revoke = button('Disconnect ' + device.label, async () => {
        revoke.disabled = true;
        try { await request('/api/devices/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: device.id }) }); revoked = true; navigationRequests.delete(device.id); row.textContent = device.label + ' disconnected.'; }
        catch (error) { message.textContent = error.message; revoke.disabled = false; }
      }); row.append(label, open, revoke, detail); paired.append(row); void inspect();
    }
    sheet.append(heading, scope, label, create, result, message, paired, button('Close connection', () => sheet.close()));
    sheet.addEventListener('close', () => {
      dismissed = true;
      for (const timer of navigationTimers) clearTimeout(timer);
      if (ticket) void request('/api/devices/cancel-pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId: ticket.pairingId }) }).catch(() => {});
      sheet.remove();
    }, { once: true });
    dialog.append(sheet); sheet.showModal();
  }

  function scheduleObjects() { clearTimeout(objectsTimer); objectsTimer = setTimeout(renderObjects, 100); }
  function renderObjects() {
    if (!view || closed) return; const query = filter.value.toLocaleLowerCase();
    const all = view.document.objects.filter(object => [object.id, object.type, object.text, object.createdBy.kind, object.updatedBy.kind].join(' ').toLocaleLowerCase().includes(query));
    objectList.replaceChildren();
    for (const object of all.slice(0, objectLimit)) {
      const label = (object.text?.slice(0, 60) || object.type) + ' · ' + object.createdBy.kind + (object.updatedBy.kind !== object.createdBy.kind ? ' → ' + object.updatedBy.kind : '') + (object.locked ? ' · locked' : '') + ' · r' + object.revision;
      const node = button(label, () => { surface.select([object.id]); if (object.type === 'text') run(editText({ x: object.x || 0, y: object.y || 0, object })); }); node.setAttribute('aria-current', String(surface.selection.has(object.id))); node.dataset.objectId = object.id;
      const row = notebookElement('li'); row.append(node); objectList.append(row);
    }
    objectCount.textContent = `Showing ${Math.min(objectLimit, all.length)} of ${all.length} objects`; more.hidden = objectLimit >= all.length;
    selectionText.textContent = surface.selection.size ? `${surface.selection.size} selected. Arrow keys move; Delete removes only these objects.` : 'Nothing selected. Use Select / lasso or the object list.';
    for (const node of selectionActions.querySelectorAll('button')) node.disabled = !surface.selection.size;
  }
  function renderStatus() {
    if (!view || closed) return;
    const origin = reviewKey ? 'Review correction saved on this device' : authBlocked ? 'Access unavailable; local work remains recoverable' : view.status === 'conflict' ? 'Conflict — local operations retained' : view.pending ? `Saved locally · ${view.pending} operation(s) awaiting the Mac` : view.offline ? 'Cached locally · Mac unavailable' : 'Confirmed by the Mac';
    status.textContent = saving ? 'Saving this gesture to the device…' : origin + ` · scene r${view.revision} · ${view.document.objects.length} objects`;
    submit.disabled = Boolean(saving || failedLocalWork.length || view.conflicts?.length || !reviewKey && (view.pending || view.offline || authBlocked));
    dialog.dataset.saveState = saving ? 'saving' : view.status; dialog.dataset.resourceId = resourceId; dialog.dataset.sceneRevision = String(view.revision);
  }
  async function render(next) {
    if (!next || closed) return; view = next; surface.setDocument(next.document); name.textContent = next.document.title;
    renderStatus(); scheduleObjects(); const state = await client.state();
    undo.disabled = !state.metadata.gestureHistory?.undo.length || Boolean(surface.gesture); redo.disabled = !state.metadata.gestureHistory?.redo.length || Boolean(surface.gesture);
    const key = (next.conflicts || []).map(op => op.operationId + ':' + op.error?.code).join('|');
    if (key !== lastConflictKey) {
      lastConflictKey = key; conflicts.replaceChildren();
      for (const op of next.conflicts || []) { const row = notebookElement('article'); row.append(notebookElement('span', 'Retained operation ' + op.operationId + ': ' + (op.error?.message || 'A newer change prevents this edit.')), button('Keep in recovery only', () => run(client.resolveConflict(op.operationId, { discard: true }).then(() => sync())))); conflicts.append(row); }
    }
  }
  async function sync(explicit = false) {
    if (reviewKey || closed || syncing || authBlocked && !explicit) return;
    syncing = true;
    try {
      if (explicit) { const cap = await request('/api/notebooks/capabilities'); if (cap.serverId !== scope.serverId) throw new Error('A different canonical location answered. The old cache is retained.'); authBlocked = false; }
      await client.flush(); if (explicit) errorBox.textContent = '';
    } catch (error) { if ([401, 403, 410].includes(error.status)) authBlocked = true; if (explicit || error.code && !['network'].includes(error.code)) fail(error); }
    finally { syncing = false; renderStatus(); }
  }
  async function editText({ x, y, object, text = object?.text || '' }) {
    if (textForm) { textForm.querySelector('textarea').focus(); return; }
    const form = textForm = notebookElement('form', '', 'notebook-text-form'), label = notebookElement('label', object ? 'Edit selected text' : 'Text draft'), input = document.createElement('textarea'); input.value = text; input.setAttribute('aria-label', 'Notebook text draft'); label.append(input); form.append(label);
    const target = { x, y, object: object ? structuredClone(object) : null };
    const persist = () => { const text = input.value; return client.exclusive(() => client.change(state => ({ metadata: { ...state.metadata, textDraft: { ...target, text } } }))); };
    input.addEventListener('input', () => run(persist()));
    const cancel = button('Cancel text', () => run(client.exclusive(() => client.change(state => ({ metadata: { ...state.metadata, textDraft: null } }))).then(() => { form.remove(); textForm = null; canvas.focus(); })));
    const add = button(object ? 'Update text' : 'Add text', null, 'notebook-primary'); add.type = 'submit'; form.append(add, cancel); stage.append(form); input.focus(); await persist();
    form.addEventListener('submit', event => { event.preventDefault(); run((async () => {
      if (!input.value.trim()) return; const id = object?.id || crypto.randomUUID();
      add.disabled = true; cancel.disabled = true; input.readOnly = true;
      try { await enqueue([object ? { kind: 'patch', id, expectedRevision: object.revision, patch: { text: input.value } } : { kind: 'put', id, expectedRevision: 0, object: { id, type: 'text', x, y, text: input.value, color: surface.brush.color, fontSize: 20 } }], { gestureId: crypto.randomUUID() });
      await client.exclusive(() => client.change(state => ({ metadata: { ...state.metadata, textDraft: null } }))); form.remove(); textForm = null; surface.select([id]); canvas.focus();
      } finally { add.disabled = false; cancel.disabled = false; input.readOnly = false; }
    })()); });
  }
  async function addImage(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or WebP image no larger than 12 MiB. The original is unchanged.');
    const bitmap = await createImageBitmap(file); const size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); if (size.width * size.height > 16_000_000) throw new Error('This image exceeds the 16 million pixel rendering limit.');
    const bytes = new Uint8Array(await file.arrayBuffer()), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), assetId = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
    const asset = { mimeType: file.type, data: notebookBase64(bytes), assetId };
    try { await client.enqueueAsset(asset); } catch (error) { failedLocalWork.push({ asset, error: error.message }); throw error; }
    const id = crypto.randomUUID(), scale = Math.min(1, 800 / size.width, 600 / size.height);
    await enqueue([{ kind: 'put', id, expectedRevision: 0, object: { id, type: 'image', asset: assetId, x: (40 - surface.view.x) / surface.view.scale, y: (40 - surface.view.y) / surface.view.scale, width: size.width * scale, height: size.height * scale } }], { gestureId: crypto.randomUUID() }); surface.select([id]);
  }
  async function exportRecovery() {
    await surface.settle().catch(() => {}); const recovery = await client.exportRecovery();
    notebookDownload(JSON.stringify({ ...recovery, failedLocalWork, failedStrokes: surface.failedStrokes, inProgress: surface.gesture?.stroke.recovery() || surface.failedStroke || null }, null, 2), 'context-room-notebook-recovery.json');
    status.textContent = 'Recovery export requested. Keep the file before closing unsaved work.';
  }
  async function exportDrawing(format) {
    await surface.settle(); const current = (await client.view()).document, base = path.split('/').pop().replace(/\.crnb$/i, '');
    if (format === 'crnb') return notebookDownload(JSON.stringify(normalizeNotebookDocument(current)) + '\n', base + '.crnb', 'application/vnd.context-room.notebook+json');
    const svg = notebookSvg(current);
    if (format === 'svg') return notebookDownload(svg, base + '.svg', 'image/svg+xml');
    const image = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try { image.src = url; await image.decode(); const b = notebookBounds(current), scale = Math.min(1, 16384 / b.width, 16384 / b.height, Math.sqrt(16_000_000 / (b.width * b.height))); const output = document.createElement('canvas'); output.width = Math.max(1, Math.ceil(b.width * scale)); output.height = Math.max(1, Math.ceil(b.height * scale)); output.getContext('2d').drawImage(image, 0, 0, output.width, output.height); const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png')); if (!blob) throw new Error('PNG export failed; editable source remains available.'); notebookDownload(await blob.arrayBuffer(), base + '.png', 'image/png'); }
    finally { URL.revokeObjectURL(url); }
  }
  async function submitScene() {
    await surface.settle(); if (textForm) throw new Error('Add or cancel the text draft before preparing the reviewed scene.');
    const current = await client.view(); if (current.conflicts.length || failedLocalWork.length) throw new Error('Resolve or export retained conflicts before submitting.');
    if (reviewKey) { await onCorrection?.(notebookBase64(new TextEncoder().encode(JSON.stringify(normalizeNotebookDocument(current.document)) + '\n'))); await close(); return; }
    if (current.pending || current.offline || authBlocked) throw new Error('Wait for a canonical receipt before submitting this exact scene.');
    // Persist the submission id BEFORE transmission. An uncertain response resumes this same intent.
    const state = await client.state(); let intent = state.metadata.submissionIntent;
    if (!intent) {
      if (submitScope.value === 'shared' && !sharedDestination) throw new Error('Wait for the exact Shared destination before submitting.');
      intent = { protocolVersion: NOTEBOOK_VERSION, resourceId, operationId: crypto.randomUUID(), expectedRevision: current.revision, locationRevision: current.locator.revision, scope: submitScope.value, title: current.document.title };
      if (intent.scope === 'shared') intent.target = structuredClone(sharedDestination);
      await client.change(value => ({ metadata: { ...value.metadata, submissionIntent: intent } }));
    } else if (intent.scope !== submitScope.value) {
      throw new Error('A previous submission is awaiting its receipt. Select its original ' + intent.scope + ' destination to resume it.');
    }
    const receipt = await transport.post('submit', intent);
    if (receipt.status !== 'submitted' || receipt.resourceId !== resourceId) throw new Error('No valid submission receipt was received. Its original request is retained.');
    await client.change(value => ({ metadata: { ...value.metadata, submissionIntent: null, lastSubmission: receipt } }));
    status.textContent = 'Frozen revision submitted to the existing review queue. No file has been accepted.'; await onSubmitted(receipt); await client.refresh();
  }
  async function close() {
    if (closed) return; await surface.settle().catch(fail);
    if ((failedLocalWork.length || surface.failedStroke) && !confirm('Some samples could not be saved. Export recovery before closing. Close without those unsaved samples?')) return;
    closed = true; clearInterval(timer); clearTimeout(objectsTimer); cleanup.abort(); client.close(); surface.dispose(); dialog.close(); dialog.remove(); await onClosed();
    // Keep the connection alive until in-flight durable operations settle; cache contents are never deleted.
    await client.serial; await Promise.resolve(client.flushing).catch(() => {}); await storage.close();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); run(close()); });
  dialog.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(event.target.tagName)) { event.preventDefault(); run(replayGesture(event.shiftKey ? 'redo' : 'undo')); } });
  window.addEventListener('beforeunload', event => { if (saving || failedLocalWork.length) { event.preventDefault(); event.returnValue = ''; } }, { signal: cleanup.signal });
  window.addEventListener('online', () => void sync(), { signal: cleanup.signal });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); }, { signal: cleanup.signal });
  try {
    if (createOffline) await client.createOffline({ path, title: title || path.split('/').pop().replace(/\.crnb$/i, '') });
    else if (!cached || !reviewKey) await client.initialize(snapshot);
    else await client.notify();
    if (offlineError && !reviewKey) { await client.change(state => ({ metadata: { ...state.metadata, offline: true } })); authBlocked = [401, 403, 410].includes(offlineError.status); fail(offlineError); await client.notify(); }
    const saved = await client.state(); if (saved.metadata.view) surface.view = saved.metadata.view;
    if (saved.metadata.eink) { dialog.classList.add('notebook-eink'); eink.setAttribute('aria-pressed', 'true'); }
    if (saved.metadata.textDraft) await editText(saved.metadata.textDraft);
    renderObjects(); surface.schedule(); canvas.focus();
    if (initialImage) await addImage(initialImage);
    timer = setInterval(() => { if (document.visibilityState === 'visible') void sync(); }, 900);
    void sync();
    return { dialog, client, surface, scope, path, resourceId, close, busy: () => Boolean(surface.gesture || textForm || saving), binding: () => ({ resourceId, path, revision: view.revision, locationRevision: view.locator.revision, selection: [...surface.selection], working: true }) };
  } catch (error) { fail(error); return { dialog, client, surface, close, error, busy: () => true }; }
}

/** A folder-scoped create/open chooser, not a separate notes library or project catalogue. */
export async function chooseNotebook({ api, directory = '', scopeKey, ...options }) {
  notebookStyles(); const dialog = notebookElement('dialog', '', 'notebook-chooser'); dialog.setAttribute('aria-label', 'Notebook in this folder');
  const heading = notebookElement('h2', 'Notebook in this folder'), explanation = notebookElement('p', 'Use an ordinary .crnb file. Working ink stays separate from accepted documentation.');
  const form = document.createElement('form'), label = notebookElement('label', 'Notebook path'), input = document.createElement('input'); input.value = (directory ? directory.replace(/\/$/, '') + '/' : '') + 'Sketch.crnb'; input.required = true; input.setAttribute('aria-label', 'Notebook path'); label.append(input);
  const open = button('Create or open notebook'); open.type = 'submit'; const cancel = button('Cancel', () => dialog.close()); form.append(label, open, cancel);
  const status = notebookElement('p'); status.setAttribute('role', 'status'); const drafts = notebookElement('ul'); drafts.setAttribute('aria-label', 'Working notebooks in this folder');
  dialog.append(heading, explanation, form, drafts, status); document.body.append(dialog); dialog.showModal(); input.focus();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', event => { event.preventDefault(); open.disabled = true; openNotebookEditor({ api, path: input.value.trim(), scopeKey, ...options }).then(() => dialog.close()).catch(error => { status.textContent = error.message; open.disabled = false; }); });
  try {
    const data = await api('/api/notebooks');
    for (const item of data.notebooks.filter(item => item.path.split('/').slice(0, -1).join('/') === directory.replace(/\/$/, ''))) { const row = notebookElement('li'); row.append(button(item.path + ' · working scene', () => { input.value = item.path; form.requestSubmit(); })); drafts.append(row); }
  } catch { status.textContent = 'The Mac is unavailable. Previously loaded notebook caches can still be opened by their exact path.'; }
}
