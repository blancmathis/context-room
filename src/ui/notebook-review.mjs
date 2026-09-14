import { normalizeNotebookDocument } from '../notebook_protocol.mjs';
import { notebookSvg } from '../notebook_render.mjs';
import { notebookElement, notebookStyles, openNotebookEditor } from './notebook-editor.mjs';

/** A frozen document renderer. It never obtains the changing working scene or decides a review. */
export async function renderNotebookReview(holder, { bytes, file, editable = false, api, scopeKey, onCorrection = () => {}, onBusy = () => {} }) {
  notebookStyles();
  let snapshot = normalizeNotebookDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const preview = notebookElement('div', '', 'notebook-review-render'), origins = notebookElement('p', '', 'notebook-review-origins');
  const render = () => {
    // notebookSvg validates all object fields and permits only embedded raster assets.
    preview.innerHTML = notebookSvg(snapshot, { showOrigins: true });
    const agent = snapshot.objects.filter(object => object.createdBy.kind === 'agent' || object.updatedBy.kind === 'agent').length;
    origins.textContent = `Frozen scene r${snapshot.revision} · ${snapshot.objects.length} objects · ${agent} containing agent changes. This exact rendered document includes its embedded assets.`;
  };
  render(); holder.append(preview, origins);
  if (!editable) return;
  const correct = notebookElement('button', 'Correct notebook'); correct.type = 'button'; correct.className = 'quiet-button'; holder.append(correct);
  correct.addEventListener('click', async () => {
    correct.disabled = true; onBusy(true);
    try {
      await openNotebookEditor({ api, scopeKey, path: file.path, fixedSnapshot: snapshot, reviewKey: file.revision,
        onCorrection: async contentBase64 => {
          const corrected = Uint8Array.from(atob(contentBase64), character => character.charCodeAt(0));
          snapshot = normalizeNotebookDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(corrected)));
          render(); await onCorrection(contentBase64);
        }, onClosed: () => { correct.disabled = false; onBusy(false); },
      });
    } catch (error) { holder.append(notebookElement('p', error.message)); correct.disabled = false; onBusy(false); }
  });
}
