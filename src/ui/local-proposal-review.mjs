function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

const bytesOf = (base64) => base64 === null ? null : Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const textOf = (bytes) => bytes ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : "";
let rendererPromise;
async function renderDiagram(source, holder) {
  const renderId = holder.dataset.renderId = crypto.randomUUID();
  try {
    rendererPromise ||= window.mermaid ? Promise.resolve(window.mermaid) : new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = "/vendor/mermaid.min.js";
      script.onload = () => resolve(window.mermaid); script.onerror = () => reject(new Error("Diagram renderer unavailable.")); document.head.append(script);
    });
    const renderer = await rendererPromise;
    if (/%%\{|\bclick\s|<\/?[a-z]|(?:https?|javascript|file):/i.test(source)) throw new Error("Remove executable directives or external links to preview this diagram.");
    renderer.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, suppressErrorRendering: true });
    const { svg } = await renderer.render(`proposal-diagram-${crypto.randomUUID()}`, source);
    if (holder.dataset.renderId === renderId) holder.innerHTML = svg;
  } catch (error) { if (holder.dataset.renderId === renderId) holder.textContent = error.message; }
}

export async function openLocalProposalReview({ item, api, scopeKey, onChange }) {
  document.querySelector("dialog.local-proposal-review")?.close();
  const dialog = element("dialog", "", "local-proposal-review");
  dialog.setAttribute("aria-label", item.title);
  const styles = element("style");
  styles.textContent = `
    dialog.local-proposal-review { width: min(1100px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: var(--dialog-gutter, 24px); background: var(--surface-floating, #252526); color: var(--text, #d4d4d4); border: 1px solid var(--line, #777778); border-radius: 12px; }
    .local-proposal-review::backdrop { background: rgb(0 0 0 / .65); }
    .local-proposal-review header, .local-proposal-review footer, .local-proposal-review nav { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .local-proposal-review h2 { margin: 0; flex: 1; font-size: 20px; }
    .local-proposal-review nav { margin-block: 20px; }
    .local-proposal-review button[aria-current=true] { outline: 2px solid var(--accent, #569cd6); outline-offset: 2px; }
    .local-proposal-review .local-proposal-versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 20px; }
    .local-proposal-review section { min-width: 0; }
    .local-proposal-review h3 { overflow-wrap: anywhere; font-size: 14px; margin: 0 0 12px; }
    .local-proposal-review textarea, .local-proposal-review pre, .local-proposal-review iframe { box-sizing: border-box; width: 100%; min-height: 320px; max-height: 55dvh; overflow: auto; padding: 16px; margin: 0; border: 1px solid var(--line, #777778); border-radius: 6px; color: var(--text, #d4d4d4); background: var(--file-bg, #1e1e1e); font: 14px/1.65 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .local-proposal-review textarea { display: block; height: 320px; resize: vertical; }
    .local-proposal-review img { max-width: 100%; max-height: 55dvh; object-fit: contain; }
    .local-proposal-review .local-proposal-diagram { margin-top: 16px; overflow: auto; }
    .local-proposal-review .local-proposal-diagram svg { display: block; width: 100%; height: auto; max-width: 100%; }
    .local-proposal-review footer { justify-content: flex-end; margin-top: 20px; }
    .local-proposal-review [role=status] { min-height: 24px; margin-top: 12px; color: var(--muted, #9a9a9a); }
  `;
  dialog.append(styles);
  const header = element("header");
  const close = element("button", "Close", "quiet-button");
  close.type = "button";
  header.append(element("h2", item.title), close);
  const nav = element("nav");
  nav.setAttribute("aria-label", "Changed files");
  const versions = element("div", "", "local-proposal-versions");
  const status = element("div");
  status.setAttribute("role", "status");
  const footer = element("footer");
  dialog.append(header, nav, versions, status, footer);
  document.body.append(dialog);
  let objectUrls = [];
  let activePath = "";
  let editor = null;
  let initialText = "";
  let lineEnding = "\n";
  let busy = false;
  let drawing = null;
  let importedDrawing = null;
  let notebookCorrection = null;
  let requestId = 0;
  let correctionListener = null;
  let files = [...item.files];
  const isDirty = () => Boolean(editor && editor.value !== initialText || drawing?.dirty || importedDrawing || notebookCorrection);
  const cleanupUrls = () => { objectUrls.forEach((url) => URL.revokeObjectURL(url)); objectUrls = []; };
  dialog.addEventListener("close", () => { requestId++; cleanupUrls(); dialog.remove(); }, { once: true });
  const mayClose = () => {
    if (busy || isDirty()) { status.textContent = "Save and accept your correction, or undo it before closing."; return false; }
    return true;
  };
  close.addEventListener("click", () => { if (mayClose()) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (!mayClose()) event.preventDefault(); });
  const request = (url, options = {}) => api(url, { ...options, headers: {
    ...options.headers, ...(item.projectId ? { "x-context-room-target-project": item.projectId } : {}),
  } });

  function renderVersion(label, bytes, file, editable) {
    const section = element("section");
    section.append(element("h3", label));
    if (bytes === null) { section.append(element("p", label === "Accepted" ? "New document" : "Document removed")); return section; }
    const extension = file.path.split(".").pop().toLowerCase();
    if (["html", "htm"].includes(extension)) {
      const frame = element("iframe");
      frame.title = `${label}: ${file.path}`;
      frame.setAttribute("sandbox", "");
      frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">' + textOf(bytes);
      section.append(frame);
      if (item.proposalId) {
        const page = new DOMParser().parseFromString(textOf(bytes), "text/html");
        const pending = [...page.querySelectorAll("img[src],link[rel=stylesheet][href]")].map(async (resource) => {
          const reference = resource.getAttribute(resource.tagName === "IMG" ? "src" : "href");
          if (!reference || /^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
          const resolved = new URL(reference, `https://proposal.invalid/${file.path}`);
          const rel = decodeURIComponent(resolved.pathname.slice(1));
          const data = await request(`/api/docqa/local-proposal-resource?${new URLSearchParams({ proposal: item.proposalId, path: rel, side: editable ? "after" : "before", revision: file.revision })}`);
          if (resource.tagName === "IMG") { resource.setAttribute("src", `data:${data.mimeType};base64,${data.data}`); resource.removeAttribute("srcset"); }
          else { const style = page.createElement("style"); style.textContent = textOf(bytesOf(data.data)); resource.replaceWith(style); }
        });
        Promise.allSettled(pending).then((results) => {
          if (!frame.isConnected) return;
          frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">' + page.documentElement.outerHTML;
          if (results.some((result) => result.status === "rejected")) section.append(element("p", "Some linked assets are absent from this version."));
        });
      }
    } else if (extension === "crnb") {
      import("/assets/ui/notebook-review.mjs").then(({ renderNotebookReview }) => {
        if (!section.isConnected) return;
        return renderNotebookReview(section, { bytes, file, editable, api: request, scopeKey,
          onBusy: value => { busy = value; renderNavigation(); for (const node of footer.querySelectorAll("button")) node.disabled = value; close.disabled = value; },
          onCorrection: contentBase64 => { notebookCorrection = contentBase64; dialog.dispatchEvent(new Event("correction")); },
        });
      }).catch(error => { status.textContent = "Notebook rendering failed: " + error.message; });
    } else if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) {
      const image = element("img");
      image.alt = `${label}: ${file.path}`;
      const type = extension === "svg" ? "image/svg+xml" : extension === "jpg" ? "image/jpeg" : `image/${extension}`;
      image.src = URL.createObjectURL(new Blob([bytes], { type }));
      objectUrls.push(image.src);
      section.append(image);
      if (editable && ["png", "jpg", "jpeg", "webp"].includes(extension)) {
        const draw = element("button", "Draw on image", "quiet-button"); draw.type = "button";
        section.append(draw);
        draw.addEventListener("click", async () => {
          try {
            await image.decode();
            if (image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error("This image exceeds the integrated drawing size limit. Its original resolution is preserved.");
            const canvas = element("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            canvas.style.cssText = "max-width:100%;max-height:55dvh;touch-action:none;object-fit:contain";
            canvas.setAttribute("aria-label", `Drawing: ${file.path}`);
            const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
            const color = element("input"); color.type = "color"; color.value = "#e64545"; color.setAttribute("aria-label", "Ink color");
            const width = element("input"); width.type = "range"; width.min = "1"; width.max = "40"; width.value = "4"; width.setAttribute("aria-label", "Ink width");
            const strokes = [], redoStrokes = [];
            const undoStroke = element("button", "Undo stroke"), redoStroke = element("button", "Redo stroke");
            undoStroke.type = redoStroke.type = "button";
            const redraw = () => {
              context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
              for (const stroke of strokes) {
                context.beginPath(); context.moveTo(...stroke.points[0]); context.strokeStyle = stroke.color; context.lineWidth = stroke.width; context.lineCap = "round"; context.lineJoin = "round";
                for (const point of stroke.points.slice(1)) context.lineTo(...point);
                context.stroke();
              }
              drawing.dirty = strokes.length > 0; undoStroke.disabled = !strokes.length; redoStroke.disabled = !redoStrokes.length;
              dialog.dispatchEvent(new Event("correction"));
            };
            drawing = { canvas, context, image, dirty: false, type, undo: () => { strokes.length = 0; redoStrokes.length = 0; redraw(); } };
            let pointer = null;
            const point = (event) => { const box = canvas.getBoundingClientRect(); return [(event.clientX - box.left) * canvas.width / box.width, (event.clientY - box.top) * canvas.height / box.height]; };
            canvas.addEventListener("pointerdown", (event) => {
              if (busy || pointer !== null) return; pointer = event.pointerId; canvas.setPointerCapture(pointer); redoStrokes.length = 0;
              const at = point(event); strokes.push({ color: color.value, width: Number(width.value), points: [at, [at[0] + 0.01, at[1] + 0.01]] }); redraw();
            });
            canvas.addEventListener("pointermove", (event) => { if (pointer !== event.pointerId || busy) return; strokes.at(-1).points.push(point(event)); redraw(); });
            const release = (event) => { if (pointer === event.pointerId) pointer = null; };
            canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
            undoStroke.addEventListener("click", () => { if (!busy && strokes.length) { redoStrokes.push(strokes.pop()); redraw(); } });
            redoStroke.addEventListener("click", () => { if (!busy && redoStrokes.length) { strokes.push(redoStrokes.pop()); redraw(); } });
            section.append(undoStroke, redoStroke); redraw();
            image.hidden = true; draw.remove(); section.append(color, width, canvas); dialog.dispatchEvent(new Event("correction"));
          } catch (error) { status.textContent = error.message; }
        });
      }
    } else if (bytes.includes(0) || ["pdf", "doc", "docx", "xlsx", "pptx", "zip"].includes(extension)) {
      section.append(element("p", `${bytes.length.toLocaleString()} bytes. Integrated preview is not available for this format yet.`));
    } else if (editable) {
      editor = element("textarea");
      const original = textOf(bytes);
      lineEnding = original.includes('\r\n') && !/[\r\n]/.test(original.replace(/\r\n/g, '')) ? '\r\n' : original.includes('\r') && !original.includes('\n') ? '\r' : '\n';
      editor.value = original;
      initialText = editor.value;
      editor.setAttribute("aria-label", `Proposed content: ${file.path}`);
      editor.spellcheck = false;
      section.append(editor);
    } else section.append(element("pre", textOf(bytes)));
    if (["mmd", "mermaid"].includes(extension)) {
      const preview = element("div", "", "local-proposal-diagram"); preview.setAttribute("aria-label", `${label} diagram`); section.append(preview);
      renderDiagram(textOf(bytes), preview);
      if (editable && editor) {
        const sourceEditor = editor; let timer;
        sourceEditor.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => renderDiagram(sourceEditor.value, preview), 250); });
      }
    }
    return section;
  }

  function renderNavigation() {
    nav.replaceChildren();
    for (const file of files) {
      const button = element("button", file, "quiet-button");
      button.type = "button";
      button.setAttribute("aria-current", String(file === activePath));
      button.disabled = busy;
      button.addEventListener("click", () => {
        if (isDirty()) { status.textContent = "Save and accept your correction, or undo it before switching files."; return; }
        openFile(file).catch((error) => { status.textContent = error.message; });
      });
      nav.append(button);
    }
  }

  async function openFile(filePath) {
    const serial = ++requestId;
    busy = true;
    activePath = filePath;
    editor = null;
    drawing = null;
    importedDrawing = null;
    notebookCorrection = null;
    footer.replaceChildren();
    renderNavigation();
    status.textContent = "Loading versions…";
    try {
      const file = await request(item.type === "shared-asset" ? `/api/docqa/shared-asset-file?path=${encodeURIComponent(filePath)}` : item.type === "local-asset" ? `/api/docqa/asset-file?path=${encodeURIComponent(filePath)}` : `/api/docqa/local-proposal-file?proposal=${encodeURIComponent(item.proposalId)}&path=${encodeURIComponent(filePath)}`);
      if (serial !== requestId || !dialog.isConnected) return;
      cleanupUrls();
      versions.replaceChildren(renderVersion("Accepted", bytesOf(file.beforeBase64), file, false), renderVersion("Proposed", bytesOf(file.afterBase64), file, true));
      const accept = element("button", "Accept file", "file-action primary");
      const reject = element("button", "Reject file", "file-action danger-action");
      const undo = element("button", "Undo correction", "quiet-button");
      const reload = element("button", "Reload review", "quiet-button");
      for (const button of [accept, reject, undo, reload]) button.type = "button";
      undo.hidden = !editor;
      undo.addEventListener("click", () => { if (editor) editor.value = initialText; drawing?.undo(); if (importedDrawing || notebookCorrection) { importedDrawing = null; notebookCorrection = null; openFile(filePath).catch((error) => { status.textContent = error.message; }); } accept.textContent = "Accept file"; });
      if (correctionListener) dialog.removeEventListener("correction", correctionListener);
      const correction = () => { undo.hidden = !editor && !drawing && !notebookCorrection && !importedDrawing; accept.textContent = isDirty() ? "Save and accept file" : "Accept file"; };
      correctionListener = correction;
      dialog.addEventListener("correction", correction);
      editor?.addEventListener("input", () => { accept.textContent = isDirty() ? "Save and accept file" : "Accept file"; });
      reload.addEventListener("click", () => { if (!isDirty()) openFile(filePath).catch((error) => { status.textContent = error.message; }); });
      async function decide(decision) {
        busy = true;
        [accept, reject, undo, reload, close].forEach((button) => { button.disabled = true; });
        renderNavigation();
        try {
          const result = await request(item.type === "shared-asset" ? "/api/docqa/shared-asset-decision" : item.type === "local-asset" ? "/api/docqa/asset-decision" : "/api/docqa/local-proposal-decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            proposal: item.proposalId, path: file.path, decision, expectedRevision: file.revision,
            ...(decision === "accepted" && editor && isDirty() ? { content: editor.value.replace(/\n/g, lineEnding) } : {}),
            ...(decision === "accepted" && drawing?.dirty ? { contentBase64: drawing.canvas.toDataURL(drawing.type).split(",")[1] } : {}),
            ...(decision === "accepted" && importedDrawing ? { contentBase64: importedDrawing } : {}),
            ...(decision === "accepted" && notebookCorrection ? { contentBase64: notebookCorrection } : {}),
          }) });
          editor = null;
          drawing = null;
          importedDrawing = null;
          notebookCorrection = null;
          dialog.removeEventListener("correction", correction);
          files = result.changes.filter((change) => !change.decision).map((change) => change.path);
          await onChange(result);
          if (!files.length) { dialog.close(); return; }
          await openFile(files[0]);
        } catch (error) { status.textContent = error.message; }
        finally { busy = false; [accept, reject, undo, reload, close].forEach((button) => { button.disabled = false; }); renderNavigation(); }
      }
      accept.addEventListener("click", () => decide("accepted"));
      reject.addEventListener("click", () => decide("rejected"));
      footer.append(undo, reload, reject, accept);
      if (item.type === 'local-asset' && /\.crnb$/i.test(file.path) && file.afterBase64 !== null) {
        const working = element('button', 'Open working notebook', 'quiet-button'); working.type = 'button'; footer.prepend(working);
        working.addEventListener('click', async () => {
          if (busy) return;
          if (isDirty()) { status.textContent = 'Save or undo the current correction first.'; return; }
          working.disabled = true;
          try {
            const { openNotebookEditor } = await import('/assets/ui/notebook-editor.mjs');
            await openNotebookEditor({ api: request, path: file.path, scopeKey });
          } catch (error) { status.textContent = error.message; }
          finally { working.disabled = false; }
        });
      }
      if (/\.png$/i.test(file.path) && file.afterBase64 !== null) {
        const tablet = element("button", "Draw in Context Room", "quiet-button"), useDrawing = element("button", "Use saved drawing", "quiet-button");
        tablet.type = useDrawing.type = "button"; useDrawing.hidden = true;
        const destinationLabel = element("label", "Editable notebook path "), destination = element("input");
        destination.type = "text"; destination.value = file.path.replace(/\.png$/i, "-drawing.crnb");
        destination.setAttribute("aria-label", "Editable drawing notebook path"); destinationLabel.append(destination);
        footer.prepend(destinationLabel, tablet, useDrawing); let session = null;
        const runDrawing = async work => {
          if (busy) return;
          if (isDirty()) { status.textContent = "Save or undo the current correction first."; return; }
          busy = true; [tablet, useDrawing, destination, accept, reject, undo, reload, close].forEach(button => { button.disabled = true; }); renderNavigation();
          try { await work(); }
          catch (error) { if (serial === requestId && dialog.isConnected) status.textContent = error.message; }
          finally { busy = false; [tablet, useDrawing, destination, accept, reject, undo, reload, close].forEach(button => { button.disabled = false; }); destination.readOnly = Boolean(session); renderNavigation(); }
        };
        const payload = { path: file.path, proposal: item.proposalId || "", shared: item.type === "shared-asset", expectedRevision: file.revision };
        tablet.addEventListener("click", () => runDrawing(async () => {
          if (!session) session = await request("/api/lisiere/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, notebookPath: destination.value.trim() }) });
          if (serial !== requestId || !dialog.isConnected) return;
          status.textContent = session.instruction; tablet.textContent = "Open working drawing"; useDrawing.hidden = false;
          const { openNativeDrawing } = await import('/assets/ui/native-drawing.mjs');
          if (serial === requestId && dialog.isConnected) await openNativeDrawing({ api: request, scopeKey, session });
        }));
        useDrawing.addEventListener("click", () => runDrawing(async () => {
          const snapshot = await request("/api/lisiere/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, session: session.id }) });
          const { nativeDrawingPng } = await import('/assets/ui/native-drawing.mjs');
          const content = await nativeDrawingPng(snapshot);
          if (serial !== requestId || !dialog.isConnected) return;
          importedDrawing = content;
          const preview = element("img"); preview.alt = "Exact saved Context Room drawing snapshot"; preview.src = `data:image/png;base64,${content}`;
          versions.lastElementChild.replaceChildren(element("h3", "Your drawing"), preview);
          undo.hidden = false; accept.textContent = "Save and accept file";
          status.textContent = `Snapshot r${snapshot.boardRevision} at the original PNG bounds. Inspect it before deciding. All editable objects, including those outside this crop, remain in ${snapshot.path}.`;
        }));
      }
      status.textContent = file.kind === "deleted" ? "Accepting removes this file. Its accepted content stays available for recovery." : "Only this file will receive your decision.";
    } finally { busy = false; renderNavigation(); }
  }
  dialog.showModal();
  try { if (files.length) await openFile(files[0]); }
  catch (error) { status.textContent = error.message; }
}
