/** Real owner runtime with synthetic documents; never registers personal projects. */
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryServer, createContextRoomDeviceService, initializeContextRoomProject, writeGlobalContextRoomPreferences, writeMemoryWebappSettings } from '../../src/context_room.mjs';
import { emptyNotebook } from '../../src/notebook_protocol.mjs';
import { encodeNotebook, openNotebook, mutateNotebook } from '../../src/notebooks.mjs';
import { submitNotebookShared } from '../../src/notebook_workflow.mjs';
import { readSharedNotebookTarget } from '../../src/shared_context.mjs';
import { addNotebookSharedFixture } from '../fixtures/notebook_shared.mjs';

const [directory] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || fs.existsSync(directory)) throw new Error('Choose a new private fixture directory.');
fs.mkdirSync(directory, { mode: 0o700 });
const base = fs.realpathSync(directory), root = path.join(base, 'project');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) process.env[key] = path.join(base, key);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/Guide.md'), '# Connected owner guide\n\nThis synthetic document belongs to the Mac project.\n');
fs.writeFileSync(path.join(root, 'docs/Diagram.html'), '<!doctype html><html><head><title>Rendered diagram</title></head><body><h1>Rendered owner diagram</h1><p>HTML remains a rendered document.</p><script>window.parent.UNTRUSTED_DOCUMENT_EXECUTED = true;</script></body></html>');
fs.writeFileSync(path.join(root, 'docs/Owner.crnb'), encodeNotebook(emptyNotebook('owner-native-notebook', 'Owner notebook')));
initializeContextRoomProject(root, { title: 'Owner integration project', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
const computer = path.join(base, 'computer'); fs.mkdirSync(computer);
fs.writeFileSync(path.join(computer, 'Idea.md'), '# Synthetic unassigned idea\n');
const globalPreferencesPath = path.join(base, 'preferences.json');
writeGlobalContextRoomPreferences({ explorer: { computerRoot: computer }, sounds: { enabled: false } }, globalPreferencesPath);
addNotebookSharedFixture(root, base);
const actor = { kind: 'human', id: 'synthetic-owner' }, canWrite = value => value === 'docs/Shared.crnb';
const sharedNotebook = openNotebook(root, { id: 'owner-shared-notebook', path: 'docs/Shared.crnb', title: 'Owner Shared notebook', canWrite });
mutateNotebook(root, { protocolVersion: 1, resourceId: sharedNotebook.resourceId, operationId: 'shared-object',
  locationRevision: sharedNotebook.locator.revision, edits: [{ kind: 'put', id: 'shared-shape', expectedRevision: 0,
    object: { id: 'shared-shape', type: 'rect', x: 20, y: 20, width: 120, height: 90 } }] }, { actor, canWrite });
const sharedReceipt = submitNotebookShared(root, { protocolVersion: 1, scope: 'shared',
  target: readSharedNotebookTarget(root, 'docs/Shared.crnb'), resourceId: sharedNotebook.resourceId,
  operationId: 'shared-submission', locationRevision: sharedNotebook.locator.revision, expectedRevision: 1 }, { actor, canWrite });
const service = createContextRoomDeviceService({ root, stateRoot: path.join(base, 'devices') });
const runtime = createMemoryServer({ root, deviceService: service, registerInHub: true, globalPreferencesPath });
await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
await service.listen();
const reviewResponse = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/shared-context/review`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-context-room-project': runtime.projectId, 'x-context-room-owner-nonce': runtime.ownerMutationNonce },
  body: JSON.stringify({ proposal: sharedReceipt.proposalId, expectedHead: sharedReceipt.proposalRevision }) });
if (!reviewResponse.ok) throw new Error('Synthetic Shared review did not open: ' + reviewResponse.status);
const sharedReview = await reviewResponse.json();
const ticket = { ...service.describe(), ...service.createOwnerPairing({ label: 'Synthetic owner tablet' }),
  url: `https://10.0.2.2:${service.server.address().port}`, testProjectId: runtime.projectId,
  testSharedPath: new URL(sharedReview.url).pathname, testSharedHead: sharedReceipt.proposalRevision };
fs.writeFileSync(path.join(base, 'ticket.json'), JSON.stringify(ticket), { mode: 0o600 });
fs.writeFileSync(path.join(base, 'fixture.json'), JSON.stringify({ projectId: runtime.projectId, sourceRoot: root, serverId: service.serverId }), { mode: 0o600 });
process.stdout.write('Isolated owner fixture ready.\n');
async function close() {
  await service.close(); runtime.server.closeAllConnections();
  await new Promise(resolve => runtime.server.close(resolve)); await runtime.waitForShutdown();
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
