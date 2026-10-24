const element = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const button = (text, action) => { const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const when = seconds => seconds ? new Date(seconds * 1000).toLocaleString() : '';

/**
 * Codex tasks of this Mac for the exact project, read only. There is no way to send, continue
 * or change a task from here. Titles and text go in with textContent, never as HTML.
 */
const localProfile = () => { const profile = document.documentElement.dataset.contextRoomRuntimeProfile; return !profile || profile === 'local'; };
export function createMacTasks({ api, isLocal = localProfile }) {
  const section = element('section', '', 'assistant-mac-tasks'); section.setAttribute('aria-label', 'Codex tasks on this Mac'); section.hidden = true;
  const toggle = button('Codex tasks on this Mac', () => { section.hidden = !section.hidden; if (!section.hidden && !loaded) void loadList({ reset: true }); });
  const showCurrent = button('Show on Mac', () => run(openOnMac('/api/assistant/conversations/' + currentId + '/open-on-mac')));
  showCurrent.hidden = true; showCurrent.title = 'Opens this conversation’s Codex task in Codex on this Mac. Nothing is sent.';
  const search = element('input'); search.type = 'search'; search.maxLength = 120; search.setAttribute('aria-label', 'Search task titles (exact case)'); search.placeholder = 'Search titles (exact case)';
  const archivedLabel = element('label', ' Archived tasks'), archived = element('input'); archived.type = 'checkbox'; archivedLabel.prepend(archived);
  const find = button('Search', () => loadList({ reset: true }));
  const list = element('div', '', 'assistant-mac-list'), status = element('p', '', 'assistant-mac-status'); status.setAttribute('role', 'status');
  const next = button('Next tasks', () => loadList({ cursor: nextCursor, back: true })), previous = button('Previous tasks', () => loadList({ cursor: stack.pop() ?? null, popped: true }));
  const retry = button('Retry', () => loadList({ cursor: lastCursor })); retry.hidden = true;
  const detail = element('div', '', 'assistant-mac-detail'); detail.hidden = true;
  const controls = element('div', '', 'assistant-controls'); controls.append(search, find, archivedLabel);
  const paging = element('div', '', 'assistant-controls'); paging.append(previous, next, retry); paging.hidden = true;
  section.append(controls, status, list, paging, detail);
  let currentId = null, thread = null, loaded = false, nextCursor = null, lastCursor = null, stack = [], generation = 0, busy = false;
  const run = promise => Promise.resolve(promise).catch(error => { status.textContent = error.message || String(error); });
  async function openOnMac(route) { status.textContent = ''; await api(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); status.textContent = 'Shown on the Mac.'; }
  async function loadList({ cursor = null, reset = false, back = false, popped = false } = {}) {
    if (busy) return; busy = true; const epoch = ++generation; detail.hidden = true; list.hidden = false; paging.hidden = !loaded; retry.hidden = true;
    if (reset) stack = []; else if (back) stack.push(lastCursor);
    lastCursor = cursor; status.textContent = 'Loading Codex tasks…';
    const query = new URLSearchParams(); if (cursor) query.set('cursor', cursor); if (search.value) query.set('search', search.value); if (archived.checked) query.set('archived', '1');
    try {
      const result = await api('/api/assistant/mac-tasks' + (query.size ? '?' + query : '')); if (epoch !== generation) return;
      loaded = true; paging.hidden = false; nextCursor = result.nextCursor; list.replaceChildren();
      for (const task of result.data) {
        const row = element('div', '', 'assistant-mac-row'), open = button(task.title, () => run(loadTask(task.id)));
        open.setAttribute('aria-label', 'Read summary: ' + task.title); row.append(open, element('small', when(task.updatedAt) + (task.archived ? ' · archived' : ''))); list.append(row);
      }
      status.textContent = result.data.length ? 'Read only. These tasks stay in Codex.' : 'No Codex tasks for this project on this Mac.';
      next.hidden = !nextCursor; previous.hidden = !stack.length;
    } catch (error) { if (epoch !== generation) return; status.textContent = error.message || String(error); retry.hidden = false; paging.hidden = false; }
    finally { if (epoch === generation) busy = false; }
  }
  async function loadTask(id, { cursor = null, append = null } = {}) {
    const epoch = ++generation; busy = false; status.textContent = 'Loading summary…';
    try {
      const task = await api('/api/assistant/mac-tasks/' + id + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')); if (epoch !== generation) return;
      status.textContent = ''; list.hidden = true; paging.hidden = true; detail.hidden = false;
      if (!append) { detail.replaceChildren(); detail.dataset.id = id; detail.append(element('h3', task.title), element('p', 'Summary · read only', 'assistant-mac-badge')); }
      if (!append) { thread = element('div', '', 'assistant-messages'); detail.append(thread); }
      const added = [];
      for (const turn of task.turns) {
        const article = element('article');
        article.append(element('strong', 'You'), element('p', turn.user + (turn.userTruncated ? ' …' : '')), element('strong', 'Codex'), element('p', turn.assistant + (turn.assistantTruncated ? ' …' : '')));
        added.push(article);
      }
      thread.prepend(...added); // older exchanges come before the ones already shown
      const older = detail.querySelector('[data-older]'); older?.remove();
      const tools = detail.querySelector('.assistant-controls'); tools?.remove();
      const bar = element('div', '', 'assistant-controls');
      if (task.nextCursor) { const more = button('Older exchanges', () => run(loadTask(id, { cursor: task.nextCursor, append: true }))); more.dataset.older = ''; bar.append(more); }
      if (isLocal()) bar.append(button('Show on Mac', () => run(openOnMac('/api/assistant/mac-tasks/' + id + '/open'))));
      bar.append(button('Back to tasks', () => run(loadList({ cursor: lastCursor }))));
      detail.append(bar);
    } catch (error) { if (epoch === generation) { status.textContent = error.message || String(error); list.hidden = false; paging.hidden = false; } }
  }
  return { section, toggle, showCurrent,
    /** Called on every render: the header button exists only for a conversation that already has a Codex task. */
    set(conversation, local = isLocal()) { currentId = conversation.id; showCurrent.hidden = !(local && UUID.test(String(conversation.threadId || ''))); },
    dispose() { generation++; section.remove(); } };
}
