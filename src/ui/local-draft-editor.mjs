const element = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };

/** Working text and submission are separate from the existing human review. */
export async function openLocalDraftEditor({ item, api, onChange }) {
  if (document.querySelector('dialog.local-draft-editor')) return;
  const dialog = element('dialog'); dialog.className = 'local-draft-editor'; dialog.setAttribute('aria-label', item.title);
  const style = element('style'); style.textContent = `
    .local-draft-editor { box-sizing:border-box; width:min(920px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:auto; padding:24px; border:1px solid var(--line,#777); border-radius:12px; background:var(--surface-floating,#252526); color:var(--text,#ddd); }
    .local-draft-editor::backdrop { background:rgb(0 0 0 / .65); }
    .local-draft-editor header,.local-draft-editor nav,.local-draft-editor footer { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
    .local-draft-editor h2 { flex:1; margin:0; font-size:20px; overflow-wrap:anywhere; }
    .local-draft-editor nav { margin:16px 0; }
    .local-draft-editor button { min-height:40px; overflow-wrap:anywhere; }
    .local-draft-editor [aria-current=true] { outline:2px solid var(--accent,#569cd6); outline-offset:2px; }
    .local-draft-editor textarea,.local-draft-editor iframe { box-sizing:border-box; width:100%; min-height:320px; height:45dvh; padding:16px; border:1px solid var(--line,#777); border-radius:6px; color:var(--text,#ddd); background:var(--file-bg,#1e1e1e); font:14px/1.6 ui-monospace,monospace; }
    .local-draft-editor textarea { display:block; resize:vertical; }
    .local-draft-editor iframe { padding:0; background:white; }
    .local-draft-editor footer { justify-content:flex-end; margin-top:16px; }
    .local-draft-editor [role=status] { min-height:24px; margin-top:12px; overflow-wrap:anywhere; }
  `;
  const header = element('header'), close = element('button', 'Close'); close.type = 'button'; close.className = 'quiet-button';
  header.append(element('h2', item.title), close);
  const nav = element('nav'); nav.setAttribute('aria-label', 'Draft files');
  const body = element('section'), status = element('div'); status.setAttribute('role', 'status');
  const footer = element('footer'), reset = element('button', 'Undo unsaved edits'), save = element('button', 'Save draft'), submit = element('button', 'Submit for review');
  for (const button of [reset, save, submit]) { button.type = 'button'; button.className = 'quiet-button'; }
  footer.append(reset, save, submit);
  dialog.append(style, header, element('p', 'Changes stay in this working draft. Submit when ready for the separate human review.'), nav, body, status, footer);
  let draft, selected, editor, savedText = '', lineEnding = '\n', busy = false, requestId = 0;
  const dirty = () => Boolean(editor && editor.value !== savedText);
  const url = rel => '/api/docqa/local-draft?' + new URLSearchParams({ proposal: item.id, ...(rel === undefined ? {} : { path: rel }) });
  function buttons() {
    if (editor) editor.readOnly = busy;
    close.disabled = busy; reset.disabled = busy || !dirty(); save.disabled = busy || !dirty();
    submit.disabled = busy || dirty() || !draft?.files.length;
    nav.querySelectorAll('button').forEach(button => { button.disabled = busy || dirty(); });
  }
  function mayClose() { if (busy || dirty()) { status.textContent = 'Save the draft or undo unsaved edits before closing.'; return false; } return true; }
  const unloading = event => { if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unloading);
  dialog.addEventListener('close', () => { requestId++; window.removeEventListener('beforeunload', unloading); dialog.remove(); }, { once: true });
  dialog.addEventListener('cancel', event => { if (!mayClose()) event.preventDefault(); });
  close.addEventListener('click', () => { if (mayClose()) dialog.close(); });
  reset.addEventListener('click', () => { if (editor && !busy) { editor.value = savedText; status.textContent = 'Saved text restored in the editor.'; buttons(); } });
  function render(file) {
    draft = file; selected = file.path; editor = null; nav.replaceChildren(); body.replaceChildren();
    for (const entry of file.files) {
      const button = element('button', entry.path); button.type = 'button'; button.className = 'quiet-button';
      button.setAttribute('aria-current', String(entry.path === selected));
      button.addEventListener('click', () => openFile(entry.path)); nav.append(button);
    }
    if (!selected) { body.append(element('p', 'This workspace has no document yet.')); buttons(); return; }
    const bytes = file.afterBase64 === null ? null : Uint8Array.from(atob(file.afterBase64), char => char.charCodeAt(0));
    if (bytes === null) body.append(element('p', 'This document is removed in the working draft. Submission retains the deletion for review.'));
    else if (/\.(?:md|markdown|txt)$/i.test(selected) && !bytes.includes(0)) {
      try {
        const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        lineEnding = original.includes('\r\n') && !/[\r\n]/.test(original.replace(/\r\n/g, '')) ? '\r\n' : original.includes('\r') && !original.includes('\n') ? '\r' : '\n';
        editor = element('textarea'); editor.value = original; savedText = editor.value; editor.spellcheck = false;
        editor.setAttribute('aria-label', `Working content: ${selected}`); editor.addEventListener('input', buttons); body.append(editor);
      } catch { body.append(element('p', 'This original uses a different text encoding. Its bytes are retained for review.')); }
    } else if (/\.html?$/i.test(selected)) {
      const frame = element('iframe'); frame.title = `Working preview: ${selected}`; frame.setAttribute('sandbox', '');
      frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">' + new TextDecoder().decode(bytes);
      body.append(frame);
    } else body.append(element('p', 'This document stays in its original format. Submit to open its integrated review.'));
    buttons();
  }
  async function openFile(rel) {
    if (busy || dirty()) return;
    const serial = ++requestId; busy = true; buttons(); status.textContent = 'Opening saved draft…';
    try {
      let file = await api(url(rel));
      if (rel === undefined && file.files.length) file = await api(url(file.files[0].path));
      if (serial !== requestId || !dialog.isConnected) return;
      render(file); status.textContent = 'Saved working draft. Nothing accepted.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; buttons(); }
  }
  save.addEventListener('click', async () => {
    if (busy || !dirty()) return;
    busy = true; buttons(); status.textContent = 'Saving draft…';
    try {
      const file = await api('/api/docqa/local-draft', { method: 'POST', body: JSON.stringify({ proposal: item.id, path: selected, content: editor.value.replace(/\n/g, lineEnding), expectedRevision: draft.revision }) });
      render(file); status.textContent = 'Draft saved. Nothing submitted or accepted.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; buttons(); }
  });
  submit.addEventListener('click', async () => {
    if (busy || dirty() || !draft) return;
    busy = true; buttons(); status.textContent = 'Submitting the saved version…';
    try {
      await api('/api/docqa/local-draft-submit', { method: 'POST', body: JSON.stringify({ proposal: item.id, expectedRevision: draft.revision }) });
      busy = false; dialog.close(); await onChange?.();
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; buttons(); }
  });
  document.body.append(dialog); dialog.showModal(); await openFile();
}
