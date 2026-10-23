// Reading and editing helpers shared by the document view and the working-draft editor.
// The pure functions run in Node tests; createFindBar is the only part that touches the DOM.

const ACCENT_MARKS = /[̀-ͯ]/g;
const UNIT_TO_FOLD = /[A-Z]+|[^\x00-\x7f]/g;
export const CONTENTS_PAGE_SIZE = 40;
export const FIND_LIMIT = 10_000;

function foldUnit(unit) {
  // A UTF-16 unit is folded only if it stays one unit, so a folded index is also a real index.
  const folded = unit.normalize("NFD").replace(ACCENT_MARKS, "").toLowerCase();
  return folded.length === 1 ? folded : unit;
}

/** Lowercase and drop accents without changing the length of the text. */
export function foldForSearch(value) {
  const text = String(value ?? "");
  return text.replace(UNIT_TO_FOLD, (part) => part <= "\x7f" ? part.toLowerCase() : foldUnit(part));
}

/** Start indexes of every match, up to `limit`; `more` says the count was cut. `exact` keeps case and accents. */
export function findMatches(text, query, { exact = false, limit = FIND_LIMIT } = {}) {
  const needle = exact ? String(query ?? "") : foldForSearch(query);
  const result = { starts: [], length: needle.length, more: false };
  if (!needle) return result;
  const haystack = exact ? String(text ?? "") : foldForSearch(text);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (result.starts.length >= limit) { result.more = true; break; }
    result.starts.push(at);
  }
  return result;
}

/** Replace every match in one pass. The count is exact, even past the display bound. */
export function replaceAllText(text, query, replacement, { exact = false } = {}) {
  const value = String(text ?? "");
  const needle = exact ? String(query ?? "") : foldForSearch(query);
  if (!needle) return { text: value, count: 0 };
  const haystack = exact ? value : foldForSearch(value);
  const parts = [];
  let last = 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, last)) {
    parts.push(value.slice(last, at), replacement);
    last = at + needle.length;
    count += 1;
  }
  if (!count) return { text: value, count: 0 };
  parts.push(value.slice(last));
  return { text: parts.join(""), count };
}

const foldedTitles = new WeakMap();
function foldedEntryText(entries, index) {
  let cache = foldedTitles.get(entries);
  if (!cache) foldedTitles.set(entries, cache = []);
  return cache[index] ?? (cache[index] = foldForSearch(entries[index].text).replace(/\s+/g, " "));
}

/**
 * One page of a long list of headings. `active` is the index of the current heading in `entries`;
 * without `start`, the page that holds it opens first. Every item keeps its index in `entries`.
 */
export function contentsPage(entries, { query = "", start = null, active = -1, pageSize = CONTENTS_PAGE_SIZE } = {}) {
  const needle = foldForSearch(String(query ?? "").trim()).replace(/\s+/g, " ");
  let indexes;
  if (needle) {
    indexes = [];
    for (let index = 0; index < entries.length; index += 1) if (foldedEntryText(entries, index).includes(needle)) indexes.push(index);
  }
  const total = indexes ? indexes.length : entries.length;
  const position = active < 0 ? 0 : indexes ? Math.max(0, indexes.indexOf(active)) : active;
  const lastStart = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
  const wanted = Number.isFinite(start) ? start : Math.floor(position / pageSize) * pageSize;
  const first = Math.min(lastStart, Math.max(0, Math.floor(wanted / pageSize) * pageSize));
  const end = Math.min(total, first + pageSize);
  const items = [];
  for (let at = first; at < end; at += 1) {
    const index = indexes ? indexes[at] : at;
    items.push({ ...entries[index], index });
  }
  return { items, start: first, end, total, hasPrevious: first > 0, hasNext: end < total };
}

/** Undo and redo for a big text, bounded by characters (16 MiB drafts times many steps would not fit in memory). */
export function createTextHistory({ maxChars = 64 * 2 ** 20, maxSteps = 200 } = {}) {
  let past = [];
  let future = [];
  let chars = 0;
  const size = (item) => item.length;
  return {
    /** Remember `before` as the state to return to, then forget redo. */
    push(before) {
      if (past.length && past[past.length - 1] === before) return;
      past.push(before);
      chars += size(before);
      for (const item of future) chars -= size(item);
      future = [];
      while (past.length > 1 && (chars > maxChars || past.length > maxSteps)) chars -= size(past.shift());
    },
    undo(current) {
      if (!past.length) return null;
      const value = past.pop();
      chars -= size(value);
      future.push(current);
      chars += size(current);
      return value;
    },
    redo(current) {
      if (!future.length) return null;
      const value = future.pop();
      chars -= size(value);
      past.push(current);
      chars += size(current);
      return value;
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get steps() { return past.length; },
    get chars() { return chars; },
    clear() { past = []; future = []; chars = 0; },
  };
}

/** Scroll so the character at `offset` of a textarea is visible: the textarea itself, or the nearest scrolling parent when it grows with its text. */
export function revealTextareaOffset(textarea, offset) {
  const text = textarea.value;
  const style = getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight) || 24;
  let top;
  if (text.length <= 200_000) {
    const mirror = document.createElement("div");
    for (const name of ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderLeftWidth", "borderRightWidth", "borderLeftStyle", "borderRightStyle", "tabSize", "whiteSpace", "overflowWrap", "wordBreak"]) mirror.style[name] = style[name];
    mirror.style.cssText += ";position:absolute;visibility:hidden;top:0;left:-9999px;height:auto;overflow:hidden";
    mirror.textContent = text.slice(0, offset);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.append(marker);
    document.body.append(mirror);
    top = marker.offsetTop;
    mirror.remove();
  } else top = textarea.scrollHeight * offset / Math.max(1, text.length);
  let scroller = textarea;
  if (!(textarea.scrollHeight > textarea.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY))) {
    scroller = textarea.parentElement;
    while (scroller && scroller !== document.body && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!scroller || scroller === document.body) scroller = document.scrollingElement;
  }
  const inside = scroller === textarea ? 0 : textarea.getBoundingClientRect().top - (scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop;
  const wanted = inside + top;
  const height = scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight;
  if (wanted < scroller.scrollTop + lineHeight || wanted > scroller.scrollTop + height - 2 * lineHeight) scroller.scrollTop = Math.max(0, wanted - height / 3);
}

const NUMBER = new Intl.NumberFormat("en-US");
export function formatCount(value, more = false) { return NUMBER.format(value) + (more ? "+" : ""); }

/**
 * A Find / Replace bar. The host owns the text and its history:
 * `getText()` returns the current text, `select(start, end)` shows a match,
 * `apply(text, { start, end })` makes one undoable edit (Replace one, Replace all).
 */
export function createFindBar({ getText, select, apply, onClose = () => {} }) {
  const bar = document.createElement("div");
  bar.className = "find-bar";
  bar.setAttribute("role", "search");
  bar.setAttribute("aria-label", "Find and replace");
  bar.hidden = true;
  bar.innerHTML = '<input type="search" data-find-query aria-label="Find" placeholder="Find" autocomplete="off" spellcheck="false">'
    + '<input type="text" data-find-replacement aria-label="Replace with" placeholder="Replace with" autocomplete="off" spellcheck="false">'
    + '<button type="button" data-find-previous>Previous</button><button type="button" data-find-next>Next</button>'
    + '<button type="button" data-find-replace>Replace</button><button type="button" data-find-replace-all>Replace all</button>'
    + '<label class="find-exact"><input type="checkbox" data-find-exact> Exact (case and accents)</label>'
    + '<span class="find-count" data-find-count role="status" aria-live="polite"></span>'
    + '<button type="button" data-find-close>Close</button>';
  const queryInput = bar.querySelector("[data-find-query]");
  const replacementInput = bar.querySelector("[data-find-replacement]");
  const exactInput = bar.querySelector("[data-find-exact]");
  const count = bar.querySelector("[data-find-count]");
  let current = -1;
  let result = { starts: [], length: 0, more: false };
  let cacheText = null;
  let caretAt = 0;

  const run = () => {
    const text = getText();
    cacheText = text;
    result = findMatches(text, queryInput.value, { exact: exactInput.checked });
    return result;
  };
  const show = () => {
    const total = result.starts.length;
    count.textContent = !queryInput.value ? ""
      : !total ? "No matches"
      : current >= 0 && !result.more ? (current + 1) + " of " + formatCount(total)
      : formatCount(total, result.more) + (total === 1 ? " match" : " matches");
    for (const name of ["previous", "next", "replace", "replace-all"]) bar.querySelector("[data-find-" + name + "]").disabled = !total;
  };
  const goto = (index) => {
    if (!result.starts.length) return;
    current = (index + result.starts.length) % result.starts.length;
    const start = result.starts[current];
    select(start, start + result.length);
    show();
  };
  const refresh = ({ keep = false } = {}) => {
    run();
    current = keep && result.starts.length ? Math.min(current, result.starts.length - 1) : -1;
    show();
  };
  const next = (step) => {
    if (cacheText !== getText()) refresh({ keep: true });
    if (current < 0) {
      const caret = caretAt;
      const found = step > 0 ? result.starts.findIndex((start) => start >= caret) : result.starts.findLastIndex((start) => start < caret);
      goto(found < 0 ? (step > 0 ? 0 : result.starts.length - 1) : found);
    } else goto(current + step);
  };
  const replaceOne = () => {
    if (cacheText !== getText()) refresh({ keep: true });
    if (current < 0) next(1);
    if (current < 0) return;
    const text = getText();
    const start = result.starts[current];
    const replacement = replacementInput.value;
    apply(text.slice(0, start) + replacement + text.slice(start + result.length), { start, end: start + replacement.length });
    const at = start + replacement.length;
    run();
    current = -1;
    const found = result.starts.findIndex((candidate) => candidate >= at);
    if (result.starts.length) goto(found < 0 ? 0 : found); else show();
  };
  const replaceEverything = () => {
    if (!queryInput.value) return;
    const text = getText();
    const done = replaceAllText(text, queryInput.value, replacementInput.value, { exact: exactInput.checked });
    if (!done.count) return;
    apply(done.text, { start: 0, end: 0 });
    run();
    current = -1;
    show();
    count.textContent = "Replaced " + formatCount(done.count) + (done.count === 1 ? " match" : " matches");
  };

  let timer = 0;
  queryInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => refresh(), 120); });
  exactInput.addEventListener("change", () => refresh());
  queryInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    clearTimeout(timer);
    next(event.shiftKey ? -1 : 1);
  });
  replacementInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); replaceOne(); } });
  bar.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); api.close(); } });
  bar.querySelector("[data-find-previous]").addEventListener("click", () => next(-1));
  bar.querySelector("[data-find-next]").addEventListener("click", () => next(1));
  bar.querySelector("[data-find-replace]").addEventListener("click", replaceOne);
  bar.querySelector("[data-find-replace-all]").addEventListener("click", replaceEverything);
  bar.querySelector("[data-find-close]").addEventListener("click", () => api.close());

  const api = {
    element: bar,
    /** `caret` is where the search starts when no match is current yet. */
    open({ caret = 0, selectedText = "", keepQuery = false } = {}) {
      caretAt = caret;
      bar.hidden = false;
      if (!keepQuery && selectedText && !/\n/.test(selectedText) && selectedText.length <= 200) queryInput.value = selectedText;
      refresh();
      queryInput.focus();
      queryInput.select();
    },
    close() { bar.hidden = true; onClose(); },
    get isOpen() { return !bar.hidden; },
    get values() { return { query: queryInput.value, replacement: replacementInput.value, exact: exactInput.checked }; },
    set values(next) { queryInput.value = next.query ?? ""; replacementInput.value = next.replacement ?? ""; exactInput.checked = Boolean(next.exact); },
    refresh,
  };
  return api;
}
