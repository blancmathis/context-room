import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { removeNotebookSharedFixture } from './fixtures/notebook_shared.mjs';
import { notebookHash } from '../src/notebook_io.mjs';

test('prepared Android recording fixture starts only an isolated owner service with exact synthetic PCM and no existing association or provider', { timeout: 45000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.cr-native-pcm-fixture-'))), output = path.join(base, 'fixture');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./android/owner-fixture.mjs', import.meta.url)), output], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTEXT_ROOM_TEST_RECORDING: '1', CONTEXT_ROOM_TEST_REAL_AGENT: '0', CONTEXT_ROOM_TEST_LEGACY_HISTORY: '0', CONTEXT_ROOM_TEST_TABLET_DRAFT: '0' },
  });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes.toString()).slice(-10000); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(15000, undefined, { ref: false }).then(() => { throw new Error('Owned fixture did not stop'); })]); }
    removeNotebookSharedFixture(base); });
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(path.join(output, 'fixture.json'))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Synthetic fixture failed: ' + logs);
    await delay(50);
  }
  const state = JSON.parse(fs.readFileSync(path.join(output, 'fixture.json'))), ticket = JSON.parse(fs.readFileSync(path.join(output, 'ticket.json')));
  assert.deepEqual(ticket.testRecording, state.recording); assert.equal(state.recording.bytes, 32000);
  assert.equal(notebookHash(fs.readFileSync(path.join(state.recording.source, 'workspace.sqlite'))), state.recording.sourceHash);
  assert.equal(notebookHash(fs.readFileSync(path.join(state.sourceRoot, 'docs/Guide.md'))), state.recording.documentHash);
  assert.equal(fs.existsSync(path.join(output, 'private-assistant/legacy-recordings')), false);
  assert.equal(fs.existsSync(path.join(output, 'unexpected-provider-start')), false);
  assert.equal((await fetch(state.ownerUrl + '/api/health')).status, 200);
});
