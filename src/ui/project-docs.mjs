// « All docs » on the page of one project (R9): every doc by folder or by date, a filter that works while one types
// (Enter opens the first result), the first « # » heading next to the name, and the other files folded away.
// Loaded on demand by the project page. The first part is pure data, tested without a browser.

/* global escapeHtml, api, setStatus, globalProjectSelectedWorktree, contextHubReviewItems */

const DOC = /\.(md|mdx|markdown|txt)$/i;
const FOLDER_ROWS = 12;

export const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
export const folderOf = (path) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** Docs (Markdown and text) and the other files of the index, each list kept apart. */
export function splitDocs(files) {
  const docs = [];
  const others = [];
  for (const file of files || []) (DOC.test(file.path) ? docs : others).push(file);
  return { docs, others };
}

/** Root first, then folders by name; inside a folder, files by name. */
export function groupByFolder(docs) {
  const groups = new Map();
  for (const doc of [...docs].sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path)))) {
    const folder = folderOf(doc.path);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(doc);
  }
  return [...groups].sort(([a], [b]) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b));
}

export const byDate = (docs) => [...docs].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.path.localeCompare(b.path));

/** The docs that match every word of the query: a name that starts with it first, then a name that holds it, then the path or the heading. */
export function filterDocs(docs, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return docs;
  const rank = (doc) => {
    const name = fold(nameOf(doc.path));
    const all = name + ' ' + fold(doc.path) + ' ' + fold(doc.title);
    if (!words.every((word) => all.includes(word))) return -1;
    return name.startsWith(words[0]) ? 0 : words.every((word) => name.includes(word)) ? 1 : 2;
  };
  return docs.map((doc) => [rank(doc), doc]).filter(([score]) => score >= 0)
    .sort(([left, a], [right, b]) => left - right || nameOf(a.path).localeCompare(nameOf(b.path)) || a.path.localeCompare(b.path))
    .map(([, doc]) => doc);
}

const CSS = `
.pd{display:grid;gap:10px}
.pd-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.pd-head h2{margin:0;font-size:15px}
.pd-head input{flex:1 1 260px;min-width:0;min-height:34px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text);font:inherit}
.pd-head label{display:flex;align-items:center;gap:6px;color:var(--muted)}
.pd-head select{min-height:34px}
.pd-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:4px 24px;align-items:start}
.pd-cols details>summary{display:flex;gap:6px;padding:8px 0 4px;cursor:pointer;font-weight:600}
.pd-cols summary span,.pd-list small,.pd-list time{color:var(--muted);font-weight:400}
.pd-list{display:grid;margin:0;padding:0;list-style:none}
.pd-list li{display:grid;grid-template-columns:12px minmax(0,auto) minmax(0,1fr) auto;align-items:baseline;gap:6px;min-height:32px}
.pd-list li>i{font-style:normal;color:var(--accent)}
.pd-list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pd-list time{font-size:13px;white-space:nowrap}
.pd-list button{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pd-more{border:0;background:none;color:var(--accent);font:inherit;padding:4px 0 4px 18px;cursor:pointer}
.pd-empty{margin:0;color:var(--muted)}
@media (min-width:981px){.pd-cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:1280px){.pd-cols{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (pointer:coarse){.pd-list li,.pd-cols summary,.pd-more,.pd-head input,.pd-head select{min-height:44px}.pd-list li{align-items:center}}
`;

export function createProjectDocs(box, open) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  box.className = 'docqa-panel pd';
  box.innerHTML = '<div class="pd-head"><h2 id="projectDocsHeading">All docs</h2><input type="search" data-pd-filter placeholder="Filter the docs of this project…" aria-label="Filter the docs of this project">'
    + '<label>Sort <select data-pd-sort aria-label="Sort the docs"><option value="folder">By folder</option><option value="date">By date</option></select></label></div><div data-pd-list></div>';
  box.setAttribute('aria-labelledby', 'projectDocsHeading');
  const input = box.querySelector('[data-pd-filter]');
  const sort = box.querySelector('[data-pd-sort]');
  const list = box.querySelector('[data-pd-list]');
  const heading = box.querySelector('h2');
  const cache = new Map();
  const more = new Set();
  let id = '';
  let drawn = '';
  let shown = [];

  const when = (value) => {
    if (!value) return '';
    const date = new Date(value);
    return date.toLocaleDateString([], date.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const row = (doc, review, detail) => {
    const name = nameOf(doc.path);
    const title = doc.title && fold(doc.title) !== fold(name.replace(DOC, '')) ? doc.title : '';
    return '<li><i aria-hidden="true">' + (review.has(doc.path) ? '●' : '') + '</i><button type="button" class="pp-link" data-pd-open="' + escapeHtml(doc.path) + '" title="' + escapeHtml(doc.path) + '"'
      + (review.has(doc.path) ? ' aria-label="' + escapeHtml(name) + ', to review"' : '') + '>' + escapeHtml(name) + '</button><small>' + escapeHtml(detail ?? title) + '</small><time>' + escapeHtml(when(doc.updatedAt)) + '</time></li>';
  };
  const folderBlock = ([folder, docs], review, root, touch) => {
    const all = more.has(folder) || docs.length <= FOLDER_ROWS;
    return '<details' + (!touch || !folder ? ' open' : '') + '><summary>' + escapeHtml(folder ? folder + '/' : root + '/') + '<span>· ' + docs.length + '</span></summary><ul class="pd-list">'
      + (all ? docs : docs.slice(0, FOLDER_ROWS)).map((doc) => row(doc, review)).join('') + '</ul>'
      + (all ? '' : '<button type="button" class="pd-more" data-pd-more="' + escapeHtml(folder) + '">+ ' + (docs.length - FOLDER_ROWS) + ' more</button>') + '</details>';
  };

  function draw(project) {
    const data = cache.get(id);
    const review = new Set(contextHubReviewItems().filter((item) => item.type === 'local' && item.projectId === id).map((item) => item.path));
    const key = JSON.stringify([id, Boolean(data), input.value, sort.value, [...more], [...review]]);
    if (key === drawn) return;
    drawn = key;
    if (!data) return void (list.innerHTML = '<p class="pd-empty">Reading the docs…</p>');
    if (data.error) return void (list.innerHTML = '<p class="pd-empty">' + escapeHtml(data.error) + '</p>');
    const { docs, others } = splitDocs(data.files);
    heading.textContent = 'All docs · ' + docs.length;
    const query = input.value.trim();
    const dated = sort.value === 'date';
    shown = query ? filterDocs(docs, query) : dated ? byDate(docs) : [];
    const flat = (items) => '<ul class="pd-list">' + items.map((doc) => row(doc, review, folderOf(doc.path))).join('') + '</ul>';
    list.innerHTML = (query ? (shown.length ? flat(shown) : '<p class="pd-empty">No doc matches « ' + escapeHtml(query) + ' ».</p>')
      : dated ? flat(shown)
      : docs.length ? '<div class="pd-cols">' + groupByFolder(docs).map((group) => folderBlock(group, review, project.title || project.id, matchMedia('(pointer:coarse)').matches)).join('') + '</div>'
      : '<p class="pd-empty">No doc in this project yet.</p>')
      + (others.length && !query ? '<details class="pd-cols" data-pd-others><summary>Other files<span>· ' + others.length + '</span></summary><ul class="pd-list">' + others.map((doc) => row(doc, review, folderOf(doc.path))).join('') + '</ul></details>' : '');
    if (!query && !dated) shown = groupByFolder(docs).flatMap(([, items]) => items);
  }

  input.addEventListener('input', () => draw(current));
  sort.addEventListener('change', () => draw(current));
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !shown.length || event.isComposing) return;
    event.preventDefault();
    open(shown[0].path);
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.dataset.pdOpen) open(button.dataset.pdOpen);
    else if (button?.dataset.pdMore != null) {
      more.add(button.dataset.pdMore);
      draw(current);
    }
  });

  let current = null;
  return {
    /** Called on each sync of the project page; reads the list once per visit of a project. */
    show(project) {
      const worktree = project && globalProjectSelectedWorktree(project);
      const next = worktree?.root && worktree.available !== false ? worktree.id : '';
      box.hidden = !next;
      current = project;
      if (!next) return void (id = '');
      if (next !== id) {
        id = next;
        input.value = '';
        more.clear();
        cache.delete(next);
        api('/api/context-hub/project-docs?projectId=' + encodeURIComponent(next))
          .then((data) => cache.set(next, data), (error) => {
            cache.set(next, { error: error.message });
            setStatus(error.message);
          })
          .finally(() => { if (id === next) draw(current); });
      }
      draw(project);
    },
  };
}
