import './web-app.mjs';
import { appendCachedNotebooks } from './notebook-offline.mjs';
import { openNotebookEditor } from './notebook-editor.mjs';
const mode = document.querySelector('meta[name="context-room-web-entry"]').content;
const status = document.getElementById('web-entry-status'), content = document.getElementById('web-entry-content'), actions = document.getElementById('web-entry-actions');
function button(label, action) { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', () => Promise.resolve().then(action).catch(error => { status.textContent = error.message; })); return node; }
async function json(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || 'The Mac is unavailable.'), { status: response.status, code: value.code });
  return value;
}
if (mode === 'offline') {
  status.textContent = 'Mac unavailable · open a locally saved working notebook. No document is accepted offline.';
  const link = document.createElement('a'); link.href = '/'; link.textContent = 'Reconnect to Context Room'; actions.append(link);
  await appendCachedNotebooks(content);
} else if (mode === 'pair') {
  status.textContent = 'Pair this browser from the Mac. Drawing permission and the complete owner interface are separate choices.';
  const form = document.createElement('form'), label = document.createElement('label'), input = document.createElement('textarea');
  label.textContent = 'One-use pairing code'; input.required = true; input.setAttribute('aria-label', 'One-use pairing code'); label.append(input);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Pair this browser'; form.append(label, submit); content.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try { await json('/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(JSON.parse(input.value)) }); input.value = ''; location.replace('/'); }
    catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
} else {
  try {
    const session = await json('/browser/session');
    status.textContent = 'Complementary drawing · only the notebooks explicitly granted on the Mac are available. Review remains on the owner interface.';
    const grants = session.device.grants.filter(g => g.mode === 'draw');
    const open = (grant, path, options = {}) => {
      const api = (url, input = {}) => json(url, { ...input, headers: { ...input.headers, 'x-context-room-device-project': grant.projectId } });
      return openNotebookEditor({ api, path, scopeKey: JSON.stringify([location.origin, grant.projectId, '', '']), ...options });
    };
    window.openSharedDrawingTarget = (target, beforePresent) => {
      const grant = grants.find(g => g.projectId === target.projectId && g.paths.includes(target.path));
      if (!grant) throw new Error('This target is outside the original drawing permission.');
      return open(grant, target.path, { resourceId: target.resourceId, beforePresent });
    };
    for (const grant of grants) for (const path of grant.paths) content.append(button(path, () => open(grant, path)));
    if (!globalThis.ContextRoomNativeOwner) actions.append(button('Disconnect this browser', async () => { await json('/browser/logout', { method: 'POST' }); location.replace('/'); }));
  } catch (error) { status.textContent = error.message; await appendCachedNotebooks(content); }
}
