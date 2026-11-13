// Markdown editor core, loaded by app.mjs with the first Markdown doc (R7): undo history, pointer selection,
// the caret drawn over the rendered lines, and find. Moved as is out of the main script; app passes what it uses.
export function createDocEditor(app) {
  const { el, state, isMacPlatform, isDocLinkModifierEventActive, scheduleCodexReferenceActionUpdate, syncMarkdownEditorScroll, wireMarkdownEditorDocLinks, updateMarkdownEditorHighlight, updateHeader, updatePreview, updateConflictCompareLive, scheduleConflictCheck, scheduleSessionStatePush, loadTextTools, setStatus, scheduleDocAutosave } = app;

  function wireRenderedMarkdownEditor() {
    const docEditor = el("docEditor");
    if (!docEditor) return;
    prepareMarkdownEditorHistory(docEditor);
    state.markdownHighlightLastText = docEditor.value;
    wireEditorFind(docEditor);
    syncMarkdownEditorScroll();
    docEditor.addEventListener("beforeinput", (event) => captureMarkdownEditorHistory(docEditor, event));
    docEditor.addEventListener("input", (event) => {
      commitMarkdownEditorHistory(docEditor, event);
      syncMarkdownEditorValue(docEditor);
      scheduleCodexReferenceActionUpdate();
    });
    docEditor.addEventListener("keyup", () => {
      updateMarkdownEditorVisualSelection();
      scheduleCodexReferenceActionUpdate();
    });
    docEditor.addEventListener("keydown", (event) => {
      if ((isMacPlatform() ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "f") {
        event.preventDefault();
        openEditorFind();
        return;
      }
      if (handleMarkdownEditorHistoryShortcut(event, docEditor)) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) resetMarkdownEditorHistoryGroup();
      window.requestAnimationFrame(updateMarkdownEditorVisualSelection);
    });
    docEditor.addEventListener("select", () => {
      updateMarkdownEditorVisualSelection();
      scheduleCodexReferenceActionUpdate();
    });
    docEditor.addEventListener("scroll", syncMarkdownEditorScroll, { passive: true });
    docEditor.addEventListener("pointerdown", enterMarkdownEditorAtPoint);
    docEditor.addEventListener("pointermove", extendMarkdownEditorPointerSelection);
    docEditor.addEventListener("pointerup", finishMarkdownEditorPointerSelection);
    docEditor.addEventListener("pointercancel", finishMarkdownEditorPointerSelection);
    wireMarkdownEditorDocLinks(docEditor);
    updateMarkdownEditorVisualSelection();
  }

  function markdownEditorHistorySnapshot(editor) {
    return {
      value: editor.value,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
      selectionDirection: editor.selectionDirection || "none",
    };
  }

  function prepareMarkdownEditorHistory(editor) {
    const current = markdownEditorHistorySnapshot(editor);
    if (state.markdownEditorHistory?.path === state.selected && state.markdownEditorHistory.current?.value === current.value) {
      state.markdownEditorHistory.current = current;
      return state.markdownEditorHistory;
    }
    state.markdownEditorHistory = {
      path: state.selected,
      past: [],
      future: [],
      pending: null,
      current,
      lastInputType: "",
      lastInputAt: 0,
    };
    return state.markdownEditorHistory;
  }

  function captureMarkdownEditorHistory(editor, event) {
    const history = prepareMarkdownEditorHistory(editor);
    history.pending = markdownEditorHistorySnapshot(editor);
    history.pendingInputType = String(event.inputType || "");
  }

  function commitMarkdownEditorHistory(editor, event) {
    const history = state.markdownEditorHistory?.path === state.selected
      ? state.markdownEditorHistory
      : prepareMarkdownEditorHistory(editor);
    const before = history.pending || history.current;
    const inputType = String(event.inputType || history.pendingInputType || "");
    const now = Date.now();
    const coalescible = ["insertText", "deleteContentBackward", "deleteContentForward"].includes(inputType) && before.selectionStart === before.selectionEnd;
    const continuesGroup = coalescible && history.lastInputType === inputType && now - history.lastInputAt < 1000;
    if (before?.value !== editor.value && !continuesGroup) {
      history.past.push(before);
      if (history.past.length > 200) history.past.shift();
    }
    if (before?.value !== editor.value) history.future = [];
    history.pending = null;
    history.pendingInputType = "";
    history.current = markdownEditorHistorySnapshot(editor);
    history.lastInputType = coalescible ? inputType : "";
    history.lastInputAt = coalescible ? now : 0;
    updateEditorHistoryButtons();
  }

  function editorHistoryAvailable(direction) {
    const history = state.markdownEditorHistory;
    if (!history || history.path !== state.selected) return false;
    return (direction === "redo" ? history.future : history.past).length > 0;
  }

  function updateEditorHistoryButtons() {
    for (const direction of ["undo", "redo"]) {
      const button = document.querySelector("[data-editor-" + direction + "]");
      if (button) button.disabled = !editorHistoryAvailable(direction);
    }
  }

  function resetMarkdownEditorHistoryGroup() {
    if (!state.markdownEditorHistory) return;
    state.markdownEditorHistory.lastInputType = "";
    state.markdownEditorHistory.lastInputAt = 0;
  }

  function handleMarkdownEditorHistoryShortcut(event, editor) {
    const modifier = isMacPlatform() ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey) return false;
    const key = String(event.key || "").toLowerCase();
    const undo = key === "z" && !event.shiftKey;
    const redo = (key === "z" && event.shiftKey) || (!isMacPlatform() && key === "y" && !event.shiftKey);
    if (!undo && !redo) return false;
    event.preventDefault();
    applyMarkdownEditorHistory(editor, redo ? "redo" : "undo");
    return true;
  }

  function applyMarkdownEditorHistory(editor, direction) {
    const history = prepareMarkdownEditorHistory(editor);
    const source = direction === "redo" ? history.future : history.past;
    const destination = direction === "redo" ? history.past : history.future;
    const snapshot = source.pop();
    if (!snapshot) return;
    destination.push(markdownEditorHistorySnapshot(editor));
    editor.value = snapshot.value;
    editor.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection);
    history.pending = null;
    history.current = markdownEditorHistorySnapshot(editor);
    resetMarkdownEditorHistoryGroup();
    syncMarkdownEditorValue(editor);
    updateEditorHistoryButtons();
  }

  function syncMarkdownEditorValue(editor) {
    el("editor").value = editor.value;
    state.dirty = editor.value !== state.saved;
    updateMarkdownEditorHighlight(editor.value);
    updateHeader();
    updatePreview();
    updateConflictCompareLive(editor.value);
    scheduleConflictCheck();
    scheduleSessionStatePush();
    scheduleDocAutosave();
    window.requestAnimationFrame(updateMarkdownEditorVisualSelection);
  }

  function enterMarkdownEditorAtPoint(event) {
    const editor = el("docEditor");
    if (!editor || event.button !== 0 || isDocLinkModifierEventActive(event)) return;
    // Finger or pen (R2): the caret lands on lift, only if the point barely moved, so a scroll never opens the keyboard.
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      event.preventDefault();
      state.markdownTouchTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    resetMarkdownEditorHistoryGroup();
    const offset = markdownEditorSourceOffsetAtPoint(event.clientX, event.clientY);
    if (!Number.isInteger(offset)) return;
    event.preventDefault();
    try { editor.focus({ preventScroll: true }); }
    catch { editor.focus(); }

    if (event.detail >= 3) {
      const range = markdownEditorLineRange(editor.value, offset);
      editor.setSelectionRange(range.start, range.end, "forward");
      state.markdownPointerSelection = null;
      updateMarkdownEditorVisualSelection();
      return;
    }
    if (event.detail === 2) {
      const range = markdownEditorWordRange(editor.value, offset);
      editor.setSelectionRange(range.start, range.end, "forward");
      state.markdownPointerSelection = null;
      updateMarkdownEditorVisualSelection();
      return;
    }

    const anchor = event.shiftKey ? markdownEditorSelectionAnchor(editor) : offset;
    setMarkdownEditorSelection(editor, anchor, offset);
    state.markdownPointerSelection = { pointerId: event.pointerId, anchor };
    try { editor.setPointerCapture(event.pointerId); }
    catch {}
    updateMarkdownEditorVisualSelection();
  }

  function extendMarkdownEditorPointerSelection(event) {
    const editor = el("docEditor");
    const pointer = state.markdownPointerSelection;
    if (!editor || !pointer || pointer.pointerId !== event.pointerId) return;
    event.preventDefault();
    scrollMarkdownEditorForPointer(editor, event.clientY);
    const offset = markdownEditorSourceOffsetAtPoint(event.clientX, event.clientY);
    if (!Number.isInteger(offset)) return;
    setMarkdownEditorSelection(editor, pointer.anchor, offset);
    updateMarkdownEditorVisualSelection();
  }

  function finishMarkdownEditorPointerSelection(event) {
    const editor = el("docEditor");
    const pointer = state.markdownPointerSelection;
    const tap = state.markdownTouchTap;
    if (editor && tap?.pointerId === event.pointerId) {
      state.markdownTouchTap = null;
      const offset = event.type === "pointerup" && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 10 ? markdownEditorSourceOffsetAtPoint(event.clientX, event.clientY) : null;
      if (!Number.isInteger(offset)) return;
      resetMarkdownEditorHistoryGroup();
      try { editor.focus({ preventScroll: true }); }
      catch { editor.focus(); }
      setMarkdownEditorSelection(editor, offset, offset);
      updateMarkdownEditorVisualSelection();
      return;
    }
    if (!editor || !pointer || pointer.pointerId !== event.pointerId) return;
    try { editor.releasePointerCapture(event.pointerId); }
    catch {}
    state.markdownPointerSelection = null;
    updateMarkdownEditorVisualSelection();
    scheduleCodexReferenceActionUpdate();
  }

  function markdownEditorSelectionAnchor(editor) {
    if (editor.selectionStart === editor.selectionEnd) return editor.selectionStart;
    return editor.selectionDirection === "backward" ? editor.selectionEnd : editor.selectionStart;
  }

  function setMarkdownEditorSelection(editor, anchor, focus) {
    const safeAnchor = Math.max(0, Math.min(editor.value.length, Number(anchor) || 0));
    const safeFocus = Math.max(0, Math.min(editor.value.length, Number(focus) || 0));
    editor.setSelectionRange(
      Math.min(safeAnchor, safeFocus),
      Math.max(safeAnchor, safeFocus),
      safeFocus < safeAnchor ? "backward" : "forward",
    );
  }

  function markdownEditorWordRange(value, offset) {
    const text = String(value || "");
    const safe = Math.max(0, Math.min(text.length, Number(offset) || 0));
    if (!text.length) return { start: 0, end: 0 };
    const pivot = safe === text.length ? safe - 1 : safe;
    const classify = (character) => /[\p{L}\p{N}_]/u.test(character || "") ? "word" : /\s/u.test(character || "") ? "space" : "symbol";
    const type = classify(text[pivot]);
    let start = pivot;
    let end = pivot + 1;
    while (start > 0 && classify(text[start - 1]) === type && text[start - 1] !== "\n") start -= 1;
    while (end < text.length && classify(text[end]) === type && text[end] !== "\n") end += 1;
    return { start, end };
  }

  function markdownEditorLineRange(value, offset) {
    const text = String(value || "");
    const safe = Math.max(0, Math.min(text.length, Number(offset) || 0));
    const start = text.lastIndexOf("\n", Math.max(0, safe - 1)) + 1;
    const nextBreak = text.indexOf("\n", safe);
    return { start, end: nextBreak === -1 ? text.length : nextBreak + 1 };
  }

  function scrollMarkdownEditorForPointer(editor, clientY) {
    const rect = editor.getBoundingClientRect();
    const edge = Math.min(42, Math.max(20, rect.height * 0.08));
    if (clientY < rect.top + edge) editor.scrollTop = Math.max(0, editor.scrollTop - edge);
    else if (clientY > rect.bottom - edge) editor.scrollTop += edge;
    syncMarkdownEditorScroll();
  }

  function markdownEditorSourceOffsetAtPoint(clientX, clientY) {
    const editor = el("docEditor");
    const highlighter = el("docHighlighter");
    if (!editor || !highlighter) return null;
    const rect = highlighter.getBoundingClientRect();
    const x = Math.max(rect.left + 1, Math.min(rect.right - 1, clientX));
    const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, clientY));
    const previousHighlighterPointerEvents = highlighter.style.pointerEvents;
    const previousEditorPointerEvents = editor.style.pointerEvents;
    highlighter.style.pointerEvents = "auto";
    editor.style.pointerEvents = "none";
    try {
      let line = document.elementFromPoint(x, y)?.closest?.(".markdown-line") || null;
      if (!line || !highlighter.contains(line)) {
        const lines = [...highlighter.querySelectorAll(".markdown-line")];
        line = y <= (lines[0]?.getBoundingClientRect().top ?? y) ? lines[0] : lines.at(-1);
      }
      if (!line) return editor.value.length;
      const lineIndex = Number(line.dataset.lineIndex);
      if (!Number.isInteger(lineIndex)) return null;
      const sourceLines = editor.value.split("\n");
      const sourceLine = sourceLines[lineIndex] || "";
      const renderedOffset = renderedCaretOffsetAtPoint(line, x, y);
      const sourceColumn = markdownSourceOffsetForRenderedOffset(sourceLine, renderedOffset);
      const lineStart = sourceLines.slice(0, lineIndex).reduce((total, current) => total + current.length + 1, 0);
      return Math.min(editor.value.length, lineStart + sourceColumn);
    } finally {
      highlighter.style.pointerEvents = previousHighlighterPointerEvents;
      editor.style.pointerEvents = previousEditorPointerEvents;
    }
  }

  // Tap on the rendered doc (R2): source offset of the tapped point. The reader hides Markdown marks, so the text
  // before the caret is matched in order against the source line; marks it skips (#, **, [](…)) are passed over.
  function readerSourceOffset(event, text) {
    const reader = el("docReader");
    const line = event.target.closest?.("[data-line-index]");
    if (line && reader?.contains(line)) {
      const lines = String(text).split("\n"), index = Number(line.dataset.lineIndex), source = lines[index] ?? "";
      if (!Number.isInteger(index) || index >= lines.length) return null;
      let column = 0;
      for (const char of (line.textContent || "").slice(0, renderedCaretOffsetAtPoint(line, event.clientX, event.clientY))) {
        const found = source.indexOf(char, column);
        if (found >= 0 && found - column < 40) column = found + 1;
      }
      return lines.slice(0, index).reduce((total, current) => total + current.length + 1, 0) + column;
    }
    return reader?.matches("pre") ? Math.min(String(text).length, renderedCaretOffsetAtPoint(reader, event.clientX, event.clientY)) : null;
  }

  function renderedCaretOffsetAtPoint(line, clientX, clientY) {
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    const node = position?.offsetNode;
    const offset = position?.offset;
    if (node && line.contains(node)) {
      const range = document.createRange();
      range.setStart(line, 0);
      range.setEnd(node, offset);
      return range.toString().length;
    }
    const legacyRange = document.caretRangeFromPoint?.(clientX, clientY);
    if (legacyRange?.startContainer && line.contains(legacyRange.startContainer)) {
      const range = document.createRange();
      range.setStart(line, 0);
      range.setEnd(legacyRange.startContainer, legacyRange.startOffset);
      return range.toString().length;
    }
    return line.textContent?.length || 0;
  }

  function markdownSourceOffsetForRenderedOffset(sourceLine, renderedOffset) {
    const source = String(sourceLine || "");
    const wanted = Math.max(0, Number(renderedOffset) || 0);
    const pattern = /\[([^\]\n]+)\]\(([^) \n]+)\)/g;
    let sourceIndex = 0;
    let renderedIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const plainLength = match.index - sourceIndex;
      if (wanted <= renderedIndex + plainLength) return sourceIndex + (wanted - renderedIndex);
      renderedIndex += plainLength;
      const label = match[1];
      if (wanted <= renderedIndex + label.length) return match.index + 1 + (wanted - renderedIndex);
      renderedIndex += label.length;
      sourceIndex = match.index + match[0].length;
    }
    return Math.min(source.length, sourceIndex + (wanted - renderedIndex));
  }

  function markdownRenderedOffsetForSourceOffset(sourceLine, sourceOffset) {
    const source = String(sourceLine || "");
    const wanted = Math.max(0, Math.min(source.length, Number(sourceOffset) || 0));
    const pattern = /\[([^\]\n]+)\]\(([^) \n]+)\)/g;
    let sourceIndex = 0;
    let renderedIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const plainLength = match.index - sourceIndex;
      if (wanted <= match.index) return renderedIndex + (wanted - sourceIndex);
      renderedIndex += plainLength;
      const labelStart = match.index + 1;
      const labelEnd = labelStart + match[1].length;
      if (wanted <= labelEnd) return renderedIndex + Math.max(0, wanted - labelStart);
      renderedIndex += match[1].length;
      const linkEnd = match.index + match[0].length;
      if (wanted <= linkEnd) return renderedIndex;
      sourceIndex = linkEnd;
    }
    return renderedIndex + (wanted - sourceIndex);
  }

  function markdownEditorDomPosition(sourceOffset) {
    const editor = el("docEditor");
    const highlighter = el("docHighlighter");
    if (!editor || !highlighter) return null;
    const safeOffset = Math.max(0, Math.min(editor.value.length, Number(sourceOffset) || 0));
    const before = editor.value.slice(0, safeOffset);
    const lineIndex = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    const sourceLine = editor.value.split("\n")[lineIndex] || "";
    let renderedOffset = markdownRenderedOffsetForSourceOffset(sourceLine, safeOffset - lineStart);
    const line = highlighter.querySelector('.markdown-line[data-line-index="' + lineIndex + '"]');
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const length = node.nodeValue?.length || 0;
      if (renderedOffset <= length) return { node, offset: renderedOffset, line };
      renderedOffset -= length;
      node = walker.nextNode();
    }
    return { node: line, offset: line.childNodes.length, line };
  }

  function markdownCaretRect(position) {
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    const direct = range.getClientRects()[0];
    if (direct) return direct;
    if (position.node.nodeType === Node.TEXT_NODE && position.offset > 0) {
      range.setStart(position.node, position.offset - 1);
      range.setEnd(position.node, position.offset);
      const previous = range.getBoundingClientRect();
      return { left: previous.right, top: previous.top, height: previous.height };
    }
    const lineRect = position.line.getBoundingClientRect();
    return { left: lineRect.left, top: lineRect.top, height: Number.parseFloat(getComputedStyle(position.line).lineHeight) || 24 };
  }

  function updateMarkdownEditorVisualSelection() {
    const editor = el("docEditor");
    const highlighter = el("docHighlighter");
    const caret = el("markdownEditorCaret");
    if (!editor || !highlighter || !caret) return;
    if (globalThis.CSS?.highlights) CSS.highlights.delete("markdown-editor-selection");
    const focused = document.activeElement === editor;
    const collapsed = editor.selectionStart === editor.selectionEnd;
    caret.hidden = !focused || !collapsed;
    if (focused && collapsed) {
      const position = markdownEditorDomPosition(editor.selectionStart);
      const rect = markdownCaretRect(position);
      const shellRect = caret.parentElement.getBoundingClientRect();
      if (rect) {
        caret.style.left = (rect.left - shellRect.left) + "px";
        caret.style.top = (rect.top - shellRect.top) + "px";
        caret.style.height = Math.max(16, rect.height || 0) + "px";
      }
    }
    if (!focused || collapsed || !globalThis.CSS?.highlights || typeof Highlight !== "function") return;
    const start = markdownEditorDomPosition(editor.selectionStart);
    const end = markdownEditorDomPosition(editor.selectionEnd);
    if (!start || !end) return;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    CSS.highlights.set("markdown-editor-selection", new Highlight(range));
  }

  // ---- Find and replace in the editor, on top of the editor's own undo history.
  function wireEditorFind(editor) {
    const previous = state.editorFind;
    const wasOpen = Boolean(previous?.isOpen);
    if (previous) state.editorFindValues = previous.values;
    state.editorFind = null;
    loadTextTools().then((tools) => {
      if (!editor.isConnected) return;
      const apply = (value, selection) => {
        const history = prepareMarkdownEditorHistory(editor);
        history.past.push(markdownEditorHistorySnapshot(editor));
        if (history.past.length > 200) history.past.shift();
        history.future.length = 0;
        editor.value = value;
        editor.setSelectionRange(selection.start, selection.end);
        history.pending = null;
        history.current = markdownEditorHistorySnapshot(editor);
        resetMarkdownEditorHistoryGroup();
        syncMarkdownEditorValue(editor);
        updateEditorHistoryButtons();
      };
      const select = (start, end) => {
        editor.setSelectionRange(start, end);
        tools.revealTextareaOffset(editor, start);
        updateMarkdownEditorVisualSelection();
      };
      const bar = tools.createFindBar({ getText: () => editor.value, select, apply, onClose: () => { state.editorFindValues = bar.values; try { editor.focus({ preventScroll: true }); } catch {} } });
      bar.values = state.editorFindValues || {};
      (editor.closest(".markdown-editor-shell") || editor).before(bar.element);
      state.editorFind = bar;
      if (wasOpen || state.editorFindWanted) {
        state.editorFindWanted = false;
        bar.open({ caret: editor.selectionStart, keepQuery: wasOpen });
      }
    }).catch((error) => setStatus(error.message));
  }

  function openEditorFind() {
    const editor = el("docEditor");
    if (!editor) return;
    const bar = state.editorFind;
    if (!bar || !bar.element.isConnected) { state.editorFindWanted = true; return; }
    bar.open({ caret: editor.selectionStart, selectedText: editor.value.slice(editor.selectionStart, editor.selectionEnd) });
  }

  return { wireRenderedMarkdownEditor, editorHistoryAvailable, applyMarkdownEditorHistory, markdownEditorDomPosition, updateMarkdownEditorVisualSelection, openEditorFind, readerSourceOffset };
}
