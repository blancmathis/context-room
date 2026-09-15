import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeContextRoomProject, writeMemoryWebappSettings } from '../src/context_room.mjs';
import { readNotebook } from '../src/notebooks.mjs';
const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
const id = '10000000-0000-4000-a000-000000000001';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-native-cli-'))), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME', 'CONTEXT_ROOM_ASSISTANT_HOME']) {
    previous[key] = process.env[key]; process.env[key] = path.join(root, key);
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Synthetic guide\n');
  initializeContextRoomProject(root, { title: 'Native recovery CLI', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', CONTEXT_ROOM_WHISPER_BIN: path.join(root, 'absent-whisper'), CONTEXT_ROOM_WHISPER_MODEL: path.join(root, 'absent-model') };
  const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 45000, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
  return { root, run };
}

test('doctor exposes local optional dependencies in ordinary and scoped JSON output without installing or starting them', t => {
  const { root, run } = fixture(t);
  const human = run(['doctor']); assert.match(human, /Local voice: dependencies incomplete/); assert.match(human, /whisper-executable-missing/);
  const report = JSON.parse(run(['doctor', '--format', 'json'])); assert.equal(report.ok, true);
  const audio = report.data.runtimeDependencies.audio; assert.equal(audio.transcriptionReadyForAttempt, false); assert.equal(audio.model.inferenceVerified, false);
  assert.equal(audio.legacyRuntimeRequired, false); assert.equal(audio.localOnly, true);
  assert.equal(fs.existsSync(path.join(root, 'absent-model')), false); assert.equal(fs.existsSync(path.join(root, 'absent-whisper')), false);
});

test('the real migrate CLI inventories, previews and recovers a chosen legacy transfer without another application', t => {
  const { root, run } = fixture(t), directory = path.join(root, '.context-room/lisiere/sessions', id);
  fs.mkdirSync(path.join(directory, 'workspace'), { recursive: true }); fs.writeFileSync(path.join(directory, 'workspace/source.png'), png);
  const session = JSON.stringify({ id, boardId: id, title: 'Original drawing', source: { path: 'docs/original.png', revision: 'original-review' } });
  fs.writeFileSync(path.join(directory, 'session.json'), session);
  const inventory = JSON.parse(run(['migrate', '--legacy-session', id])); assert.equal(inventory.ok, true); assert.equal(inventory.data.candidates[0].frame, 'source');
  const options = ['migrate', '--legacy-session', id, '--session-frame', 'source', '--path', 'docs/recovered.crnb'];
  const preview = JSON.parse(run(options)); assert.equal(preview.ok, true); assert.equal(preview.data.accepted, false); assert.equal(preview.data.applied, false);
  assert.equal(fs.existsSync(path.join(root, '.context-room/notebooks')), false);
  const applied = JSON.parse(run([...options, '--apply', '--revision', preview.data.revision]));
  assert.equal(applied.ok, true); assert.equal(applied.data.applied, true); assert.equal(applied.data.accepted, false);
  assert.equal(applied.data.delivery, 'not-inferred'); assert.equal(applied.data.legacyTaskChanged, false);
  assert.equal(readNotebook(root, applied.data.resourceId).document.objects[0].createdBy.kind, 'import');
  assert.equal(JSON.parse(run([...options, '--apply', '--revision', preview.data.revision])).data.replayed, true);
  assert.equal(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'), session);
  assert.equal(fs.existsSync(path.join(root, 'docs/recovered.crnb')), false);
  assert.throws(() => run(['migrate', '--session-frame', 'source']), /requires --legacy-session/);
});
