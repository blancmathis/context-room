import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectLocalAudio } from '../src/local_audio_diagnostics.mjs';
import { LocalAudio } from '../src/local_audio.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-audio-diagnostic-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, modelPath: path.join(root, 'synthetic-model'), whisper: path.join(root, 'whisper-cli'), speech: path.join(root, 'say'), platform: 'darwin', searchPath: root };
}

test('audio diagnostics are read-only and never imply that missing dependencies are configured', t => {
  const options = fixture(t), before = fs.readdirSync(options.root), report = inspectLocalAudio(options);
  assert.equal(report.transcriptionReadyForAttempt, false); assert.equal(report.synthesisReadyForAttempt, false);
  assert.equal(report.model.inferenceVerified, false); assert.equal(report.legacyRuntimeRequired, false);
  assert.deepEqual(report.issues.map(issue => issue.code), ['whisper-executable-missing', 'whisper-model-unavailable', 'speech-executable-missing']);
  assert.deepEqual(fs.readdirSync(options.root), before);
});

test('model presence alone does not hide missing whisper, and executable presence does not claim recognition quality', t => {
  const options = fixture(t);
  fs.writeFileSync(options.modelPath, 'Synthetic test bytes; not a real speech model.');
  assert.equal(inspectLocalAudio(options).transcriptionReadyForAttempt, false);
  for (const executable of [options.whisper, options.speech]) { fs.writeFileSync(executable, '#!/bin/sh\nexit 99\n'); fs.chmodSync(executable, 0o755); }
  const before = fs.readdirSync(options.root), report = inspectLocalAudio(options);
  assert.equal(report.transcriptionReadyForAttempt, true); assert.equal(report.synthesisReadyForAttempt, true);
  assert.equal(report.model.inferenceVerified, false); assert.equal(report.acousticQualityVerified, false);
  assert.deepEqual(report.issues, []); assert.deepEqual(fs.readdirSync(options.root), before);
  const runtime = new LocalAudio(options); assert.equal(runtime.diagnostics().transcriptionReadyForAttempt, true);
});

test('empty, linked and directory models are not accepted as readable model files', t => {
  const options = fixture(t);
  fs.writeFileSync(options.modelPath, ''); assert.equal(inspectLocalAudio(options).model.state, 'empty'); fs.unlinkSync(options.modelPath);
  fs.mkdirSync(options.modelPath); assert.equal(inspectLocalAudio(options).model.state, 'not-regular'); fs.rmdirSync(options.modelPath);
  const target = path.join(options.root, 'elsewhere'); fs.writeFileSync(target, 'model'); fs.symlinkSync(target, options.modelPath);
  assert.equal(inspectLocalAudio(options).model.readable, false);
});

test('PATH lookup avoids implicit current-directory executables and non-macOS speech has no external fallback', t => {
  const options = fixture(t);
  fs.writeFileSync(options.whisper, '#!/bin/sh\nexit 99\n'); fs.chmodSync(options.whisper, 0o755);
  const absolute = inspectLocalAudio({ ...options, whisper: 'whisper-cli' }); assert.equal(absolute.whisper.executable, true);
  assert.equal(inspectLocalAudio({ ...options, whisper: 'whisper-cli', searchPath: ':.' }).whisper.executable, false);
  const linux = inspectLocalAudio({ ...options, platform: 'linux' }); assert.equal(linux.synthesisReadyForAttempt, false);
  assert.equal(linux.issues.at(-1).code, 'speech-platform-unavailable'); assert.equal(linux.localOnly, true);
});
