import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attestLocation, observeLocation, acceptsRootIdentity, rootIdentityAliases } from '../../src/location_attestation.mjs';
import { canonicalNotebookRoot, notebookHash, readNotebookJson, stableNotebookJson } from '../../src/notebook_io.mjs';
import { openNotebook, readNotebook, mutateNotebook, notebookReceipt, importNotebookDraft } from '../../src/notebooks.mjs';
import { emptyNotebook } from '../../src/notebook_protocol.mjs';
import { AssistantSessions } from '../../src/assistant_sessions.mjs';
import { beginLocalProposal, submitLocalProposal, inspectLocalProposal } from '../../src/local_proposals.mjs';
import { planStateMigration, applyStateMigration } from '../../src/state_migration.mjs';
import { createDeviceAuthority } from '../../src/device_authority.mjs';

const [action, base, change = '{}'] = process.argv.slice(2);
const root = path.join(base, 'project'), store = path.join(base, 'conversations'), stateRoot = path.join(base, 'devices');
const altered = JSON.parse(change);
// Change the filesystem observations in this process, never the comparator or serialized evidence.
for (const method of ['lstatSync', 'statSync', 'fstatSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const stats = original(...args);
    if (!stats) return stats; // lstat(..., {throwIfNoEntry:false}) preserves absent-control-file behavior.
    const amount = value => typeof stats.dev === 'bigint' ? BigInt(value) : Number(value);
    if (altered.dev) stats.dev += amount(altered.dev);
    if (args[0] === root) {
      if (altered.ino) stats.ino += amount(altered.ino);
      if (altered.birth && typeof stats.birthtimeNs === 'bigint') stats.birthtimeNs += BigInt(altered.birth);
      if (altered.missingBirth && typeof stats.birthtimeNs === 'bigint') stats.birthtimeNs = 0n;
    }
    return stats;
  };
}
const manifestPath = path.join(base, 'manifest.json');
const sessions = new AssistantSessions({ root: store,
  resolveSource: (_root, source) => ({ source, title: 'Retained source', tools: [], context: {} }),
  providerFactory: () => { throw new Error('A reader must never start Codex.'); } });
const authority = () => createDeviceAuthority({ stateRoot, serverId: 'fixture-server', now: () => 1000 });
const source = { kind: 'document', path: 'docs/a.md' };
const archiveBytes = Buffer.from(stableNotebookJson({ version: 1, original: { conversation: { id: 'old-conversation', thread: 'old-thread' } },
  messages: [{ role: 'user', text: 'Retained message' }] }) + '\n');
const legacy = { hash: notebookHash(archiveBytes), messageCount: 1, originalConversationId: 'old-conversation', originalThreadId: 'old-thread' };
const importInput = { path: 'docs/Imported.crnb', requestId: 'retained-import', sourceRevision: 'a'.repeat(64),
  document: emptyNotebook('retained-imported-scene', 'Imported drawing') };

if (action === 'create') {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'Original document\n');
  const scene = openNotebook(root, { path: 'docs/Scene.crnb', id: 'retained-scene', canWrite: () => true });
  for (let i = 0; i < 3; i++) mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId,
    operationId: `initial-${i}`, locationRevision: scene.locator.revision,
    edits: [{ kind: 'put', id: `shape-${i}`, expectedRevision: 0, object: { type: 'rect', x: i, y: i } }] },
  { actor: { kind: 'human', id: 'fixture' }, canWrite: () => true });
  const first = sessions.create(root, { source });
  sessions.create(root, { source });
  const requestId = randomUUID();
  const imported = sessions.importRetainedConversation(root, { requestId, source, legacy, archiveBytes });
  sessions.update(first.id, state => {
    state.operation = { id: 'uncertain-turn', status: 'uncertain', error: 'Preserve this uncertain turn' };
  });
  const cursor = sessions.history(root, { source, limit: 1 }).pagination.nextCursor;
  const importedNotebook = importNotebookDraft(root, importInput, { canWrite: () => true });
  mutateNotebook(root, { protocolVersion: 1, resourceId: importedNotebook.resourceId, operationId: 'after-import',
    locationRevision: importedNotebook.locator.revision, edits: [{ kind: 'put', id: 'retained-shape', expectedRevision: 0,
      object: { type: 'rect', x: 2, y: 3 } }] }, { actor: { kind: 'human', id: 'fixture' }, canWrite: () => true });
  const proposal = beginLocalProposal(root, { title: 'Retained draft', allowedPaths: ['docs/'],
    files: [{ path: 'docs/a.md', content: Buffer.from('Original document\n') }] });
  fs.writeFileSync(path.join(proposal.editRoot, 'docs/a.md'), 'Pending document\n');
  const submitted = submitLocalProposal(root, proposal.id);
  const plan = planStateMigration(root); applyStateMigration(root, { expectedRevision: plan.revision });
  const journalPath = path.join(root, '.context-room/migrations/workflow-v1/journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath)); journal.status = 'preparing';
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  const deviceAuthority = authority();
  const ticket = deviceAuthority.createPairing({ grants: [{ mode: 'draw', projectId: 'a'.repeat(24), root,
    rootIdentity: canonicalNotebookRoot(root), paths: ['docs/Scene.crnb'] }], label: 'Fixture tablet' });
  const device = deviceAuthority.pair({ ...ticket, protocolVersion: 1 });
  fs.writeFileSync(manifestPath, JSON.stringify({ scene, importedNotebook, first: first.id, imported: imported.id, cursor,
    proposal: proposal.id, submittedRevision: submitted.submittedRevision, device, legacyIdentity: canonicalNotebookRoot(root), storeIdentity: canonicalNotebookRoot(store) }));
} else if (action === 'attest') {
  const record = attestLocation(root);
  attestLocation(store); // History cursors also include the private store identity.
  assert.equal(record.aliases.observed.length, 1); assert.deepEqual(record.aliases.confirmed, []);
} else if (action === 'confirm') {
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  attestLocation(root, { legacy: manifest.legacyIdentity });
  attestLocation(store, { legacy: manifest.storeIdentity });
} else if (action === 'observe') {
  assert.deepEqual(observeLocation(root), { status: 'same', added: true });
  assert.deepEqual(observeLocation(store), { status: 'same', added: true });
} else if (action === 'read' || action === 'read-confirmed' || action === 'blocked') {
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const readers = [
    () => readNotebook(root, manifest.scene.resourceId),
    () => sessions.get(root, manifest.first),
    () => inspectLocalProposal(root, manifest.proposal),
    () => planStateMigration(root),
  ];
  if (action === 'blocked') {
    for (const read of readers) assert.throws(read);
    assert.equal(sessions.list(root).length, 0);
    assert.equal(authority().authenticate(manifest.device.token).grants[0].rootIdentity, manifest.legacyIdentity);
    assert.notEqual(canonicalNotebookRoot(root), manifest.legacyIdentity);
    assert.notEqual(acceptsRootIdentity(root, manifest.legacyIdentity), 'alias');
  } else {
    const [scene, conversation, proposal, migration] = readers.map(read => read());
    assert.equal(scene.sequence, 3); assert.equal(scene.document.objects.length, 3);
    assert.equal(scene.locator.revision, manifest.scene.locator.revision);
    assert.equal(notebookReceipt(root, scene.resourceId, 'initial-2').status, 'confirmed');
    const replay = importNotebookDraft(root, importInput, { canWrite: () => true });
    assert.equal(replay.replayed, true); assert.equal(replay.document.objects.length, 1);
    assert.deepEqual(replay.imported, manifest.importedNotebook.imported);
    assert.equal(replay.locator.revision, manifest.importedNotebook.locator.revision);
    assert.throws(() => importNotebookDraft(root, { ...importInput, sourceRevision: 'b'.repeat(64) }, { canWrite: () => true }), { code: 'notebook_location_conflict' });
    assert.equal(conversation.operation.status, 'uncertain'); assert.equal(conversation.threadId, null);
    assert.equal(sessions.list(root).length, 3);
    assert.equal(sessions.history(root, { source, cursor: manifest.cursor, limit: 1 }).conversations.length, 1);
    const imported = sessions.importRetainedConversation(root, { requestId: manifest.imported, source, legacy, archiveBytes });
    assert.equal(imported.id, manifest.imported);
    assert.equal(sessions.legacyHistory(root, manifest.imported).messages[0].text, 'Retained message');
    assert.throws(() => sessions.importRetainedConversation(root, { requestId: manifest.imported,
      source: { ...source, path: 'docs/other.md' }, legacy, archiveBytes }), { code: 'assistant_request_conflict' });
    assert.equal(proposal.submittedRevision, manifest.submittedRevision); assert.equal(migration.migrated, true);
    const granted = authority().authenticate(manifest.device.token);
    assert.equal(granted.grants[0].rootIdentity, action === 'read-confirmed' ? manifest.legacyIdentity : canonicalNotebookRoot(root));
    assert.deepEqual(granted.grants[0].paths, ['docs/Scene.crnb']); assert.equal(granted.expiresAt, manifest.device.device.expiresAt);
    assert.equal(acceptsRootIdentity(root, manifest.legacyIdentity), action === 'read-confirmed' ? 'confirmed' : altered.dev ? 'alias' : 'same');
    assert.ok(rootIdentityAliases(root).includes(manifest.legacyIdentity));
  }
} else if (action === 'recover-workflow') {
  assert.equal(applyStateMigration(root).idempotent, true);
  assert.equal(readNotebookJson(root, '.context-room/migrations/workflow-v1/journal.json').recovered, true);
} else throw new Error('Unknown fixture action');
await sessions.close();
process.stdout.write('ok\n');
