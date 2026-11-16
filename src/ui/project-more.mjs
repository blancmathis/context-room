// What only the Files view offered, now on the project page (R12): « Trust the current versions » while no file of the
// project is accepted, the project's notebooks, and a ⋯ button (hide the project, the internal Hub folder, Trust…).
// Loaded on demand with the first project page; it calls the page's own functions and `state`.

/* global state, api, escapeHtml, setStatus, globalProjectSelectedWorktree, showTrustCurrentVersionsDialog,
   captureNotebookApi, openContextRoomNotebook, openGlobalExplorerContextMenu */

const CSS = `#projectTrust{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:6px 0 10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px}
#projectTrust p{margin:0;flex:1 1 240px}
#projectNotebooks h2{margin:18px 0 6px;font-size:15px}
#projectNotebooks ul{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
@media (pointer:coarse){#projectTrust button,#projectNotebooks button,#projectPageHead [data-pp-more]{min-height:44px;min-width:44px}}`;

const mounted = (worktree) => Boolean(worktree?.root) && worktree.available !== false;
const byDate = (left, right) => String(right.changedAt || '').localeCompare(String(left.changedAt || ''));

export function createProjectMore(head, docsBox) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const trust = document.createElement('div');
  trust.id = 'projectTrust';
  trust.hidden = true;
  head.after(trust);
  const notes = document.createElement('section');
  notes.id = 'projectNotebooks';
  notes.setAttribute('aria-labelledby', 'projectNotebooksHeading');
  notes.hidden = true;
  docsBox.after(notes);
  // The offer is asked again when the project's review count changes (a trust, its undo, a new scan).
  const offers = new Map();
  const notebooks = new Map();
  let entered = '';

  const current = () => (state.contextHub?.projects || []).find((project) => project.projectKey === state.globalExplorerProjectKey) || null;
  const worktreeOf = (project) => globalProjectSelectedWorktree(project) || project;

  async function ask(map, key, load) {
    map.set(key, null);
    try { map.set(key, await load()); } catch { map.set(key, undefined); }
    render();
  }

  function render() {
    const project = current();
    const shown = Boolean(project) && !head.hidden;
    const offer = shown ? offers.get(project.projectKey + ':' + Number(project.localReviewCount || 0)) : null;
    trust.hidden = !offer;
    if (offer) {
      trust.innerHTML = '<p><strong>' + offer + (offer === 1 ? ' file has' : ' files have') + ' no accepted version yet.</strong> Agents get none of them until they are accepted.</p>'
        + '<button class="primary" type="button" data-pp-trust>Trust the current versions…</button>';
    }
    const list = shown ? notebooks.get(project.projectKey) : null;
    notes.hidden = !list?.length;
    if (list?.length) {
      notes.innerHTML = '<h2 id="projectNotebooksHeading">Notebooks · ' + list.length + '</h2><ul>'
        + list.map((item) => '<li><button class="secondary" type="button" data-pp-notebook="' + escapeHtml(item.id) + '">' + escapeHtml(item.title || item.id) + '</button></li>').join('') + '</ul>';
    }
  }

  function show(project) {
    if (project && !head.hidden && !head.querySelector('[data-pp-more]')) {
      head.insertAdjacentHTML('beforeend', '<button class="secondary" type="button" data-pp-more aria-haspopup="menu" aria-label="'
        + escapeHtml('Project actions · ' + (project.title || project.id)) + '">⋯</button>');
    }
    if (!project) entered = '';
    const worktree = project && worktreeOf(project);
    if (mounted(worktree)) {
      const offerKey = project.projectKey + ':' + Number(project.localReviewCount || 0);
      if (!offers.has(offerKey)) {
        void ask(offers, offerKey, async () => {
          const preview = await api('/api/context-hub/trust-current?projectId=' + encodeURIComponent(worktree.id));
          return preview?.offered ? (preview.items || []).length : 0;
        });
      }
      // Notebooks are read again each time the page is entered: one may have been made from the tree.
      if (entered !== project.projectKey) {
        entered = project.projectKey;
        void ask(notebooks, project.projectKey, async () => [...((await captureNotebookApi(project.id).api('/api/notebooks')).notebooks || [])].sort(byDate));
      }
    }
    render();
  }

  head.addEventListener('click', (event) => {
    const project = current();
    if (project && event.target.closest('[data-pp-more]')) openGlobalExplorerContextMenu(event, { scope: 'project', kind: 'project', path: '', projectKey: project.projectKey });
  });
  trust.addEventListener('click', (event) => {
    const project = current();
    const trigger = event.target.closest('[data-pp-trust]');
    if (project && trigger) void showTrustCurrentVersionsDialog(worktreeOf(project).id, project.title || project.id, { trigger });
  });
  notes.addEventListener('click', (event) => {
    const project = current();
    const button = event.target.closest('[data-pp-notebook]');
    if (!project || !button) return;
    const reload = () => { entered = ''; show(current()); };
    openContextRoomNotebook('', { projectId: project.id, resourceId: button.dataset.ppNotebook, onClosed: reload }).catch((error) => setStatus(error.message));
  });

  return { show };
}
