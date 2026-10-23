import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planBackup, writeBackup, previewRestore, applyRestore, loadBackup, backupNotebookRoots } from '../src/backup.mjs';
import { openNotebook, readNotebook, encodeNotebook } from '../src/notebooks.mjs';
import { AssistantSessions } from '../src/assistant_sessions.mjs';
import { createReviewReceiptStore } from '../src/review_authority.mjs';

const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
const KEYS = ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_ASSISTANT_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = { kind: 'notebook', path: 'docs/Scene.crnb', resourceId: 'original', locationRevision: 'a'.repeat(64) };
const resolveSource = (project, value) => ({ source: value, title: 'Synthetic scene', context: {}, tools: [], call: async () => ({}) });

/** Homes live under <base>/<name>/…; entering a world points every Context Room home at it. */
function laboratory(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-backup-test-')));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(base, { recursive: true, force: true }); });
  const world = name => {
    const dir = path.join(base, name, 'data');
    const homes = { hub: path.join(dir, 'hub'), assistant: path.join(dir, 'assistant'), shared: path.join(dir, 'shared'), review: path.join(dir, 'hub', 'review-authority') };
    fs.mkdirSync(homes.hub, { recursive: true, mode: 0o700 }); fs.mkdirSync(homes.assistant, { recursive: true, mode: 0o700 });
    return { ...homes, name, enter() {
      delete process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
      Object.assign(process.env, { CONTEXT_ROOM_HUB_HOME: homes.hub, CONTEXT_ROOM_ASSISTANT_HOME: homes.assistant, CONTEXT_ROOM_SHARED_HOME: homes.shared });
    } };
  };
  const project = name => { const root = path.join(base, 'projects', name); fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); return fs.realpathSync(root); };
  const register = (w, ...roots) => fs.writeFileSync(path.join(w.hub, 'registry.json'), JSON.stringify({ version: 2, projects: roots.map((root, index) => ({ id: `p${index}`, root })), sharedRepositories: [] }));
  /** One project with a notebook and its source, one conversation, one review receipt, plus things a backup must skip. */
  const populate = (w, root) => {
    w.enter(); register(w, root);
    const scene = openNotebook(root, { path: 'docs/Sketch.crnb', id: 'synthetic-notebook', title: 'Synthetic sketch', canWrite: () => true });
    fs.writeFileSync(path.join(root, 'docs/Sketch.crnb'), encodeNotebook(readNotebook(root, scene.resourceId).document));
    const sessions = new AssistantSessions({ root: w.assistant, resolveSource });
    const conversation = sessions.create(root, { requestId: '10000000-0000-4000-a000-000000000001', source });
    const receipts = createReviewReceiptStore('synthetic-domain', { authorityHome: w.review });
    fs.mkdirSync(receipts.base, { recursive: true, mode: 0o700 });
    const record = receipts.sign({ decision: 'accepted', path: 'docs/guide.md' });
    fs.writeFileSync(receipts.pathFor('receipt-1.json'), JSON.stringify(record));
    for (const [home, rel] of [[w.hub, 'devices/pairing.json'], [w.assistant, 'models/ggml.bin'], [w.assistant, 'audio-jobs/job.json'], [w.hub, 'events.jsonl']]) {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), 'skip me');
    }
    return { root, scene, conversationId: conversation.id, record, receiptName: 'receipt-1.json', sessions };
  };
  return { base, world, project, register, populate };
}
function tree(directory, files = new Map()) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) tree(full, files); else if (item.isFile()) files.set(full, sha(fs.readFileSync(full)));
  }
  return files;
}
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code, `expected ${code}`);
const conversationFile = (w, id = '10000000-0000-4000-a000-000000000001') => path.join(w.assistant, 'conversations', `${id}.json`);

test('backup writes a private manifest whose objects match their sha256', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); const data = lab.populate(w, root);
  const output = path.join(lab.base, 'out', 'b1'), result = writeBackup({ output });
  assert.equal(fs.statSync(output).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(output, 'objects')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(output, 'manifest.json')).mode & 0o777, 0o600);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1); assert.equal(manifest.mediaType, 'application/vnd.context-room.backup+json');
  assert.deepEqual(manifest.containsSecrets, ['review/authority.key']); assert.deepEqual(result.containsSecrets, manifest.containsSecrets);
  for (const entry of manifest.entries) {
    const object = path.join(output, 'objects', entry.sha256);
    assert.equal(fs.statSync(object).mode & 0o777, 0o600); assert.equal(sha(fs.readFileSync(object)), entry.sha256); assert.equal(fs.statSync(object).size, entry.bytes);
  }
  const paths = manifest.entries.map(entry => `${entry.section}:${entry.path}`);
  assert.ok(paths.includes('registry:registry.json')); assert.ok(paths.includes('review:authority.key'));
  assert.ok(paths.includes(`conversations:conversations/${data.conversationId}.json`)); assert.ok(paths.includes('notebooks:docs/Sketch.crnb'));
  assert.ok(paths.some(item => item.startsWith('notebooks:.context-room/notebooks/v1/resources/synthetic-notebook/header.json')));
  assert.ok(paths.some(item => item.startsWith('review:review-receipts/')));
  assert.equal(paths.some(item => /devices|models|audio-jobs|events\.jsonl|\.lock|runtime\.json/.test(item)), false);
  assert.equal(fs.readdirSync(path.dirname(output)).some(name => name.endsWith('.partial')), false);
  assert.equal(loadBackup(output).manifest.contentRevision, manifest.contentRevision);
});

test('backup includes every registry root such as the free Carnets space', t => {
  const lab = laboratory(t), w = lab.world('a'), one = lab.project('one'), space = lab.project('Carnets'); lab.populate(w, one); lab.register(w, one, space);
  openNotebook(space, { path: 'docs/Memo.crnb', id: 'free-memo', title: 'Free memo', canWrite: () => true });
  assert.deepEqual(backupNotebookRoots(), [one, space].sort());
  const manifest = JSON.parse(fs.readFileSync(path.join(writeBackup({ output: path.join(lab.base, 'b') }).output, 'manifest.json'), 'utf8'));
  assert.ok(manifest.entries.some(entry => entry.root === space && entry.path.includes('free-memo')));
});

test('backup refuses an existing output or one inside a source home', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  fs.mkdirSync(path.join(lab.base, 'exists'));
  throwsCode(() => writeBackup({ output: path.join(lab.base, 'exists') }), 'backup_output_exists');
  for (const inner of [path.join(w.hub, 'b'), path.join(w.assistant, 'x', 'b'), path.join(w.review, 'b'), path.join(root, '.context-room', 'b')]) {
    throwsCode(() => writeBackup({ output: inner }), 'backup_output_inside_source'); assert.equal(fs.existsSync(inner), false);
  }
  throwsCode(() => writeBackup({}), 'backup_output'); throwsCode(() => writeBackup({ output: path.join(lab.base, 'z'), only: 'devices' }), 'backup_sections');
});

test('backup plan writes nothing and reports section counts', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const before = tree(lab.base), plan = planBackup();
  assert.equal(plan.applied, false); assert.equal(plan.sections.registry.files, 1); assert.equal(plan.sections.conversations.files, 1);
  assert.ok(plan.sections.notebooks.files >= 2); assert.ok(plan.sections.review.files >= 2); assert.ok(plan.bytes > 0); assert.deepEqual(plan.containsSecrets, ['review/authority.key']);
  assert.deepEqual(tree(lab.base), before);
  assert.deepEqual(Object.keys(planBackup({ only: 'registry,recordings' }).sections), ['registry', 'recordings']);
});

test('backup retries when a source changes during the copy', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const file = conversationFile(w), attempts = [];
  const result = writeBackup({ output: path.join(lab.base, 'b1') }, { checkpoint(name, attempt) { attempts.push(attempt); if (attempt === 1) fs.writeFileSync(file, '{"changed":true}\n'); } });
  assert.deepEqual(attempts, [1, 2]);
  const manifest = loadBackup(result.output).manifest, entry = manifest.entries.find(item => item.path.endsWith('0001.json'));
  assert.equal(entry.sha256, sha('{"changed":true}\n'));
  assert.equal(fs.readdirSync(path.join(result.output, 'objects')).length, new Set(manifest.entries.map(item => item.sha256)).size, 'stale objects are removed');
  let counter = 0;
  throwsCode(() => writeBackup({ output: path.join(lab.base, 'b2') }, { checkpoint() { fs.writeFileSync(file, `{"n":${counter += 1}}\n`); } }), 'backup_changed');
  assert.equal(fs.existsSync(path.join(lab.base, 'b2')), false); assert.deepEqual(fs.readdirSync(lab.base).filter(name => name.includes('partial')), []);
});

test('restore preview is read-only and classifies create same conflict blocked', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); const data = lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  let preview = previewRestore(output);
  assert.equal(preview.create, 0); assert.equal(preview.conflict, 0); assert.equal(preview.blocked, 0); assert.ok(preview.same >= 6);
  fs.writeFileSync(conversationFile(w), 'edited\n');
  fs.rmSync(path.join(w.review, 'review-receipts'), { recursive: true });
  const moved = `${root}-away`;
  fs.renameSync(root, moved); const before = tree(lab.base);
  preview = previewRestore(output);
  assert.equal(preview.sections.conversations.conflict, 1); assert.equal(preview.conflicts[0].path, `conversations/${data.conversationId}.json`);
  assert.equal(preview.sections.review.create, 1); assert.ok(preview.sections.notebooks.blocked >= 2); assert.equal(preview.blocked, preview.sections.notebooks.blocked);
  assert.match(preview.blockedFiles[0].reason, /missing or replaced/); assert.equal(preview.kept, 0);
  assert.match(preview.revision, /^[a-f0-9]{64}$/); assert.equal(preview.applied, false);
  assert.equal(previewRestore(output).revision, preview.revision); assert.notEqual(previewRestore(output, { replace: true }).revision, preview.revision);
  assert.deepEqual(tree(lab.base), before); fs.renameSync(moved, root);
});

test('restore refuses a damaged object or an unsafe manifest path', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  const copy = name => { const target = path.join(lab.base, name); fs.cpSync(output, target, { recursive: true }); return target; };
  const edit = (directory, change) => { const file = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8')); change(manifest); fs.writeFileSync(file, JSON.stringify(manifest)); return directory; };
  const damaged = copy('damaged'), first = fs.readdirSync(path.join(damaged, 'objects'))[0]; fs.appendFileSync(path.join(damaged, 'objects', first), 'x');
  throwsCode(() => previewRestore(damaged), 'restore_damaged');
  const linked = copy('linked'), victim = path.join(lab.base, 'victim'); fs.writeFileSync(victim, 'x'); fs.rmSync(path.join(linked, 'objects', first)); fs.symlinkSync(victim, path.join(linked, 'objects', first));
  throwsCode(() => previewRestore(linked), 'restore_damaged');
  for (const [name, change] of [['dots', m => { m.entries[0].path = '../escape'; }], ['absolute', m => { m.entries[0].path = '/etc/passwd'; }],
    ['section', m => { m.entries[0].section = 'devices'; }], ['revision', m => { m.contentRevision = 'f'.repeat(64); }],
    ['home', m => { m.entries.find(e => e.section === 'review').root = '@hub'; }], ['version', m => { m.version = 2; }]])
    throwsCode(() => previewRestore(edit(copy(name), change)), 'restore_manifest');
  // A link inside the target is reported as blocked and nothing is written through it.
  const outside = path.join(lab.base, 'outside'); fs.mkdirSync(outside);
  fs.rmSync(path.join(root, '.context-room/notebooks'), { recursive: true }); fs.symlinkSync(outside, path.join(root, '.context-room/notebooks'));
  const preview = previewRestore(output); assert.ok(preview.blocked >= 1); assert.match(preview.blockedFiles[0].reason, /./);
  applyRestore(output, { expectedRevision: preview.revision }); assert.deepEqual(fs.readdirSync(outside), []);
  throwsCode(() => previewRestore(path.join(lab.base, 'nothing')), 'restore_manifest');
});

test('restore apply refuses a stale revision', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') }), preview = previewRestore(output);
  throwsCode(() => applyRestore(output, {}), 'restore_revision_required');
  throwsCode(() => applyRestore(output, { expectedRevision: 'a'.repeat(64) }), 'restore_stale');
  fs.writeFileSync(conversationFile(w), 'changed after the preview\n');
  throwsCode(() => applyRestore(output, { expectedRevision: preview.revision }), 'restore_stale');
  assert.equal(fs.readFileSync(conversationFile(w), 'utf8'), 'changed after the preview\n');
  throwsCode(() => applyRestore(output, { replace: true, expectedRevision: previewRestore(output).revision }), 'restore_stale');
});

test('restore apply refuses conflicts without --replace and changes nothing', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  fs.writeFileSync(conversationFile(w), 'edited\n'); fs.rmSync(path.join(w.review, 'authority.key'));
  const preview = previewRestore(output), before = tree(lab.base);
  assert.equal(preview.conflict, 1); assert.equal(preview.create, 1);
  throwsCode(() => applyRestore(output, { expectedRevision: preview.revision }), 'restore_conflicts');
  assert.deepEqual(tree(lab.base), before); assert.equal(fs.existsSync(path.join(lab.base, 'a', 'data', 'backups')), false);
  const partial = previewRestore(output, { only: 'review' }); assert.equal(partial.conflict, 0);
  const result = applyRestore(output, { only: 'review', expectedRevision: partial.revision });
  assert.equal(result.applied, true); assert.equal(result.written, 1); assert.equal(result.undoBackup, null); assert.equal(fs.readFileSync(conversationFile(w), 'utf8'), 'edited\n');
});

test('restore apply with --replace keeps an undo backup that restores the prior state', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') }), original = fs.readFileSync(conversationFile(w), 'utf8');
  fs.writeFileSync(conversationFile(w), 'edited\n');
  const preview = previewRestore(output, { replace: true }), result = applyRestore(output, { replace: true, expectedRevision: preview.revision });
  assert.equal(result.replaced, 1); assert.equal(fs.readFileSync(conversationFile(w), 'utf8'), original);
  assert.equal(path.dirname(result.undoBackup), path.join(path.dirname(w.hub), 'backups')); assert.match(path.basename(result.undoBackup), /^before-restore-\d{4}-/);
  assert.equal(fs.statSync(result.undoBackup).mode & 0o777, 0o700);
  assert.equal(previewRestore(output).conflict, 0);
  const undo = previewRestore(result.undoBackup, { replace: true }); assert.equal(undo.conflict, 1);
  applyRestore(result.undoBackup, { replace: true, expectedRevision: undo.revision });
  assert.equal(fs.readFileSync(conversationFile(w), 'utf8'), 'edited\n');
});

test('restore apply refuses while the Hub runtime is alive', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') }), preview = previewRestore(output);
  fs.writeFileSync(path.join(w.hub, 'runtime.json'), JSON.stringify({ version: 1, pid: process.pid, port: 4319, url: 'http://127.0.0.1:4319', root }));
  assert.throws(() => applyRestore(output, { expectedRevision: preview.revision }), error => error.code === 'restore_hub_running' && /launchctl bootout/.test(error.message));
  fs.writeFileSync(path.join(w.hub, 'runtime.json'), JSON.stringify({ version: 1, pid: 2 ** 22 + 12345, port: 4319, url: 'http://127.0.0.1:4319', root }));
  assert.equal(applyRestore(output, { expectedRevision: preview.revision }).applied, true);
});

test('restore never deletes files absent from the backup', t => {
  const lab = laboratory(t), w = lab.world('a'), root = lab.project('one'); lab.populate(w, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  const extra = path.join(w.assistant, 'conversations', '20000000-0000-4000-a000-000000000002.json'), project = path.join(root, '.context-room/notebooks/v1/resources/later/header.json');
  fs.writeFileSync(extra, 'later\n'); fs.mkdirSync(path.dirname(project), { recursive: true }); fs.writeFileSync(project, 'later\n'); fs.rmSync(conversationFile(w));
  const preview = previewRestore(output); assert.equal(preview.kept, 2);
  const result = applyRestore(output, { expectedRevision: preview.revision });
  assert.equal(result.kept, 2); assert.equal(fs.readFileSync(extra, 'utf8'), 'later\n'); assert.equal(fs.readFileSync(project, 'utf8'), 'later\n'); assert.equal(fs.existsSync(conversationFile(w)), true);
});

test('restore only selected sections with --only', t => {
  const lab = laboratory(t), a = lab.world('a'), b = lab.world('b'), root = lab.project('one'); lab.populate(a, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  b.enter(); fs.rmSync(path.join(root, '.context-room'), { recursive: true });
  throwsCode(() => previewRestore(output, { only: 'devices' }), 'backup_sections');
  const preview = previewRestore(output, { only: 'conversations' }); assert.deepEqual(Object.keys(preview.sections), ['conversations']);
  const result = applyRestore(output, { only: 'conversations', expectedRevision: preview.revision });
  assert.equal(result.written, 1); assert.equal(fs.existsSync(conversationFile(b)), true);
  assert.equal(fs.existsSync(path.join(b.hub, 'registry.json')), false); assert.equal(fs.existsSync(path.join(root, '.context-room')), false); assert.equal(fs.existsSync(path.join(b.review, 'authority.key')), false);
});

test('restored notebook and conversation read back', t => {
  const lab = laboratory(t), a = lab.world('a'), b = lab.world('b'), root = lab.project('one'), data = lab.populate(a, root);
  const before = readNotebook(root, data.scene.resourceId), { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  b.enter(); fs.rmSync(path.join(root, '.context-room'), { recursive: true }); fs.rmSync(path.join(root, 'docs/Sketch.crnb'));
  const preview = previewRestore(output); assert.equal(preview.conflict, 0); assert.ok(preview.create >= 6);
  const result = applyRestore(output, { expectedRevision: preview.revision }); assert.equal(result.applied, true);
  assert.deepEqual(readNotebook(root, data.scene.resourceId), before); assert.equal(fs.statSync(path.join(root, 'docs/Sketch.crnb')).mode & 0o777, 0o644);
  const sessions = new AssistantSessions({ root: b.assistant, resolveSource });
  assert.equal(sessions.read(data.conversationId).origin.source.path, 'docs/Scene.crnb'); sessions.close?.();
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.hub, 'registry.json'), 'utf8')).projects[0].root, root);
  const again = previewRestore(output); assert.equal(again.create, 0); assert.equal(again.conflict, 0); assert.equal(again.same, preview.create);
});

test('restored review receipts still verify with the restored authority key', t => {
  const lab = laboratory(t), a = lab.world('a'), b = lab.world('b'), root = lab.project('one'), data = lab.populate(a, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  b.enter();
  const empty = createReviewReceiptStore('synthetic-domain', { authorityHome: b.review });
  assert.equal(empty.verify(data.record), false, 'a different key cannot verify it');
  const preview = previewRestore(output, { only: 'review' }); applyRestore(output, { only: 'review', expectedRevision: preview.revision });
  const restored = createReviewReceiptStore('synthetic-domain', { authorityHome: b.review });
  const record = JSON.parse(fs.readFileSync(restored.pathFor(data.receiptName), 'utf8'));
  assert.equal(restored.verify(record), true); assert.equal(fs.statSync(path.join(b.review, 'authority.key')).mode & 0o777, 0o600);
  assert.equal(restored.verify({ ...record, decision: 'rejected' }), false);
});

test('a failed write puts the files already written back', t => {
  const lab = laboratory(t), a = lab.world('a'), root = lab.project('one'); lab.populate(a, root);
  const { output } = writeBackup({ output: path.join(lab.base, 'b1') });
  fs.writeFileSync(conversationFile(a), 'edited\n'); fs.rmSync(path.join(a.review, 'authority.key'));
  const preview = previewRestore(output, { replace: true }), snapshot = new Map([...tree(lab.base)].filter(([file]) => !file.includes(`${path.sep}backups${path.sep}`)));
  assert.throws(() => applyRestore(output, { replace: true, expectedRevision: preview.revision }, { checkpoint(name, index) { if (name === 'before-write' && index === 1) throw Object.assign(new Error('disk full'), { code: 'EFBIG' }); } }), /disk full.*put back/);
  assert.deepEqual(new Map([...tree(lab.base)].filter(([file]) => !file.includes(`${path.sep}backups${path.sep}`))), snapshot);
});

test('backup and restore run through the CLI with preview then --apply --revision', t => {
  const lab = laboratory(t), a = lab.world('a'), b = lab.world('b'), root = lab.project('one'); lab.populate(a, root);
  const run = (world, args) => { const result = spawnSync(process.execPath, [cli, ...args], { cwd: lab.base, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: lab.base, CONTEXT_ROOM_HUB_HOME: world.hub, CONTEXT_ROOM_ASSISTANT_HOME: world.assistant, CONTEXT_ROOM_SHARED_HOME: world.shared, CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: world.review, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const text = result.stdout || result.stderr; let json = null; try { json = JSON.parse(text); } catch {} return { ...result, json, text }; };
  const output = path.join(lab.base, 'cli-backup');
  const plan = run(a, ['backup', '--plan']); assert.equal(plan.status, 0); assert.equal(plan.json.data.applied, false); assert.equal(fs.existsSync(output), false);
  const made = run(a, ['backup', '--output', output]); assert.equal(made.status, 0); assert.equal(made.json.ok, true); assert.deepEqual(made.json.data.containsSecrets, ['review/authority.key']);
  assert.match(run(a, ['backup', '--output', output, '--format', 'human']).text, /already exists/);
  assert.equal(run(a, ['backup']).status, 2);
  fs.rmSync(path.join(root, '.context-room'), { recursive: true });
  const preview = run(b, ['restore', output]); assert.equal(preview.status, 0); assert.equal(preview.json.data.applied, false); assert.ok(preview.json.data.create >= 4);
  assert.equal(fs.existsSync(conversationFile(b)), false);
  const human = run(b, ['restore', output, '--format', 'human']); assert.match(human.text, /Restore preview/); assert.match(human.text, new RegExp(`--apply --revision ${preview.json.data.revision}`));
  const refused = run(b, ['restore', output, '--apply']); assert.equal(refused.status, 1); assert.equal(refused.json.error.code, 'restore-revision-required');
  const unknown = run(b, ['restore', output, '--bogus']); assert.equal(unknown.status, 2);
  const applied = run(b, ['restore', output, '--apply', '--revision', preview.json.data.revision]); assert.equal(applied.status, 0); assert.equal(applied.json.data.applied, true);
  assert.equal(fs.existsSync(conversationFile(b)), true);
  const after = run(b, ['restore', output]); assert.equal(after.json.data.create, 0); assert.equal(after.json.data.conflict, 0);
  assert.equal(run(b, ['restore', output, '--apply', '--revision', preview.json.data.revision]).json.error.code, 'restore-stale');
  fs.writeFileSync(conversationFile(b), 'edited\n');
  const conflicted = run(b, ['restore', output]).json.data; assert.equal(conflicted.conflict, 1);
  assert.equal(run(b, ['restore', output, '--apply', '--revision', conflicted.revision]).json.error.code, 'restore-conflicts');
  const replaced = run(b, ['restore', output, '--replace']).json.data;
  assert.equal(run(b, ['restore', output, '--apply', '--replace', '--revision', replaced.revision]).json.data.replaced, 1);
});
