import { IndexedNotebookStorage } from '../notebook_client.mjs';
import { notebookElement, notebookStyles, showNotebookDialog } from './notebook-editor.mjs';
import { safeFileBase } from './file-names.mjs';
import { foldForSearch } from './text-tools.mjs';

/** The Notebooks space keeps its notebooks under one folder; the folder name is not shown. */
export const NOTEBOOK_SPACE_FOLDER = 'Carnets/';
export const notebookSpaceDisplayPath = value => String(value || '').startsWith(NOTEBOOK_SPACE_FOLDER) ? String(value).slice(NOTEBOOK_SPACE_FOLDER.length) : String(value || '');

/** New notebook asks nothing: a fresh file name and a dated title. Online only in v1. */
export function newSpaceNotebook(date = new Date()) {
  const id = crypto.randomUUID(), pad = value => String(value).padStart(2, '0');
  const title = `Note · ${date.getDate()} ${date.toLocaleString('en-GB', { month: 'short' })}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return { id, path: NOTEBOOK_SPACE_FOLDER + id + '.crnb', title };
}

function fileNameFor(title) { return safeFileBase(title, 'Notebook') + '.crnb'; }

/** Local ink that the Mac has not confirmed must reach it before the notebook changes place. */
async function assertNotebookMovable(resourceId) {
  if ([...document.querySelectorAll('dialog.notebook-dialog')].some(dialog => dialog.open)) throw new Error('Close the notebook before moving it.');
  const storage = new IndexedNotebookStorage();
  try {
    for (const entry of await storage.list()) {
      if (entry.snapshot?.resourceId !== resourceId) continue;
      const saved = await storage.read(entry.key);
      if (saved.operations.length || saved.metadata.pendingCreate) throw new Error('This notebook has local changes waiting for the Mac. Open it, let it sync, then move it.');
    }
  } finally { await storage.close(); }
}

/** The resource id stays; the place (serverId) changes, so the local cache follows it. */
async function followMovedNotebookCache({ resourceId, fromServerId, toServerId, toScopeKey }) {
  const storage = new IndexedNotebookStorage();
  try {
    for (const entry of await storage.list()) {
      let scope; try { scope = JSON.parse(entry.key); } catch { continue; }
      if (!Array.isArray(scope) || scope[0] !== fromServerId || scope[3] !== resourceId) continue;
      const toKey = JSON.stringify([toServerId, scope[1], scope[2], resourceId]);
      // A cache already at the destination wins; the earlier one stays recoverable.
      await storage.rekey(entry.key, toKey, metadata => metadata.reopen ? { ...metadata, reopen: { ...metadata.reopen, scopeKey: toScopeKey, capabilities: undefined } } : metadata).catch(() => {});
    }
  } finally { await storage.close(); }
}

/**
 * One notebook at a time: choose the place, check the preview, then Move.
 * `move(body)` posts to /api/context-hub/notebooks/move; `scopeKeyFor(id)` names the destination cache scope.
 */
export async function openNotebookMoveDialog({ notebook, from, places, move, scopeKeyFor, onMoved = () => {}, onOpen = null }) {
  await assertNotebookMovable(notebook.id);
  notebookStyles();
  const toSpace = places.length === 1 && places[0].space;
  const dialog = notebookElement('dialog', '', 'notebook-chooser notebook-move'); dialog.setAttribute('aria-label', toSpace ? 'Move to Notebooks' : 'Move to project');
  const heading = notebookElement('h2', toSpace ? 'Move to Notebooks' : 'Move to project');
  const what = notebookElement('p', `${notebook.title || notebookSpaceDisplayPath(notebook.path)} · from ${from.title}`);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search projects'; search.setAttribute('aria-label', 'Search projects'); search.hidden = toSpace;
  const list = notebookElement('ul', '', 'notebook-move-places'); list.setAttribute('aria-label', 'Places');
  const label = notebookElement('label', 'File in the destination'), pathInput = document.createElement('input'); pathInput.required = true; pathInput.setAttribute('aria-label', 'File in the destination'); label.append(pathInput); label.hidden = toSpace;
  const summary = notebookElement('p', '', 'notebook-move-preview'); summary.setAttribute('role', 'status');
  const actions = notebookElement('div', '', 'notebook-move-actions');
  const previewButton = notebookElement('button', 'Preview'), moveButton = notebookElement('button', 'Move'), cancel = notebookElement('button', 'Cancel');
  for (const node of [previewButton, moveButton, cancel]) node.type = 'button';
  moveButton.disabled = true; actions.append(previewButton, moveButton, cancel);
  dialog.append(heading, what, search, list, label, summary, actions); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  cancel.addEventListener('click', () => dialog.close());
  let target = toSpace ? places[0] : null, preview = null;
  const invalidate = () => { preview = null; moveButton.disabled = true; summary.textContent = ''; };
  const defaultPath = place => place.space ? NOTEBOOK_SPACE_FOLDER + notebook.id + '.crnb' : 'docs/' + fileNameFor(notebook.title);
  const renderPlaces = () => {
    const query = foldForSearch(search.value.trim());
    list.replaceChildren(...places.filter(place => !query || foldForSearch(place.title).includes(query)).map(place => {
      const row = notebookElement('li'), choose = notebookElement('button', place.title, 'notebook-move-place'); choose.type = 'button';
      choose.setAttribute('aria-pressed', String(target?.id === place.id));
      choose.addEventListener('click', () => { target = place; pathInput.value = defaultPath(place); invalidate(); renderPlaces(); });
      row.append(choose); return row;
    }));
  };
  if (target) pathInput.value = defaultPath(target);
  renderPlaces();
  search.addEventListener('input', renderPlaces);
  pathInput.addEventListener('input', invalidate);
  const body = extra => ({ fromProjectId: from.id, toProjectId: target.id, resourceId: notebook.id, path: pathInput.value.trim(), ...extra });
  previewButton.addEventListener('click', async () => {
    if (!target) { summary.textContent = 'Choose a project first.'; return; }
    previewButton.disabled = true; invalidate();
    try {
      preview = await move(body({ preview: true }));
      summary.textContent = `${from.title} › ${notebookSpaceDisplayPath(notebook.path)}  →  ${target.title} › ${notebookSpaceDisplayPath(preview.to.path)}. Nothing is overwritten.`;
      moveButton.disabled = false;
    } catch (error) { summary.textContent = error.message; }
    finally { previewButton.disabled = false; }
  });
  moveButton.addEventListener('click', async () => {
    if (!preview) return;
    moveButton.disabled = previewButton.disabled = true;
    try {
      const moved = await move(body({ revision: preview.revision }));
      await followMovedNotebookCache({ resourceId: notebook.id, fromServerId: moved.from.serverId, toServerId: moved.to.serverId, toScopeKey: scopeKeyFor(target.id) });
      onMoved(moved, target);
      if (target.space || !onOpen) { dialog.close(); return; }
      // The moved file is a working notebook: it is not in the document tree, so offer to open it.
      summary.textContent = `Moved to ${target.title} › ${moved.to.path}.`;
      for (const node of [search, list, label, previewButton, moveButton]) node.hidden = true;
      const openIt = notebookElement('button', 'Open it'); openIt.type = 'button'; cancel.textContent = 'Done';
      openIt.addEventListener('click', () => { dialog.close(); onOpen(moved, target); });
      actions.replaceChildren(openIt, cancel); openIt.focus();
    } catch (error) { summary.textContent = error.message; previewButton.disabled = false; }
  });
  showNotebookDialog(dialog, toSpace ? previewButton : search, toSpace ? previewButton : cancel);
  return dialog;
}
