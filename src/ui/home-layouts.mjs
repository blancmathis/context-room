// Prototype (T-021): two layouts for the global Home, behind ?homeLayout=a|b.
// One project list. Files of every type. A view the person sets up with one tap: pin, hide, type, sort.
// E-ink rules: grey, targets of 44 px or more, no animation, breakpoints 639, 980/981 and 1279/1280 only.

export const HOME_LAYOUTS = ['a', 'b'];
export const HOME_TYPES = [['all', 'All'], ['md', 'Markdown'], ['html', 'HTML'], ['crnb', 'Notebooks'], ['image', 'Images'], ['other', 'Other']];
export const HOME_FILE_SORTS = [['name', 'Name'], ['recent', 'Modified'], ['type', 'Type']];
export const HOME_PROJECT_SORTS = [['name', 'Name'], ['opened', 'Last opened'], ['reviews', 'Reviews']];
const PREFS_KEY = 'context-room.home.v1';
const TYPE_TAG = { folder: 'DIR', md: 'MD', html: 'HTML', crnb: 'NB', image: 'IMG', other: 'TXT' };

export const defaultHomePrefs = () => ({ pinned: [], hidden: [], projectSort: 'opened', fileSort: 'name', type: 'all', showShared: false });

export function normalizeHomePrefs(raw) {
  const base = defaultHomePrefs();
  if (!raw || typeof raw !== 'object') return base;
  const list = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string'))] : [];
  return {
    pinned: list(raw.pinned),
    hidden: list(raw.hidden).filter(key => !list(raw.pinned).includes(key)),
    projectSort: HOME_PROJECT_SORTS.some(([id]) => id === raw.projectSort) ? raw.projectSort : base.projectSort,
    fileSort: HOME_FILE_SORTS.some(([id]) => id === raw.fileSort) ? raw.fileSort : base.fileSort,
    type: HOME_TYPES.some(([id]) => id === raw.type) ? raw.type : base.type,
    showShared: raw.showShared === true,
  };
}

/** md, html, crnb, image, other; folders stay folders. */
export function homeEntryType(entry) {
  if (entry?.type === 'directory') return 'folder';
  const name = String(entry?.name || entry?.path || '').toLowerCase();
  if (/\.(md|mdx|markdown)$/.test(name)) return 'md';
  if (/\.html?$/.test(name)) return 'html';
  if (name.endsWith('.crnb')) return 'crnb';
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(name)) return 'image';
  return 'other';
}

/** Folders first, then the chosen order. Never mutates the input. */
export function sortHomeEntries(entries, sort = 'name') {
  const text = (left, right) => String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
  return [...entries].sort((left, right) => {
    const folders = Number(homeEntryType(right) === 'folder') - Number(homeEntryType(left) === 'folder');
    if (folders) return folders;
    if (sort === 'recent') {
      const delta = Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '');
      if (Number.isFinite(delta) && delta) return delta;
    }
    if (sort === 'type') return text(homeEntryType(left), homeEntryType(right)) || text(left.name, right.name);
    return text(left.name, right.name);
  });
}

export function filterHomeEntries(entries, type = 'all') {
  return type === 'all' ? entries : entries.filter(entry => homeEntryType(entry) === 'folder' || homeEntryType(entry) === type);
}

export function countHomeTypes(entries) {
  const counts = { all: 0, md: 0, html: 0, crnb: 0, image: 0, other: 0 };
  for (const entry of entries) { const type = homeEntryType(entry); if (type !== 'folder') { counts[type] += 1; counts.all += 1; } }
  return counts;
}

const isLocal = project => Boolean(project?.root) && project.mode !== 'shared';

/**
 * Groups: pinned (in pin order), main (local, with a folder), shared (no local folder), hidden.
 * The Notebooks space counts as a main project; it keeps its own place in the list.
 */
export function groupHomeProjects(projects, prefs, { opened = () => 0 } = {}) {
  const byKey = new Map(projects.map(project => [project.projectKey, project]));
  const title = project => String(project.title || project.id || '');
  const order = {
    name: (a, b) => title(a).localeCompare(title(b), 'en', { sensitivity: 'base' }),
    opened: (a, b) => (Date.parse(b.lastOpenedAt || '') || 0) - (Date.parse(a.lastOpenedAt || '') || 0) || title(a).localeCompare(title(b), 'en'),
    reviews: (a, b) => (Number(b.localReviewCount || 0) + Number(b.sharedProposalCount || 0)) - (Number(a.localReviewCount || 0) + Number(a.sharedProposalCount || 0)) || title(a).localeCompare(title(b), 'en'),
  }[prefs.projectSort] || (() => 0);
  const hidden = projects.filter(project => prefs.hidden.includes(project.projectKey));
  const pinned = prefs.pinned.map(key => byKey.get(key)).filter(project => project && !prefs.hidden.includes(project.projectKey));
  const rest = projects.filter(project => !prefs.pinned.includes(project.projectKey) && !prefs.hidden.includes(project.projectKey));
  return {
    pinned,
    main: rest.filter(isLocal).sort(order),
    shared: rest.filter(project => !isLocal(project)).sort(order),
    hidden: hidden.sort(order),
  };
}

export function formatHomeDate(value, now = new Date()) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  const options = date.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return date.toLocaleDateString('en-GB', options);
}

const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const STYLE = `
.hl { --hl-line: var(--line); display: grid; gap: 0; min-width: 0; }
.hl h2, .hl h3 { margin: 0; }
.hl button, .hl select, .hl summary { min-height: 44px; font: inherit; color: var(--text); }
.hl button, .hl select { padding: 0 14px; border: 1px solid var(--control-line, var(--hl-line)); border-radius: 8px; background: transparent; cursor: pointer; }
.hl button[aria-pressed="true"], .hl button[aria-current="true"] { border-color: var(--text); background: var(--surface-card-hover); font-weight: 700; }
.hl button:focus-visible, .hl a:focus-visible, .hl select:focus-visible, .hl summary:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
.hl-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--hl-line); }
.hl-head p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.hl-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.hl-tools label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.hl kbd { font: 11px/1 ui-monospace, Menlo, monospace; padding: 2px 5px; border: 1px solid var(--hl-line); border-radius: 4px; }
.hl-view { border: 1px solid var(--hl-line); border-radius: 8px; }
.hl-view > summary { display: flex; align-items: center; padding: 0 14px; cursor: pointer; list-style: none; }
.hl-view-body { display: grid; gap: 10px; padding: 10px 14px 14px; border-top: 1px solid var(--hl-line); }
.hl-view-body label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
.hl-chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--hl-line); }
.hl-chips button { border-radius: 999px; }
.hl-chips small { color: var(--muted); margin-left: 6px; }
.hl-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; border-bottom: 1px solid var(--hl-line); }
.hl-row > button, .hl-row > a { min-width: 0; }
.hl-select { display: grid; gap: 2px; justify-items: start; text-align: left; border: 0 !important; border-radius: 0 !important; padding: 8px 16px !important; min-height: 56px; }
.hl-select strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.hl-select span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
.hl-star { width: 48px; padding: 0 !important; font-size: 20px; line-height: 1; border: 0 !important; }
.hl-quiet { border-color: transparent !important; color: var(--muted) !important; font-size: 12px; }
.hl-group > summary, .hl-group-title { display: flex; align-items: center; padding: 0 16px; min-height: 44px; border-bottom: 1px solid var(--hl-line); color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
.hl-group-title { cursor: default; }
.hl-empty { padding: 18px 16px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.hl-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--hl-line); font-size: 13px; }
.hl .hl-crumbs button { min-height: 44px; border-color: transparent; }
.home-layout-panel { grid-column: 1 / -1 !important; }
.hl .hl-file { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 56px; padding: 6px 16px; border-bottom: 1px solid var(--hl-line); color: var(--text); text-decoration: none; text-align: left; width: 100%; border-left: 0; border-right: 0; border-top: 0; border-radius: 0; }
.hl-file-name { min-width: 0; display: grid; gap: 2px; }
.hl-file-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.hl-file-name span { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hl-file-date { color: var(--muted); font-size: 12px; white-space: nowrap; }
.hl-tag { display: inline-grid; place-items: center; min-width: 44px; height: 28px; padding: 0 6px; border: 1px solid var(--control-line, var(--hl-line)); border-radius: 6px; color: var(--muted); font: 700 10px/1 ui-monospace, Menlo, monospace; letter-spacing: .04em; }
.hl-more { padding: 12px 16px; }
.hl-links { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--hl-line); }
.app.home-layout-on { grid-template-columns: minmax(0, 1fr) !important; }
.app.home-layout-on > aside, .app.home-layout-on > .explorer-open, .app.home-layout-on > .explorer-edge-trigger { display: none !important; }
/* Layout A: two panes */
.hl[data-layout="a"] .hl-split { display: grid; grid-template-columns: 340px minmax(0, 1fr); align-items: start; }
.hl[data-layout="a"] .hl-side { border-right: 1px solid var(--hl-line); min-width: 0; }
.hl[data-layout="a"] .hl-main { min-width: 0; }
.hl[data-layout="a"] .hl-strip { display: none; }
/* Layout B: tiles and one feed */
.hl-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--hl-line); }
.hl-tile { display: grid; gap: 6px; align-content: start; padding: 12px; border: 1px solid var(--control-line, var(--hl-line)); border-radius: 10px; min-width: 0; }
.hl-tile[aria-current="true"] { border-color: var(--text); border-width: 2px; padding: 11px; }
.hl-tile-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.hl-tile-title { border: 0 !important; padding: 0 !important; text-align: left; font-weight: 700; font-size: 15px; justify-content: flex-start; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.hl-tile p { margin: 0; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hl-tile-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.hl-tile-actions button { flex: 1 1 auto; font-size: 12px; }
.hl-feed-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--hl-line); }
.hl-feed-head h3 { font-size: 15px; }
@media (max-width: 1279px) { .hl-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 980px) {
  .hl[data-layout="a"] .hl-split { grid-template-columns: 1fr; }
  .hl[data-layout="a"] .hl-side { display: none; }
  .hl[data-layout="a"] .hl-strip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 12px; border-bottom: 1px solid var(--hl-line); }
  .hl[data-layout="a"] .hl-strip button { flex: 0 0 auto; white-space: nowrap; }
}
@media (max-width: 639px) {
  .hl-tiles { grid-template-columns: 1fr; }
  .hl-head { padding: 12px; }
  .hl-chips { flex-wrap: nowrap; overflow-x: auto; padding: 10px 12px; }
  .hl-chips button { flex: 0 0 auto; }
  .hl .hl-file { grid-template-columns: 44px minmax(0, 1fr); padding: 6px 12px; }
  .hl-file-date { display: none; }
  .hl-links, .hl-feed-head, .hl-crumbs { padding-left: 12px; padding-right: 12px; }
}
`;

function loadPrefs() {
  try { return normalizeHomePrefs(JSON.parse(window.localStorage.getItem(PREFS_KEY) || 'null')); } catch { return defaultHomePrefs(); }
}
function savePrefs(prefs) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: the view still works for this visit */ }
}

/**
 * ctx (from the shell): projects() -> catalog projects (not prioritised), worktreeId(project), listDirectory(project, directory) -> {entries, nextCursor},
 * notebooks(project) -> [{id,title,changedAt}], openFile(project, path), openNotebook(project, id), href(project, path), attention(project) -> {kind,label},
 * where(project) -> short location text, ready() -> bool.
 */
export function createHomeLayout({ layout, host, ctx }) {
  if (!document.getElementById('homeLayoutStyle')) {
    const style = document.createElement('style'); style.id = 'homeLayoutStyle'; style.textContent = STYLE; document.head.append(style);
  }
  let prefs = loadPrefs();
  let selectedKey = '';
  let directory = '';
  let editing = false;
  const listings = new Map(); // `${key}::${dir}` -> { entries, error, loading, more }
  let renderedMarkup = '';

  const persist = next => { prefs = normalizeHomePrefs(next); savePrefs(prefs); render(); };
  const projectsAll = () => (ctx.projects() || []).filter(project => project.projectKey);
  const byKey = key => projectsAll().find(project => project.projectKey === key) || null;
  const groups = () => groupHomeProjects(projectsAll(), prefs);
  const browsable = project => Boolean(project && (project.space === 'notebooks' || (isLocal(project) && project.available !== false)));
  const visibleMain = () => { const g = groups(); return [...g.pinned, ...g.main].filter(browsable); };

  function ensureSelection() {
    if (selectedKey && byKey(selectedKey) && !prefs.hidden.includes(selectedKey)) return;
    const first = visibleMain()[0];
    selectedKey = first ? first.projectKey : '';
    directory = '';
  }

  async function load(project, dir = '') {
    const key = `${project.projectKey}::${dir}`;
    const current = listings.get(key);
    if (current && (current.loading || current.entries)) return;
    listings.set(key, { loading: true });
    try {
      if (project.space === 'notebooks') {
        const items = await ctx.notebooks(project);
        listings.set(key, { entries: items.map(item => ({ path: 'Carnets/' + item.id + '.crnb', name: (item.title || item.id) + '.crnb', title: item.title || item.id, type: 'file', kind: 'notebook', bytes: 0, updatedAt: item.changedAt || null, notebookId: item.id })) });
      } else {
        const page = await ctx.listDirectory(project, dir);
        listings.set(key, { entries: page.entries || [], more: page.nextCursor || null });
      }
    } catch (error) {
      listings.set(key, { error: error?.message || 'Could not list this folder.' });
    }
    render();
  }

  const entriesFor = (project, dir) => listings.get(`${project.projectKey}::${dir}`) || null;

  // ---------- markup ----------
  const goto = () => `<button type="button" data-notebook-space-new>New notebook</button><button type="button" data-context-hub-project-goto title="Go to project (⌘K)" data-hl-focus="goto">Go to… <kbd>⌘K</kbd></button>`;

  function viewMenu() {
    const options = (list, current) => list.map(([id, label]) => `<option value="${id}"${id === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const g = groups();
    return `<details class="hl-view"><summary data-hl-focus="view">View</summary><div class="hl-view-body">
      <label>Sort projects<select data-hl-pref="projectSort">${options(HOME_PROJECT_SORTS, prefs.projectSort)}</select></label>
      <label>Sort files<select data-hl-pref="fileSort">${options(HOME_FILE_SORTS, prefs.fileSort)}</select></label>
      <button type="button" data-hl-edit aria-pressed="${editing}">${editing ? 'Done editing' : 'Hide projects…'}</button>
      <button type="button" data-hl-reset>Reset the view${g.hidden.length || g.pinned.length ? '' : ' (already default)'}</button>
    </div></details>`;
  }

  function starButton(project) {
    const pinned = prefs.pinned.includes(project.projectKey);
    return `<button type="button" class="hl-star" data-hl-pin="${esc(project.projectKey)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(project.title)}" data-hl-focus="pin:${esc(project.projectKey)}">${pinned ? '★' : '☆'}</button>`;
  }
  function hideButton(project, hidden) {
    return `<button type="button" class="hl-quiet" data-hl-hide="${esc(project.projectKey)}" data-hl-focus="hide:${esc(project.projectKey)}">${hidden ? 'Show' : 'Hide'}</button>`;
  }

  function projectRow(project, { hidden = false } = {}) {
    const attention = ctx.attention(project);
    const open = browsable(project)
      ? `<button type="button" class="hl-select" data-hl-open="${esc(project.projectKey)}" aria-current="${project.projectKey === selectedKey}" data-hl-focus="open:${esc(project.projectKey)}"><strong>${esc(project.title)}</strong><span>${esc(attention.label)}</span></button>`
      : `<button type="button" class="hl-select" data-context-hub-project-destination="open" data-project-key="${esc(project.projectKey)}" data-hl-focus="open:${esc(project.projectKey)}"><strong>${esc(project.title)}</strong><span>${esc(attention.label)} · open</span></button>`;
    return `<li class="hl-row">${open}${hidden || editing ? hideButton(project, hidden) : '<span></span>'}${hidden ? '<span></span>' : starButton(project)}</li>`;
  }

  function projectList() {
    const g = groups();
    const list = items => `<ul style="list-style:none;margin:0;padding:0">${items.map(project => projectRow(project)).join('')}</ul>`;
    const detail = (id, title, items, extra = '') => items.length ? `<details class="hl-group" ${extra}><summary>${esc(title)} · ${items.length}</summary><ul style="list-style:none;margin:0;padding:0">${items.map(project => projectRow(project, { hidden: id === 'hidden' })).join('')}</ul></details>` : '';
    return (g.pinned.length ? `<div class="hl-group-title">Pinned</div>${list(g.pinned)}` : '')
      + `<div class="hl-group-title">${g.pinned.length ? 'Projects' : 'Projects · tap ☆ to pin'}</div>${g.main.length ? list(g.main) : '<div class="hl-empty">No other project with a local folder.</div>'}`
      + detail('shared', 'Shared · no local folder', g.shared, prefs.showShared ? 'open' : '')
      + detail('hidden', 'Hidden', g.hidden);
  }

  function chips(counts) {
    return `<div class="hl-chips" role="group" aria-label="Filter by file type">${HOME_TYPES.map(([id, label]) => `<button type="button" data-hl-type="${id}" aria-pressed="${prefs.type === id}" data-hl-focus="type:${id}">${esc(label)}${counts ? `<small>${counts[id] ?? 0}</small>` : ''}</button>`).join('')}</div>`;
  }

  function fileRow(project, entry, { showProject = false } = {}) {
    const type = homeEntryType(entry);
    const tag = `<span class="hl-tag" aria-hidden="true">${TYPE_TAG[type]}</span>`;
    const date = formatHomeDate(entry.updatedAt);
    const where = entry.notebookId ? 'Notebook' : entry.path;
    const sub = showProject ? `${esc(project.title)} · ${esc(where)}` : esc(where);
    const body = `${tag}<span class="hl-file-name"><strong>${esc(entry.title || entry.name)}</strong><span>${sub}</span></span><span class="hl-file-date">${esc(date)}</span>`;
    if (type === 'folder') return `<button type="button" class="hl-file" data-hl-dir="${esc(entry.path)}" data-hl-project="${esc(project.projectKey)}">${body.replace('<span class="hl-file-date"></span>', '<span class="hl-file-date">›</span>')}</button>`;
    return `<a class="hl-file" href="${esc(entry.notebookId ? '#' : ctx.href(project, entry.path))}" data-hl-file="${esc(entry.path)}" data-hl-project="${esc(project.projectKey)}"${entry.notebookId ? ` data-hl-notebook="${esc(entry.notebookId)}"` : ''}>${body}</a>`;
  }

  function crumbs(project) {
    const parts = directory ? directory.split('/') : [];
    const buttons = [`<button type="button" data-hl-dir="" data-hl-project="${esc(project.projectKey)}">${esc(project.title)}</button>`];
    parts.forEach((part, index) => buttons.push(`<span aria-hidden="true">›</span><button type="button" data-hl-dir="${esc(parts.slice(0, index + 1).join('/'))}" data-hl-project="${esc(project.projectKey)}">${esc(part)}</button>`));
    return `<nav class="hl-crumbs" aria-label="Folder">${buttons.join('')}</nav>`;
  }

  function projectLinks(project) {
    const attention = ctx.attention(project);
    const dest = (id, label) => `<button type="button" data-context-hub-project-destination="${id}" data-project-key="${esc(project.projectKey)}" aria-label="${esc(label + ' · ' + project.title)}">${esc(label)}</button>`;
    if (project.space === 'notebooks') return '';
    return `<div class="hl-links">${dest('review', attention.kind === 'work' ? attention.label : 'To review')}${dest('context', 'Context')}</div>`;
  }

  function filesPane(project, { heading = true } = {}) {
    const listing = entriesFor(project, directory);
    let body;
    let counts = null;
    if (!listing || listing.loading) body = '<div class="hl-empty">Loading files…</div>';
    else if (listing.error) body = `<div class="hl-empty">${esc(listing.error)}</div>`;
    else {
      counts = countHomeTypes(listing.entries);
      const shown = sortHomeEntries(filterHomeEntries(listing.entries, prefs.type), prefs.fileSort);
      body = shown.length ? shown.map(entry => fileRow(project, entry)).join('') : `<div class="hl-empty">${prefs.type === 'all' ? 'This folder is empty.' : 'No file of this type here. Pick “All” to see everything.'}</div>`;
      if (listing.more) body += `<div class="hl-more"><button type="button" data-hl-more>Show more files</button></div>`;
    }
    return `${heading ? `<div class="hl-feed-head"><h3>${esc(project.title)}</h3><span class="hl-file-date">${esc(ctx.where(project))}</span></div>` : ''}${projectLinks(project)}${chips(counts)}${project.space === 'notebooks' ? '' : crumbs(project)}<div>${body}</div>`;
  }

  function renderA() {
    ensureSelection();
    const project = byKey(selectedKey);
    const g = groups();
    const strip = [...g.pinned, ...g.main].filter(browsable).map(item => `<button type="button" data-hl-open="${esc(item.projectKey)}" aria-current="${item.projectKey === selectedKey}">${esc(item.title)}</button>`).join('');
    return `<div class="hl" data-layout="a">
      <div class="hl-head"><div><h2>Home</h2><p>${projectsAll().length} projects · ${visibleMain().length} with files here</p></div><div class="hl-tools">${goto()}${viewMenu()}</div></div>
      <div class="hl-strip" role="group" aria-label="Projects">${strip}</div>
      <div class="hl-split"><div class="hl-side">${projectList()}</div><div class="hl-main">${project ? filesPane(project) : '<div class="hl-empty">Pin or pick a project to see its files.</div>'}</div></div>
    </div>`;
  }

  function tile(project) {
    const attention = ctx.attention(project);
    const pinned = prefs.pinned.includes(project.projectKey);
    const reviews = Number(project.localReviewCount || 0) + Number(project.sharedProposalCount || 0);
    return `<div class="hl-tile" aria-current="${project.projectKey === selectedKey}">
      <div class="hl-tile-top"><button type="button" class="hl-tile-title" data-hl-open="${esc(project.projectKey)}" data-hl-focus="open:${esc(project.projectKey)}">${esc(project.title)}</button>${starButton(project)}</div>
      <p>${esc(ctx.where(project))}</p>
      <p>${esc(attention.label)}${project.lastOpenedAt ? ' · opened ' + esc(formatHomeDate(project.lastOpenedAt)) : ''}</p>
      <div class="hl-tile-actions"><button type="button" data-hl-open="${esc(project.projectKey)}">Files</button>${reviews ? `<button type="button" data-context-hub-project-destination="review" data-project-key="${esc(project.projectKey)}">${reviews} to review</button>` : ''}</div>
    </div>`;
  }

  function feed() {
    const scope = directoryScoped && byKey(selectedKey) ? byKey(selectedKey) : null;
    if (scope) return `<div class="hl-feed-head"><h3>${esc(scope.title)}</h3><button type="button" data-hl-all>All main projects</button></div>${filesPane(scope, { heading: false })}`;
    const sources = visibleMain();
    const loaded = sources.map(project => ({ project, listing: entriesFor(project, '') }));
    const pending = loaded.some(item => !item.listing || item.listing.loading);
    const all = loaded.flatMap(item => (item.listing?.entries || []).filter(entry => homeEntryType(entry) !== 'folder').map(entry => ({ project: item.project, entry })));
    const counts = countHomeTypes(all.map(item => item.entry));
    const shown = filterHomeEntries(all.map(item => item.entry), prefs.type);
    const rows = sortHomeEntries(shown, prefs.fileSort === 'name' ? 'recent' : prefs.fileSort).map(entry => all.find(item => item.entry === entry)).map(item => fileRow(item.project, item.entry, { showProject: true }));
    return `<div class="hl-feed-head"><h3>Files across main projects</h3><span class="hl-file-date">${pending ? 'Loading…' : all.length + ' files at the top level'}</span></div>${chips(counts)}<div>${rows.join('') || (pending ? '<div class="hl-empty">Loading files…</div>' : '<div class="hl-empty">No file of this type at the top level. Open a project to browse its folders.</div>')}</div>`;
  }
  let directoryScoped = false;

  function renderB() {
    ensureSelection();
    const g = groups();
    const main = (g.pinned.length ? g.pinned : g.main.slice(0, 6)).filter(browsable);
    const others = [...g.pinned.length ? g.main : g.main.slice(6)];
    const moreList = (title, items, extra = '', hidden = false) => items.length ? `<details class="hl-group" ${extra}><summary>${esc(title)} · ${items.length}</summary><ul style="list-style:none;margin:0;padding:0">${items.map(project => projectRow(project, { hidden })).join('')}</ul></details>` : '';
    return `<div class="hl" data-layout="b">
      <div class="hl-head"><div><h2>Home</h2><p>${g.pinned.length ? 'Your pinned projects' : 'First projects · tap ☆ to choose yours'}</p></div><div class="hl-tools">${goto()}${viewMenu()}</div></div>
      <div class="hl-tiles">${main.map(tile).join('') || '<div class="hl-empty">Pin a project with ☆.</div>'}</div>
      ${feed()}
      ${moreList('Other projects', others)}${moreList('Shared · no local folder', g.shared, prefs.showShared ? 'open' : '')}${moreList('Hidden', g.hidden, '', true)}
    </div>`;
  }

  // ---------- render ----------
  function render() {
    if (!ctx.ready()) { host.innerHTML = '<div class="hl-empty">Loading projects…</div>'; renderedMarkup = ''; return; }
    ensureSelection();
    const project = byKey(selectedKey);
    if (layout === 'a' && project) void load(project, directory);
    if (layout === 'b') {
      if (directoryScoped && project) void load(project, directory);
      else visibleMain().forEach(item => void load(item, ''));
    }
    const markup = layout === 'b' ? renderB() : renderA();
    if (markup === renderedMarkup) return;
    const active = document.activeElement && host.contains(document.activeElement) ? document.activeElement.dataset.hlFocus : '';
    const openDetails = [...host.querySelectorAll('details[open]')].map(node => node.querySelector('summary')?.textContent?.split(' · ')[0] || '');
    host.innerHTML = markup; renderedMarkup = markup;
    for (const node of host.querySelectorAll('details')) if (openDetails.includes(node.querySelector('summary')?.textContent?.split(' · ')[0] || '')) node.open = true;
    if (active) host.querySelector(`[data-hl-focus="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
  }

  // ---------- events ----------
  host.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const pin = target.closest('[data-hl-pin]');
    if (pin) {
      const key = pin.dataset.hlPin, on = prefs.pinned.includes(key);
      persist({ ...prefs, pinned: on ? prefs.pinned.filter(item => item !== key) : [...prefs.pinned, key] });
      return;
    }
    const hide = target.closest('[data-hl-hide]');
    if (hide) {
      const key = hide.dataset.hlHide, on = prefs.hidden.includes(key);
      persist({ ...prefs, hidden: on ? prefs.hidden.filter(item => item !== key) : [...prefs.hidden, key], pinned: on ? prefs.pinned : prefs.pinned.filter(item => item !== key) });
      return;
    }
    const type = target.closest('[data-hl-type]');
    if (type) { persist({ ...prefs, type: type.dataset.hlType }); return; }
    const open = target.closest('[data-hl-open]');
    if (open) { selectedKey = open.dataset.hlOpen; directory = ''; directoryScoped = true; render(); return; }
    if (target.closest('[data-hl-all]')) { directoryScoped = false; directory = ''; render(); return; }
    const dir = target.closest('[data-hl-dir]');
    if (dir) { selectedKey = dir.dataset.hlProject; directory = dir.dataset.hlDir; directoryScoped = true; render(); return; }
    if (target.closest('[data-hl-more]')) { void loadMore(); return; }
    if (target.closest('[data-hl-edit]')) { editing = !editing; render(); return; }
    if (target.closest('[data-hl-reset]')) { editing = false; persist(defaultHomePrefs()); return; }
    const file = target.closest('[data-hl-file]');
    if (file) {
      if (event.metaKey || event.ctrlKey || event.shiftKey) { if (!file.dataset.hlNotebook) return; }
      event.preventDefault();
      const project = byKey(file.dataset.hlProject);
      if (!project) return;
      if (file.dataset.hlNotebook) ctx.openNotebook(project, file.dataset.hlNotebook);
      else ctx.openFile(project, file.dataset.hlFile);
    }
  });
  host.addEventListener('change', event => {
    const select = event.target instanceof Element ? event.target.closest('[data-hl-pref]') : null;
    if (select) persist({ ...prefs, [select.dataset.hlPref]: select.value });
  });

  async function loadMore() {
    const project = byKey(selectedKey);
    const key = `${selectedKey}::${directory}`;
    const listing = listings.get(key);
    if (!project || !listing?.more || !ctx.listDirectory) return;
    try {
      const page = await ctx.listDirectory(project, directory, listing.more);
      listings.set(key, { entries: [...listing.entries, ...(page.entries || [])], more: page.nextCursor || null });
    } catch (error) { listings.set(key, { ...listing, error: error?.message || 'Could not load more files.' }); }
    render();
  }

  // The folder cache lives for the visit; a new catalog (refresh) drops it so stale rows never stay.
  return { update() { render(); }, invalidate() { listings.clear(); renderedMarkup = ''; render(); }, state: () => ({ prefs, selectedKey, directory }) };
}
