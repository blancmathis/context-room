/** Opt-in real recognition, Codex and speech; the browser microphone input is explicitly synthetic. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createCodexProvider } from '../../src/codex_provider.mjs';
import { pcm16Wave, readPcm16Wave } from '../../src/local_audio.mjs';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer } from '../../src/context_room.mjs';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] || ''; };
if (!process.argv.includes('--run') || !option('--output') || !option('--model') || !option('--sample')) throw new Error('Use explicit --run, --output, --model and a synthetic --sample WAVE file.');
const output = path.resolve(option('--output')), repository = fs.realpathSync(new URL('../../', import.meta.url)), resuming = process.argv.includes('--resume');
const voiceProof = process.argv.includes('--voice');
if (voiceProof && resuming) throw new Error('A Voice proof requires a fresh fixture. Inspect a failed fixture before deciding on another real turn.');
if (output === repository || !path.relative(repository, output).startsWith('..' + path.sep)) throw new Error('Keep live-account evidence outside the repository.');
const marker = path.join(output, 'audio-proof-fixture.json');
if (resuming) assert.equal(JSON.parse(fs.readFileSync(marker)).version, 1); else { fs.mkdirSync(output, { mode: 0o700 }); fs.writeFileSync(marker, '{"version":1}\n', { mode: 0o600 }); }
const root = path.join(output, 'project'), documentPath = path.join(root, 'docs/Original.md');
for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) process.env[key] = path.join(output, key);
if (!resuming) {
  fs.mkdirSync(path.dirname(documentPath), { recursive: true }); fs.writeFileSync(documentPath, '# Carnet vocal\n\nCette idée reste dans son document original.\n');
  initializeContextRoomProject(root, { title: 'Isolated speech verification', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
}
const original = fs.readFileSync(documentPath), sample = readPcm16Wave(fs.readFileSync(path.resolve(option('--sample'))));
const padded = Buffer.concat([Buffer.alloc(32000), sample, Buffer.alloc(16000)]), captureFile = path.join(output, 'synthetic-microphone.wav');
if (!resuming) fs.writeFileSync(captureFile, pcm16Wave(padded), { mode: 0o600 });
const room = createMemoryServer({ root, assistantOptions: { root: path.join(output, 'private-assistant'), modelPath: path.resolve(option('--model')),
  providerFactory: options => createCodexProvider({ ...options, ...(option('--codex-state') ? { stateRoot: path.resolve(option('--codex-state')) } : {}) }) } });
await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + captureFile] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], receipts = [];
if (voiceProof) {
  // A finite, explicitly synthetic MediaStream is followed by silent streams.
  // This tests real Web Audio capture/VAD without repeating a file microphone
  // when the continuous loop opens its next listening interval.
  await page.addInitScript(({ pcm }) => {
    let first = true;
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 16000 }), output = context.createMediaStreamDestination();
      const source = context.createBufferSource(), bytes = Uint8Array.from(atob(first ? pcm : btoa('\0\0')), c => c.charCodeAt(0)); first = false;
      const view = new DataView(bytes.buffer), buffer = context.createBuffer(1, bytes.length / 2, 16000), channel = buffer.getChannelData(0);
      for (let n = 0; n < channel.length; n++) channel[n] = view.getInt16(n * 2, true) / 32768;
      source.buffer = buffer; source.connect(output); await context.resume(); source.start();
      const track = output.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); void context.close(); }; return output.stream;
    };
  }, { pcm: padded.toString('base64') });
}
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.url().endsWith('/api/assistant/audio/receipt')) receipts.push(request.postDataJSON()); });
try {
  await page.goto(`http://127.0.0.1:${room.server.address().port}`); await page.waitForFunction(() => Boolean(state.projectId && state.ownerMutationNonce));
  await page.evaluate(() => selectFile('docs/Original.md')); await page.getByRole('button', { name: 'Discuss', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Original document conversation' });
  await page.waitForFunction(() => document.querySelector('.assistant-panel select')?.value);
  const id = await pane.getByLabel('Saved conversations for this original source').inputValue(); let transcription;
  if (voiceProof) {
    const played = page.waitForResponse(response => response.url().endsWith('/api/assistant/audio/receipt') && response.ok(), { timeout: 190000 });
    played.catch(() => {});
    await pane.getByRole('button', { name: 'Voice', exact: true }).click();
    await played;
    await page.waitForFunction(() => document.querySelector('.assistant-panel')?.dataset.operationStatus === 'completed' &&
      document.querySelector('.assistant-panel')?.dataset.voiceState === 'listening', null, { timeout: 190000 });
    assert.ok(receipts.length > 0, 'The actual voice answer must complete playback before listening resumes');
    await pane.getByRole('button', { name: 'End voice', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.assistant-panel')?.dataset.voiceState === 'off');
    const completed = await (await fetch(`http://127.0.0.1:${room.server.address().port}/api/assistant/conversations/${id}`)).json();
    const user = completed.messages.filter(message => message.role === 'user'); assert.equal(user.length, 1, 'No echoed or repeated microphone input');
    assert.ok(!option('--expected') || user[0].text.includes(option('--expected')), user[0].text);
    assert.equal(completed.operation.status, 'completed'); assert.deepEqual(errors, []); assert.deepEqual(fs.readFileSync(documentPath), original);
    await page.screenshot({ path: path.join(output, 'continuous-voice-original-answer.png') });
    const proof = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })),
      microphoneInput: 'finite synthetic browser MediaStream, then silence', endpoint: 'actual browser capture and speech endpoint',
      transcription: user[0].text, provider: 'real local Codex', answer: completed.messages.findLast(message => message.role === 'assistant')?.text,
      synthesis: 'real local macOS speech', playback: 'actual Web Audio completion with muted output', playbackReceipts: receipts.length,
      listeningResumed: true, explicitEnd: true, documentUnchanged: true, physicalMicrophoneOrAudibility: 'not-tested' };
    fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 }); console.log(JSON.stringify(proof));
  } else {
  if (!resuming) {
    await pane.getByRole('button', { name: 'Dictate', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.assistant-panel button')].some(button => button.textContent === 'Finish dictation'));
    await page.waitForTimeout(padded.length / 32 + 300);
    const started = Date.now(); await pane.getByRole('button', { name: 'Finish dictation' }).click();
    await page.waitForFunction(() => document.querySelector('.assistant-panel textarea')?.value.trim(), null, { timeout: 90000 });
    transcription = { text: await pane.getByRole('textbox').inputValue(), elapsedMs: Date.now() - started };
    fs.writeFileSync(path.join(output, 'transcription.json'), JSON.stringify(transcription, null, 2), { mode: 0o600 });
    assert.ok(!option('--expected') || transcription.text.includes(option('--expected')), transcription.text);
    assert.equal(await pane.getByRole('log', { name: 'Conversation messages', includeHidden: true }).textContent(), '', 'Dictation must not send a message');
    await page.screenshot({ path: path.join(output, 'reviewable-dictation.png') });
  } else transcription = JSON.parse(fs.readFileSync(path.join(output, 'transcription.json')));
  const conversation = await (await fetch(`http://127.0.0.1:${room.server.address().port}/api/assistant/conversations/${id}`)).json();
  if (!conversation.messages.some(message => message.role === 'user')) {
    await pane.getByRole('textbox').fill(transcription.text + '\nRéponds en français en une courte phrase qui confirme mon idée. Ne modifie aucun document.');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
  } else if (conversation.operation?.status === 'uncertain') await pane.getByRole('button', { name: 'Inspect original task' }).click();
  await page.waitForFunction(() => ['completed', 'failed', 'stopped'].includes(document.querySelector('.assistant-panel')?.dataset.operationStatus), null, { timeout: 190000 });
  assert.equal(await pane.getAttribute('data-operation-status'), 'completed', await pane.locator('.assistant-status').innerText());
  const conversationLog = await pane.getByRole('log').innerText();
  const completed = await (await fetch(`http://127.0.0.1:${room.server.address().port}/api/assistant/conversations/${id}`)).json();
  const answer = completed.messages.findLast(message => message.role === 'assistant' && message.text)?.text;
  assert.ok(answer); await pane.getByRole('button', { name: 'Read answer', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.assistant-audio-state')?.textContent === 'Microphone off · audio stopped.' && ![...document.querySelectorAll('.assistant-panel button')].find(button => button.textContent === 'Read answer')?.disabled, null, { timeout: 90000 });
  assert.ok(receipts.length > 0, 'Actual browser playback must acknowledge a prepared passage'); assert.deepEqual(errors, []); assert.deepEqual(fs.readFileSync(documentPath), original);
  await page.screenshot({ path: path.join(output, 'spoken-original-answer.png') });
  const proof = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })),
    microphoneInput: 'synthetic WAVE through actual Chromium media capture', transcription, provider: 'real local Codex', answer, conversationLog, playbackReceipts: receipts.length,
    synthesis: 'real local macOS speech', playback: 'actual Web Audio completion with muted output', documentUnchanged: true, physicalMicrophoneOrAudibility: 'not-tested' };
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 }); console.log(JSON.stringify(proof));
  }
} finally { await browser.close(); await new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }); await room.waitForShutdown(); }
