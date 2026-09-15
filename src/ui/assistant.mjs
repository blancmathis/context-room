import { readDraft, writeDraft, browserRecordings, pendingAudioReleases, saveAudioRelease, conversationScopeAliases } from './assistant-drafts.mjs';
import { captureMicrophone, recoverBrowserRecording, acknowledgeRecording } from './assistant-audio.mjs';
import { LiveSourcePreview } from './assistant-observation.mjs';
export { documentDraftPreview } from './assistant-observation.mjs';

const element = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const button = (text, action) => { const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const activeStatuses = new Set(['queued', 'starting', 'running', 'stopping']);
let active = null;
let opening = Promise.resolve();

export function dockConversation(parent = document.body) { if (active) parent.append(active.panel); }
export function prepareVoiceAudio() {
  if (globalThis.ContextRoomNativeOwner?.playAudio) return null;
  const context = new (window.AudioContext || window.webkitAudioContext)(), resumed = context.resume(); resumed.catch(() => {});
  return { context, resumed };
}

/** A captured API, never a callback that reads the browser's later project selection. */
export function openConversation(options) {
  // Unlock browser output in the direct Voice gesture, before loading history.
  const activation = options.voiceActivation || (options.mode === 'voice' ? prepareVoiceAudio() : null);
  const primedAudioContext = activation?.context || null, primed = activation?.resumed;
  const result = opening.then(async () => { await primed; return buildConversation({ ...options, primedAudioContext }); });
  opening = result.catch(async () => { if (primedAudioContext?.state !== 'closed') await primedAudioContext?.close(); });
  return result;
}
async function buildConversation({ api, scopeKey, source, parent = document.body, mode = 'text', fresh = false, onState = () => {}, dictationTarget = null, captureSource = null, primedAudioContext = null }) {
  if (!fresh && active && active.scopeKey === scopeKey && active.conversation.source.kind === source.kind && active.conversation.source.path === source.path
    && JSON.stringify(active.conversation.source.selection || []) === JSON.stringify(source.selection || [])) {
    parent.append(active.panel); active.onState = onState; active.captureSource = captureSource; active.notifyState(); active.panel.hidden = false; active.panel.classList.remove('assistant-minimized'); active.present(mode, dictationTarget, primedAudioContext); return active;
  }
  if (!document.getElementById('context-room-assistant-style')) { const link = element('link'); link.id = 'context-room-assistant-style'; link.rel = 'stylesheet'; link.href = '/assets/ui/assistant.css'; document.head.append(link); }
  const post = (route, body) => api('/api/assistant' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = fresh ? null : (await api('/api/assistant/conversations')).conversations.find(item => item.source.kind === source.kind && item.source.path === source.path
    && JSON.stringify(item.source.selection || []) === JSON.stringify(source.selection || []));
  const conversation = saved ? await api('/api/assistant/conversations/' + saved.id) : await post('/conversations', { requestId: crypto.randomUUID(), source });
  if (active) await active.dispose();
  const panel = element('aside', '', 'assistant-panel'); panel.setAttribute('aria-label', 'Original document conversation');
  const heading = element('header'), title = element('h2', 'Conversation'), minimize = button('Minimize conversation', () => panel.classList.contains('assistant-direct') ? run(self.dispose().then(() => self.notifyState({ dismiss: true }))) : panel.classList.toggle('assistant-minimized'));
  const expand = button('Open conversation', () => self.present('text', self.dictationTarget)); expand.hidden = true;
  heading.append(title, expand, minimize); const original = element('p', conversation.source.path, 'assistant-origin');
  const boundary = element('p', 'Linked to this original source. Proposed changes require human review.', 'assistant-boundary');
  const history = element('select'); history.setAttribute('aria-label', 'Saved conversations for this original source');
  const historyRow = element('div', '', 'assistant-controls assistant-history'), newConversation = button('New conversation', () => run(openConversation({ api, scopeKey, source, parent, mode: 'text', fresh: true, onState: self.onState, captureSource: self.captureSource }))); historyRow.append(history, newConversation);
  const audioStatus = element('p', 'Microphone off · audio stopped.', 'assistant-audio-state'); audioStatus.setAttribute('role', 'status');
  const observationRow = element('div', '', 'assistant-observation');
  const observationStatus = element('p', 'Live preview off.'); observationStatus.setAttribute('role', 'status');
  const observationButton = button('Share live source', () => run(preview.stream ? preview.stop() : preview.start(Boolean(preview.remote?.active))));
  observationButton.title = 'Share only this source, including unfinished work. Codex receives its current preview when it reads the source.';
  observationRow.append(observationButton, observationStatus); heading.append(observationRow);
  const messages = element('div', '', 'assistant-messages'); messages.tabIndex = 0; messages.setAttribute('role', 'log'); messages.setAttribute('aria-label', 'Conversation messages');
  const form = element('form', '', 'assistant-composer'), input = element('textarea'); input.rows = 3; input.maxLength = 32000; input.setAttribute('aria-label', 'Message to the original document agent');
  const status = element('p', '', 'assistant-status'); status.setAttribute('role', 'status');
  const errorBox = element('p', '', 'assistant-error'); errorBox.setAttribute('role', 'alert');
  const infoBox = element('p', '', 'assistant-info'); infoBox.setAttribute('role', 'status');
  const controls = element('div', '', 'assistant-controls'), send = button('Send', () => {}); send.type = 'submit';
  const stop = button('Stop agent', () => run(stopTurn())), dictate = button('Dictate', () => run(toggleDictation())), speak = button('Read answer', () => run(readAnswer()));
  stop.dataset.agentStop = ''; heading.insertBefore(stop, minimize);
  const audioStop = button('Stop audio', () => run(voice ? endVoice() : releaseAudio()));
  const voiceButton = button('Voice', () => run(voice ? endVoice() : startVoice()));
  const interruptVoiceButton = button('Interrupt and speak', () => run(interruptVoice())); interruptVoiceButton.hidden = true;
  voiceButton.dataset.voiceControl = ''; interruptVoiceButton.dataset.voiceControl = '';
  const recoverAudio = button('Recover dictation', () => run(recoverNativeRecording())); recoverAudio.hidden = true;
  const discardAudio = button('Discard dictation', () => run(discardDictation())); discardAudio.hidden = true;
  const useDictation = button('Copy into draft', () => run((async () => {
    if (!self.dictationTarget || audioBusy || recording || voice || !input.value.trim()) return;
    await saveDraft(); await self.dictationTarget.apply(input.value);
    inform('Copied into the original draft. This transcript is kept here until you clear it.');
  })())); useDictation.hidden = true;
  for (const control of [dictate, audioStop, recoverAudio, discardAudio, useDictation]) control.dataset.dictationControl = '';
  const recover = button('Inspect original task', () => run((async () => { current = await post('/conversations/' + current.id + '/recover', {}); render(); })())); recover.hidden = true;
  controls.append(send, dictate, voiceButton, interruptVoiceButton, speak, audioStop, recoverAudio, discardAudio, useDictation, recover); form.append(input, controls);
  const modelRow = element('details', '', 'assistant-model'), modelTitle = element('summary', 'Codex model'), models = element('select'), efforts = element('select');
  models.setAttribute('aria-label', 'Conversation Codex model'); efforts.setAttribute('aria-label', 'Conversation reasoning effort');
  const connect = button('Load available models', () => run((async () => { await post('/connect', {}); modelPending = true; await poll(); })()));
  modelRow.append(modelTitle, models, efforts, connect);
  panel.append(heading, original, audioStatus, boundary, historyRow, messages, modelRow, form, status, infoBox, errorBox); parent.append(panel);
  const clientId = crypto.randomUUID();
  let closed = false, current = conversation, pollBusy = false, lease = null, renewTimer = null, recording = null, speaker = null,
    audioContext = null, audioGeneration = 0, modelPending = false, rendered = '', sendRequest = null, retainedRecording = null, recordingRequest = null, audioBusy = false, audioReading = false, changingConversation = false, draftWrites = Promise.resolve(), nativeRecordings = [], voice = null, voiceClosing = false, initializing = true;
  const fail = error => { if (!closed && error.name !== 'AbortError') { infoBox.textContent = ''; errorBox.textContent = error.message || String(error); } };
  function inform(text) { errorBox.textContent = ''; infoBox.textContent = text; }
  const run = promise => Promise.resolve(promise).catch(fail);
  const owned = () => ({ conversationId: current.id, clientId, epoch: lease?.epoch });
  function saveDraft() {
    const id = current.id, draft = { text: input.value, sendRequest, recording: retainedRecording };
    const write = () => writeDraft(scopeKey, id, draft);
    draftWrites = draftWrites.then(write, write); return draftWrites;
  }
  input.addEventListener('input', () => { run(saveDraft()); render(); });
  async function restoreDraft() {
    const draft = await readDraft(scopeKey, current.id); input.value = draft.text || ''; sendRequest = draft.sendRequest || null; retainedRecording = draft.recording || null;
    if (sendRequest && current.messages.some(message => message.id === sendRequest.requestId)) { input.value = ''; sendRequest = null; await saveDraft(); }
    dictate.textContent = retainedRecording ? 'Retry dictation' : 'Dictate'; await flushAudioReleases(); await refreshNativeRecordings();
  }
  async function refreshNativeRecordings() {
    if (globalThis.ContextRoomNativeOwner?.active === false) return;
    nativeRecordings = [];
    if (globalThis.ContextRoomNativeOwner?.recoverRecordings) {
      for (const original of conversationScopeAliases(scopeKey)) nativeRecordings.push(...(await ContextRoomNativeOwner.recoverRecordings({ scopeKey: original, conversationId: current.id })).recordings.map(item => ({ ...item, recordingScopeKey: original })));
    } else nativeRecordings = (await browserRecordings(scopeKey, current.id)).map(item => ({ ...item, browser: true }));
    recoverAudio.hidden = !nativeRecordings.length || Boolean(retainedRecording);
  }
  async function recoverNativeRecording() {
    if (recording || retainedRecording || !nativeRecordings.length) return;
    const item = nativeRecordings.sort((a, b) => a.createdAt - b.createdAt)[0];
    const original = item.recordingScopeKey || scopeKey;
    retainedRecording = item.browser ? await recoverBrowserRecording({ scopeKey: original, conversationId: current.id }, item.recordingId) :
      { ...await ContextRoomNativeOwner.recoverRecordings({ scopeKey: original, conversationId: current.id, recordingId: item.recordingId }), recordingScopeKey: original };
    await saveDraft(); recoverAudio.hidden = true; dictate.textContent = 'Retry dictation'; inform('Original recording recovered. Choose Retry dictation to transcribe it.'); render();
  }
  async function discardDictation() {
    if (!retainedRecording || audioBusy || recording || voice) return;
    const discarded = retainedRecording; retainedRecording = null; recordingRequest = null; await saveDraft();
    await acknowledgeRecording({ scopeKey, conversationId: current.id }, discarded); await refreshNativeRecordings();
    dictate.textContent = 'Dictate'; inform('Recorded dictation discarded. Your text draft is unchanged.'); render();
  }
  const self = { panel, scopeKey, conversation: current, onState, dictationTarget, captureSource, focus: () => input.focus(), present(mode, target = null, primedContext = null) {
    if (mode === 'dictate' && voice) { run(endVoice().then(() => self.present(mode, target, primedContext))); return; }
    if (mode === 'voice' && !voice && (recording || retainedRecording || audioBusy || input.value.trim() || sendRequest || activeStatuses.has(current.operation?.status))) {
      if (primedContext && primedContext.state !== 'closed') run(primedContext.close());
      throw new Error('Finish or clear the original dictation or draft before starting Voice. It has been retained.');
    }
    self.dictationTarget = target;
    if (mode === 'dictate') run(preview.stop());
    observationRow.hidden = !self.captureSource || mode === 'dictate' || mode === 'voice' && !preview.stream;
    const direct = mode === 'dictate' || mode === 'voice';
    panel.classList.toggle('assistant-direct', direct); panel.classList.toggle('assistant-direct-dictation', mode === 'dictate');
    panel.classList.remove('assistant-minimized'); panel.dataset.mode = mode;
    title.textContent = mode === 'dictate' ? 'Dictation' : mode === 'voice' ? 'Voice' : 'Conversation';
    panel.setAttribute('aria-label', mode === 'dictate' ? 'Original source dictation' : 'Original document conversation');
    expand.hidden = !direct; minimize.textContent = direct ? 'Close' : 'Minimize conversation';
    minimize.setAttribute('aria-label', direct ? mode === 'dictate' ? 'Close dictation' : 'Close voice' : 'Minimize conversation');
    useDictation.textContent = target?.label || 'Copy into draft'; render();
    if (mode === 'dictate' && !initializing && !recording && !audioBusy && !retainedRecording) run(toggleDictation());
    if (mode === 'voice' && !voice) run(startVoice(primedContext).finally(() => { if (primedContext && primedContext.state !== 'closed') return primedContext.close(); }));
    else if (primedContext && primedContext.state !== 'closed') run(primedContext.close());
    if (mode !== 'voice') input.focus();
  }, notifyState(extra = {}) {
    run(self.onState({ conversationId: current.id, scopeKey, source: current.source, progress: current.progress, closed,
      busy: activeStatuses.has(current.operation?.status), audioActive: Boolean(recording) || audioBusy || audioReading || Boolean(voice), hasDraft: Boolean(input.value.trim() || retainedRecording), ...extra }));
  }, async dispose() {
    if (closed) return; await preview.dispose().catch(fail); await endVoice(); await saveDraft(); await releaseAudio(); closed = true; self.notifyState(); clearInterval(timer); panel.remove(); if (active === self) active = null;
  } }; active = self;
  const preview = new LiveSourcePreview({ api, identity: () => ({ conversationId: current.id, clientId }),
    capture: () => self.captureSource?.(current.source), visible: () => !closed && panel.isConnected && !panel.hidden && document.visibilityState === 'visible', onError: fail,
    onState: value => {
      observationRow.hidden = !self.captureSource || panel.dataset.mode === 'dictate' || panel.dataset.mode === 'voice' && !value.active;
      observationButton.textContent = value.active ? 'Stop sharing source' : value.elsewhere ? 'Take over source sharing' : 'Share live source';
      observationButton.disabled = value.busy && !value.active;
      observationButton.setAttribute('aria-pressed', String(value.active));
      panel.dataset.observation = value.active ? value.paused ? 'paused' : 'live' : value.elsewhere ? 'elsewhere' : 'off';
      observationStatus.textContent = value.active ? value.paused ? 'Sharing paused · return to the original source.'
        : value.lastObservedAt ? 'Sharing this source · last read by Codex at ' + new Date(value.lastObservedAt).toLocaleTimeString() + '.'
          : 'Sharing this source · waiting for Codex to read it.' : value.elsewhere ? 'Another surface is sharing this source.' : 'Live preview off.';
    } });
  run(preview.refresh());
  function render() {
    self.conversation = current; const busy = activeStatuses.has(current.operation?.status), uncertain = current.operation?.status === 'uncertain';
    panel.dataset.ready = String(!initializing); panel.setAttribute('aria-busy', String(initializing));
    panel.dataset.capturing = String(Boolean(recording));
    panel.classList.toggle('assistant-voice-enabled', Boolean(voice));
    send.disabled = initializing || busy || uncertain || Boolean(voice); stop.disabled = !busy; stop.hidden = !busy; models.disabled = initializing || busy || uncertain || Boolean(voice); efforts.disabled = models.disabled;
    history.disabled = initializing || busy || uncertain || Boolean(recording) || audioBusy || audioReading || changingConversation || Boolean(voice) || voiceClosing;
    newConversation.disabled = history.disabled;
    dictate.disabled = initializing || audioBusy || Boolean(voice); input.readOnly = initializing || Boolean(voice);
    discardAudio.hidden = !retainedRecording; discardAudio.disabled = initializing || audioBusy || Boolean(voice);
    useDictation.hidden = !self.dictationTarget; useDictation.disabled = initializing || audioBusy || Boolean(recording) || Boolean(voice) || !input.value.trim();
    voiceButton.textContent = voice ? 'End voice' : 'Voice'; voiceButton.setAttribute('aria-pressed', String(Boolean(voice)));
    voiceButton.disabled = initializing || voiceClosing || changingConversation || !voice && (Boolean(recording) || audioBusy || audioReading || busy || uncertain);
    interruptVoiceButton.hidden = !voice; interruptVoiceButton.disabled = !audioReading && !busy;
    panel.dataset.voiceState = voice?.phase || (voiceClosing ? 'stopping' : 'off');
    recover.hidden = !uncertain; recover.disabled = current.recovery === 'inspecting';
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
    speak.disabled = Boolean(recording) || audioBusy || audioReading || Boolean(voice) || !current.messages.some(message => message.role === 'assistant' && message.text);
    self.notifyState();
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
    if (recording || audioBusy || audioReading || changingConversation || voice || voiceClosing) { history.value = current.id; return; }
    changingConversation = true; const id = history.value; render();
    try { await preview.stop(); await saveDraft(); await releaseAudio(); const next = await api('/api/assistant/conversations/' + id); current = next; rendered = ''; await restoreDraft(); await preview.refresh(); showModels(); }
    finally { changingConversation = false; render(); }
  })()));
  form.addEventListener('submit', event => { event.preventDefault(); if (!voice) run(submitMessage()); });
  async function submitMessage(voiceSession = null) {
    if (initializing || !input.value.trim() || activeStatuses.has(current.operation?.status)) return;
    const text = input.value;
    if (sendRequest && sendRequest.text !== text) throw new Error('The previous send is unconfirmed. Refresh its original conversation before changing the message.');
    sendRequest ||= { requestId: crypto.randomUUID(), text }; send.disabled = true;
    await saveDraft();
    if (voiceSession && voice !== voiceSession) return;
    if (voiceSession) voiceSession.requestId = sendRequest.requestId;
    try {
      current = await post('/conversations/' + current.id + '/send', sendRequest); input.value = ''; sendRequest = null; await saveDraft(); inform(''); render();
      if (voiceSession && voice !== voiceSession && activeStatuses.has(current.operation?.status)) await stopTurn(voiceSession.requestId);
    }
    catch (error) {
      await poll();
      if (current.messages.some(item => item.id === sendRequest?.requestId)) { input.value = ''; sendRequest = null; }
      else if (error.status >= 400 && error.status < 500) sendRequest = null;
      await saveDraft();
      throw error;
    }
  }
  async function stopTurn(operationId = current.operation?.id) {
    const id = current.id, result = await post('/conversations/' + id + '/stop', { operationId });
    if (id === current.id && current.operation?.id === operationId) { current = result; render(); }
  }
  async function acquireAudio(takeover = false, generation = audioGeneration) {
    const id = current.id;
    await flushAudioReleases();
    const capabilities = await api('/api/assistant/capabilities');
    if (closed || generation !== audioGeneration) throw new DOMException('Audio stopped.', 'AbortError');
    try {
      const acquired = await post('/audio/controller', { ...owned(), action: 'acquire', takeover, epoch: takeover ? capabilities.audio.controller?.epoch : lease?.epoch });
      if (closed || generation !== audioGeneration || id !== current.id) {
        await post('/audio/controller', { conversationId: id, clientId, epoch: acquired.epoch, action: 'release' }).catch(() => {});
        throw new DOMException('Audio stopped.', 'AbortError');
      }
      lease = acquired;
    }
    catch (error) {
      if (error.code === 'assistant_audio_owned' && !panel.querySelector('[data-audio-takeover]')) {
        const take = button('Take over audio', () => run(acquireAudio(true).then(() => { take.remove(); inform('Audio control moved here. Choose Dictate or Read answer.'); }))); take.dataset.audioTakeover = ''; controls.append(take);
      } throw error;
    }
    if (globalThis.ContextRoomNativeOwner?.audioController) await ContextRoomNativeOwner.audioController({ ...lease, scopeKey });
    if (closed || generation !== audioGeneration) throw new DOMException('Audio stopped.', 'AbortError');
    clearInterval(renewTimer); renewTimer = setInterval(() => run((async () => {
      const epoch = lease?.epoch, renewingGeneration = audioGeneration;
      try {
        const renewed = await post('/audio/controller', { ...owned(), action: 'renew' });
        if (renewingGeneration !== audioGeneration || lease?.epoch !== epoch) return;
        lease = renewed;
        if (globalThis.ContextRoomNativeOwner?.audioController) await ContextRoomNativeOwner.audioController({ ...lease, scopeKey, renew: true });
      } catch (error) { if (renewingGeneration === audioGeneration && lease?.epoch === epoch) { await releaseAudio(false); throw error; } }
    })()), 5000);
  }
  async function waitAudio(job, generation) {
    while (job.status === 'running') { await sleep(250); if (closed || generation !== audioGeneration) throw new Error('Audio stopped.'); job = await post('/audio/job', { ...owned(), requestId: job.id }); }
    if (job.status !== 'completed') throw Object.assign(new Error(job.error || 'Audio processing stopped.'), { audioStatus: job.status });
    return job;
  }
  async function releaseAudio(notify = true) {
    const generation = ++audioGeneration, releasedLease = lease, capture = recording, player = speaker, context = audioContext;
    lease = null; recording = null; speaker = null; audioContext = null; clearInterval(renewTimer); renewTimer = null;
    dictate.textContent = retainedRecording ? 'Retry dictation' : 'Dictate'; audioStatus.textContent = 'Microphone off · audio stopped.';
    let captureFailure;
    const savedRelease = releasedLease && notify ? saveAudioRelease(scopeKey, releasedLease) : Promise.resolve();
    // Queue before awaiting microphone cleanup: a backgrounded native bridge
    // cannot send the HTTP release, and a reload must retain its exact epoch.
    savedRelease.catch(() => {});
    try { player?.stop(); } catch { /* An already ended browser source has no audio left to stop. */ }
    if (context && context !== voice?.context) await context.close().catch(() => {});
    if (capture) try { await capture.cancel(); } catch (error) { captureFailure = error; }
    if (releasedLease && globalThis.ContextRoomNativeOwner?.releaseAudio) await ContextRoomNativeOwner.releaseAudio({ conversationId: releasedLease.conversationId, epoch: releasedLease.epoch }).catch(() => {});
    await savedRelease;
    if (releasedLease && notify) await flushAudioReleases();
    if (generation === audioGeneration) await refreshNativeRecordings();
    if (captureFailure) throw captureFailure;
  }
  async function flushAudioReleases() {
    if (globalThis.ContextRoomNativeOwner?.active === false) return;
    for (const pending of await pendingAudioReleases(scopeKey)) {
      const { releaseScopeKey, ...released } = pending;
      if (pending.expiresAt <= Date.now()) { await saveAudioRelease(releaseScopeKey, pending, true); continue; }
      try { await post('/audio/controller', { ...released, action: 'release' }); }
      catch (error) { if (error.code !== 'assistant_audio_stale') continue; }
      await saveAudioRelease(releaseScopeKey, pending, true);
    }
  }
  async function toggleDictation() {
    if (initializing || audioBusy || changingConversation || voice) return; audioBusy = true; dictate.disabled = true; render(); let generation = audioGeneration;
    try {
    if (recording) {
      const capture = recording; recording = null; retainedRecording = await capture.finish(); await saveDraft(); dictate.textContent = 'Retry dictation';
      if (closed || generation !== audioGeneration) return;
      dictate.textContent = 'Transcribing…';
      audioStatus.textContent = 'Microphone off · transcribing on the Mac…';
    } else if (!retainedRecording) {
      if (audioReading) await releaseAudio();
      if (globalThis.ContextRoomNativeOwner?.ensureMicrophone) await ContextRoomNativeOwner.ensureMicrophone();
      if (closed) return;
      generation = audioGeneration; await acquireAudio(false, generation); inform('');
      const capture = await captureMicrophone(() => run(toggleDictation()), { ...owned(), scopeKey }, { onError: error => run(releaseAudio().then(() => { throw error; })) });
      if (closed || generation !== audioGeneration) { await capture.cancel(); return; }
      recording = capture; dictate.textContent = 'Finish dictation'; audioStatus.textContent = 'Microphone on · dictation stays in this original source.'; return;
    }
    if (!lease) await acquireAudio(false, generation);
    if (!recordingRequest || recordingRequest.epoch !== lease.epoch) recordingRequest = { ...owned(), requestId: crypto.randomUUID(), pcm: retainedRecording.pcm, language: 'fr' };
    const pending = await post('/audio/transcribe', recordingRequest);
    const job = await waitAudio(pending, generation);
    if (generation !== audioGeneration) return;
    const completedRecording = retainedRecording;
    if (job.result.text) input.value += (input.value.trim() ? '\n' : '') + job.result.text;
    retainedRecording = null; recordingRequest = null; await saveDraft(); dictate.textContent = 'Dictate';
    await acknowledgeRecording({ scopeKey, conversationId: current.id }, completedRecording);
    await refreshNativeRecordings();
    await releaseAudio();
    inform(job.result.silent ? 'No speech detected. Nothing was sent.' : 'Dictation added to your draft. Read it before sending.'); input.focus();
    } catch (error) { dictate.textContent = retainedRecording ? 'Retry dictation' : 'Dictate'; if (error.audioStatus === 'failed' || error.audioStatus === 'cancelled') recordingRequest = null; throw error; }
    finally { audioBusy = false; dictate.disabled = false; render(); }
  }
  async function readAnswer(voiceSession = null) {
    if (voiceSession && voice !== voiceSession) return;
    if (recording || audioBusy || audioReading || changingConversation) return;
    audioReading = true; render(); const generation = ++audioGeneration;
    try {
    speaker?.stop(); speaker = null;
    if (!globalThis.ContextRoomNativeOwner?.playAudio) { audioContext ||= voiceSession?.context || new (window.AudioContext || window.webkitAudioContext)(); await audioContext.resume(); }
    await acquireAudio(false, generation); audioStatus.textContent = 'Microphone off · reading the original answer…';
    const message = current.messages.findLast(item => item.role === 'assistant' && item.text);
    if (!message) return;
    for (let start = 0; start < message.text.length && generation === audioGeneration; ) {
      let end = Math.min(message.text.length, start + 420);
      if (end < message.text.length) { const space = message.text.lastIndexOf(' ', end); if (space > start + 150) end = space + 1; }
      const job = await waitAudio(await post('/audio/speak', { ...owned(), requestId: crypto.randomUUID(), messageId: message.id, start, end }), generation);
      if (generation !== audioGeneration) return;
      if (job.result.played === true) { start = end; continue; }
      if (globalThis.ContextRoomNativeOwner?.playAudio) {
        const ownership = owned();
        speaker = { stop: () => ContextRoomNativeOwner.stopAudio(ownership).catch(() => {}) };
        const playback = await ContextRoomNativeOwner.playAudio({ ...ownership, pcm: job.result.pcm, sampleRate: job.result.sampleRate });
        if (playback?.played !== true) throw new Error('Playback did not confirm the complete passage.');
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
    } finally { audioReading = false; if (generation === audioGeneration) await releaseAudio(); render(); }
  }
  async function endVoice() {
    const ending = voice; if (!ending) return;
    voice = null; voiceClosing = true; render();
    try { await releaseAudio(); } finally {
      try {
      if (ending.context && ending.context.state !== 'closed') await ending.context.close();
      if (ending.requestId === current.operation?.id && activeStatuses.has(current.operation?.status)) await stopTurn(ending.requestId);
      } finally { voiceClosing = false; render(); }
    }
  }
  async function interruptVoice() {
    const session = voice; if (!session) return;
    if (session.phase === 'speaking') { session.interrupted = true; await releaseAudio(); }
    if (session.requestId === current.operation?.id && activeStatuses.has(current.operation?.status)) await stopTurn(session.requestId);
  }
  async function startVoice(primedContext = null) {
    if (initializing || voice || voiceClosing || audioBusy || audioReading || recording || activeStatuses.has(current.operation?.status)) return;
    if (input.value.trim() || sendRequest || retainedRecording) throw new Error('Send or clear the saved draft before starting Voice. Recoverable dictation stays separate.');
    if (globalThis.ContextRoomNativeOwner?.ensureMicrophone) {
      voiceClosing = true; render();
      try { await ContextRoomNativeOwner.ensureMicrophone(); } finally { voiceClosing = false; render(); }
      if (closed || ContextRoomNativeOwner.active === false) return;
    }
    const session = { phase: 'starting', requestId: null, context: null, interrupted: false, stopping: null }; voice = session; render();
    try {
      // Unlock browser output in this explicit user gesture, before any network wait.
      if (!globalThis.ContextRoomNativeOwner?.playAudio) { session.context = primedContext || new (window.AudioContext || window.webkitAudioContext)(); await session.context.resume(); }
      inform('');
      while (voice === session && !closed) {
        const generation = audioGeneration; await acquireAudio(false, generation);
        if (voice !== session) break;
        let ended = false, captureError = null;
        const capture = await captureMicrophone(() => { ended = true; }, { ...owned(), scopeKey }, { voice: true,
          onSpeech() {
            // Speech can interrupt an agent that is still drawing or thinking.
            // The exact turn is stopped before a new phrase may be submitted.
            if (voice === session && session.requestId === current.operation?.id && activeStatuses.has(current.operation?.status)) {
              session.stopping = stopTurn(session.requestId).catch(error => { captureError = error; ended = true; });
            }
          }, onError(error) { captureError = error; ended = true; } });
        if (voice !== session || generation !== audioGeneration) { await capture.cancel(); break; }
        recording = capture; session.phase = 'listening'; audioStatus.textContent = 'Microphone on · Voice sends spoken phrases to this original source.'; render();
        let answerReady = false;
        while (voice === session && !ended && generation === audioGeneration) {
          if (captureError) break;
          if (!capture.hadSpeech && session.requestId && current.operation?.id === session.requestId && current.operation.status === 'completed') { answerReady = true; break; }
          if (session.requestId && current.operation?.id === session.requestId && ['failed', 'uncertain'].includes(current.operation.status)) throw new Error(current.operation.error || 'The original voice turn needs attention.');
          await sleep(100);
        }
        if (captureError) throw captureError;
        if (voice !== session || generation !== audioGeneration) break;
        recording = null;
        if (answerReady) {
          await capture.cancel({ discardSilent: true }); await releaseAudio();
          if (voice !== session) break;
          session.phase = 'speaking'; session.interrupted = false; render();
          try { await readAnswer(session); } catch (error) { if (!session.interrupted || voice !== session) throw error; }
          session.requestId = null; continue;
        }
        if (!capture.hadSpeech) { await capture.cancel({ discardSilent: true }); await releaseAudio(); continue; }
        audioBusy = true; session.phase = 'transcribing'; audioStatus.textContent = 'Microphone off · transcribing on the Mac…'; render();
        try {
          retainedRecording = await capture.finish(); await saveDraft();
          if (voice !== session || generation !== audioGeneration) break;
          recordingRequest = { ...owned(), requestId: crypto.randomUUID(), pcm: retainedRecording.pcm, language: 'fr' };
          const job = await waitAudio(await post('/audio/transcribe', recordingRequest), generation);
          if (voice !== session || generation !== audioGeneration) break;
          const saved = retainedRecording;
          input.value = job.result.text; retainedRecording = null; recordingRequest = null; await saveDraft();
          await acknowledgeRecording({ scopeKey, conversationId: current.id }, saved); await releaseAudio();
          if (voice !== session) break;
          if (session.stopping) { await session.stopping; session.stopping = null; }
          const deadline = Date.now() + 30000;
          while (voice === session && activeStatuses.has(current.operation?.status) && Date.now() < deadline) { await poll(); await sleep(100); }
          if (voice !== session) break;
          if (activeStatuses.has(current.operation?.status) || current.operation?.status === 'uncertain') throw new Error('The previous turn has not confirmed its stop. Your new transcript is saved; nothing was resent.');
          if (input.value.trim()) await submitMessage(session);
        } finally { audioBusy = false; render(); }
      }
    } finally { if (voice === session) await endVoice(); }
  }
  const hidden = () => { if (document.visibilityState === 'hidden') run(voice ? endVoice() : releaseAudio()); };
  const nativeActivity = event => { if (event.detail === false) run(voice ? endVoice() : releaseAudio()); else run(flushAudioReleases().then(refreshNativeRecordings)); };
  const nativeAudioInterrupted = event => { if (event.detail?.type === 'audio-interrupted') run((voice ? endVoice() : releaseAudio()).then(() => { throw new Error('Audio was interrupted by another application. Start it again explicitly.'); })); };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('context-room-native-active', nativeActivity);
  window.addEventListener('context-room-native-audio', nativeAudioInterrupted);
  const dispose = self.dispose; self.dispose = async () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('context-room-native-active', nativeActivity); window.removeEventListener('context-room-native-audio', nativeAudioInterrupted); await dispose(); };
  const timer = setInterval(() => void poll(), 500); showModels(); render(); await restoreDraft(); await refreshHistory(); initializing = false; render();
  self.present(mode, dictationTarget, primedAudioContext); return self;
}
