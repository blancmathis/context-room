import { notebookDownload } from './notebook-download.mjs';

const element = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
/** Historical records are read-only. They never become a pending agent send. */
export function createRetainedHistory({ api }) {
  const section = element('section'); section.setAttribute('aria-label', 'Recovered Lisière history'); section.hidden = true;
  const identity = element('p'), boundary = element('p'), details = element('details'), summary = element('summary'), list = element('div');
  list.className = 'assistant-messages'; const older = element('button', 'Load more retained messages'), download = element('button', 'Export original history'), error = element('p');
  for (const control of [older, download]) control.type = 'button'; error.setAttribute('role', 'status');
  details.append(summary, identity, list, older, download, error); section.append(boundary, details);
  let currentId = null, loaded = false, nextOffset = 0, loading = false, generation = 0;
  const valid = (id, epoch) => id === currentId && epoch === generation && section.isConnected;
  const request = (id, query) => api('/api/assistant/conversations/' + id + '/legacy-history?' + new URLSearchParams(query));
  function message(item, id, epoch) {
    const article = element('article'), text = element('p', item.text);
    const status = { 'delivery-unconfirmed': 'Delivery unconfirmed · never replayed', partial: 'Retained partial answer', 'item-completed': 'Retained complete answer',
      'recorded-send-intent': 'Recorded send intent · delivery not inferred', 'recorded-item': 'Original recorded message', 'historical-status': 'Historical status',
      'historical-record': 'Historical event', unparsed: 'Original data retained; display unavailable' };
    article.append(element('strong', item.role === 'user' ? 'Original user' : item.role === 'assistant' ? 'Original agent' : 'Historical record'), text, element('small', status[item.completion] || 'Retained historical record'));
    if (item.context !== undefined) { const context = element('details'); context.append(element('summary', 'Original context'), element('pre', item.context + (item.contextTruncated ? '\nContext excerpt; export contains the complete original.' : ''))); article.append(context); }
    if (item.nextTextOffset !== null) {
      const more = element('button', 'Read more of this retained message'); more.type = 'button'; let offset = item.nextTextOffset;
      more.addEventListener('click', async () => {
        more.disabled = true;
        try { const result = await request(id, { message: item.index, textOffset: offset }); if (!valid(id, epoch)) return;
          const part = result.messages[0]; text.textContent += part.text; offset = part.nextTextOffset; more.hidden = offset === null;
        } catch (failure) { if (valid(id, epoch)) error.textContent = failure.message; } finally { more.disabled = false; }
      }); article.append(more);
    }
    return article;
  }
  async function load() {
    if (loading || nextOffset === null || !currentId) return;
    const id = currentId, epoch = generation; loading = true; older.disabled = true; error.textContent = '';
    try { const page = await request(id, { offset: nextOffset }); if (!valid(id, epoch)) return;
      list.append(...page.messages.map(item => message(item, id, epoch))); loaded = true; nextOffset = page.pagination.nextOffset; older.hidden = nextOffset === null;
      if (!page.pagination.total) list.append(element('p', 'This snapshot contains no readable messages. The original task identity and source records are retained.'));
    } catch (failure) { if (valid(id, epoch)) error.textContent = failure.message; }
    finally { if (valid(id, epoch)) { loading = false; older.disabled = false; } }
  }
  older.addEventListener('click', load); details.addEventListener('toggle', () => { if (details.open && !loaded) void load(); });
  download.addEventListener('click', async () => {
    const id = currentId, epoch = generation; download.disabled = true; error.textContent = '';
    try { let result = await request(id, { download: 1 }); if (!valid(id, epoch)) return;
      if (!Number.isSafeInteger(result.totalBytes) || result.totalBytes < 1 || result.totalBytes > 30 * 1024 * 1024) throw new Error('The original export exceeds the supported size.');
      const bytes = new Uint8Array(result.totalBytes), expectedHash = result.sha256; let offset = 0;
      while (true) {
        const part = Uint8Array.from(atob(result.data), value => value.charCodeAt(0));
        if (result.sha256 !== expectedHash || result.totalBytes !== bytes.length || result.offset !== offset || !part.length || offset + part.length > bytes.length) throw new Error('The original export changed during download.');
        bytes.set(part, offset); offset += part.length;
        if (result.nextOffset === null) { if (offset !== bytes.length) throw new Error('The original export is incomplete.'); break; }
        if (result.nextOffset !== offset) throw new Error('The original export has a missing passage.');
        result = await request(id, { download: 1, offset }); if (!valid(id, epoch)) return;
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== expectedHash) throw new Error('The original export failed its integrity check.');
      if (!valid(id, epoch)) return; const saved = await notebookDownload(bytes, 'retained-lisiere-history.json');
      if (valid(id, epoch)) error.textContent = saved?.saved === false ? 'Export cancelled. Original history remains available.' : 'Original history exported.';
    } catch (failure) { if (valid(id, epoch)) error.textContent = failure.message; } finally { if (valid(id, epoch)) download.disabled = false; }
  });
  return { section, set(conversation) {
    section.hidden = !conversation.legacy;
    if (currentId !== conversation.id) { currentId = conversation.id; generation++; loaded = false; loading = false; nextOffset = 0;
      list.replaceChildren(); details.open = false; older.hidden = false; older.disabled = download.disabled = false; error.textContent = ''; }
    if (!conversation.legacy) return;
    const legacy = conversation.legacy;
    identity.textContent = 'Original task ' + legacy.originalThreadId + ' · ' + legacy.recordCount + ' exact source records';
    boundary.textContent = conversation.threadId ? 'Continuation in a separate Context Room task. Original history stays unchanged.'
      : 'Sending or Voice starts a new task for ' + conversation.source.path + '. Original history stays unchanged.';
    summary.textContent = 'Read retained messages (' + legacy.messageCount + ')';
  } };
}
