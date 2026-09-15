import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalNotebookRoot, makeNotebookDirectory, readNotebookBytes, readNotebookJson } from './notebook_io.mjs';

const fault = (code, message) => Object.assign(new Error(message), { code });
export const PCM_RATE = 16_000;
const MAX_RECORDING_BYTES = PCM_RATE * 2 * 120;

export function pcm16Wave(pcm, sampleRate = PCM_RATE) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > MAX_RECORDING_BYTES || ![16_000, 24_000].includes(sampleRate)) throw fault('audio_format', 'Use bounded mono PCM16 audio.');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function readPcm16Wave(bytes, sampleRate = PCM_RATE) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 4 * 1024 * 1024
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) throw fault('audio_format', 'Invalid bounded WAVE audio.');
  let format, pcm;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > bytes.length) throw fault('audio_format', 'The WAVE audio is incomplete.');
    const chunk = bytes.subarray(offset + 8, end);
    if (kind === 'fmt ') {
      if (format || size < 16) throw fault('audio_format', 'Invalid WAVE format metadata.');
      format = chunk;
    }
    if (kind === 'data') { if (pcm) throw fault('audio_format', 'Duplicate WAVE audio data.'); pcm = chunk; }
    offset = end + (size % 2);
  }
  if (!format || !pcm?.length || pcm.length % 2 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
    || format.readUInt32LE(4) !== sampleRate || format.readUInt32LE(8) !== sampleRate * 2
    || format.readUInt16LE(12) !== 2 || format.readUInt16LE(14) !== 16) throw fault('audio_format', 'Use mono PCM16 audio at the requested sample rate.');
  return pcm;
}

function runAudioProcess(executable, args, { cwd, signal, timeoutMs }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let failure, killTimer, output = 0;
    const stop = error => {
      failure ||= error;
      if (child.exitCode === null && child.signalCode === null && !killTimer) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
      }
    };
    const abort = () => stop(fault('audio_cancelled', 'Audio processing was stopped.'));
    const timer = setTimeout(() => stop(fault('audio_timeout', 'Local audio processing did not finish in time.')), timeoutMs);
    const drain = chunk => { output += chunk.length; if (output > 2 * 1024 * 1024) stop(fault('audio_output_limit', 'The local audio process returned too much output.')); };
    child.stdout.on('data', drain); child.stderr.on('data', drain);
    child.on('error', () => { failure ||= fault('audio_provider_missing', 'The local speech program is unavailable.'); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure); else if (code !== 0) reject(fault('audio_provider_failed', 'Local audio processing failed. No transcript was sent.')); else resolve(); });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

/** Local recognition and exact-text speech. Neither operation invokes an agent or sends a message. */
export class LocalAudio {
  constructor({ root, modelPath, whisper = 'whisper-cli', speech = '/usr/bin/say', run = runAudioProcess }) {
    canonicalNotebookRoot(root); Object.assign(this, { root, modelPath, whisper, speech, run });
    this.rootIdentity = canonicalNotebookRoot(root); this.transcribing = false; this.speaking = false;
  }
  job() {
    if (canonicalNotebookRoot(this.root) !== this.rootIdentity) throw fault('audio_storage', 'The original audio store is unavailable.');
    const directory = makeNotebookDirectory(this.root, 'audio-jobs');
    return fs.mkdtempSync(path.join(directory, 'job-'));
  }
  async transcribe(pcm, { language = 'fr', signal } = {}) {
    signal?.throwIfAborted(); const wave = pcm16Wave(pcm);
    if (!/^(auto|[a-z]{2,3})$/.test(language)) throw fault('audio_language', 'Choose a supported transcription language.');
    if (this.transcribing) throw fault('audio_busy', 'Another dictation is being transcribed.');
    let energy = 0, peak = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) { const value = pcm.readInt16LE(offset); energy += value * value; peak = Math.max(peak, Math.abs(value)); }
    if (Math.sqrt(energy / (pcm.length / 2)) < 35 && peak < 600) return { text: '', silent: true, submitted: false };
    let model;
    try { model = fs.lstatSync(this.modelPath); } catch {}
    if (!model?.isFile() || model.isSymbolicLink()) throw fault('audio_model_missing', 'Choose an installed local Whisper model before dictating.');
    this.transcribing = true; let directory;
    try {
      directory = this.job(); fs.writeFileSync(path.join(directory, 'input.wav'), wave, { mode: 0o600 });
      await this.run(this.whisper, ['-m', this.modelPath, '-f', path.join(directory, 'input.wav'), '-l', language,
        '-nt', '-np', '-oj', '-of', path.join(directory, 'transcript'), '-nf', '-bs', '1', '-bo', '1'], { cwd: directory, signal, timeoutMs: 80_000 });
      signal?.throwIfAborted();
      const result = readNotebookJson(directory, 'transcript.json'), items = result?.transcription;
      if (!Array.isArray(items) || items.some(item => typeof item.text !== 'string')) throw fault('audio_transcript', 'The local recognizer did not return a transcript.');
      const text = items.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > 32_000) throw fault('audio_transcript_limit', 'The transcript is too long to review safely.');
      return { text, silent: !text, submitted: false };
    } finally { this.transcribing = false; if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  }
  async synthesize(text, { voice = '', signal } = {}) {
    signal?.throwIfAborted();
    if (typeof text !== 'string' || !text.trim() || text.length > 420 || typeof voice !== 'string' || voice.length > 80 || voice && !/^[\p{L}][\p{L}\p{N} _-]*$/u.test(voice)) throw fault('audio_speech_text', 'Speak one short passage using an installed voice.');
    if (this.speaking) throw fault('audio_busy', 'Another speech passage is being prepared.');
    this.speaking = true; let directory;
    try {
      directory = this.job(); fs.writeFileSync(path.join(directory, 'text.txt'), text, { mode: 0o600 });
      await this.run(this.speech, [...(voice ? ['-v', voice] : []), '--rate=175', '-o', path.join(directory, 'speech.wav'),
        '--data-format=LEI16@24000', '-f', path.join(directory, 'text.txt')], { cwd: directory, signal, timeoutMs: 20_000 });
      signal?.throwIfAborted(); const bytes = readNotebookBytes(directory, 'speech.wav', 3 * 1024 * 1024);
      const pcm = readPcm16Wave(bytes, 24_000);
      if (pcm.length > 24_000 * 2 * 60) throw fault('audio_speech_limit', 'The speech passage exceeds one minute.');
      return { mimeType: 'audio/wav', data: bytes.toString('base64'), pcm: pcm.toString('base64'), sampleRate: 24_000, channels: 1, durationMs: pcm.length / 48, text, played: false };
    } finally { this.speaking = false; if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
