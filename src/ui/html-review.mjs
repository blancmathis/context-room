// Visual review of a changed HTML page (T-html-diff). Loads on demand from app.mjs.
// The accepted page and the new page are compared block by block (headings, paragraphs, lists, tables,
// images, leaf boxes). The new page shows Added / Changed / Removed frames; a section where most blocks
// changed shows one « Rewritten » frame. A tap on a frame shows the earlier version in place.

// A section is « Rewritten » when it has at least REWRITE_MIN_BLOCKS blocks and at least REWRITE_SHARE of
// its blocks (removed ones included) changed: below that, single frames stay few and say more.
export const REWRITE_MIN_BLOCKS = 3, REWRITE_SHARE = 0.6;

const BLOCK = /^(H[1-6]|P|UL|OL|DL|TABLE|PRE|BLOCKQUOTE|FIGURE|IMG|SVG|HR|VIDEO|CANVAS|PICTURE|FORM|DETAILS)$/;
const SKIP = /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT|LINK|META|TITLE)$/;
const INNER = "h1,h2,h3,h4,h5,h6,p,ul,ol,dl,table,pre,blockquote,figure,img,svg,hr,video,canvas,picture,form,details,div,section,article,main,header,footer,nav,aside";

// Blocks of a parsed document in reading order: { el, t: tag, k: comparison key, s: section id }.
export function extractBlocks(doc) {
  const out = [];
  let sec = 0;
  const walk = (parent) => {
    for (const el of parent.children) {
      const t = el.tagName.toUpperCase();
      if (SKIP.test(t)) continue;
      if (/^H[1-3]$/.test(t)) sec += 1;
      const text = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (BLOCK.test(t) || text || !el.querySelector(INNER)) {
        const media = [...el.querySelectorAll("img,source,video"), el].map((node) => node.getAttribute?.("src") || "").join(" ");
        out.push({ el, t, k: t + "|" + el.textContent.replace(/\s+/g, " ").trim() + "|" + media.trim(), s: sec });
      } else if (t === "SECTION" || t === "ARTICLE") {
        sec += 1; walk(el); sec += 1;
      } else walk(el);
    }
  };
  if (doc.body) walk(doc.body);
  return out;
}

// Aligns two block lists. ops: { type: same | changed | added | removed, a?, b? } in reading order of the
// new page (removed ops sit where the block was). units: what the reader steps through.
export function diffBlocks(a, b) {
  let p = 0, q = 0;
  while (p < a.length && p < b.length && a[p].k === b[p].k) p += 1;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q].k === b[b.length - 1 - q].k) q += 1;
  const n = a.length - p - q, m = b.length - p - q, pairs = [];
  for (let i = 0; i < p; i += 1) pairs.push([i, i]);
  // Above 4 M cells the middle stays one replaced run (no quadratic table on a huge page).
  if (n && m && n * m <= 4e6) {
    const w = m + 1, T = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) {
      T[i * w + j] = a[p + i].k === b[p + j].k ? T[(i + 1) * w + j + 1] + 1 : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[p + i].k === b[p + j].k) { pairs.push([p + i, p + j]); i += 1; j += 1; }
      else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) i += 1;
      else j += 1;
    }
  }
  for (let i = 0; i < q; i += 1) pairs.push([a.length - q + i, b.length - q + i]);
  pairs.push([a.length, b.length]);
  const ops = [];
  let ai = 0, bi = 0;
  for (const [ae, be] of pairs) {
    // In a gap, an old and a new block of the same tag, in order, are one changed block.
    let r = ai;
    for (; bi < be; bi += 1) {
      let i = r;
      while (i < ae && a[i].t !== b[bi].t) i += 1;
      if (i < ae) {
        for (; r < i; r += 1) ops.push({ type: "removed", a: r });
        ops.push({ type: "changed", a: i, b: bi });
        r = i + 1;
      } else ops.push({ type: "added", b: bi });
    }
    for (; r < ae; r += 1) ops.push({ type: "removed", a: r });
    if (ae < a.length) ops.push({ type: "same", a: ae, b: be });
    ai = ae + 1; bi = be + 1;
  }
  return { ops, units: groupUnits(ops, a, b) };
}

// A removed block joins the section of the shown block after it when both were in the same old section,
// else the section of the shown block before it. Only removed blocks of the section's own old section count
// toward « Rewritten »: a whole deleted section stays one « N blocks removed » line.
function groupUnits(ops, a, b) {
  const n = ops.length, prev = [], next = [];
  for (let i = 0, p = -1; i < n; i += 1) { if ("b" in ops[i]) p = i; prev[i] = p; }
  for (let i = n - 1, q = -1; i >= 0; i -= 1) { if ("b" in ops[i]) q = i; next[i] = q; }
  const oldSec = (x) => x >= 0 && "a" in ops[x] ? a[ops[x].a].s : NaN;
  const secOf = ops.map((op, i) => {
    if ("b" in op) return b[op.b].s;
    const home = next[i] >= 0 && (prev[i] < 0 || oldSec(next[i]) === a[op.a].s) ? next[i] : prev[i];
    return home < 0 ? null : b[ops[home].b].s;
  });
  const units = [];
  for (let i = 0; i < n;) {
    let e = i;
    while (e < n && secOf[e] === secOf[i]) e += 1;
    const idx = Array.from({ length: e - i }, (_, x) => i + x);
    const homes = new Set(idx.filter((x) => "a" in ops[x] && "b" in ops[x]).map(oldSec));
    const own = idx.filter((x) => "b" in ops[x] || !homes.size || homes.has(oldSec(x)));
    const shown = own.filter((x) => "b" in ops[x]).length;
    const moved = own.filter((x) => ops[x].type !== "same");
    const removed = moved.length - moved.filter((x) => "b" in ops[x]).length;
    const rewrite = shown >= REWRITE_MIN_BLOCKS && moved.length / (shown + removed) >= REWRITE_SHARE;
    let whole = null;
    for (const x of idx) {
      const type = ops[x].type, last = units.at(-1);
      if (rewrite && own.includes(x)) {
        if (!whole) units.push(whole = { kind: !removed && moved.length === shown && moved.every((y) => ops[y].type === "added") ? "added" : "rewritten", ops: [] });
        whole.ops.push(x);
      } else if (type === "removed" && last?.kind === "removed" && last.ops.at(-1) === x - 1) last.ops.push(x);
      else if (type !== "same") units.push({ kind: type, ops: [x] });
    }
    i = e;
  }
  return units;
}

const LABEL = { added: "Added", changed: "Changed", rewritten: "Rewritten", removed: "Removed" };
const FRAME_CSS = "[data-cr-hide]{display:none!important}.cr-gone{margin:12px 0;padding:8px 12px;border-top:3px dotted #333;font:600 14px/1.4 system-ui,sans-serif;color:#222;background:#eee;cursor:pointer}"
  + ".cr-was{outline:2px dashed #555;outline-offset:2px}.cr-layer{position:absolute;top:0;left:0;width:100px;height:0;pointer-events:none;z-index:2147483647}"
  + ".cr-box{position:absolute;box-sizing:border-box;border:3px solid #222;border-radius:4px}.cr-box.added{border-style:double;border-width:5px}.cr-box.rewritten{border-width:4px}.cr-box.cur{box-shadow:0 0 0 4px rgba(0,0,0,.25)}"
  + ".cr-tag{position:absolute;left:-3px;top:-24px;padding:2px 8px;background:#222;color:#fff;font:700 12px/20px system-ui,sans-serif;white-space:nowrap;border-radius:3px}";
const UI_CSS = ".crh-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0}.crh-bar button{min-height:44px;min-width:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text);font:inherit;cursor:pointer}"
  + ".crh-bar button[aria-pressed=true]{background:var(--text);color:var(--file-bg,#fff)}.crh-seg{display:inline-flex}.crh-seg button+button{margin-left:-1px}.crh-note{font-weight:700}.crh-count{min-width:56px;text-align:center;color:var(--muted)}"
  + ".crh-frames{position:relative;display:grid}.crh-frames iframe{display:block;width:100%;height:calc(100vh - 214px);min-height:420px;border:0;background:var(--file-bg)}.crh .html-preview-shell{max-height:none;min-height:0}"
  + ".crh-frames iframe[data-off],.crh-frames.both .crh-old{position:absolute;inset:0;visibility:hidden}.crh-both{display:none}"
  + "@media (min-width:1280px){.crh-both{display:inline-flex}.crh-frames.both{grid-template-columns:1fr 1fr;gap:8px}.crh-frames.both iframe{order:2}.crh-frames.both .crh-old{position:static;visibility:visible;order:1}}";

// Per project and page: mode, current change, open « before » blocks and reading place. A new render of the
// view (a background refresh) keeps them while both versions stay the same.
const prefs = new Map();
let keysWired = false, active = null;

function frameTag(cls, title, src) {
  const f = document.createElement("iframe");
  f.className = cls;
  f.setAttribute("sandbox", "allow-same-origin allow-scripts");
  f.setAttribute("referrerpolicy", "no-referrer");
  f.title = title;
  f.srcdoc = src;
  return f;
}

function addStyle(doc, css) {
  const s = doc.createElement("style");
  s.textContent = css;
  doc.head.append(s);
}

// root: the empty [data-html-review] box. change: the review (path, baseContent, diskContent, changeKind).
// The app's helpers (globals of its classic script) give the accepted text, sanitize both pages and wire the
// first frame (links, zoom), so app.mjs only calls mount().
export function mount(root, change) {
  if (!root.isConnected) return;
  const path = change.path || "document", afterText = change.diskContent || "", beforeText = externalReviewBaseContent(change);
  const deleted = change.changeKind === "deleted" || (!afterText.trim() && beforeText.trim());
  const added = !deleted && (change.changeKind === "added" || !beforeText.trim());
  const key = state.projectId + "\n" + path, sig = beforeText + "\0" + afterText;
  let pref = prefs.get(key);
  if (pref?.sig !== sig) prefs.set(key, pref = { sig, mode: pref?.mode || "after", cur: -1, open: [], place: null });
  if (!document.querySelector("style[data-crh]")) {
    const s = document.createElement("style");
    s.dataset.crh = "";
    s.textContent = UI_CSS;
    document.head.append(s);
  }
  const single = added || deleted;
  const oldSrc = sanitizedHtmlPreviewDocument(beforeText), newSrc = sanitizedHtmlPreviewDocument(afterText);
  let diff = { ops: [], units: [] }, styleOnly = false;
  if (!single) {
    const parse = (src) => new DOMParser().parseFromString(src, "text/html");
    diff = diffBlocks(extractBlocks(parse(oldSrc)), extractBlocks(parse(newSrc)));
    styleOnly = !diff.units.length && beforeText.trim() !== afterText.trim();
  }
  const units = diff.units, total = units.length;
  if (pref.cur >= total) pref.cur = -1;
  const note = deleted ? "Page deleted" : added ? "New page" : total ? total + (total === 1 ? " change" : " changes") : styleOnly ? "Style changed" : "No visible change";
  root.className = "crh";
  root.innerHTML = '<div class="crh-bar" role="toolbar" aria-label="Page changes"><span class="crh-note" data-crh-note>' + note + "</span>"
    + (single ? "" : '<span class="crh-seg"><button type="button" data-crh-mode="before" title="Show the accepted page (B)">Before</button><button type="button" data-crh-mode="after" title="Show the new page (B)">After</button></span><button type="button" class="crh-both" data-crh-mode="both" title="Before and after side by side">Side by side</button>')
    + (total ? '<button type="button" data-crh-step="-1" aria-label="Previous change" title="Previous change (Shift+N)">↑</button><span class="crh-count" aria-live="polite" data-crh-count></span><button type="button" data-crh-step="1" title="Next change (N)">Next change ↓</button>' : "")
    + '</div><div class="html-preview-shell"><div class="crh-frames"></div></div>';
  const box = root.querySelector(".crh-frames");
  const label = (what) => "HTML preview: " + path + (what ? " (" + what + ")" : "");
  // The first frame keeps the app's class, so links, zoom and scroll memory work as before. The app wires it
  // first, so its zoom is on the page before the reading place is restored below.
  const main = frameTag("html-preview-frame", label(deleted ? "deleted page" : ""), deleted ? oldSrc : newSrc);
  box.append(main);
  wireHtmlPreviewNavigation();
  const old = single ? null : frameTag("crh-old", label("before"), oldSrc);
  if (old) box.append(old);
  const view = { root, main, old, units, ops: diff.ops, pref, total };
  active = view;
  const ready = (frame, setup) => {
    const run = () => { const doc = frame.contentDocument; if (doc?.body && doc.URL === "about:srcdoc" && doc.readyState !== "loading" && frame.__crh !== doc) { frame.__crh = doc; setup(doc); } };
    frame.addEventListener("load", run);
    run();
  };
  // The reading place of the page on screen, kept for the next render.
  const track = (frame, doc) => doc.addEventListener("scroll", () => { if (!frame.hasAttribute("data-off")) pref.place = placeOf(doc); }, { passive: true });
  // The earlier page follows every zoom (reading size) of the new one.
  const zoom = () => {
    const from = main.contentDocument?.documentElement?.style, to = old?.contentDocument?.documentElement?.style;
    if (from && to) { to.zoom = from.zoom; to.fontSize = from.fontSize; }
  };
  ready(main, (doc) => {
    doc.addEventListener("keydown", onKey);
    if (single) return;
    new MutationObserver(zoom).observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
    zoom();
    markAfter(view, doc);
    pref.open.forEach((u) => toggleOld(view, u));
    goTo(main, pref.place);
    track(main, doc);
  });
  if (old) ready(old, (doc) => {
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("click", (event) => { if (event.target.closest?.("a[href]")) event.preventDefault(); });
    zoom();
    extractBlocks(doc).forEach((block, i) => { const op = view.ops.findIndex((o) => o.a === i); if (op >= 0) block.el.dataset.crR = op; });
    goTo(old, pref.place);
    track(old, doc);
  });
  root.querySelectorAll("[data-crh-mode]").forEach((button) => button.addEventListener("click", () => setMode(view, button.dataset.crhMode)));
  root.querySelectorAll("[data-crh-step]").forEach((button) => button.addEventListener("click", () => step(view, Number(button.dataset.crhStep))));
  applyMode(view);
  showCount(view);
  if (!keysWired) { keysWired = true; document.addEventListener("keydown", onKey); }
}

// Every shown block gets its row (data-cr-r), even with no change, so Before | After keeps the place.
function markAfter(view, doc) {
  const blocks = extractBlocks(doc), { ops, units } = view, at = (op) => blocks[op.b]?.el;
  ops.forEach((op, i) => { if (at(op)) at(op).dataset.crR = i; });
  if (!view.total) return;
  addStyle(doc, FRAME_CSS);
  const oldBlocks = extractBlocks(new DOMParser().parseFromString(view.old.srcdoc, "text/html"));
  const layer = doc.createElement("div");
  layer.className = "cr-layer";
  doc.documentElement.append(layer);
  units.forEach((unit, u) => {
    unit.els = [];
    unit.old = [];
    for (const x of unit.ops) {
      // The live page can hold other blocks than the parsed copy (a <noscript> runs differently): skip a miss.
      const op = ops[x], el = at(op);
      if (el) { el.dataset.crU = u; unit.els.push(el); }
      else if (unit.kind === "removed" && x === unit.ops[0]) {
        // One line where removed blocks were: before the next shown block, else after the last one.
        const line = doc.createElement("div");
        line.className = "cr-gone";
        line.dataset.crU = u;
        line.dataset.crR = x;
        const count = unit.ops.length;
        line.textContent = count + (count === 1 ? " block removed" : " blocks removed");
        const next = ops.slice(x).find(at), prev = ops.slice(0, x).findLast(at);
        if (next) at(next).before(line);
        else if (prev) at(prev).after(line);
        else doc.body.append(line);
        unit.els.push(line);
      }
      // A rewritten section shows all its earlier blocks, unchanged ones included.
      if ("a" in op && oldBlocks[op.a]) unit.old.push(oldBlocks[op.a].el);
    }
  });
  view.doc = doc;
  view.layer = layer;
  doc.addEventListener("click", (event) => {
    if (event.target.closest?.("a[href], [data-cr-document]")) return;
    const hit = event.target.closest?.("[data-cr-u]");
    if (hit) toggleOld(view, Number(hit.dataset.crU));
  });
  const redraw = () => drawFrames(view);
  new ResizeObserver(redraw).observe(doc.body);
  doc.addEventListener("load", redraw, true);
  redraw();
}

// A tap shows the unit's earlier blocks in place of the new ones; a second tap brings the new ones back.
function toggleOld(view, u) {
  const unit = view.units[u], doc = view.doc;
  if (!unit?.els?.length) return;
  if (unit.shown) {
    unit.shown.forEach((node) => node.remove());
    unit.els.forEach((el) => delete el.dataset.crHide);
    unit.shown = null;
  } else {
    unit.shown = unit.old.map((el) => {
      const copy = doc.importNode(el, true);
      copy.classList.add("cr-was");
      copy.dataset.crU = u;
      return copy;
    });
    if (!unit.shown.length) {
      const none = doc.createElement("div");
      none.className = "cr-gone";
      none.dataset.crU = u;
      none.textContent = "Not in the earlier version";
      unit.shown.push(none);
    }
    unit.els[0].before(...unit.shown);
    unit.els.forEach((el) => { el.dataset.crHide = ""; });
  }
  view.pref.open = view.units.flatMap((one, i) => one.shown ? [i] : []);
  drawFrames(view);
}

function drawFrames(view) {
  const { layer, units } = view;
  if (!layer?.isConnected) return;
  const base = layer.getBoundingClientRect(), scale = base.width / 100 || 1;
  const html = [];
  units.forEach((unit, u) => {
    const els = unit.shown || unit.els;
    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      top = Math.min(top, r.top); left = Math.min(left, r.left); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
    if (top === Infinity) return;
    const pad = 6, k = (v) => Math.round(v / scale);
    const word = unit.shown ? "Before" : LABEL[unit.kind];
    html.push('<div class="cr-box ' + unit.kind + (u === view.pref.cur ? " cur" : "") + '" style="top:' + k(top - base.top - pad) + "px;left:" + k(left - base.left - pad) + "px;width:" + k(right - left + 2 * pad) + "px;height:" + k(bottom - top + 2 * pad) + 'px"><span class="cr-tag">' + word + (unit.shown ? "" : " · tap for before") + "</span></div>");
  });
  layer.innerHTML = html.join("");
}

function showCount(view) {
  const count = view.root.querySelector("[data-crh-count]");
  if (count) count.textContent = (view.pref.cur >= 0 ? view.pref.cur + 1 : "–") + " / " + view.total;
}

function step(view, delta) {
  if (!view.total) return;
  if (view.pref.mode === "before") setMode(view, "after");
  const cur = view.pref.cur;
  view.pref.cur = cur < 0 ? (delta > 0 ? 0 : view.total - 1) : (cur + delta + view.total) % view.total;
  showCount(view);
  drawFrames(view);
  const unit = view.units[view.pref.cur], win = view.main.contentWindow;
  const el = (unit?.shown || unit?.els || [])[0];
  if (el && win) win.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + win.scrollY - 64) });
}

function setMode(view, mode) {
  if (mode === view.pref.mode) return;
  const from = view.pref.mode === "before" ? view.old : view.main, to = mode === "before" ? view.old : view.main;
  view.pref.mode = mode;
  applyMode(view);
  // The block at the top of the page shown stays at the top of the other one.
  if (from !== to && from.contentDocument) goTo(to, placeOf(from.contentDocument));
}

function applyMode(view) {
  const { mode } = view.pref;
  view.root.querySelectorAll("[data-crh-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.crhMode === mode)));
  if (!view.old) return;
  view.root.querySelector(".crh-frames").classList.toggle("both", mode === "both");
  view.main.toggleAttribute("data-off", mode === "before");
  view.old.toggleAttribute("data-off", mode === "after");
}

// The first row on screen and its offset from the top of the frame.
function placeOf(doc) {
  const top = [...doc.querySelectorAll("[data-cr-r]")].find((el) => el.getBoundingClientRect().bottom > 0);
  return top ? { r: Number(top.dataset.crR), off: top.getBoundingClientRect().top } : null;
}

function goTo(frame, place) {
  const doc = frame.contentDocument, rows = place && doc ? [...doc.querySelectorAll("[data-cr-r]")] : [];
  const target = rows.findLast((el) => Number(el.dataset.crR) <= place.r && el.getClientRects().length) || rows[0];
  if (target) frame.contentWindow.scrollBy(0, target.getBoundingClientRect().top - place.off);
}

function onKey(event) {
  const view = active;
  if (!view?.root.isConnected || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) { if (!view?.root.isConnected) active = null; return; }
  if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
  const key = event.key;
  if ((key === "b" || key === "B") && view.old) setMode(view, view.pref.mode === "before" ? "after" : "before");
  else if (key === "n" || key === "N") step(view, event.shiftKey ? -1 : 1);
  else return;
  event.preventDefault();
}
