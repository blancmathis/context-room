// The page of one project in the Hub (R3a): its name, its part of « To review », then tiles that lead into its docs.
// Loaded on demand by the Hub page (it calls the page's own functions and `state`). The first part is pure data:
// the Hub server imports it to keep the tiles of each project.

export const PROJECT_TILE_TYPES = ['agents', 'all', 'recent', 'folder', 'file'];
const MAX_TILES = 60;

export const projectTileKey = (tile) => tile.path ? tile.type + ':' + tile.path : tile.type;

function cleanTilePath(value) {
  if (typeof value !== 'string' || value.length > 1024) return '';
  const parts = value.split('/').filter(Boolean);
  return parts.length && !parts.some((part) => part === '.' || part === '..') ? parts.join('/') : '';
}

/** Unknown types, bad paths and repeats drop out. No `tiles` list = the default (worked out from the tree); an empty list is a real choice. */
export function normalizeProjectPage(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tiles)) return { version: 1, tiles: null };
  const seen = new Set();
  const tiles = [];
  for (const item of raw.tiles) {
    if (!item || !PROJECT_TILE_TYPES.includes(item.type)) continue;
    const tile = { type: item.type, size: item.size === 'half' ? 'half' : 'full' };
    if (item.type === 'folder' || item.type === 'file') {
      tile.path = cleanTilePath(item.path);
      if (!tile.path) continue;
    }
    const key = projectTileKey(tile);
    if (seen.has(key) || tiles.length >= MAX_TILES) continue;
    seen.add(key);
    tiles.push(tile);
  }
  return { version: 1, tiles };
}

/** The default page: the agent files first, then one tile per top-level folder of the tree. « Recent docs » is opt-in. */
export const defaultProjectTiles = (folders = []) => [{ type: 'agents', size: 'full' }, ...folders.map((path) => ({ type: 'folder', path, size: 'half' }))];

/** Each change returns a new list and never mutates. */
export function moveProjectTile(tiles, key, delta) {
  const index = tiles.findIndex((tile) => projectTileKey(tile) === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= tiles.length) return tiles;
  const next = [...tiles];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
export const removeProjectTile = (tiles, key) => tiles.filter((tile) => projectTileKey(tile) !== key);
export function addProjectTile(tiles, tile) {
  const next = normalizeProjectPage({ tiles: [...tiles, tile] }).tiles;
  return next.length > tiles.length ? next : tiles;
}
export const sizeProjectTile = (tiles, key) => tiles.map((tile) => projectTileKey(tile) === key ? { ...tile, size: tile.size === 'full' ? 'half' : 'full' } : tile);

const TILE_INFO = {
  agents: ['Agent files', 'What agents load'],
  all: ['All docs', 'The whole tree'],
  recent: ['Recent docs', 'Go to the newest'],
};
const tileName = (tile) => TILE_INFO[tile.type]?.[0] || tile.path.split('/').pop() + (tile.type === 'folder' ? '/' : '');

const CSS = `
#projectPageHead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;padding:4px 0 2px}
#projectPageHead h2{margin:0;font-size:20px}
#projectPageHead .pp-count{color:var(--muted)}
#projectPageHead .pp-end{margin-left:auto}
#projectPageHead .pp-back{display:none}
.pp-tiles{display:grid;gap:10px}
.pp-tiles-head{display:flex;align-items:center;gap:10px}
.pp-tiles-head h2{margin:0;font-size:15px}
.pp-tiles-head button{margin-left:auto}
.pp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.pp-grid>li{grid-column:span 2;display:flex;gap:6px;min-width:0}
.pp-grid>li.pp-half{grid-column:span 1}
.pp-tile{flex:1;min-width:0;min-height:56px;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:2px 10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--text);text-align:left;cursor:pointer;font:inherit}
.pp-tile:hover,.pp-tile:focus-visible{border-color:var(--accent)}
.pp-tile svg{grid-row:span 2;width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.6}
.pp-tile strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-tile small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-tile[data-tile-type=folder],.pp-tile[data-tile-type=all]{background:color-mix(in srgb,var(--accent) 9%,transparent);border-color:transparent}
.pp-tile[data-tile-type=file]{border-style:dashed}
.pp-edit{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.pp-edit button,.pp-add button{min-width:34px;min-height:34px}
.pp-add{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--muted)}
.pp-empty{color:var(--muted);margin:0}
#reviewQueuePanel.pp-none{display:none!important}
.pp-group{display:flex;align-items:center;gap:10px;padding:14px 0 4px;cursor:pointer}
.pp-group button{margin-left:auto}
.pp-levels{display:grid;gap:6px;margin-bottom:12px}
.pp-levels h3,.pp-recent h3{margin:0;font-size:14px}
.pp-levels summary{display:flex;flex-wrap:wrap;gap:4px 10px;padding:8px 0;cursor:pointer}
.pp-levels summary span,.pp-list small{color:var(--muted)}
.pp-list{display:grid;gap:2px;margin:0;padding:0;list-style:none}
.pp-list li{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;min-height:36px}
.pp-list li>span:last-child{margin-left:auto;color:var(--muted)}
.pp-link{border:0;background:none;color:var(--accent);font:inherit;padding:4px 0;cursor:pointer;text-align:left}
@media (max-width:980px){#projectPageHead .pp-back{display:inline-flex}}
@media (max-width:639px){.pp-grid>li.pp-half{grid-column:span 2}}
@media (pointer:coarse){.pp-edit button,.pp-add button,#projectPageHead button,.pp-tiles-head button,.pp-link,.pp-group button{min-height:44px;min-width:44px}}
`;

const ICONS = {
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/>',
  agents: '<path d="M12 3v3M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9.5 13h.01M14.5 13h.01"/>',
  recent: '<path d="M12 7v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z"/>',
};
ICONS.all = ICONS.folder;

/* global state, el, escapeHtml, api, setStatus, renderGlobalProjectExplorer, renderContextHealth, openContextHubProject,
   openGlobalProjectInspection, openContextHubProjectPicker, returnToGlobalContextHubHome, globalProjectSelectedWorktree,
   globalProjectExplorerPageKey, globalProjectExpandedFolderKey, loadGlobalProjectExplorerPage, isExplorerCollapsed,
   isExplorerDesktopViewport, setExplorerCollapsedFromUser, applyExplorerCollapsed, agentContextProvider, AGENT_PROVIDER_LABELS,
   formatTokenEstimate, contextHubReviewItems, contextHubProjectForItem, openGlobalProjectExplorer,
   contextHubPrioritizedProjects */

// A copy on an unmounted disk keeps its root but is not available: no request goes to it.
const mounted = (worktree) => Boolean(worktree?.root) && worktree.available !== false;
const reviewCount = (project) => Number(project?.localReviewCount || 0) + Number(project?.sharedProposalCount || 0);
const LEVEL_NAMES = { global: 'Global', root: 'Project root' };
const fileRow = (file, detail, right = '') => '<li>' + (file.path ? '<button type="button" class="pp-link" data-pp-open="' + escapeHtml(file.path) + '">' + escapeHtml(file.name) + '</button>' : '<span>' + escapeHtml(file.name) + '</span>')
  + '<small>' + escapeHtml(detail) + '</small>' + (right ? '<span>' + escapeHtml(right) + '</span>' : '') + '</li>';
const levelMarkup = (level) => '<details class="pp-level" data-pp-level="' + escapeHtml(level.level) + '"' + (level.level === 'global' ? '' : ' open') + '><summary><strong>' + escapeHtml((Object.hasOwn(LEVEL_NAMES, level.level) ? LEVEL_NAMES[level.level] : level.level + '/')) + '</strong><span>'
  + level.files.length + (level.files.length === 1 ? ' file' : ' files') + ' · ' + formatTokenEstimate(level.startupTokens) + ' tokens at start' + (level.onDemandTokens ? ' · ' + formatTokenEstimate(level.onDemandTokens) + ' on demand' : '') + (level.documentTokens ? ' · ' + formatTokenEstimate(level.documentTokens) + ' in PLAN/CONTEXT, read on request' : '') + '</span></summary><ul class="pp-list">'
  + (level.files.length ? level.files.map((file) => fileRow(file, (file.kind === 'skill' ? 'Skill · ' : file.kind === 'document' ? 'Doc · ' : '') + (file.path || file.locator), file.kind === 'document' ? formatTokenEstimate(file.onDemandTokens) + ' on request' : formatTokenEstimate(file.startupTokens))).join('') : '<li class="pp-empty">No agent file here.</li>') + '</ul></details>';

export function createProjectPage() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const queue = el('reviewQueuePanel');
  const head = document.createElement('header');
  head.id = 'projectPageHead';
  head.hidden = true;
  const tiles = document.createElement('section');
  tiles.id = 'projectTiles';
  tiles.className = 'docqa-panel pp-tiles';
  tiles.setAttribute('aria-labelledby', 'projectTilesHeading');
  tiles.hidden = true;
  queue?.before(head);
  queue?.after(tiles);
  // « What agents load »: the agent files of each level (global, root, subfolders) with their tokens, above the checks.
  const levelsBox = document.createElement('section');
  levelsBox.className = 'pp-levels';
  levelsBox.id = 'projectAgentLevels';
  levelsBox.hidden = true;
  el('contextHealth')?.before(levelsBox);
  const levels = new Map();
  let levelsShown = '';
  let recent = null;
  let entered = '';
  const pages = new Map();
  let editing = false;
  let toolsOpen = false;
  let toolsView = null;

  const currentProject = () => state.globalExplorerProjectKey && ['project', 'computer'].includes(state.globalExplorerMode)
    ? (state.contextHub?.projects || []).find((project) => project.projectKey === state.globalExplorerProjectKey) || null
    : null;
  const rootFolders = (project) => {
    const details = state.globalProjectExplorerDetails.get(globalProjectExplorerPageKey(project));
    return details ? (details.entries || []).filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.')).map((entry) => entry.path) : null;
  };
  const tilesOf = (project) => pages.get(project.projectKey)?.page.tiles || defaultProjectTiles(rootFolders(project) || []);

  // One chain per project: a save waits for the load and for the previous save,
  // then sends the revision the server returned last, so quick edits never 409.
  const chains = new Map();
  const revisions = new Map();
  const enqueue = (key, step) => {
    const run = (chains.get(key) || Promise.resolve()).then(step);
    chains.set(key, run);
    return run;
  };

  function load(project) {
    const key = project.projectKey;
    if (pages.has(key)) return chains.get(key);
    pages.set(key, { page: { version: 1, tiles: null }, revision: '', loading: true });
    return enqueue(key, async () => {
      try {
        const data = await api('/api/context-hub/project-page?project=' + encodeURIComponent(key));
        revisions.set(key, data.revision || '');
        if (pages.get(key)?.loading) pages.set(key, data);
      } catch (error) {
        pages.delete(key);
        setStatus(error.message);
      }
      sync();
    });
  }

  function save(project, next) {
    const key = project.projectKey;
    const stored = pages.get(key);
    pages.set(key, { ...stored, page: { version: 1, tiles: next }, loading: false });
    sync();
    const run = enqueue(key, async () => {
      try {
        const data = await api('/api/context-hub/project-page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project: key, page: { tiles: next }, expectedRevision: revisions.get(key) || '' }),
        });
        revisions.set(key, data.revision || '');
        if (chains.get(key) === run) pages.set(key, data);
      } catch (error) {
        if (chains.get(key) === run) {
          pages.delete(key);
          revisions.delete(key);
          setStatus(error.message);
          void load(project);
        }
      }
      sync();
    });
    return run;
  }

  // The tree loader returns null while the same listing is in flight (just after a reload): wait for it.
  async function listing(project, directory) {
    for (let tries = 0; tries < 50; tries += 1) {
      const details = await loadGlobalProjectExplorerPage(project, { directory });
      if (details || !state.globalProjectExplorerLoading.has(globalProjectExplorerPageKey(project, { directory, query: '' }))) return details;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  // A path is asked for only once its parent listing shows it: a gone path never costs a 404.
  async function listedInProject(project, path, type) {
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const child = parts.slice(0, index + 1).join('/');
      const details = await listing(project, parts.slice(0, index).join('/'));
      const wanted = index === parts.length - 1 ? type : 'directory';
      if (!(details?.entries || []).some((entry) => entry.type === wanted && entry.path === child)) return false;
    }
    return true;
  }

  async function revealFolder(project, folder) {
    const parts = folder.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      const child = parts.slice(0, index + 1).join('/');
      const details = await listing(project, parent);
      // Only a folder seen in its parent's listing is asked for: a gone folder never costs a 404.
      if (!(details?.entries || []).some((entry) => entry.type === 'directory' && entry.path === child)) {
        setStatus(folder + ' is not in this project any more');
        return;
      }
      state.globalProjectExpandedFolders.add(globalProjectExpandedFolderKey(project, child));
    }
    await loadGlobalProjectExplorerPage(project, { directory: folder });
    showTree();
    window.requestAnimationFrame(() => {
      const row = [...document.querySelectorAll('#globalProjectList [data-global-project-folder]')].find((node) => node.dataset.globalProjectFolder === folder);
      row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      row?.focus({ preventScroll: true });
    });
  }

  function showTree() {
    if (isExplorerCollapsed() || !isExplorerDesktopViewport()) setExplorerCollapsedFromUser(false);
    renderGlobalProjectExplorer();
  }

  function openFile(project, filePath) {
    const worktree = globalProjectSelectedWorktree(project);
    listedInProject(project, filePath, 'file').then((found) => {
      if (!found) return setStatus(filePath + ' is not in this project any more');
      if (!isExplorerDesktopViewport()) setExplorerCollapsedFromUser(true);
      return openContextHubProject(worktree?.id || project.id, { filePath });
    }).catch((error) => setStatus(error.message));
  }

  // « Recent docs » lists the newest docs of this project under the shortcuts; a second press hides it.
  function toggleRecent(project) {
    const worktree = globalProjectSelectedWorktree(project);
    if (!mounted(worktree)) return setStatus('This project has no local copy on this device');
    const key = worktree.id;
    if (recent?.key === key) recent = null;
    else {
      recent = { key, files: null };
      api('/api/context-hub/project-recent?projectId=' + encodeURIComponent(key))
        .then((data) => { if (recent?.key === key) recent.files = data.files || []; }, (error) => { if (recent?.key === key) recent.error = error.message; })
        .finally(sync);
    }
    sync();
  }

  function recentMarkup(project) {
    if (!recent || recent.key !== globalProjectSelectedWorktree(project)?.id) return '';
    const when = (value) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return '<div class="pp-recent" id="projectRecentDocs"><h3>Recent docs</h3>' + (recent.error ? '<p class="pp-empty">' + escapeHtml(recent.error) + '</p>'
      : !recent.files ? '<p class="pp-empty">Reading…</p>'
      : recent.files.length ? '<ul class="pp-list">' + recent.files.map((file) => fileRow({ path: file.path, name: file.path.split('/').pop() }, file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '', when(file.updatedAt))).join('') + '</ul>'
      : '<p class="pp-empty">No doc yet.</p>') + '</div>';
  }

  function syncLevels(project) {
    const worktree = project && state.projectAgentsOpen ? globalProjectSelectedWorktree(project) : null;
    levelsBox.hidden = !mounted(worktree);
    if (levelsBox.hidden) return void (levelsShown = '');
    const provider = agentContextProvider();
    const key = worktree.id + '|' + provider;
    if (!levels.has(key)) {
      levels.set(key, null);
      api('/api/context-hub/project-agents?projectId=' + encodeURIComponent(worktree.id) + '&provider=' + encodeURIComponent(provider))
        .then((data) => levels.set(key, data), (error) => levels.set(key, { error: error.message }))
        .finally(sync);
    }
    const data = levels.get(key);
    // Drawn again only when its data changes, so an open or closed level stays as the person left it.
    const shown = key + (data ? data.error ? ':error' : ':ready' : ':loading');
    if (shown === levelsShown) return;
    levelsShown = shown;
    levelsBox.innerHTML = '<h3>Per level · ' + escapeHtml(AGENT_PROVIDER_LABELS[provider] || provider) + '</h3>'
      + (!data ? '<p class="pp-empty">Reading agent files…</p>' : data.error ? '<p class="pp-empty">' + escapeHtml(data.error) + '</p>' : data.levels.map(levelMarkup).join(''));
  }

  // « Skills & MCP » is its own module (skills-mcp.mjs), fetched on the first press and placed under the shortcuts.
  function syncTools(project) {
    const worktree = project && toolsOpen ? globalProjectSelectedWorktree(project) : null;
    const id = mounted(worktree) ? worktree.id : '';
    if (!toolsView) {
      if (!id) return;
      toolsView = import('/assets/ui/skills-mcp.mjs').then((module) => module.createSkillsMcp(tiles, (filePath) => {
        const now = currentProject();
        if (now) openFile(now, filePath);
      }, () => {
        toolsOpen = false;
        sync();
      }));
      toolsView.catch((error) => {
        toolsView = null;
        toolsOpen = false;
        setStatus(error.message);
        sync();
      });
    }
    toolsView.then((view) => view.show(id), () => {});
  }

  function openTile(project, tile) {
    if (tile.type === 'file') openFile(project, tile.path);
    else if (tile.type === 'folder') void revealFolder(project, tile.path).catch((error) => setStatus(error.message));
    else if (tile.type === 'agents') openAgents(project);
    else if (tile.type === 'recent') toggleRecent(project);
    else {
      showTree();
      window.requestAnimationFrame(() => el('globalProjectList')?.querySelector('.global-project-tree-entry')?.focus());
    }
  }

  function openAgents(project) {
    state.projectAgentsOpen = true;
    openGlobalProjectInspection('startup', project);
    window.requestAnimationFrame(() => el('contextHealthPanel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  function tileMarkup(tile, index, count) {
    const key = escapeHtml(projectTileKey(tile));
    const name = tileName(tile);
    const hint = tile.path || TILE_INFO[tile.type][1];
    const kind = tile.type === 'folder' ? 'Folder' : tile.type === 'file' ? 'File' : '';
    return '<li class="pp-' + tile.size + '"><button class="pp-tile" type="button" data-tile-type="' + tile.type + '" data-project-tile="' + key + '" title="' + escapeHtml(hint) + '"'
      + (kind ? ' aria-label="' + kind + ' ' + escapeHtml(name.replace(/\/$/, '')) + '"' : '') + '>'
      + '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[tile.type] + '</svg><strong>' + escapeHtml(name) + '</strong><small>' + escapeHtml(kind ? kind + ' · ' + hint : hint) + '</small></button>'
      + (editing ? '<span class="pp-edit">'
        + '<button type="button" data-tile-move="-1" data-tile-key="' + key + '" aria-label="Move ' + escapeHtml(name) + ' up"' + (index ? '' : ' disabled') + '>↑</button>'
        + '<button type="button" data-tile-move="1" data-tile-key="' + key + '" aria-label="Move ' + escapeHtml(name) + ' down"' + (index < count - 1 ? '' : ' disabled') + '>↓</button>'
        + '<button type="button" data-tile-size data-tile-key="' + key + '" aria-label="' + (tile.size === 'full' ? 'Half width' : 'Full width') + ' · ' + escapeHtml(name) + '">' + (tile.size === 'full' ? '½' : '⇔') + '</button>'
        + '<button type="button" data-tile-remove data-tile-key="' + key + '" aria-label="Remove ' + escapeHtml(name) + '">✕</button></span>' : '')
      + '</li>';
  }

  function sync() {
    const project = currentProject();
    // Tabs: Projects · <this project> · Computer. Inside a project, Projects leads back to the list (decision 8).
    const tabProject = state.globalExplorerProjectKey && (state.contextHub?.projects || []).find((item) => item.projectKey === state.globalExplorerProjectKey);
    const tab = document.querySelector('[data-global-explorer-mode="project"]');
    if (tab) {
      tab.hidden = !tabProject;
      tab.textContent = tabProject ? tabProject.title || tabProject.id : '';
    }
    const back = document.querySelector('[data-global-explorer-mode="projects"]');
    const inProject = Boolean(tabProject) && state.globalExplorerMode === 'project';
    back?.toggleAttribute('data-global-explorer-back', inProject);
    for (const name of ['title', 'aria-label']) {
      if (inProject) back?.setAttribute(name, 'Back to projects');
      else back?.removeAttribute(name);
    }
    head.hidden = tiles.hidden = !project;
    const toReview = reviewCount(project);
    band(project);
    syncLevels(project);
    syncTools(project);
    group();
    if (!project) {
      editing = false;
      toolsOpen = false;
      entered = '';
      return;
    }
    // Below 981 px the Explorer is a drawer: entering a project closes it, so it never covers the page.
    if (entered !== project.projectKey) {
      entered = project.projectKey;
      if (!isExplorerDesktopViewport()) applyExplorerCollapsed(true);
    }
    if (!pages.has(project.projectKey)) void load(project);
    const all = (state.contextHub?.projects || []).reduce((sum, item) => sum + reviewCount(item), 0);
    head.innerHTML = '<button class="secondary pp-back" type="button" data-pp-home>‹ To review' + (all ? ' · ' + all : '') + '</button><h2>' + escapeHtml(project.title || project.id) + '</h2>'
      + '<span class="pp-count">' + (toReview ? toReview + ' to review' : 'Nothing to review') + '</span>'
      + '<button class="secondary pp-end" type="button" data-pp-tools aria-expanded="' + toolsOpen + '">Skills &amp; MCP ›</button>'
      + '<button class="secondary" type="button" data-pp-agents aria-expanded="' + String(Boolean(state.projectAgentsOpen)) + '">What agents load ›</button>';
    const list = tilesOf(project);
    const keys = new Set(list.map(projectTileKey));
    const addable = [{ type: 'agents' }, { type: 'all' }, { type: 'recent' }, ...(rootFolders(project) || []).map((path) => ({ type: 'folder', path }))]
      .filter((tile) => !keys.has(projectTileKey(tile)));
    tiles.innerHTML = '<div class="pp-tiles-head"><h2 id="projectTilesHeading">Shortcuts</h2><button class="secondary" type="button" data-tiles-edit aria-pressed="' + editing + '">' + (editing ? 'Done' : 'Edit') + '</button></div>'
      + (list.length ? '<ul class="pp-grid">' + list.map((tile, index) => tileMarkup(tile, index, list.length)).join('') + '</ul>' : '<p class="pp-empty">No shortcut. Edit adds one; ⋯ › Pin to project page in the tree pins a file or a folder.</p>')
      + (editing && addable.length ? '<div class="pp-add">Add: ' + addable.map((tile) => '<button class="secondary" type="button" data-tile-add="' + escapeHtml(JSON.stringify(tile)) + '">' + escapeHtml(tileName(tile)) + '</button>').join('') + '</div>' : '')
      + recentMarkup(project);
  }

  // On « To review » (all projects), one heading per project run: « Name · N », then Open project ›.
  const reviewList = el('reviewQueue');
  const watcher = new MutationObserver(group);
  // The band hides only when nothing of this project would show in it: files, local proposals, images,
  // shared proposals, working drafts or a review in progress. Not while the queue is still unknown.
  function band(project) {
    const busy = (key) => reviewCount(project) || contextHubReviewItems().some((item) => contextHubProjectForItem(item)?.projectKey === key)
      || (state.contextHub?.workingDrafts || []).some((draft) => draft.projectKey === key) || !el('reviewFlowPanel')?.hidden;
    queue?.classList.toggle('pp-none', Boolean(project && state.contextHubReviewQueueReady && project.localReviewCount != null && !busy(project.projectKey)));
  }

  function group() {
    if (!reviewList) return;
    watcher.disconnect();
    for (const node of reviewList.querySelectorAll(':scope > .pp-group')) node.remove();
    const project = currentProject();
    band(project);
    if (!project) {
      const all = contextHubReviewItems();
      const items = new Map(all.map((item) => [item.id, item]));
      const order = new Map(contextHubPrioritizedProjects(state.contextHub?.projects || []).map((item, index) => [item.projectKey, index]));
      const rank = (owner) => owner ? order.get(owner.projectKey) ?? order.size : order.size + 1;
      // One group per project, in project order (N2); rows keep their order inside a group.
      const rows = [...reviewList.querySelectorAll(':scope > [data-context-room-review-entry]')]
        .map((row, index) => ({ row, index, owner: contextHubProjectForItem(items.get(row.dataset.contextRoomReviewEntry)) }))
        .sort((left, right) => rank(left.owner) - rank(right.owner) || left.index - right.index);
      const anchor = rows[0] && document.createComment('');
      rows[0]?.row.before(anchor);
      for (const { row } of rows) anchor.before(row);
      anchor?.remove();
      // The count is the project's whole review, not the rows shown (the list stops at 80).
      const proposals = (key) => all.filter((item) => (item.type === 'local-proposal' || item.type === 'local-asset') && contextHubProjectForItem(item)?.projectKey === key).length;
      rows.forEach(({ row, owner }, index) => {
        if (!owner || owner.projectKey === rows[index - 1]?.owner?.projectKey) return;
        const header = document.createElement('div');
        header.className = 'pp-group';
        header.dataset.ppGroup = owner.projectKey;
        header.innerHTML = '<strong>' + escapeHtml(owner.title || owner.id) + ' · ' + (reviewCount(owner) + proposals(owner.projectKey)) + '</strong><button class="secondary" type="button">Open project ›</button>';
        header.addEventListener('click', (event) => {
          event.stopPropagation();
          void openGlobalProjectExplorer(owner).catch((error) => setStatus(error.message));
        });
        row.before(header);
      });
    }
    watcher.observe(reviewList, { childList: true });
  }

  head.addEventListener('click', (event) => {
    const project = currentProject();
    if (!project) return;
    if (event.target.closest('[data-pp-home]')) void returnToGlobalContextHubHome().catch((error) => setStatus(error.message));
    else if (event.target.closest('[data-pp-agents]')) {
      if (state.projectAgentsOpen) closeAgents();
      else openAgents(project);
    } else if (event.target.closest('[data-pp-tools]')) {
      if (!toolsOpen && !mounted(globalProjectSelectedWorktree(project))) return setStatus('This project has no local copy on this device');
      toolsOpen = !toolsOpen;
      sync();
    }
  });

  levelsBox.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pp-open]');
    const project = currentProject();
    if (button && project) openFile(project, button.dataset.ppOpen);
  });

  function closeAgents() {
    state.projectAgentsOpen = false;
    levels.clear();
    renderContextHealth();
    sync();
  }

  tiles.addEventListener('click', (event) => {
    const project = currentProject();
    if (!project) return;
    const button = event.target.closest('button');
    if (!button) return;
    if (button.matches('[data-tiles-edit]')) {
      editing = !editing;
      sync();
      return;
    }
    if (button.dataset.ppOpen) return openFile(project, button.dataset.ppOpen);
    const tile = button.dataset.projectTile && tilesOf(project).find((item) => projectTileKey(item) === button.dataset.projectTile);
    if (tile) return openTile(project, tile);
    const list = tilesOf(project);
    const key = button.dataset.tileKey;
    if (button.dataset.tileMove) void save(project, moveProjectTile(list, key, Number(button.dataset.tileMove)));
    else if (button.matches('[data-tile-size]')) void save(project, sizeProjectTile(list, key));
    else if (button.matches('[data-tile-remove]')) void save(project, removeProjectTile(list, key));
    else if (button.dataset.tileAdd) void save(project, addProjectTile(list, { ...JSON.parse(button.dataset.tileAdd), size: 'half' }));
  });

  // « What agents load » is a side panel that closes; it is not a third page.
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary';
  close.dataset.ppClose = '';
  close.textContent = 'Close';
  close.addEventListener('click', closeAgents);
  el('contextHealthPanel')?.querySelector('h2')?.after(close);

  return {
    sync,
    /** Pins a file or a folder of the tree (⋯ › Pin to project page). */
    async pin(project, target) {
      await load(project);
      const list = tilesOf(project);
      const next = addProjectTile(list, { type: target.kind === 'folder' ? 'folder' : 'file', path: target.path, size: 'half' });
      if (next === list) return setStatus('Already on the project page');
      await save(project, next);
      setStatus('Pinned to the project page');
    },
  };
}
