import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AssistantSessions } from './assistant_sessions.mjs';
import { LocalAudio, pcm16Wave } from './local_audio.mjs';
import { canonicalNotebookRoot, notebookHash, readNotebookJson, writeNotebookJson, withNotebookLock } from './notebook_io.mjs';

const fault = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw fault('assistant_identity', 'An exact client or request identity is required.', 400); return value; };
const LEASE_MS = 30_000;

/** One local owner runtime. Constructed lazily, never by doctor, guard or brief. */
export class AssistantRuntime {
  constructor({ root = path.join(os.homedir(), '.context-room', 'assistant'), resolveSource, providerFactory, audio,
    modelPath = process.env.CONTEXT_ROOM_WHISPER_MODEL || path.join(root, 'models', 'ggml-large-v3-turbo-q5_0.bin'), now = () => Date.now() } = {}) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); canonicalNotebookRoot(root);
    this.root = root; this.now = now;
    this.sessions = new AssistantSessions({ root, resolveSource, providerFactory });
    this.audio = audio || new LocalAudio({ root, modelPath });
    this.jobs = new Map(); this.connection = { status: 'idle', models: [] }; this.closed = false;
  }
  capabilities(project) {
    const lease = this.readLease();
    return { conversations: true, provider: 'local-codex-stdio', connection: this.connection,
      audio: { local: true, configured: Boolean(this.audio.modelPath && fs.existsSync(this.audio.modelPath)), sampleRate: 16000, maxSeconds: 120,
        controller: lease ? { ...(lease.project === project ? { conversationId: lease.conversationId, clientId: lease.clientId } : {}), epoch: lease.epoch, expiresAt: lease.expiresAt } : null,
        busyElsewhere: Boolean(lease && lease.project !== project) } };
  }
  connect() {
    if (this.connection.status === 'connecting') return this.connection;
    this.connection = { status: 'connecting', models: [] };
    this.connecting = this.sessions.ready().then(provider => { this.connection = { status: 'ready', models: provider.models }; }, error => {
      this.connection = { status: 'unavailable', models: [], error: error.message };
    });
    return this.connection;
  }
  readLease() {
    const lease = readNotebookJson(this.root, 'audio-controller.json');
    return lease && lease.expiresAt > this.now() ? lease : null;
  }
  lease(project, { conversationId, clientId, epoch, action = 'acquire', takeover = false }) {
    uuid(clientId); this.sessions.get(project, conversationId);
    return withNotebookLock(this.root, 'audio-controller.lock', () => {
      const current = this.readLease();
      if (action === 'acquire') {
        if (current && current.project === project && current.conversationId === conversationId && current.clientId === clientId && current.epoch === epoch) {
          current.expiresAt = this.now() + LEASE_MS; writeNotebookJson(this.root, 'audio-controller.json', current); return current;
        }
        if (current && (takeover !== true || epoch !== current.epoch)) throw fault('assistant_audio_owned', 'Audio is active on another surface. Choose Take over audio explicitly.');
        const lease = { project, conversationId, clientId, epoch: randomUUID(), expiresAt: this.now() + LEASE_MS };
        writeNotebookJson(this.root, 'audio-controller.json', lease); return lease;
      }
      if (!current || current.project !== project || current.conversationId !== conversationId || current.clientId !== clientId || current.epoch !== epoch) throw fault('assistant_audio_stale', 'This surface no longer owns audio.');
      if (action === 'release') { writeNotebookJson(this.root, 'audio-controller.json', { ...current, expiresAt: 0 }); return { released: true }; }
      if (action !== 'renew') throw fault('assistant_audio_action', 'Unknown audio controller action.', 400);
      current.expiresAt = this.now() + LEASE_MS; writeNotebookJson(this.root, 'audio-controller.json', current); return current;
    });
  }
  checkAudio(project, body) {
    const current = this.readLease();
    if (!current || current.project !== project || current.conversationId !== body.conversationId || current.clientId !== body.clientId || current.epoch !== body.epoch) throw fault('assistant_audio_stale', 'This surface no longer owns audio.');
    this.sessions.get(project, body.conversationId); return current;
  }
  prune() {
    for (const [id, job] of this.jobs) if (!job.controller && job.expiresAt <= this.now()) this.jobs.delete(id);
  }
  asyncJob(project, input, type, fingerprint, run) {
    if (this.closed) throw fault('assistant_closed', 'The conversation service is closed.');
    this.checkAudio(project, input); uuid(input.requestId); this.prune();
    const previous = this.jobs.get(input.requestId);
    if (previous) {
      if (previous.project !== project || previous.fingerprint !== fingerprint) throw fault('assistant_audio_replay', 'This audio request already names a different recording or passage.');
      return this.job(project, input.requestId, input);
    }
    if (this.jobs.size >= 24 || [...this.jobs.values()].filter(job => job.controller).length >= 2) throw fault('assistant_audio_busy', 'Finish the current audio processing before starting another recording.');
    const controller = new AbortController();
    const job = { id: input.requestId, project, type, fingerprint, conversationId: input.conversationId, clientId: input.clientId, epoch: input.epoch,
      status: 'running', controller, result: null, expiresAt: this.now() + 10 * 60_000 };
    this.jobs.set(job.id, job);
    const watch = setInterval(() => { try { this.checkAudio(project, input); } catch { controller.abort(); } }, 150); watch.unref?.();
    job.completion = Promise.resolve().then(() => run(controller.signal)).then(result => {
      this.checkAudio(project, input); controller.signal.throwIfAborted(); job.result = result; job.status = 'completed';
    }).catch(error => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; })
      .finally(() => { clearInterval(watch); job.controller = null; });
    return this.publicJob(job);
  }
  publicJob(job) { return { id: job.id, conversationId: job.conversationId, epoch: job.epoch, type: job.type, status: job.status, result: job.result, error: job.error || null }; }
  job(project, id, body) {
    this.checkAudio(project, body); const job = this.jobs.get(uuid(id));
    if (!job || job.project !== project || job.conversationId !== body.conversationId || job.clientId !== body.clientId || job.epoch !== body.epoch) throw fault('assistant_audio_job', 'This audio result belongs to another surface or has expired.', 404);
    return this.publicJob(job);
  }
  transcribe(project, body) {
    if (typeof body.pcm !== 'string' || body.pcm.length > 5_120_000 || body.pcm.length % 4) throw fault('audio_format', 'Use bounded base64 PCM16 mono audio at 16 kHz.', 400);
    const pcm = Buffer.from(body.pcm, 'base64'); if (pcm.toString('base64') !== body.pcm) throw fault('audio_format', 'Invalid base64 audio.', 400); pcm16Wave(pcm);
    const fingerprint = notebookHash({ conversationId: body.conversationId, clientId: body.clientId, epoch: body.epoch, pcm: body.pcm, language: body.language || 'fr' });
    return this.asyncJob(project, body, 'dictation', fingerprint, signal => this.audio.transcribe(pcm, { language: body.language || 'fr', signal }));
  }
  speak(project, body) {
    const conversation = this.sessions.get(project, body.conversationId);
    const message = conversation.messages.find(item => item.id === body.messageId && item.role === 'assistant');
    if (!message || !Number.isInteger(body.start) || !Number.isInteger(body.end) || body.start < 0 || body.end <= body.start || body.end - body.start > 420 || body.end > message.text.length) throw fault('assistant_speech_passage', 'Choose an exact passage from this conversation’s answer.', 400);
    const text = message.text.slice(body.start, body.end);
    const fingerprint = notebookHash({ conversationId: body.conversationId, clientId: body.clientId, epoch: body.epoch, messageId: body.messageId, start: body.start, end: body.end, text });
    return this.asyncJob(project, body, 'speech', fingerprint, signal => this.audio.synthesize(text, { signal }));
  }
  cancelAudio(project, body) {
    this.job(project, body.requestId, body); const job = this.jobs.get(body.requestId);
    job.controller?.abort(); job.status = 'cancelled'; job.result = null; return this.publicJob(job);
  }
  receipt(project, body) {
    this.job(project, body.requestId, body); const job = this.jobs.get(body.requestId);
    if (job.type !== 'speech' || job.status !== 'completed' || body.played !== true) throw fault('assistant_audio_receipt', 'Only completed playback may acknowledge a prepared passage.');
    job.result.played = true; return { id: job.id, played: true, epoch: job.epoch };
  }
  async close() {
    this.closed = true; for (const job of this.jobs.values()) job.controller?.abort();
    await Promise.allSettled([this.sessions.close(), ...[...this.jobs.values()].map(job => job.completion)]);
  }
}

/** All routes run behind the existing exact-project, trusted-origin and owner nonce guards. */
export async function handleAssistantHttp(req, res, { root, url, runtime, readJsonBody, sendJson }) {
  const route = url.pathname.slice('/api/assistant'.length);
  if (req.method === 'GET') {
    if (route === '/capabilities') { sendJson(res, 200, runtime.capabilities(root)); return; }
    if (route === '/conversations') { sendJson(res, 200, { conversations: runtime.sessions.list(root) }); return; }
    if (/^\/conversations\/[^/]+$/.test(route)) { sendJson(res, 200, runtime.sessions.get(root, route.split('/')[2])); return; }
  }
  if (req.method !== 'POST') throw fault('assistant_route', 'Unknown conversation operation.', 404);
  const body = await readJsonBody(req, { maxBytes: route === '/audio/transcribe' ? 5_130_000 : 250_000 });
  let result, status = 200;
  if (route === '/connect') { result = runtime.connect(); status = 202; }
  else if (route === '/conversations') { result = runtime.sessions.create(root, body); status = 201; }
  else if (/^\/conversations\/[^/]+\/send$/.test(route)) { result = runtime.sessions.send(root, route.split('/')[2], body); status = 202; }
  else if (/^\/conversations\/[^/]+\/stop$/.test(route)) result = await runtime.sessions.stop(root, route.split('/')[2]);
  else if (/^\/conversations\/[^/]+\/configure$/.test(route)) result = runtime.sessions.configure(root, route.split('/')[2], body);
  else if (/^\/conversations\/[^/]+\/recover$/.test(route)) { result = runtime.sessions.recover(root, route.split('/')[2]); status = 202; }
  else if (route === '/audio/controller') { const lease = runtime.lease(root, body); const { project, ...publicLease } = lease; result = publicLease; }
  else if (route === '/audio/transcribe') { result = runtime.transcribe(root, body); status = 202; }
  else if (route === '/audio/speak') { result = runtime.speak(root, body); status = 202; }
  else if (route === '/audio/job') result = runtime.job(root, body.requestId, body);
  else if (route === '/audio/cancel') result = runtime.cancelAudio(root, body);
  else if (route === '/audio/receipt') result = runtime.receipt(root, body);
  else throw fault('assistant_route', 'Unknown conversation operation.', 404);
  sendJson(res, status, result);
}
