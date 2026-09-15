import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAudio, pcm16Wave, readPcm16Wave } from '../src/local_audio.mjs';

const audible = () => { const bytes = Buffer.alloc(32000); for (let n = 0; n < bytes.length / 2; n++) bytes.writeInt16LE(Math.round(Math.sin(n / 8) * 6000), n * 2); return bytes; };
function fixture(t, run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-audio-'))), modelPath = path.join(root, 'synthetic-model');
  fs.writeFileSync(modelPath, 'This is a subprocess fixture, not a recognition model.');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, audio: new LocalAudio({ root, modelPath, run }) };
}
test('audio boundaries reject incomplete, stereo, wrong-rate and oversized recordings', () => {
  const pcm = audible(), wave = pcm16Wave(pcm); assert.deepEqual(readPcm16Wave(wave), pcm);
  const stereo = Buffer.from(wave); stereo.writeUInt16LE(2, 22);
  for (const invalid of [wave.subarray(0, -1), stereo, pcm16Wave(pcm, 24000)]) assert.throws(() => readPcm16Wave(invalid), { code: 'audio_format' });
  assert.throws(() => pcm16Wave(Buffer.alloc(16_000 * 2 * 121)), { code: 'audio_format' });
});
test('dictation returns reviewable text, never submits it, and removes temporary audio', async t => {
  let calls = 0;
  const { root, audio } = fixture(t, async (_, args, { cwd }) => {
    calls++; assert.ok(args.includes('-nf')); assert.ok(fs.existsSync(path.join(cwd, 'input.wav')));
    fs.writeFileSync(path.join(cwd, 'transcript.json'), JSON.stringify({ transcription: [{ text: ' Accepter le fichier ' }] }));
  });
  assert.deepEqual(await audio.transcribe(Buffer.alloc(32000)), { text: '', silent: true, submitted: false }); assert.equal(calls, 0);
  assert.deepEqual(await audio.transcribe(audible()), { text: 'Accepter le fichier', silent: false, submitted: false }); assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'audio-jobs')), []);
});
test('recognizer failure and cancellation retain no temporary audio or success receipt', async t => {
  const controller = new AbortController();
  const { root, audio } = fixture(t, async () => controller.abort());
  await assert.rejects(audio.transcribe(audible(), { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'audio-jobs')), []); assert.equal(audio.transcribing, false);
});
test('speech uses the exact supplied passage and remains unplayed until the device receipt', async t => {
  const text = 'Le carnet conserve votre idée.';
  const { root, audio } = fixture(t, async (_, args, { cwd }) => {
    assert.equal(fs.readFileSync(path.join(cwd, 'text.txt'), 'utf8'), text);
    assert.equal(args.includes(text), false);
    fs.writeFileSync(path.join(cwd, 'speech.wav'), pcm16Wave(audible(), 24000));
  });
  const speech = await audio.synthesize(text, { voice: 'Thomas' });
  assert.equal(speech.text, text); assert.equal(speech.played, false); assert.equal(speech.sampleRate, 24000);
  assert.deepEqual(Buffer.from(speech.pcm, 'base64'), audible()); assert.deepEqual(fs.readdirSync(path.join(root, 'audio-jobs')), []);
});
