import { journalRecording, readBrowserRecording, acknowledgeBrowserRecording } from './assistant-drafts.mjs';

/** Speech endpoint only; this never recognizes words or sends an agent request. */
export function speechEndpoint(sampleRate) {
  let noise = 90 / 32768, voiced = 0, quiet = 0, elapsed = 0, started = false, ended = false;
  return { get started() { return started; }, push(samples) {
    if (ended) return null;
    let energy = 0; for (const sample of samples) energy += sample * sample;
    const rms = Math.sqrt(energy / Math.max(1, samples.length)), ms = samples.length / sampleRate * 1000;
    elapsed += ms; let event = null;
    if (rms > Math.max(240 / 32768, noise * 3)) {
      voiced += ms; quiet = 0; if (!started && voiced >= 120) { started = true; event = 'speech-start'; }
    } else { if (!started) { noise = noise * .95 + rms * .05; voiced = 0; } quiet += ms; }
    if (started && quiet >= 1200 || !started && elapsed >= 15000 || elapsed >= 120000) { ended = true; return 'speech-end'; }
    return event;
  } };
}

export function microphonePcm(chunks, sampleRate) {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples > sampleRate * 121) throw new Error('The saved microphone format is invalid.');
  const all = new Float32Array(samples); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  const count = Math.min(16000 * 120, Math.floor(samples * 16000 / sampleRate)); if (!count) throw new Error('The recording contains no audio.');
  const pcm = new Uint8Array(count * 2), view = new DataView(pcm.buffer);
  for (let n = 0; n < count; n++) { const position = n * sampleRate / 16000, left = Math.floor(position), fraction = position - left;
    const value = all[left] + ((all[left + 1] ?? all[left]) - all[left]) * fraction; view.setInt16(n * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true); }
  let text = ''; for (let n = 0; n < pcm.length; n += 8192) text += String.fromCharCode(...pcm.subarray(n, n + 8192)); return btoa(text);
}
export async function recoverBrowserRecording(ownership, recordingId) {
  const value = await readBrowserRecording(ownership.scopeKey, ownership.conversationId, recordingId);
  return { browserRecordingId: recordingId, pcm: microphonePcm(value.data, value.sampleRate), sampleRate: 16000 };
}
export async function acknowledgeRecording(ownership, value) {
  if (value.browserRecordingId) return acknowledgeBrowserRecording(ownership.scopeKey, ownership.conversationId, value.browserRecordingId);
  if (value.recordingId && globalThis.ContextRoomNativeOwner?.acknowledgeRecording) return ContextRoomNativeOwner.acknowledgeRecording({ ...ownership, recordingId: value.recordingId });
}

export async function captureMicrophone(onLimit, ownership, { voice = false, onSpeech = () => {}, onError = () => {} } = {}) {
  if (globalThis.ContextRoomNativeOwner) {
    if (!ContextRoomNativeOwner.startRecording) throw new Error('Microphone support is unavailable in this installed tablet build.');
    const capture = await ContextRoomNativeOwner.startRecording({ ...ownership, voice }), value = { ...ownership, recordingId: capture.recordingId };
    let hadSpeech = false, ended = false;
    const event = event => {
      if (event.detail?.recordingId !== capture.recordingId || ended) return;
      if (event.detail.type === 'speech-start') { hadSpeech = true; onSpeech(); }
      if (['recording-limit', 'speech-end'].includes(event.detail.type)) { ended = true; onLimit(); }
      if (event.detail.type === 'recording-stopped') { ended = true; onError(new Error('Microphone interrupted. The original recording remains recoverable.')); }
    };
    window.addEventListener('context-room-native-audio', event);
    return { get hadSpeech() { return hadSpeech; }, finish: () => { window.removeEventListener('context-room-native-audio', event); return ContextRoomNativeOwner.finishRecording(value); },
      async cancel({ discardSilent = false } = {}) {
        window.removeEventListener('context-room-native-audio', event);
        if (discardSilent && !hadSpeech) { const saved = await ContextRoomNativeOwner.finishRecording(value); await acknowledgeRecording(ownership, saved); }
        else await ContextRoomNativeOwner.cancelRecording(value);
      } };
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires this local Context Room page.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  let context;
  try { context = new (window.AudioContext || window.webkitAudioContext)(); await context.resume(); } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain(); mute.gain.value = 0;
  const chunks = [], id = crypto.randomUUID(), rate = context.sampleRate, endpoint = speechEndpoint(rate);
  let samples = 0, stopped = false, cleaned = null, committed = 0, checkpoint = 0, writes = Promise.resolve(), failure = null;
  function persist() {
    if (failure) return Promise.reject(failure);
    const pending = chunks.slice(committed), offset = committed, frames = samples; if (!pending.length) return writes;
    committed = chunks.length; checkpoint = samples;
    writes = writes.then(() => journalRecording(ownership.scopeKey, ownership.conversationId, id, rate, pending, offset, frames));
    // A quota/error stops capture. Never continue and pretend new samples are safe.
    writes.catch(error => { if (failure) return; failure = error; void cleanup(false); onError(error); }); return writes;
  }
  processor.onaudioprocess = event => {
    if (stopped) return;
    const chunk = event.inputBuffer.getChannelData(0).slice(); chunks.push(chunk); samples += chunk.length;
    if (samples - checkpoint >= rate / 2) void persist();
    const signal = voice ? endpoint.push(chunk) : null;
    if (signal === 'speech-start') onSpeech();
    if (signal === 'speech-end' || samples >= rate * 120) { stopped = true; onLimit(); }
  };
  source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  function cleanup(flush = true) {
    if (cleaned) return cleaned;
    stopped = true; processor.onaudioprocess = null; processor.disconnect(); source.disconnect(); mute.disconnect(); stream.getTracks().forEach(track => track.stop());
    cleaned = Promise.all([context.close(), flush ? persist() : writes.catch(() => {})]); return cleaned;
  }
  return { get hadSpeech() { return endpoint.started; }, async cancel({ discardSilent = false } = {}) {
    await cleanup(); if (discardSilent && !endpoint.started) await acknowledgeBrowserRecording(ownership.scopeKey, ownership.conversationId, id);
  }, async finish() {
    await cleanup(); if (failure) throw failure;
    return { browserRecordingId: id, pcm: microphonePcm(chunks, rate), sampleRate: 16000 };
  } };
}
