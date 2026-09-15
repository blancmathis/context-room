import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLisiereConnector, inspectLisiereSession, migrateLisiereSession } from '../src/lisiere_connector.mjs';
import { readNotebook, mutateNotebook } from '../src/notebooks.mjs';
import { notebookHash } from '../src/notebook_io.mjs';
import { NOTEBOOK_VERSION } from '../src/notebook_protocol.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const SOURCE = { path: 'docs/drawing.png', proposal: 'proposal', revision: 'exact' };
const ID = '10000000-0000-4000-a000-000000000001';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-native-drawing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, 'docs'));
  const canWrite = rel => /^docs\/[a-z-]+\.crnb$/.test(rel);
  return { root, canWrite, connector: createLisiereConnector({ canWrite }) };
}
function edit(root, scene, id = 'human-ink') {
  return mutateNotebook(root, { protocolVersion: NOTEBOOK_VERSION, resourceId: scene.resourceId, operationId: id,
    locationRevision: scene.locator.revision, edits: [{ id, kind: 'put', expectedRevision: 0,
      object: { type: 'ink', points: [[0, 0, .3], [1, 1, .8]], color: '#000000', strokeWidth: .2 } }] },
  { actor: { kind: 'human', id: 'reviewer' }, canWrite: () => true });
}
function legacy(root, { unknownAsset = false, malformed = false } = {}) {
  const directory = path.join(root, '.context-room/lisiere/sessions', ID);
  fs.mkdirSync(path.join(directory, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'workspace/source.png'), PNG);
  fs.writeFileSync(path.join(directory, 'preview-2.png'), PNG);
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify({ id: ID, boardId: ID, source: SOURCE, title: 'Original drawing', projectId: 'legacy-project', state: 'ready',
    directory: '/original/legacy/location', width: 1, height: 1 }));
  fs.writeFileSync(path.join(directory, 'board-2.json'), JSON.stringify({ id: ID, revision: 2, objects: [
    { id: 'background', revision: 1, type: 'image', assetId: unknownAsset ? 'a'.repeat(64) : notebookHash(PNG), x: 0, y: 0, w: 1, h: 1 },
    { id: 'original-ink', ...(malformed ? {} : { revision: 2 }), type: 'ink', points: [[0, 0, .25], [1, 1, .75]], width: .2 },
  ] }));
  return directory;
}

test('the compatibility bridge uses real native editable notebooks without any legacy executable or service', async t => {
  const { root, canWrite } = fixture(t);
  let legacyCalls = 0;
  const connector = createLisiereConnector({ canWrite, command: '/must-not-execute', call: () => { legacyCalls++; throw new Error('No legacy transport'); } });
  const capabilities = await connector.status(); assert.equal(capabilities.available, true); assert.equal(capabilities.native, true); assert.equal(capabilities.legacyRuntimeRequired, false);
  const request = { source: SOURCE, bytes: PNG, title: 'Drawing', destination: 'docs/drawing.crnb' };
  const prepared = await connector.prepare(root, request);
  assert.equal(prepared.automaticTabletNavigation, false); assert.equal(prepared.accepted, false);
  assert.equal(fs.existsSync(path.join(root, SOURCE.path)), false); assert.equal(fs.existsSync(path.join(root, request.destination)), false);
  const first = readNotebook(root, prepared.resourceId); assert.equal(first.document.objects[0].createdBy.kind, 'import');
  edit(root, first);
  const imported = await connector.read(root, prepared.id, SOURCE);
  assert.equal(imported.native, true); assert.equal(imported.accepted, false); assert.equal(imported.boardRevision, 2);
  assert.match(imported.svg, /viewBox="0 0 1 1"/); assert.match(imported.svg, /human-ink/);
  assert.equal(notebookHash(fs.readFileSync(path.join(root, imported.editableSource))), imported.snapshotHash);
  assert.equal(readNotebook(root, prepared.resourceId).document.objects[1].createdBy.kind, 'human');
  const repeated = await connector.prepare(root, request); assert.equal(repeated.id, prepared.id); assert.equal(repeated.replayed, true);
  assert.equal(readNotebook(root, prepared.resourceId).document.objects.length, 2);
  assert.equal(legacyCalls, 0);
  await assert.rejects(connector.read(root, prepared.id, { ...SOURCE, revision: 'newer' }), /different document revision/);
});

test('native preparation refuses missing scope, occupied destinations, altered originals and newer source bindings', async t => {
  const { root, connector } = fixture(t), input = { source: SOURCE, bytes: PNG, destination: 'docs/drawing.crnb' };
  await assert.rejects(createLisiereConnector().prepare(root, input), /outside the editable/);
  assert.equal(fs.existsSync(path.join(root, '.context-room')), false);
  fs.writeFileSync(path.join(root, input.destination), 'newer content');
  await assert.rejects(connector.prepare(root, input), /occupied/); assert.equal(fs.readFileSync(path.join(root, input.destination), 'utf8'), 'newer content');
  fs.unlinkSync(path.join(root, input.destination));
  const prepared = await connector.prepare(root, input);
  await assert.rejects(connector.prepare(root, { ...input, source: { ...SOURCE, revision: 'later' } }), /occupied/);
  const original = path.join(root, '.context-room/lisiere/sessions', prepared.id, 'workspace/source.png');
  fs.writeFileSync(original, 'changed');
  await assert.rejects(connector.read(root, prepared.id, SOURCE), /retained original image changed/);
  await assert.rejects(connector.prepare(root, { ...input, destination: '../escape.crnb' }));
});

test('legacy session inventory never guesses a frame or continues the old task', async t => {
  const { root, connector, canWrite } = fixture(t), directory = legacy(root);
  const sourceBytes = fs.readFileSync(path.join(directory, 'session.json'));
  const inventory = inspectLisiereSession(root, ID);
  assert.deepEqual(inventory.candidates.map(row => row.frame), ['source', 'board:2', 'preview:2']);
  assert.equal(inventory.accepted, false); assert.equal(inventory.delivery, 'not-inferred');
  await assert.rejects(connector.read(root, ID, SOURCE), { code: 'lisiere_session_recovery' });
  assert.throws(() => migrateLisiereSession(root, { sessionId: ID, path: 'docs/recovered.crnb' }, { canWrite }), /exact --session-frame/);
  const options = { sessionId: ID, frame: 'board:2', path: 'docs/recovered.crnb' };
  const plan = migrateLisiereSession(root, options, { canWrite }); assert.equal(plan.structured, true); assert.equal(plan.objects, 2);
  assert.equal(fs.existsSync(path.join(root, '.context-room/notebooks')), false);
  const applied = migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite });
  assert.equal(applied.applied, true); assert.equal(applied.accepted, false); assert.equal(applied.legacyTaskChanged, false);
  const scene = readNotebook(root, applied.resourceId); assert.equal(scene.document.objects.length, 2);
  assert.ok(scene.document.objects.every(object => object.createdBy.kind === 'import'));
  assert.equal(scene.document.objects[1].points[0][2], .25);
  edit(root, scene, 'recent-work');
  assert.equal(migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite }).replayed, true);
  assert.equal(readNotebook(root, applied.resourceId).document.objects.length, 3);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'session.json')), sourceBytes);
  assert.equal(fs.existsSync(path.join(root, options.path)), false);
});

test('missing legacy assets or revisions require reconciliation; explicit raster recovery retains original board bytes', t => {
  const { root, canWrite } = fixture(t); legacy(root, { unknownAsset: true });
  const options = { sessionId: ID, path: 'docs/recovered.crnb', frame: 'board:2' };
  assert.throws(() => migrateLisiereSession(root, options, { canWrite }), /exact asset/);
  options.frame = 'preview:2';
  const plan = migrateLisiereSession(root, options, { canWrite }); assert.equal(plan.structured, false);
  const applied = migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite });
  assert.equal(readNotebook(root, applied.resourceId).document.objects.length, 1);
  assert.equal(fs.existsSync(path.join(root, '.context-room/lisiere/sessions', ID, 'board-2.json')), true);
});

test('legacy frame tampering, symlink substitution, destination conflicts and interrupted recovery never replace newer work', t => {
  const { root, canWrite } = fixture(t), directory = legacy(root);
  const options = { sessionId: ID, frame: 'source', path: 'docs/recovered.crnb' }, plan = migrateLisiereSession(root, options, { canWrite });
  assert.throws(() => migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite, beforeWrite: () => { throw new Error('synthetic interruption'); } }), /synthetic interruption/);
  assert.equal(fs.existsSync(path.join(root, options.path)), false);
  const applied = migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite }); assert.equal(applied.applied, true);
  const sessionPath = path.join(directory, 'session.json'), original = fs.readFileSync(sessionPath);
  fs.writeFileSync(sessionPath, original.toString().replace('Original drawing', 'Different drawing'));
  assert.throws(() => migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite }));
  fs.writeFileSync(sessionPath, original);
  const frame = path.join(directory, 'preview-2.png'); fs.unlinkSync(frame); fs.symlinkSync(path.join(directory, 'workspace/source.png'), frame);
  assert.throws(() => inspectLisiereSession(root, ID), /Linked and special files are not permitted/);
  assert.throws(() => inspectLisiereSession(root, '../escape'));
  assert.equal(readNotebook(root, applied.resourceId).document.objects.length, 1);
});

test('unknown structured object revisions remain an explicit recovery instead of being invented', t => {
  const { root, canWrite } = fixture(t); legacy(root, { malformed: true });
  assert.throws(() => migrateLisiereSession(root, { sessionId: ID, frame: 'board:2', path: 'docs/recovered.crnb' }, { canWrite }), /exact identity or revision/);
  assert.equal(fs.existsSync(path.join(root, 'docs/recovered.crnb')), false);
});

test('retained structured deletions have explicit tombstones rather than resurrected objects', t => {
  const { root, canWrite } = fixture(t), directory = legacy(root), file = path.join(directory, 'board-2.json');
  const board = JSON.parse(fs.readFileSync(file)); board.objects[1] = { id: 'original-ink', revision: 2, deleted: true, value: null };
  fs.writeFileSync(file, JSON.stringify(board));
  const options = { sessionId: ID, frame: 'board:2', path: 'docs/recovered.crnb' }, plan = migrateLisiereSession(root, options, { canWrite });
  const applied = migrateLisiereSession(root, { ...options, apply: true, expectedRevision: plan.revision }, { canWrite });
  const scene = readNotebook(root, applied.resourceId);
  assert.equal(scene.document.objects.length, 1); assert.equal(Object.keys(scene.tombstones).length, 1);
});

test('native PNG cropping validates exact finite bounds while full editable export is unchanged', async t => {
  const { root, connector } = fixture(t);
  const prepared = await connector.prepare(root, { source: SOURCE, bytes: PNG, destination: 'docs/drawing.crnb' });
  const { notebookSvg } = await import('../src/notebook_render.mjs'), scene = readNotebook(root, prepared.resourceId);
  assert.match(notebookSvg(scene.document), /viewBox="-25 -25 1225 925"/);
  assert.match(notebookSvg(scene.document, { bounds: { x: -1, y: -2, width: 320, height: 180 } }), /viewBox="-1 -2 320 180"/);
  for (const width of [0, -1, Infinity, NaN, '10', 10000001]) assert.throws(() => notebookSvg(scene.document, { bounds: { x: 0, y: 0, width, height: 1 } }));
});
