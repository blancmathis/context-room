import { randomUUID } from 'node:crypto';
import { canonicalNotebookRoot, notebookHash } from './notebook_io.mjs';
import { NOTEBOOK_VERSION, NOTEBOOK_LIMITS, notebookId, failNotebook } from './notebook_protocol.mjs';
import { openNotebook, readNotebook, listNotebooks, mutateNotebook, undoNotebook, addNotebookAsset, freezeNotebook, readFrozenNotebook, notebookReceipt, relocateNotebook, encodeNotebook } from './notebooks.mjs';
import { submitNotebookLocal } from './notebook_workflow.mjs';
import { notebookSvg } from './notebook_render.mjs';

export const NOTEBOOK_HTTP_PREFIX = '/api/notebooks';
export function isNotebookMutation(method, pathname) { return method === 'POST' && pathname.startsWith(NOTEBOOK_HTTP_PREFIX + '/'); }

/** Called only after the existing HTTP origin, owner authority and exact-project guards. */
export async function handleNotebookHttp(req, res, { root, url, readJsonBody, sendJson, canRead = () => false, canWrite = () => false, actor, submitShared } = {}) {
  if (!url.pathname.startsWith(NOTEBOOK_HTTP_PREFIX + '/') && url.pathname !== NOTEBOOK_HTTP_PREFIX) return false;
  const route = url.pathname.slice(NOTEBOOK_HTTP_PREFIX.length);
  if (req.method === 'GET' && route === '/capabilities') {
    sendJson(res, 200, { protocolVersion: NOTEBOOK_VERSION, serverId: notebookHash(['context-room-notebook-location-v1', root, canonicalNotebookRoot(root)]), accountId: 'local-owner', actor, format: '.crnb', limits: NOTEBOOK_LIMITS, sourceAuthority: 'mac-working-scene', reviewAuthority: 'existing-human-file-review',
      operations: ['open', 'read', 'mutate', 'undo', 'asset', 'freeze', 'submit', 'receipt', 'relocate', 'export'], sharedSubmission: typeof submitShared === 'function' }); return true;
  }
  if (req.method === 'GET' && route === '') {
    sendJson(res, 200, { protocolVersion: NOTEBOOK_VERSION, notebooks: listNotebooks(root).filter(item => canRead(item.path)) }); return true;
  }
  if (!['GET', 'POST'].includes(req.method)) failNotebook('notebook_method', 'Unsupported notebook request method.');
  const body = req.method === 'POST' ? await readJsonBody(req, { maxBytes: 30 * 1024 * 1024 }) : {};
  if (req.method === 'POST' && route === '/open') {
    if (body.protocolVersion !== NOTEBOOK_VERSION) failNotebook('notebook_version', 'The notebook client protocol is incompatible.');
    sendJson(res, 200, openNotebook(root, { path: body.path, title: body.title, id: body.id || randomUUID(), canWrite })); return true;
  }
  const id = notebookId(body.resourceId || url.searchParams.get('resourceId'));
  const scene = readNotebook(root, id, { includeDocument: false });
  if (!canRead(scene.locator.path)) failNotebook('notebook_path_scope', 'This notebook is outside the authorized folder.');
  if (req.method === 'GET' && route === '/scene') {
    const since = Number(url.searchParams.get('since') || 0);
    if (!Number.isSafeInteger(since) || since < 0) failNotebook('notebook_cursor', 'Invalid notebook cursor.');
    sendJson(res, 200, readNotebook(root, id, { since })); return true;
  }
  if (req.method === 'GET' && route === '/receipt') { sendJson(res, 200, notebookReceipt(root, id, url.searchParams.get('operationId'))); return true; }
  if (req.method === 'GET' && route === '/export') {
    const freezeId = url.searchParams.get('freezeId');
    const document = freezeId ? readFrozenNotebook(root, id, freezeId).document : readNotebook(root, id).document;
    const format = url.searchParams.get('format') || 'crnb';
    if (!['crnb', 'svg'].includes(format)) failNotebook('notebook_export', 'Choose an editable notebook or SVG export.');
    const data = format === 'svg' ? Buffer.from(notebookSvg(document)) : encodeNotebook(document);
    sendJson(res, 200, { resourceId: id, revision: document.revision, mimeType: format === 'svg' ? 'image/svg+xml' : 'application/vnd.context-room.notebook+json',
      filename: `notebook-${id}.${format}`, data: data.toString('base64'), accepted: false }); return true;
  }
  if (req.method !== 'POST') failNotebook('notebook_route', 'Unknown notebook route.');
  if (!actor) failNotebook('notebook_authority', 'A trusted author is required for notebook changes.');
  if (body.protocolVersion !== NOTEBOOK_VERSION) failNotebook('notebook_version', 'The notebook client protocol is incompatible.');
  const options = { actor, canWrite };
  let result;
  if (route === '/mutate') result = mutateNotebook(root, body, options);
  else if (route === '/undo') result = undoNotebook(root, body, options);
  else if (route === '/asset') result = addNotebookAsset(root, body, options);
  else if (route === '/freeze') result = freezeNotebook(root, body, options);
  else if (route === '/relocate') result = relocateNotebook(root, body, options);
  else if (route === '/submit') {
    if (body.scope === 'shared') {
      if (typeof submitShared !== 'function') failNotebook('notebook_shared_unavailable', 'This exact worktree is not connected to Shared. Keep the local scene and connect it explicitly.');
      result = await submitShared(body, options);
    } else if (!body.scope || body.scope === 'local') result = submitNotebookLocal(root, body, options);
    else failNotebook('notebook_scope', 'Choose local or Shared submission explicitly.');
  } else failNotebook('notebook_route', 'Unknown notebook route.');
  sendJson(res, 200, result); return true;
}
