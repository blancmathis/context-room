import { notebookDownload } from './notebook-download.mjs';

const element = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
const button = (text, callback) => { const node = element('button', text); node.type = 'button'; node.addEventListener('click', callback); return node; };

/** Explicit association review. No guessed context, autoplay, transcription or send. */
export function createLinkedRecordings({ api }) {
  const section = element('section'); section.setAttribute('aria-label', 'Recovered recordings');
  const details = element('details'), summary = element('summary', 'Recovered recordings'), list = element('div'), status = element('p');
  status.setAttribute('role', 'status');
  const form = element('form'), fields = element('fieldset'), legend = element('legend', 'Choose an original recording');
  const input = (text, placeholder) => {
    const label = element('label', text), node = element('input'); node.type = 'text'; node.placeholder = placeholder; node.required = true;
    node.setAttribute('aria-label', text); label.append(node); fields.append(label); return node;
  };
  fields.append(legend);
  const snapshot = input('Private recovery snapshot directory', 'Exact directory on the connected Mac');
  const name = input('Original PCM filename', 'Exact name from the recovery inventory');
  const label = input('Recording label', 'A label for this recording'); label.maxLength = 200; label.value = 'Recovered recording';
  const preview = element('button', 'Preview recording link'); preview.type = 'submit';
  const review = element('p'), apply = button('Attach this exact recording', () => void commit()), cancel = button('Cancel recording link', () => reset());
  apply.hidden = true; fields.append(preview, cancel); form.append(fields, review, apply); form.hidden = true;
  const choose = button('Attach recovered recording', () => { form.hidden = false; snapshot.focus(); });
  const refresh = button('Refresh recording links', () => void load());
  details.append(element('p', 'Select the source explicitly. Loading audio, playing it and sending a message are separate actions.'), list, choose, refresh, form, status);
  section.append(details);
  let id = null, epoch = 0, loaded = false, plan = null, prepared = null, urls = [], audios = [], busy = false;
  const valid = (original, generation) => id === original && epoch === generation && section.isConnected;
  const route = original => '/api/assistant/conversations/' + encodeURIComponent(original) + '/recordings';
  const post = (original, body) => api(route(original), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cleanup = () => { for (const audio of audios) { audio.pause(); audio.removeAttribute('src'); audio.load(); } audios = []; urls.forEach(url => URL.revokeObjectURL(url)); urls = []; };
  function reset() { plan = prepared = null; apply.hidden = true; review.textContent = ''; form.hidden = true; }
  function controls(disabled) { busy = disabled; fields.disabled = disabled; apply.disabled = disabled; refresh.disabled = disabled; }
  async function download(item, original, generation, format) {
    const result = await api(route(original) + '/' + item.id + '?format=' + format);
    if (!valid(original, generation)) return null;
    if (result.id !== item.id || result.revision !== item.revision || result.originalSha256 !== item.sha256
      || !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > 3_840_044) throw new Error('The selected recording changed or exceeds its size limit.');
    const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (bytes.length !== result.bytes || hash !== result.sha256 || format === 'pcm' && hash !== item.sha256) throw new Error('The recording failed its original content hash.');
    return valid(original, generation) ? { bytes, result } : null;
  }
  async function load() {
    if (!id || busy) return;
    const original = id, generation = epoch; controls(true); status.textContent = '';
    try {
      const response = await api(route(original)); if (!valid(original, generation)) return;
      cleanup(); list.replaceChildren(); loaded = true;
      for (const item of response.items) {
        const article = element('article'), audio = element('audio'); audio.controls = true; audio.preload = 'none'; audio.hidden = true; audio.setAttribute('aria-label', 'Playback: ' + item.label); audios.push(audio);
        article.append(element('strong', item.label), element('p', `${item.durationSeconds}s · ${item.target.source.path} · ${item.target.conversationId ? 'this conversation' : 'source attachment'}${item.sourceChanged ? ' · source has newer work' : ''}`));
        const read = button('Load audio for review', async () => {
          read.disabled = true;
          try { const value = await download(item, original, generation, 'wav'); if (!value) return;
            const url = URL.createObjectURL(new Blob([value.bytes], { type: 'audio/wav' })); urls.push(url); audio.src = url; audio.hidden = false;
            status.textContent = 'Recording loaded. Press Play to listen; nothing was transcribed or sent.';
          } catch (error) { if (valid(original, generation)) status.textContent = error.message; }
          finally { if (valid(original, generation)) read.disabled = false; }
        });
        const save = button('Export original PCM', async () => {
          save.disabled = true;
          try { const value = await download(item, original, generation, 'pcm'); if (!value) return;
            await notebookDownload(value.bytes, item.name, 'application/octet-stream');
          } catch (error) { if (valid(original, generation)) status.textContent = error.message; }
          finally { if (valid(original, generation)) save.disabled = false; }
        });
        article.append(read, save, audio); list.append(article);
      }
      if (!response.items.length) list.append(element('p', 'No recording has been explicitly attached to this source or conversation.'));
    } catch (error) { if (valid(original, generation)) status.textContent = error.message; }
    finally { if (valid(original, generation)) controls(false); }
  }
  form.addEventListener('input', () => { plan = prepared = null; apply.hidden = true; review.textContent = ''; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !id) return;
    const original = id, generation = epoch, input = { snapshot: snapshot.value.trim(), name: name.value.trim(), label: label.value.trim() };
    controls(true); status.textContent = '';
    try { const value = await post(original, input); if (!valid(original, generation)) return;
      plan = value; prepared = input;
      review.textContent = `${value.name} · ${value.durationSeconds}s → ${value.target.source.path} · this original conversation. SHA-256 ${value.sha256}. Attachment does not play, transcribe or send this recording.`;
      apply.hidden = false;
    } catch (error) { if (valid(original, generation)) status.textContent = error.message; }
    finally { if (valid(original, generation)) controls(false); }
  });
  async function commit() {
    if (busy || !plan || !prepared) return;
    const original = id, generation = epoch, input = { ...prepared, apply: true, expectedRevision: plan.revision };
    controls(true);
    try { await post(original, input); if (!valid(original, generation)) return; reset(); controls(false); await load();
      if (valid(original, generation)) status.textContent = 'Recording attached to the original conversation. Not played, transcribed or sent.';
    } catch (error) { if (valid(original, generation)) status.textContent = error.message; }
    finally { if (valid(original, generation)) controls(false); }
  }
  details.addEventListener('toggle', () => { if (details.open && !loaded) void load(); });
  return { section, dispose() { epoch++; cleanup(); reset(); }, set(conversation) {
    if (id === conversation.id) return;
    epoch++; cleanup(); id = conversation.id; loaded = false; controls(false); reset(); details.open = false; list.replaceChildren(); status.textContent = '';
  } };
}
