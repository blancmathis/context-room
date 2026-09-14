const element = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const button = (text, action) => { const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const activeStatuses = new Set(['queued', 'starting', 'running', 'stopping']);
let active = null;

export function dockConversation(parent = document.body) { if (active) parent.append(active.panel); }

/** A captured API, never a callback that reads the browser's later project selection. */
export async function openConversation({ api, scopeKey, source, parent = document.body, mode = 'text' }) {
  if (active && active.scopeKey === scopeKey && active.conversation.source.kind === source.kind && active.conversation.source.path === source.path
    && JSON.stringify(active.conversation.source.selection || []) === JSON.stringify(source.selection || [])) {
    parent.append(active.panel); active.panel.hidden = false; active.panel.classList.remove('assistant-minimized'); active.focus(); return active;
  }
  if (active) await active.dispose();
  if (!document.getElementById('context-room-assistant-style')) { const link = element('link'); link.id = 'context-room-assistant-style'; link.rel = 'stylesheet'; link.href = '/assets/ui/assistant.css'; document.head.append(link); }
  const post = (route, body) => api('/api/assistant' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const conversation = await post('/conversations', { requestId: crypto.randomUUID(), source });
  const panel = element('aside', '', 'assistant-panel'); panel.setAttribute('aria-label', 'Original document conversation');
  const heading = element('header'), title = element('h2', 'Conversation'), minimize = button('Minimize conversation', () => panel.classList.toggle('assistant-minimized'));
  heading.append(title, minimize); const original = element('p', conversation.source.path, 'assistant-origin');
  const boundary = element('p', 'Linked to this original source. Proposed changes require human review.', 'assistant-boundary');
  const history = element('select'); history.setAttribute('aria-label', 'Saved conversations for this original source');
  const historyRow = element('div', '', 'assistant-controls'); historyRow.append(history);
  const messages = element('div', '', 'assistant-messages'); messages.tabIndex = 0; messages.setAttribute('role', 'log'); messages.setAttribute('aria-label', 'Conversation messages');
  const form = element('form'), input = element('textarea'); input.rows = 3; input.maxLength = 32000; input.setAttribute('aria-label', 'Message to the original document agent');
  const status = element('p', '', 'assistant-status'); status.setAttribute('role', 'status');
  const errorBox = element('p', '', 'assistant-error'); errorBox.setAttribute('role', 'alert');
  const controls = element('div', '', 'assistant-controls'), send = button('Send', () => {}); send.type = 'submit';
  const stop = button('Stop agent', () => run(stopTurn())), dictate = button('Dictate', () => run(toggleDictation())), speak = button('Read answer', () => run(readAnswer()));
  const audioStop = button('Stop audio', () => run(releaseAudio()));
  const recover = button('Inspect original task', () => run((async () => { current = await post('/conversations/' + current.id + '/recover', {}); render(); })())); recover.hidden = true;
  controls.append(send, stop, dictate, speak, audioStop, recover); form.append(input, controls);
  const modelRow = element('details'), modelTitle = element('summary', 'Codex model'), models = element('select'), efforts = element('select');
  models.setAttribute('aria-label', 'Conversation Codex model'); efforts.setAttribute('aria-label', 'Conversation reasoning effort');
  const connect = button('Load available models', () => run((async () => { await post('/connect', {}); modelPending = true; await poll(); })()));
  modelRow.append(modelTitle, models, efforts, connect);
  panel.append(heading, original, boundary, historyRow, messages, modelRow, form, status, errorBox); parent.append(panel);
  const clientId = crypto.randomUUID();
  let closed = false, current = conversation, pollBusy = false, lease = null, renewTimer = null, recording = null, speaker = null,
    audioContext = null, audioGeneration = 0, modelPending = false, rendered = '', sendRequest = null, retainedRecording = null, recordingRequest = null, audioBusy = false;
  const fail = error => { if (!closed) errorBox.textContent = error.message || String(error); };
  const run = promise => Promise.resolve(promise).catch(fail);
  const owned = () => ({ conversationId: current.id, clientId, epoch: lease?.epoch });
  const self = { panel, scopeKey, conversation: current, focus: () => input.focus(), async dispose() {
    if (closed) return; await releaseAudio(); closed = true; clearInterval(timer); panel.remove(); if (active === self) active = null;
  } }; active = self;
  function render() {
    self.conversation = current; const busy = activeStatuses.has(current.operation?.status), uncertain = current.operation?.status === 'uncertain';
    send.disabled = busy || uncertain; stop.disabled = !busy; models.disabled = busy || uncertain; efforts.disabled = busy || uncertain;
    history.disabled = busy || uncertain; recover.hidden = !uncertain; recover.disabled = current.recovery === 'inspecting';
    status.textContent = current.operation?.error || ({ queued: 'Message saved · connecting to Codex…', starting: 'Opening the original Codex task…', running: 'The agent is working in the original source.', stopping: 'Stopping the original turn…', completed: 'Response complete.', stopped: 'Agent stopped. Reached drawing remains saved.', failed: 'The turn failed.', uncertain: 'Check the original task before sending again.' }[current.operation?.status] || 'Ready. Nothing has been sent to the agent.');
    if (current.progress && !current.progress.completed) status.textContent = 'The agent is drawing · reached ink is saved.';
    if (current.recovery === 'inspecting') status.textContent = 'Inspecting the exact original Codex turn. Nothing is being resent.';
    if (current.source.kind === 'notebook') document.dispatchEvent(new CustomEvent('context-room-assistant-progress', { detail: { scopeKey, resourceId: current.source.resourceId, progress: current.progress } }));
    panel.dataset.operationStatus = current.operation?.status || 'idle';
    const selectedHistory = [...history.options].find(option => option.value === current.id);
    if (selectedHistory) selectedHistory.textContent = new Date(current.createdAt).toLocaleString() + ' · ' + current.messages.length + ' messages';
    const value = JSON.stringify(current.messages);
    if (value !== rendered) {
      const nearEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
      messages.replaceChildren(...current.messages.map(message => { const article = element('article'); article.append(element('strong', message.role === 'user' ? 'You' : 'Codex'), element('p', message.text)); return article; }));
      if (nearEnd) messages.scrollTop = messages.scrollHeight; rendered = value;
    }
    speak.disabled = !current.messages.some(message => message.role === 'assistant' && message.text);
  }
  async function poll() {
    if (closed || pollBusy) return; pollBusy = true;
    try {
      const id = current.id, result = await api('/api/assistant/conversations/' + id);
      if (closed || id !== current.id) return; current = result; render();
      if (modelPending) { const capabilities = await api('/api/assistant/capabilities'); if (capabilities.connection.status !== 'connecting') { modelPending = false; showModels(capabilities.connection.models); if (capabilities.connection.error) throw new Error(capabilities.connection.error); } }
    } catch (error) { fail(error); } finally { pollBusy = false; }
  }
  function showModels(catalog = []) {
    models.replaceChildren();
    const choices = catalog.length ? catalog : [{ id: current.model, name: current.model }];
    for (const model of choices) { const option = element('option', model.name || model.id); option.value = model.id; option.dataset.efforts = JSON.stringify(model.efforts || []); models.append(option); }
    if (!choices.some(model => model.id === current.model)) { const option = element('option', current.model); option.value = current.model; models.append(option); }
    models.value = current.model; showEfforts();
  }
  function showEfforts() {
    const listed = JSON.parse(models.selectedOptions[0]?.dataset.efforts || '[]');
    efforts.replaceChildren(...(listed.length ? listed.map(item => typeof item === 'string' ? item : item.reasoningEffort) : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).map(value => { const option = element('option', value); option.value = value; return option; }));
    efforts.value = [...efforts.options].some(option => option.value === current.effort) ? current.effort : efforts.options[0]?.value;
  }
  async function configure() { current = await post('/conversations/' + current.id + '/configure', { model: models.value, effort: efforts.value }); render(); }
  models.addEventListener('change', () => { showEfforts(); run(configure()); }); efforts.addEventListener('change', () => run(configure()));
  async function refreshHistory() {
    const result = await api('/api/assistant/conversations'); history.replaceChildren();
    for (const item of result.conversations.filter(item => item.source.path === source.path && item.source.kind === source.kind)) {
      const option = element('option', new Date(item.createdAt).toLocaleString() + ' · ' + item.messageCount + ' messages'); option.value = item.id; history.append(option);
    } history.value = current.id;
  }
  history.addEventListener('change', () => run((async () => {
    await releaseAudio(); const id = history.value; const next = await api('/api/assistant/conversations/' + id); current = next; rendered = ''; input.value = ''; sendRequest = null; showModels(); render();
  })()));
  form.addEventListener('submit', event => { event.preventDefault(); run((async () => {
    if (!input.value.trim() || activeStatuses.has(current.operation?.status)) return;
    const text = input.value;
    if (sendRequest && sendRequest.text !== text) throw new Error('The previous send is unconfirmed. Refresh its original conversation before changing the message.');
    sendRequest ||= { requestId: crypto.randomUUID(), text }; send.disabled = true;
    try { current = await post('/conversations/' + current.id + '/send', sendRequest); input.value = ''; sendRequest = null; errorBox.textContent = ''; render(); }
    catch (error) {
      await poll();
      if (current.messages.some(item => item.id === sendRequest?.requestId)) { input.value = ''; sendRequest = null; }
      else if (error.status >= 400 && error.status < 500) sendRequest = null;
      throw error;
    }
  })()); });
  async function stopTurn() { current = await post('/conversations/' + current.id + '/stop', {}); render(); }
  async function acquireAudio(takeover = false) {
    const capabilities = await api('/api/assistant/capabilities');
    try { lease = await post('/audio/controller', { ...owned(), action: 'acquire', takeover, epoch: takeover ? capabilities.audio.controller?.epoch : lease?.epoch }); }
    catch (error) {
      if (error.code === 'assistant_audio_owned' && !panel.querySelector('[data-audio-takeover]')) {
        const take = button('Take over audio', () => run(acquireAudio(true).then(() => { take.remove(); errorBox.textContent = 'Audio control moved here. Choose Dictate or Read answer.'; }))); take.dataset.audioTakeover = ''; controls.append(take);
      } throw error;
    }
    clearInterval(renewTimer); renewTimer = setInterval(() => run(post('/audio/controller', { ...owned(), action: 'renew' }).catch(async error => { await releaseAudio(false); throw error; })), 5000);
  }
  async function waitAudio(job, generation) {
    while (job.status === 'running') { await sleep(250); if (closed || generation !== audioGeneration) throw new Error('Audio stopped.'); job = await post('/audio/job', { ...owned(), requestId: job.id }); }
    if (job.status !== 'completed') throw Object.assign(new Error(job.error || 'Audio processing stopped.'), { audioStatus: job.status });
    return job;
  }
  async function releaseAudio(notify = true) {
    audioGeneration++; clearInterval(renewTimer); renewTimer = null;
    if (recording) { const capture = recording; recording = null; await capture.cancel(); }
    speaker?.stop(); speaker = null; if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
    if (lease && notify) await post('/audio/controller', { ...owned(), action: 'release' }).catch(() => {});
    lease = null; dictate.textContent = retainedRecording ? 'Retry dictation' : 'Dictate';
  }
  async function toggleDictation() {
    if (audioBusy) return; audioBusy = true; dictate.disabled = true;
    try {
    if (recording) {
      const capture = recording; recording = null; retainedRecording = await capture.finish(); dictate.textContent = 'Transcribing…';
    } else if (!retainedRecording) {
      const generation = audioGeneration; await acquireAudio(); errorBox.textContent = '';
      const capture = await captureMicrophone(() => run(toggleDictation()));
      if (closed || generation !== audioGeneration) { await capture.cancel(); return; }
      recording = capture; dictate.textContent = 'Finish dictation'; return;
    }
    if (!lease) await acquireAudio(); const generation = audioGeneration;
    if (!recordingRequest || recordingRequest.epoch !== lease.epoch) recordingRequest = { ...owned(), requestId: crypto.randomUUID(), pcm: retainedRecording, language: 'fr' };
    const pending = await post('/audio/transcribe', recordingRequest);
    const job = await waitAudio(pending, generation);
    if (generation !== audioGeneration) return;
    input.value += (input.value.trim() ? '\n' : '') + job.result.text; retainedRecording = null; recordingRequest = null; dictate.textContent = 'Dictate';
    errorBox.textContent = job.result.silent ? 'No speech detected. Nothing was sent.' : 'Dictation added to your draft. Read it before sending.'; input.focus();
    } catch (error) { dictate.textContent = retainedRecording ? 'Retry dictation' : 'Dictate'; if (error.audioStatus === 'failed' || error.audioStatus === 'cancelled') recordingRequest = null; throw error; }
    finally { audioBusy = false; dictate.disabled = false; }
  }
  async function readAnswer() {
    speaker?.stop(); speaker = null;
    if (!globalThis.ContextRoomNativeOwner?.playAudio) { audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); await audioContext.resume(); }
    await acquireAudio(); const generation = ++audioGeneration;
    const message = current.messages.findLast(item => item.role === 'assistant' && item.text);
    if (!message) return;
    for (let start = 0; start < message.text.length && generation === audioGeneration; ) {
      let end = Math.min(message.text.length, start + 420);
      if (end < message.text.length) { const space = message.text.lastIndexOf(' ', end); if (space > start + 150) end = space + 1; }
      const job = await waitAudio(await post('/audio/speak', { ...owned(), requestId: crypto.randomUUID(), messageId: message.id, start, end }), generation);
      if (generation !== audioGeneration) return;
      if (globalThis.ContextRoomNativeOwner?.playAudio) {
        speaker = { stop: () => ContextRoomNativeOwner.stopAudio() };
        await ContextRoomNativeOwner.playAudio({ pcm: job.result.pcm, sampleRate: job.result.sampleRate, epoch: lease.epoch });
      } else {
        const bytes = Uint8Array.from(atob(job.result.pcm), character => character.charCodeAt(0)), view = new DataView(bytes.buffer);
        const buffer = audioContext.createBuffer(1, bytes.length / 2, job.result.sampleRate), channel = buffer.getChannelData(0);
        for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
        const player = audioContext.createBufferSource(); player.buffer = buffer; player.connect(audioContext.destination); speaker = player;
        await new Promise(resolve => { player.onended = resolve; player.start(); });
      }
      speaker = null; if (generation !== audioGeneration) return;
      await post('/audio/receipt', { ...owned(), requestId: job.id, played: true }); start = end;
    }
  }
  const hidden = () => { if (document.visibilityState === 'hidden') void releaseAudio(); };
  document.addEventListener('visibilitychange', hidden);
  const dispose = self.dispose; self.dispose = async () => { document.removeEventListener('visibilitychange', hidden); await dispose(); };
  const timer = setInterval(() => void poll(), 500); showModels(); render(); await refreshHistory();
  if (mode === 'dictate') errorBox.textContent = 'Choose Dictate to start the microphone for this source.';
  input.focus(); return self;
}

async function captureMicrophone(onLimit) {
  if (globalThis.ContextRoomNativeOwner) {
    if (!ContextRoomNativeOwner.startRecording) throw new Error('Microphone support is unavailable in this installed tablet build.');
    await ContextRoomNativeOwner.startRecording();
    return { finish: () => ContextRoomNativeOwner.finishRecording(), cancel: () => ContextRoomNativeOwner.cancelRecording() };
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires this local Context Room page.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  let context;
  try { context = new (window.AudioContext || window.webkitAudioContext)(); await context.resume(); } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain(); mute.gain.value = 0;
  const chunks = []; let samples = 0, stopped = false; const rate = context.sampleRate;
  processor.onaudioprocess = event => { if (stopped) return; const chunk = event.inputBuffer.getChannelData(0).slice(); chunks.push(chunk); samples += chunk.length; if (samples >= rate * 120) { stopped = true; onLimit(); } };
  source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  async function cleanup() { stopped = true; processor.disconnect(); source.disconnect(); mute.disconnect(); stream.getTracks().forEach(track => track.stop()); await context.close(); }
  return { cancel: cleanup, async finish() {
    await cleanup(); const all = new Float32Array(samples); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const count = Math.min(16000 * 120, Math.floor(samples * 16000 / rate)); if (!count) throw new Error('The recording contains no audio.');
    const pcm = new Uint8Array(count * 2), view = new DataView(pcm.buffer);
    for (let n = 0; n < count; n++) { const position = n * rate / 16000, left = Math.floor(position), fraction = position - left;
      const value = all[left] + ((all[left + 1] ?? all[left]) - all[left]) * fraction; view.setInt16(n * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true); }
    let text = ''; for (let n = 0; n < pcm.length; n += 8192) text += String.fromCharCode(...pcm.subarray(n, n + 8192)); return btoa(text);
  } };
}
