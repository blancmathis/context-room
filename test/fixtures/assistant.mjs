import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeContextRoomProject, writeMemoryWebappSettings, createMemoryServer } from '../../src/context_room.mjs';

/** Explicit synthetic provider for deterministic HTTP/browser contracts, never product fallback. */
export async function assistantFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-room-assistant-fixture-'))), root = path.join(base, 'project'), previous = {};
  for (const key of ['CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME', 'CONTEXT_ROOM_REVIEW_AUTHORITY_HOME']) { previous[key] = process.env[key]; process.env[key] = path.join(base, key); }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/Original.md'), '# Original document\n\nHuman original content.\n');
  fs.writeFileSync(path.join(root, 'docs/Other.md'), '# Other document\n\nIndependent human content.\n');
  initializeContextRoomProject(root, { title: 'Synthetic conversation contracts', allowedPaths: ['docs/'], watchAllow: ['docs/'] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  const turns = [], starts = [], resumes = []; let connections = 0;
  const provider = {
    models: [{ id: 'gpt-6-astra', name: 'Synthetic model contract', efforts: ['low', 'high'] }],
    async startThread(input) { starts.push(input); return { threadId: 'synthetic-owned-task-' + starts.length }; },
    async resumeOwnedThread(input) { resumes.push(input); return { threadId: input.threadId }; },
    async startTurn(input) { const turn = { ...input, turnId: 'synthetic-turn-' + (turns.length + 1) }; turns.push(turn); input.onEvent({ type: 'started', turnId: turn.turnId }); return { threadId: input.threadId, turnId: turn.turnId }; },
    async interrupt(threadId) { turns.findLast(turn => turn.threadId === threadId)?.onEvent({ type: 'completed', status: 'interrupted', failed: false }); },
    async close() {},
  };
  const room = createMemoryServer({ root, assistantOptions: { root: path.join(base, 'private-assistant'), providerFactory: async () => { connections++; return provider; } } });
  await new Promise(resolve => room.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${room.server.address().port}`;
  return { base, root, room, url, turns, starts, resumes, connections: () => connections,
    finish(text = 'Synthetic contract answer in the original source.') { const turn = turns.at(-1); turn.onEvent({ type: 'text', delta: text }); turn.onEvent({ type: 'completed', status: 'completed', failed: false }); },
    async post(route, body, extra = {}) {
      const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-context-room-owner-nonce': room.ownerMutationNonce, 'x-context-room-project': room.projectId, ...extra }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await new Promise(resolve => { room.server.closeAllConnections(); room.server.close(resolve); }); await room.waitForShutdown();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(base, { recursive: true, force: true });
    } };
}
