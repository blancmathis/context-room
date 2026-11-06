// Explorer view (T-021): one project list and a file browser, with a band of facts that help agents.
// One project list. Files of every type. A view the person sets up with one tap: pin, hide, type, sort.
// E-ink rules: grey, targets of 44 px or more, no animation, breakpoints 639, 980/981 and 1279/1280 only.

export const HOME_TYPES = [['all', 'All'], ['md', 'Markdown'], ['html', 'HTML'], ['crnb', 'Notebooks'], ['image', 'Images'], ['other', 'Other']];
export const HOME_FILE_SORTS = [['name', 'Name'], ['recent', 'Modified'], ['type', 'Type']];
export const HOME_PROJECT_SORTS = [['name', 'Name'], ['opened', 'Last opened'], ['reviews', 'Reviews']];
const PREFS_KEY = 'context-room.home.v1';
export const EXPLORER_ROOT_CLASS = 'explorer-mode';
const TYPE_TAG = { folder: 'DIR', md: 'MD', html: 'HTML', crnb: 'NB', image: 'IMG', other: 'TXT' };

export const defaultHomePrefs = () => ({ pinned: [], hidden: [], projectSort: 'opened', fileSort: 'name', type: 'all', showShared: false, showInternal: false });

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
    showInternal: raw.showInternal === true,
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

/** The Hub's own empty working folder is not a project the person works in. */
export const isInternalProject = project => /\/\.context-room\/hub\/host\/?$/.test(String(project?.root || '').replaceAll('\\', '/')) || project?.title === 'Context Room Hub';

/** One number for "to review": local reviews plus Shared proposals. */
export const reviewTotal = project => Number(project?.localReviewCount || 0) + Number(project?.sharedProposalCount || 0);

/** The location line, hidden when it only repeats the title (a folder named like its project). */
export function distinctWhere(title, where) {
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const last = String(where || '').split(' · ')[0].split('/').filter(Boolean).pop();
  return norm(last) && norm(last) === norm(title) ? String(where || '').split(' · ').slice(1).join(' · ') || '' : String(where || '');
}

/** What an agent sees first, and how fresh the documents are. Reads the existing project-inspection payload. */
export function summarizeInspection(data) {
  if (!data || typeof data !== 'object') return null;
  const docqa = data.doctor?.docqa || {};
  const graph = data.doctor?.graph || {};
  const names = (Array.isArray(data.startupContext) ? data.startupContext : []).map(item => item?.startupContext?.fileName || item?.label).filter(Boolean);
  const total = Number(docqa.totalDocs || graph.docs || 0);
  const stale = Number(graph.stale || 0) + Number(docqa.changedDocs || 0);
  const review = Number(docqa.needsReview || 0);
  const tokens = Number(data.effectiveContext?.cost?.startup?.tokens || 0);
  return { names: [...new Set(names)], tokens, total, stale, review, state: data.effectiveContext?.freshness?.state || '' };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return 'File';
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

export function formatTokens(count) {
  const n = Number(count) || 0;
  return n >= 1000 ? `~${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k tokens` : `~${n} tokens`;
}

const isLocal = project => Boolean(project?.root) && project.mode !== 'shared';

/**
 * Groups: pinned (in pin order), main (local, with a folder), shared (no local folder), hidden.
 * The Notebooks space counts as a main project; it keeps its own place in the list.
 */
export function groupHomeProjects(allProjects, prefs, { opened = () => 0 } = {}) {
  const projects = prefs.showInternal ? allProjects : allProjects.filter(project => !isInternalProject(project));
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
    internal: allProjects.filter(isInternalProject).length,
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
.hl-view { position: relative; border: 1px solid var(--hl-line); border-radius: 8px; }
.hl-view > summary { display: flex; align-items: center; padding: 0 14px; cursor: pointer; list-style: none; }
.hl-view-body { position: absolute; right: -1px; top: calc(100% + 6px); z-index: 20; box-sizing: border-box; width: 260px; display: grid; gap: 10px; padding: 12px 14px 14px; border: 1px solid var(--control-line, var(--hl-line)); border-radius: 8px; background: var(--surface-card, var(--bg, #111)); }
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
.hl .hl-file { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 56px; padding: 6px 16px; border-bottom: 1px solid var(--hl-line); color: var(--text); text-decoration: none; text-align: left; width: 100%; border-left: 0; border-right: 0; border-top: 0; border-radius: 0; }
.hl-file-name { min-width: 0; display: grid; gap: 2px; }
.hl-file-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.hl-file-name span { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hl-file-date { color: var(--muted); font-size: 12px; white-space: nowrap; }
.hl-tag { display: inline-grid; place-items: center; min-width: 44px; height: 28px; padding: 0 6px; border: 1px solid var(--control-line, var(--hl-line)); border-radius: 6px; color: var(--muted); font: 700 10px/1 ui-monospace, Menlo, monospace; letter-spacing: .04em; }
.hl-agent { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid var(--hl-line); }
.hl-agent > div { display: grid; gap: 2px; align-content: start; padding: 10px 16px; min-width: 0; border-right: 1px solid var(--hl-line); }
.hl-agent > div:last-child { border-right: 0; }
.hl-agent b { color: var(--muted); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.hl-agent span { font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.hl-agent .hl-warn { font-weight: 700; }
.hl-agent button { justify-self: start; min-height: 44px; }
.hl-folders { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--hl-line); }
.hl-folders button { min-height: 44px; font-size: 13px; }
.hl-feed-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--hl-line); }
.hl-feed-head .hl-crumbs { border-bottom: 0; flex: 1 1 auto; min-width: 0; }
.hl-feed-head .hl-tools { padding-right: 12px; }
.hl-crumbs [aria-current="page"] { font-weight: 700; min-height: 44px; display: inline-flex; align-items: center; padding: 0 14px; }
.hl-sep { color: var(--muted); }
#home.explorer-mode > :not(.docqa-grid), #home.explorer-mode .docqa-grid > :not(#explorerViewPanel) { display: none !important; }
#home:not(.explorer-mode) #explorerViewPanel { display: none !important; }
.explorer-view-panel { grid-column: 1 / -1 !important; }
.hl-more { padding: 12px 16px; }
.app.explorer-view-on { grid-template-columns: minmax(0, 1fr) !important; }
.app.explorer-view-on > aside, .app.explorer-view-on > .explorer-open, .app.explorer-view-on > .explorer-edge-trigger { display: none !important; }
/* Layout A: two panes */
.hl .hl-split { display: grid; grid-template-columns: 340px minmax(0, 1fr); align-items: start; }
.hl .hl-side { border-right: 1px solid var(--hl-line); min-width: 0; }
.hl .hl-main { min-width: 0; }
.hl .hl-strip { display: none; }
@media (max-width: 980px) {
  .hl .hl-split { grid-template-columns: 1fr; }
  .hl .hl-side { display: none; }
  .hl.hl-editing .hl-side { display: block; border-right: 0; border-bottom: 1px solid var(--hl-line); }
  .hl.hl-editing .hl-strip { display: none; }
  .hl.hl-editing .hl-quiet, .hl.hl-editing .hl-star { min-height: 44px; min-width: 44px; }
  .hl .hl-strip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 12px; border-bottom: 1px solid var(--hl-line); }
  .hl .hl-strip button { flex: 0 0 auto; white-space: nowrap; }
}
@media (max-width: 639px) {
  .hl-agent { grid-template-columns: 1fr; }
  .hl-agent > div { border-right: 0; border-bottom: 1px solid var(--hl-line); padding: 8px 12px; }
    .hl-head { padding: 12px; }
  .hl-chips { flex-wrap: nowrap; overflow-x: auto; padding: 10px 12px; }
  .hl-chips button { flex: 0 0 auto; }
  .hl .hl-file { grid-template-columns: 44px minmax(0, 1fr); padding: 6px 12px; }
  .hl-file-date { display: none; }
  .hl-feed-head, .hl-crumbs { padding-left: 12px; padding-right: 12px; }
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
export function createExplorerView({ host, ctx, initial = {}, onNavigate = () => {} }) {
  if (!document.getElementById('explorerViewStyle')) {
    const style = document.createElement('style'); style.id = 'explorerViewStyle'; style.textContent = STYLE; document.head.append(style);
  }
  let prefs = loadPrefs();
  let selectedKey = String(initial.projectKey || '');
  let directory = String(initial.directory || '').replace(/^\/+|\/+$/g, '');
  let editing = false;
  let inspectQueue = Promise.resolve();
  const inspections = new Map(); // projectKey -> { summary, error, loading }
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
  const navigated = () => onNavigate({ projectKey: selectedKey, directory });

  async function load(project, dir = '') {
    const key = `${project.projectKey}::${dir}`;
    const current = listings.get(key);
    if (current && (current.loading || current.entries || current.error)) return; // an error stays until the person retries
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
      // A folder that is gone (stale link, deleted): go back to the project root instead of a retry that cannot work.
      if (dir && /^Folder not found/.test(error?.message || '') && project.projectKey === selectedKey && dir === directory) {
        listings.delete(key); directory = ''; navigated(); render(); return;
      }
      listings.set(key, { error: error?.message || 'Could not list this folder.' });
    }
    render();
  }

  async function loadInspection(project) {
    if (!ctx.inspect || !isLocal(project) || project.available === false) return;
    const current = inspections.get(project.projectKey);
    if (current) return;
    inspections.set(project.projectKey, { loading: true });
    // One at a time: a cold check can take seconds and must not block the page.
    inspectQueue = inspectQueue.then(async () => {
      try { inspections.set(project.projectKey, { summary: summarizeInspection(await ctx.inspect(project)) }); }
      catch (error) { inspections.set(project.projectKey, { error: error?.message || 'Could not read the project checks.' }); }
      render();
    });
  }

  const workLabel = project => { const total = reviewTotal(project); return total ? `${total} to review` : ''; };
  const statusText = project => {
    const attention = ctx.attention(project);
    if (attention.kind === 'work') return workLabel(project);
    // "Refreshing…" and "Cached snapshot" describe the app, not the project: they must never stay on a card.
    return String(attention.label || '').replace(/^(Refreshing…|Cached snapshot)( · )?/, '') || 'Up to date';
  };

  /** Three facts that help agents: what they read first, whether documents are current, what waits for a human. */
  function agentStrip(project) {
    if (project.space === 'notebooks') return '';
    const item = inspections.get(project.projectKey);
    const total = reviewTotal(project);
    const reviews = total
      ? `<button type="button" data-context-hub-project-destination="review" data-project-key="${esc(project.projectKey)}" aria-label="${esc(workLabel(project) + ' · ' + project.title)}">${total} to review</button>`
      : '<span>Nothing waiting</span>';
    let context = '<span>Reading…</span>', docs = '<span>Reading…</span>';
    if (item?.error) { context = docs = `<span>${esc(item.error)}</span>`; }
    else if (item?.summary) {
      const sm = item.summary;
      context = sm.names.length ? `<span>${esc(sm.names.slice(0, 3).join(', '))}${sm.names.length > 3 ? ' +' + (sm.names.length - 3) : ''}${sm.tokens ? ' · ' + formatTokens(sm.tokens) : ''}</span>` : '<span>No startup file yet</span>';
      docs = !sm.total ? '<span>No tracked document yet</span>'
        : sm.stale ? `<span class="hl-warn">${sm.stale} stale · changed since review</span><span>${sm.total} tracked</span>`
        : `<span>${sm.total} tracked · all up to date</span>`;
    }
    return `<div class="hl-agent" role="group" aria-label="What helps agents in ${esc(project.title)}"><div><b>Agent context</b>${context}</div><div><b>Documents</b>${docs}</div><div><b>Reviews</b>${reviews}</div></div>`;
  }

  const entriesFor = (project, dir) => listings.get(`${project.projectKey}::${dir}`) || null;

  // ---------- markup ----------
  const goto = () => `<button type="button" data-explorer-home>Home</button><button type="button" data-notebook-space-new>New notebook</button><button type="button" data-context-hub-project-goto title="Go to project (⌘K)" data-hl-focus="goto">Go to… <kbd>⌘K</kbd></button>`;

  function viewMenu() {
    const options = (list, current) => list.map(([id, label]) => `<option value="${id}"${id === current ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const g = groups();
    return `<details class="hl-view"><summary data-hl-focus="view">View</summary><div class="hl-view-body">
      <label>Sort projects<select data-hl-pref="projectSort">${options(HOME_PROJECT_SORTS, prefs.projectSort)}</select></label>
      <label>Sort files<select data-hl-pref="fileSort">${options(HOME_FILE_SORTS, prefs.fileSort)}</select></label>
      <button type="button" data-hl-edit aria-pressed="${editing}">${editing ? 'Done editing' : 'Hide projects…'}</button>
      ${g.internal ? `<button type="button" data-hl-internal aria-pressed="${prefs.showInternal}">${prefs.showInternal ? 'Hide' : 'Show'} the internal Hub folder</button>` : ''}
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
    const open = browsable(project)
      ? `<button type="button" class="hl-select" data-hl-open="${esc(project.projectKey)}" aria-current="${project.projectKey === selectedKey}" data-hl-focus="open:${esc(project.projectKey)}"><strong>${esc(project.title)}</strong><span>${esc(statusText(project))}</span></button>`
      : `<button type="button" class="hl-select" data-context-hub-project-destination="open" data-project-key="${esc(project.projectKey)}" data-hl-focus="open:${esc(project.projectKey)}"><strong>${esc(project.title)}</strong><span>${esc(statusText(project))} · open</span></button>`;
    return `<li class="hl-row">${open}${hidden || editing ? hideButton(project, hidden) : '<span></span>'}${hidden ? '<span></span>' : starButton(project)}</li>`;
  }

  function projectList() {
    const g = groups();
    const list = items => `<ul style="list-style:none;margin:0;padding:0">${items.map(project => projectRow(project)).join('')}</ul>`;
    const detail = (id, title, items, extra = '') => items.length ? `<details class="hl-group" ${extra}><summary>${esc(title)} · ${items.length}</summary><ul style="list-style:none;margin:0;padding:0">${items.map(project => projectRow(project, { hidden: id === 'hidden' })).join('')}</ul></details>` : '';
    return (g.pinned.length ? `<div class="hl-group-title">Pinned</div>${list(g.pinned)}` : '')
      + `<div class="hl-group-title">${g.pinned.length ? 'Projects' : 'Projects · tap ☆ to pin'}</div>${g.main.length ? list(g.main) : (g.shared.length || g.hidden.length ? '<div class="hl-empty">No other project with a local folder.</div>' : '<div class="hl-empty">No project yet.</div>')}`
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
    // The path only helps when it says more than the name: in a folder, or in the mixed feed.
    const nested = String(entry.path || '').includes('/');
    const kind = entry.notebookId ? 'Notebook' : type === 'folder' ? 'Folder' : formatBytes(entry.bytes);
    const where = nested && !entry.notebookId ? String(entry.path).split('/').slice(0, -1).join('/') : '';
    const sub = showProject ? [esc(project.title), esc(where)].filter(Boolean).join(' · ') : [esc(kind), esc(where)].filter(Boolean).join(' · ');
    const body = `${tag}<span class="hl-file-name"><strong>${esc(entry.title || entry.name)}</strong><span>${sub}</span></span><span class="hl-file-date">${esc(date)}</span>`;
    if (type === 'folder') return `<button type="button" class="hl-file" data-hl-dir="${esc(entry.path)}" data-hl-project="${esc(project.projectKey)}">${body.replace('<span class="hl-file-date"></span>', '<span class="hl-file-date">›</span>')}</button>`;
    return `<a class="hl-file" href="${esc(entry.notebookId ? '#' : ctx.href(project, entry.path))}" data-hl-file="${esc(entry.path)}" data-hl-project="${esc(project.projectKey)}"${entry.notebookId ? ` data-hl-notebook="${esc(entry.notebookId)}"` : ''}>${body}</a>`;
  }

  /** The path, always visible: project, then each folder. Every segment but the last one is a button. */
  function crumbs(project) {
    const parts = directory && project.space !== 'notebooks' ? directory.split('/') : [];
    const root = parts.length ? `<button type="button" data-hl-dir="" data-hl-project="${esc(project.projectKey)}">${esc(project.title)}</button>` : `<span aria-current="page">${esc(project.title)}</span>`;
    const rest = parts.map((part, index) => index === parts.length - 1
      ? `<span class="hl-sep" aria-hidden="true">›</span><span aria-current="page">${esc(part)}</span>`
      : `<span class="hl-sep" aria-hidden="true">›</span><button type="button" data-hl-dir="${esc(parts.slice(0, index + 1).join('/'))}" data-hl-project="${esc(project.projectKey)}">${esc(part)}</button>`);
    return `<nav class="hl-crumbs" aria-label="Path">${root}${rest.join('')}</nav>`;
  }

  function projectLinks(project) {
    const dest = (id, label) => `<button type="button" data-context-hub-project-destination="${id}" data-project-key="${esc(project.projectKey)}" aria-label="${esc(label + ' · ' + project.title)}">${esc(label)}</button>`;
    if (project.space === 'notebooks') return '';
    return dest('context', 'Open context');
  }

  function filesPane(project) {
    const listing = entriesFor(project, directory);
    let body;
    let counts = null;
    if (!listing || listing.loading) body = '<div class="hl-empty">Loading files…</div>';
    else if (listing.error) body = `<div class="hl-empty">${esc(listing.error)}<div class="hl-more"><button type="button" data-hl-retry>Try again</button></div></div>`;
    else {
      counts = countHomeTypes(listing.entries);
      // The project's own bookkeeping folders are not documents to browse.
      const visible = listing.entries.filter(entry => !(entry.type === 'directory' && /^\.(git|context-room)$/.test(entry.name)));
      const shown = sortHomeEntries(filterHomeEntries(visible, prefs.type), prefs.fileSort);
      // Folders sit in one compact row, so the files start high on the page.
      const folders = shown.filter(entry => homeEntryType(entry) === 'folder');
      const files = shown.filter(entry => homeEntryType(entry) !== 'folder');
      const folderRow = folders.length ? `<div class="hl-folders" role="group" aria-label="Folders">${folders.map(entry => `<button type="button" data-hl-dir="${esc(entry.path)}" data-hl-project="${esc(project.projectKey)}">${esc(entry.name)}</button>`).join('')}</div>` : '';
      body = shown.length ? folderRow + files.map(entry => fileRow(project, entry)).join('') : `<div class="hl-empty">${prefs.type === 'all' ? 'This folder is empty.' : 'No file of this type here. Pick “All” to see everything.'}</div>`;
      if (listing.more) body += `<div class="hl-more"><button type="button" data-hl-more>Show more files</button></div>`;
    }
    const where = distinctWhere(project.title, ctx.where(project));
    return `<div class="hl-feed-head">${crumbs(project)}<div class="hl-tools">${where ? `<span class="hl-file-date">${esc(where)}</span>` : ''}${projectLinks(project)}</div></div>${agentStrip(project)}${chips(counts)}<div>${body}</div>`;
  }

  function renderView() {
    ensureSelection();
    const project = byKey(selectedKey);
    const g = groups();
    const strip = [...g.pinned, ...g.main].filter(browsable).map(item => `<button type="button" data-hl-open="${esc(item.projectKey)}" aria-current="${item.projectKey === selectedKey}">${esc(item.title)}</button>`).join('');
    return `<div class="hl${editing ? ' hl-editing' : ''}">
      <div class="hl-head"><div><h2>Files</h2><p>${g.pinned.length + g.main.length + g.shared.length} projects · ${visibleMain().length} with files here</p></div><div class="hl-tools">${goto()}${viewMenu()}</div></div>
      <div class="hl-strip" role="group" aria-label="Projects">${strip}</div>
      <div class="hl-split"><div class="hl-side">${projectList()}</div><div class="hl-main">${project ? filesPane(project) : (g.pinned.length + g.main.length + g.shared.length + g.hidden.length ? '<div class="hl-empty">Pin or pick a project to see its files.</div>' : '<div class="hl-empty">No project yet. Use “Add a project…” above.</div>')}</div></div>
    </div>`;
  }

  // ---------- render ----------
  function render() {
    if (!ctx.ready()) { host.innerHTML = '<div class="hl-empty">Loading projects…</div>'; renderedMarkup = ''; return; }
    ensureSelection();
    const project = byKey(selectedKey);
    if (project) { void load(project, directory); void loadInspection(project); }
    const markup = renderView();
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
    if (open) { selectedKey = open.dataset.hlOpen; directory = ''; render(); navigated(); return; }
    const dir = target.closest('[data-hl-dir]');
    if (dir) { selectedKey = dir.dataset.hlProject; directory = dir.dataset.hlDir; render(); navigated(); return; }
    if (target.closest('[data-hl-retry]')) { listings.delete(`${selectedKey}::${directory}`); render(); return; }
    if (target.closest('[data-hl-more]')) { void loadMore(); return; }
    if (target.closest('[data-hl-edit]')) { editing = !editing; render(); return; }
    if (target.closest('[data-hl-internal]')) { persist({ ...prefs, showInternal: !prefs.showInternal }); return; }
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
  return { update() { render(); }, navigate(next = {}) { selectedKey = String(next.projectKey || ''); directory = String(next.directory || ''); render(); }, invalidate() { listings.clear(); inspections.clear(); renderedMarkup = ''; render(); }, state: () => ({ prefs, projectKey: selectedKey, directory }) };
}
