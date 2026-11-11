// Hub doc links, loaded by app.mjs with the first relative link of a Hub doc. In the Hub, state.files is empty:
// a link target is looked up in the open file's project, walking down from the root in the Explorer cache.
// Only folders listed by their parent are read (no 404). A cleared cache or a failed read is read again.
export function createHubDocLinks(app) {
  const { state } = app;
  const pending = new Map(); // file path -> Explorer cache key of its project
  let draining = false;
  let redrawWanted = false;

  function openProject() {
    const project = (state.contextHub?.projects || []).find((item) => item.projectKey === state.globalExplorerProjectKey);
    return project && state.activeProjectLocationId && state.activeProjectLocationId === (app.globalProjectSelectedWorktree(project)?.id || project.id) ? project : null;
  }

  // true, false, null, or the folder to read first.
  function walk(project, filePath) {
    const parts = filePath.split("/");
    let directory = "";
    for (let index = 0; index < parts.length; index += 1) {
      const page = state.globalProjectExplorerDetails.get(app.globalProjectExplorerPageKey(project, { directory }));
      if (!page) return directory;
      const childPath = directory ? directory + "/" + parts[index] : parts[index];
      const entry = page.entries?.find((item) => item.path === childPath);
      const last = index === parts.length - 1;
      if (!entry) return page.nextCursor == null && !parts[index].startsWith(".") ? false : null;
      if (last || entry.type !== "directory") return last && entry.type !== "directory";
      directory = childPath;
    }
    return null;
  }

  function known(filePath) {
    const project = openProject();
    if (!project || !filePath) return null;
    const result = walk(project, filePath);
    if (typeof result !== "string") return result;
    const scope = app.globalProjectExplorerCacheKey(project);
    pending.set(filePath, scope);
    if (!draining) {
      draining = true;
      queueMicrotask(() => void drain(scope));
    }
    return null;
  }

  // Read the folders level by level, then redraw the open doc once, whichever doc it is now.
  async function drain(scope) {
    const current = () => { const project = openProject(); return project && app.globalProjectExplorerCacheKey(project) === scope ? project : null; };
    const tries = new Map();
    let loaded = redrawWanted;
    redrawWanted = false;
    try {
      for (let round = 0, project; round < 16 && (project = current()); round += 1) {
        const directories = new Set();
        for (const [filePath, pathScope] of pending) {
          if (pathScope !== scope) continue;
          const result = walk(project, filePath);
          if (typeof result === "string" && (tries.get(result) || 0) < 2) directories.add(result);
          else pending.delete(filePath);
        }
        if (!directories.size) break;
        const pages = await Promise.all([...directories].map((directory) => loadDirectory(project, directory).catch(() => null)));
        [...directories].forEach((directory, index) => pages[index] ? (loaded = true) : tries.set(directory, (tries.get(directory) || 0) + 1));
        // A failed read is tried once more.
        if (!pages.some(Boolean)) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      draining = false;
    }
    // Another project opened during the reads: read its paths now, and redraw once at the end.
    const project = openProject(), next = project && app.globalProjectExplorerCacheKey(project);
    for (const [filePath, pathScope] of pending) if (pathScope === scope || pathScope !== next) pending.delete(filePath);
    if (pending.size) {
      draining = true;
      redrawWanted = loaded;
      return void drain(next);
    }
    if (loaded && openProject()) redraw();
  }

  async function loadDirectory(project, directory) {
    const key = app.globalProjectExplorerPageKey(project, { directory });
    let page = await app.loadGlobalProjectExplorerPage(project, { directory });
    // The Explorer may be reading it already.
    for (let wait = 0; !page && wait < 50 && state.globalProjectExplorerLoading.has(key); wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    page ||= state.globalProjectExplorerDetails.get(key);
    for (let pages = 1; page?.nextCursor != null && pages < 8; pages += 1) {
      page = await app.loadGlobalProjectExplorerPage(project, { directory, cursor: page.nextCursor, force: true });
    }
    return page;
  }

  // One redraw of the open doc; keeps the reading place, or the heading a jump is still aligning on.
  function redraw() {
    if (state.page !== "file" || state.mode !== "view" || state.dirty) return;
    const place = app.captureReadingPlace();
    const anchor = app.settlingAnchor();
    app.renderViewer();
    if (!anchor || !app.scrollToMarkdownAnchor(anchor)) app.restoreReadingPlace(place);
  }

  function missing(rawTarget) {
    const target = app.cleanMarkdownDocLinkTarget(rawTarget);
    if (!target || !app.isMarkdownDocLinkTarget(target) || target.startsWith("/")) return false;
    const directory = app.currentDocumentDirectory();
    const candidates = /^\.{1,2}\//.test(target) ? [app.normalizeDocPath(directory ? directory + "/" + target : target)] : [app.normalizeDocPath(target), directory ? app.normalizeDocPath(directory + "/" + target) : ""];
    return candidates.every((candidate) => !candidate || known(candidate) === false);
  }

  // Links seen before the module loaded: check them, then redraw once.
  function prime(targets) {
    redrawWanted = true;
    for (const target of targets) missing(target);
    if (!draining) { redrawWanted = false; redraw(); }
  }

  return { known, missing, prime };
}
