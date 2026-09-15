import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistantFixture } from './fixtures/assistant.mjs';
import { recordingFixture } from './fixtures/lisiere-recording.mjs';
import { attachLisiereRecording, listLinkedRecordings, readLinkedRecording, recordingTargetFromResolved } from '../src/lisiere_recording_links.mjs';
import { createAssistantSourceResolver } from '../src/assistant_sources.mjs';
import { readPcm16Wave } from '../src/local_audio.mjs';

async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-recording-link-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = await recordingFixture(base), root = path.join(base, 'project'), storageRoot = path.join(base, 'private');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs/idea.md'), '# Original\n');
  const source = { kind: 'document', path: 'docs/idea.md' };
  let allowed = true;
  const resolve = createAssistantSourceResolver({ canRead: (_, rel) => allowed && rel === source.path, canWrite: () => false });
  const resolveTarget = () => recordingTargetFromResolved(resolve(root, source, { creating: true }));
  return { ...f, root, storageRoot, options: { snapshot: f.snapshot, name: f.name, path: source.path }, auth: { storageRoot, resolveTarget },
    current: resolveTarget, revoke: () => { allowed = false; } };
}

test('preview makes no store; exact PCM and target are retained privately, not played or sent; repeat preserves newer source work', async t => {
  const f = await fixture(t), plan = attachLisiereRecording(f.root, f.options, f.auth);
  assert.equal(plan.applied, false); assert.equal(plan.sourceChanged, false); assert.equal(fs.existsSync(f.storageRoot), false);
  const apply = { ...f.options, apply: true, expectedRevision: plan.revision };
  const linked = attachLisiereRecording(f.root, apply, f.auth); assert.equal(linked.applied, true); assert.equal(linked.played, false); assert.equal(linked.submitted, false);
  const pcm = readLinkedRecording(f.root, linked.id, { storageRoot: f.storageRoot, current: f.current() });
  assert.deepEqual(Buffer.from(pcm.data, 'base64'), f.pcm);
  const wave = readLinkedRecording(f.root, linked.id, { storageRoot: f.storageRoot, current: f.current(), format: 'wav' });
  assert.deepEqual(readPcm16Wave(Buffer.from(wave.data, 'base64')), f.pcm);
  fs.writeFileSync(path.join(f.root, 'docs/idea.md'), '# Newer independent work\n');
  const retry = attachLisiereRecording(f.root, apply, f.auth); assert.equal(retry.replayed, true); assert.equal(retry.sourceChanged, true);
  assert.equal(listLinkedRecordings(f.root, { storageRoot: f.storageRoot, current: f.current() }).items.length, 1);
  assert.equal(fs.readdirSync(path.join(f.root, 'docs')).join(), 'idea.md');
  assert.throws(() => readLinkedRecording(f.root, linked.id, { storageRoot: f.storageRoot, current: { ...f.current(), source: { kind: 'document', path: 'docs/other.md' } } }), /another original/);
  f.revoke(); assert.throws(() => attachLisiereRecording(f.root, apply, f.auth), /allowed scope/);
});

test('stale preview, copied-audio interruption, mismatched link metadata, tampering and symbolic stores fail without overwriting', async t => {
  const f = await fixture(t), plan = attachLisiereRecording(f.root, f.options, f.auth);
  fs.appendFileSync(path.join(f.root, f.options.path), 'New paragraph');
  assert.throws(() => attachLisiereRecording(f.root, { ...f.options, apply: true, expectedRevision: plan.revision }, f.auth), /changed after/);
  assert.equal(fs.existsSync(f.storageRoot), false);
  const current = attachLisiereRecording(f.root, f.options, f.auth), apply = { ...f.options, apply: true, expectedRevision: current.revision };
  assert.throws(() => attachLisiereRecording(f.root, apply, { ...f.auth, checkpoint: () => { throw new Error('Synthetic interruption'); } }), /Synthetic/);
  assert.equal(listLinkedRecordings(f.root, { storageRoot: f.storageRoot, current: f.current() }).items.length, 0);
  assert.equal(attachLisiereRecording(f.root, apply, f.auth).applied, true);
  assert.throws(() => attachLisiereRecording(f.root, { ...apply, label: 'Different label' }, f.auth), /different metadata/);
  const object = path.join(f.storageRoot, 'legacy-recordings/v1/objects', current.sha256 + '.pcm');
  fs.writeFileSync(object, Buffer.alloc(f.pcm.length));
  assert.throws(() => readLinkedRecording(f.root, current.id, { storageRoot: f.storageRoot, current: f.current() }), /content hash/);
  assert.deepEqual(fs.readFileSync(object), Buffer.alloc(f.pcm.length));
  assert.throws(() => attachLisiereRecording(f.root, apply, { ...f.auth, storageRoot: path.join(f.root, 'private') }), /outside the project/);
  const alias = f.storageRoot + '-alias'; fs.symlinkSync(f.storageRoot, alias);
  assert.throws(() => attachLisiereRecording(f.root, apply, { ...f.auth, storageRoot: alias }), /exact original/);
});

test('owner HTTP preview/attach/read stays within the original conversation and does not connect a provider', async t => {
  const f = await assistantFixture(); t.after(() => f.close()); const legacy = await recordingFixture(f.base);
  const original = (await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Original.md' } })).body;
  const other = (await f.post('/api/assistant/conversations', { source: { kind: 'document', path: 'docs/Other.md' } })).body;
  const route = `/api/assistant/conversations/${original.id}/recordings`, body = { snapshot: legacy.snapshot, name: legacy.name, label: 'Explicit synthetic voice note' };
  for (const headers of [{ 'x-context-room-owner-nonce': '' }, { origin: 'https://untrusted.invalid' }]) assert.equal((await f.post(route, body, headers)).status, 403);
  assert.equal((await f.post(route, body, { 'x-context-room-project': 'wrong' })).status, 409);
  const plan = await f.post(route, body); assert.equal(plan.status, 200); assert.equal(plan.body.applied, false);
  const linked = await f.post(route, { ...body, apply: true, expectedRevision: plan.body.revision }); assert.equal(linked.status, 200);
  const listed = await (await fetch(f.url + route)).json(); assert.equal(listed.items.length, 1);
  assert.equal((await (await fetch(f.url + `/api/assistant/conversations/${other.id}/recordings`)).json()).items.length, 0);
  const denied = await fetch(f.url + `/api/assistant/conversations/${other.id}/recordings/${plan.body.id}`); assert.notEqual(denied.status, 200);
  const exported = await (await fetch(f.url + route + '/' + plan.body.id)).json(); assert.deepEqual(Buffer.from(exported.data, 'base64'), legacy.pcm);
  assert.equal(f.connections(), 0); assert.equal(f.turns.length, 0);
  assert.equal((await (await fetch(f.url + '/api/assistant/conversations/' + original.id)).json()).operation, null);
});

test('the installed CLI attaches to an explicit source and rejects ambiguous source choices', async t => {
  const f = await assistantFixture(); t.after(() => f.close()); const legacy = await recordingFixture(f.base);
  const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url)), privateStore = path.join(f.base, 'cli-private');
  const args = [cli, 'migrate', '--import-lisiere', legacy.snapshot, '--legacy-recording', legacy.name, '--path', 'docs/Original.md'];
  const options = { cwd: f.root, env: { ...process.env, HOME: f.base, CONTEXT_ROOM_ASSISTANT_HOME: privateStore }, encoding: 'utf8', stdio: 'pipe', timeout: 45000 };
  const run = extra => JSON.parse(execFileSync(process.execPath, [...args, ...extra], options));
  const plan = run([]); assert.equal(plan.ok, true); assert.equal(fs.existsSync(privateStore), false);
  assert.equal(run(['--apply', '--revision', plan.data.revision]).data.applied, true);
  assert.throws(() => run(['--conversation-id', '00000000-0000-4000-a000-000000000000']), /Select exactly one/);
});
