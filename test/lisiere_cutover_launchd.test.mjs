// Opt-in essay on the REAL launchd user domain (gui/<uid>) with a throwaway
// test.contextroom.synthetic-<nonce> agent. Never run by `npm test` or Linux CI:
//   CONTEXT_ROOM_LAUNCHD_ESSAY=1 node --test --test-concurrency=1 test/lisiere_cutover_launchd.test.mjs
// Optional CONTEXT_ROOM_LAUNCHD_ESSAY_LOG=<file> appends one JSON line per step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { reconciliationFixture } from './fixtures/lisiere-reconciliation.mjs';
import { projectWriterAuthority } from '../src/writer_authority.mjs';

const enabled = process.platform === 'darwin' && process.env.CONTEXT_ROOM_LAUNCHD_ESSAY === '1';
const skip = enabled ? false : 'macOS launchd essay: set CONTEXT_ROOM_LAUNCHD_ESSAY=1 on a Mac';
const PREFIX = '/private/tmp/cr-launchd-essay-';
const REAL_SERVICES = ['app.contextroom.local', 'fr.lisiere.companion', 'fr.lisiere.updates'];
const cli = fileURLToPath(new URL('../bin/context-room.mjs', import.meta.url));
const helper = fileURLToPath(new URL('../src/mac_legacy_quiescence.py', import.meta.url));
const renamer = fileURLToPath(new URL('../src/exclusive_rename.py', import.meta.url));
const uid = process.getuid?.();
const domain = `gui/${uid}`;

function log(t, step, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), test: t.name, step, ...detail });
  t.diagnostic(line);
  if (process.env.CONTEXT_ROOM_LAUNCHD_ESSAY_LOG) fs.appendFileSync(process.env.CONTEXT_ROOM_LAUNCHD_ESSAY_LOG, line + '\n');
}
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, ...options });
const launchctl = (...args) => run('/bin/launchctl', args);
function launchdList() {
  const listed = launchctl('list'); assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\n').map(line => line.split('\t')).filter(fields => fields.length === 3);
}
const realPids = () => Object.fromEntries(REAL_SERVICES.map(label => [label, launchdList().find(fields => fields[2] === label)?.[0] ?? null]));

async function essay(t) {
  const nonce = randomBytes(6).toString('hex'), label = 'test.contextroom.synthetic-' + nonce;
  assert.match(label, /^test\.contextroom\.synthetic-[a-f0-9]{12}$/);
  const base = fs.mkdtempSync(PREFIX); fs.chmodSync(base, 0o700);
  assert.ok(base.startsWith(PREFIX) && fs.realpathSync(base) === base);
  const home = path.join(base, 'home'), source = path.join(home, '.local/share/lisiere/workspace');
  const plist = path.join(home, 'Library/LaunchAgents', label + '.plist'), agentDir = path.join(base, 'agent');
  const project = path.join(base, 'project'), module = 'contextroom_synthetic_' + nonce;
  const env = { ...process.env, HOME: home, CONTEXT_ROOM_HUB_HOME: path.join(base, 'hub'), CONTEXT_ROOM_SHARED_HOME: path.join(base, 'shared'),
    CONTEXT_ROOM_ASSISTANT_HOME: path.join(base, 'assistant'), CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT: nonce };
  const before = realPids();
  t.after(() => {
    // E12: unload, re-enable (launchd keeps an `enabled` override for the label), remove only our directory.
    const out = launchctl('bootout', `${domain}/${label}`), enable = launchctl('enable', `${domain}/${label}`);
    if (base.startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true });
    const leftovers = launchdList().filter(fields => fields[2].includes(nonce)), after = realPids();
    log(t, 'E12', { bootout: out.status, enable: enable.status, leftovers: leftovers.length, before, after });
    assert.deepEqual(leftovers, []); assert.deepEqual(after, before);
  });
  return { nonce, label, base, home, source, plist, agentDir, project, module, env, before,
    cli: (args, { ok = true, synthetic = true } = {}) => {
      const childEnv = { ...env }; if (!synthetic) delete childEnv.CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT;
      const result = run(process.execPath, [cli, ...args, '--format', 'json'], { cwd: base, env: childEnv });
      let json = null; for (const text of [result.stdout, result.stderr]) { try { json = JSON.parse(text); break; } catch {} }
      if (ok) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      else assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
      return { ...result, json, message: json?.error?.message || result.stderr };
    } };
}

async function exportSnapshot(e, sourceDir, output) {
  const preview = e.cli(['migrate', '--export-lisiere', sourceDir, '--output', output]).json.data;
  e.cli(['migrate', '--export-lisiere', sourceDir, '--output', output, '--apply', '--revision', preview.revision]);
  return preview.revision;
}

async function prepare(t, e) {
  // E0
  assert.notEqual(e.home, os.userInfo().homedir);
  assert.deepEqual(launchdList().filter(fields => fields[2].includes(e.nonce)), []);
  log(t, 'E0', { label: e.label, realPids: e.before });
  // E1
  const absent = launchctl('print', `${domain}/${e.label}`);
  assert.notEqual(absent.status, 0); assert.match(absent.stderr, /Could not find service/);
  const disabled = launchctl('print-disabled', domain); assert.equal(disabled.status, 0);
  log(t, 'E1', { printStatus: absent.status, printStderr: absent.stderr.trim().slice(0, 200),
    printDisabledSample: disabled.stdout.split('\n').find(line => /fr\.lisiere\.|=>/.test(line))?.trim() });
  // E2: synthetic WAL fixture at the standard path, CLI export, registered project.
  fs.mkdirSync(e.home, { recursive: true, mode: 0o700 });
  await reconciliationFixture(e.base, { macSource: e.source }); fs.chmodSync(e.source, 0o700);
  const r0 = await exportSnapshot(e, e.source, path.join(e.base, 'mac-snapshot-cli'));
  fs.mkdirSync(path.join(e.project, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q', e.project]);
  const init = run(process.execPath, [cli, 'init', '--root', e.project], { cwd: e.base, env: e.env }); assert.equal(init.status, 0, init.stderr);
  e.cli(['project', 'register', '--root', e.project]);
  log(t, 'E2', { r0 });
  // E3: a faithful stand-in for the companion: WAL connection held open, KeepAlive, log inside the workspace.
  fs.mkdirSync(e.agentDir, { mode: 0o700 });
  fs.writeFileSync(path.join(e.agentDir, e.module + '.py'), `import os, signal, sqlite3, sys, time
DB = ${JSON.stringify(path.join(e.source, 'workspace.sqlite'))}
AGENT = ${JSON.stringify(e.agentDir)}
connection = sqlite3.connect(DB)
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('SELECT count(*) FROM boards').fetchone()
def stop(signum, frame):
    if os.path.exists(os.path.join(AGENT, 'write-on-term')):
        connection.execute("INSERT INTO boards VALUES(?,?,NULL,NULL,1,'')", ('written-while-stopping-' + str(time.time_ns()), 'Saved during shutdown'))
        connection.commit()
    connection.close()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
with open(os.path.join(AGENT, 'pid.tmp'), 'w') as handle:
    handle.write(str(os.getpid()))
os.replace(os.path.join(AGENT, 'pid.tmp'), os.path.join(AGENT, 'pid'))
while True:
    time.sleep(3600)
`);
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(path.dirname(e.plist), { recursive: true, mode: 0o700 });
  execFileSync('python3', ['-B', '-c', `import plistlib,sys,json
body = json.loads(sys.argv[2])
open(sys.argv[1], 'wb').write(plistlib.dumps(body))`, e.plist, JSON.stringify({ Label: e.label, ProgramArguments: [python, '-m', e.module],
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10, StandardOutPath: path.join(e.source, 'service.log'),
    StandardErrorPath: path.join(e.source, 'service.log'), EnvironmentVariables: { PYTHONPATH: e.agentDir } })]);
  fs.chmodSync(e.plist, 0o600);
  return { r0, python };
}

async function start(t, e, step) {
  fs.rmSync(path.join(e.agentDir, 'pid'), { force: true });
  const loaded = launchctl('bootstrap', domain, e.plist); assert.equal(loaded.status, 0, loaded.stderr);
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = launchctl('print', `${domain}/${e.label}`);
    if (/state = running/.test(status.stdout) && fs.existsSync(path.join(e.agentDir, 'pid'))) {
      const pid = Number(fs.readFileSync(path.join(e.agentDir, 'pid'), 'utf8'));
      log(t, step, { state: 'running', pid }); return pid;
    }
    await delay(250);
  }
  assert.fail('The synthetic agent did not reach state = running within 10 s.');
}

function assertStopped(e, pid) {
  const disabled = launchctl('print-disabled', domain).stdout.split('\n').find(line => line.includes(`"${e.label}"`))?.trim();
  assert.match(disabled || '', /=>\s*(?:true|disabled)\b/);
  const status = launchctl('print', `${domain}/${e.label}`); assert.notEqual(status.status, 0); assert.match(status.stderr, /Could not find service/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return disabled;
}

const rows = (database, table = 'boards') => Number(execFileSync('python3', ['-B', '-c', `import sqlite3,sys
print(sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True).execute('SELECT count(*) FROM ' + sys.argv[2]).fetchone()[0])`, database, table], { encoding: 'utf8' }));

test('launchd synthetic cutover, rollback and resume leave real services untouched', { skip, timeout: 300000 }, async t => {
  const e = await essay(t), { r0 } = await prepare(t, e);
  const pid = await start(t, e, 'E3');
  // E4: the held WAL connection is visible; lsof must report it without warnings.
  const closed = run('python3', ['-B', helper, 'closed-files', '--source', e.source], { cwd: e.base });
  assert.equal(closed.status, 1); assert.match(closed.stderr, /file is open/);
  const lsof = run('/usr/sbin/lsof', ['-F', 'p', '+D', e.source], { cwd: e.base });
  log(t, 'E4', { closedFiles: closed.stderr.trim(), lsofStatus: lsof.status, lsofStderr: lsof.stderr.trim().slice(0, 300), pids: lsof.stdout.trim().split('\n') });
  assert.equal(lsof.stderr.trim(), '', 'lsof warnings would block the real cutover');
  // E5: without the nonce the helper never accepts a temporary HOME.
  const args = ['migrate', '--root', e.project, '--cutover-lisiere', e.source, '--mac-snapshot', path.join(e.base, 'mac-snapshot'), '--legacy-plist', e.plist];
  const refused = e.cli(args, { ok: false, synthetic: false });
  assert.match(refused.message, /account home directory|exact original/);
  assert.match(launchctl('print', `${domain}/${e.label}`).stdout, /state = running/);
  assert.equal(fs.existsSync(path.join(e.home, 'Library/LaunchAgents/fr.lisiere.companion.plist')), false);
  log(t, 'E5', { refused: refused.message.trim().slice(0, 200) });
  // E6
  const plan = e.cli(args).json.data;
  assert.equal(plan.service.label, e.label); assert.equal(plan.service.synthetic, true); assert.equal(plan.completed, false);
  log(t, 'E6', { r1: plan.revision, label: plan.service.label });
  // E7
  const applied = e.cli([...args, '--apply', '--revision', plan.revision]).json.data;
  assert.equal(applied.completed, true); assert.equal(applied.mode, 'context-room');
  const disabledLine = assertStopped(e, pid);
  assert.equal(rows(path.join(applied.backup, 'workspace.sqlite')), 1);
  assert.equal(fs.lstatSync(path.join(e.source, 'workspace.sqlite')).isDirectory(), true);
  assert.equal(projectWriterAuthority(e.project).mode, 'context-room');
  const retainedRevision = await exportSnapshot(e, applied.backup, path.join(e.base, 'retained-check'));
  assert.equal(retainedRevision, r0);
  log(t, 'E7', { backup: applied.backup, printDisabled: disabledLine });
  // E8
  const rollback = e.cli(['migrate', '--root', e.project, '--rollback-cutover']).json.data;
  assert.equal(e.cli(['migrate', '--root', e.project, '--rollback-cutover', '--apply', '--revision', rollback.revision]).json.data.mode, 'paused');
  log(t, 'E8', { r2: rollback.revision });
  // E9: functional return to the legacy service (plan §(c) rollback steps 2-4).
  const fence = e.source + '.context-room-fence-' + plan.revision.slice(0, 16);
  execFileSync('python3', ['-B', renamer, e.source, fence]); execFileSync('python3', ['-B', renamer, applied.backup, e.source]);
  assert.equal(launchctl('enable', `${domain}/${e.label}`).status, 0);
  const pid2 = await start(t, e, 'E9');
  fs.writeFileSync(path.join(e.agentDir, 'write-on-term'), 'synthetic work done under the legacy service\n');
  // E10: resume refuses the missing fence, then the newer retained work, until an exact export acknowledges it.
  const resumeArgs = ['migrate', '--root', e.project, '--resume-cutover'];
  assert.match(e.cli(resumeArgs, { ok: false }).message, /Restore the original fence/);
  const stopped = run('python3', ['-B', helper, 'stop', '--source', e.source, '--plist', e.plist, '--revision', plan.service.plistSha256], { cwd: e.base, env: e.env });
  assert.equal(stopped.status, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).stopped, true);
  assertStopped(e, pid2);
  execFileSync('python3', ['-B', renamer, e.source, applied.backup]); execFileSync('python3', ['-B', renamer, fence, e.source]);
  assert.match(e.cli(resumeArgs, { ok: false }).message, /newer work/);
  assert.equal(rows(path.join(applied.backup, 'workspace.sqlite')), 2);
  const snap2 = path.join(e.base, 'snap2'), r3base = await exportSnapshot(e, applied.backup, snap2);
  const resume = e.cli([...resumeArgs, '--mac-snapshot', snap2]).json.data;
  assert.deepEqual(resume.acknowledged, { snapshot: snap2, revision: r3base });
  assert.equal(e.cli([...resumeArgs, '--mac-snapshot', snap2, '--apply', '--revision', resume.revision]).json.data.mode, 'context-room');
  assert.equal(projectWriterAuthority(e.project).mode, 'context-room');
  log(t, 'E10', { r3: resume.revision, acknowledged: r3base });
});

test('launchd synthetic cutover supersedes after a write during shutdown', { skip, timeout: 300000 }, async t => {
  const e = await essay(t); await prepare(t, e);
  const pid = await start(t, e, 'E11-start');
  fs.writeFileSync(path.join(e.agentDir, 'write-on-term'), 'the companion saves while stopping\n');
  const args = ['migrate', '--root', e.project, '--cutover-lisiere', e.source, '--mac-snapshot', path.join(e.base, 'mac-snapshot'), '--legacy-plist', e.plist];
  const plan = e.cli(args).json.data;
  const refused = e.cli([...args, '--apply', '--revision', plan.revision], { ok: false });
  assert.match(refused.message, /saved newer work while stopping/);
  assert.equal(fs.statSync(path.join(e.source, 'workspace.sqlite')).isFile(), true);
  assert.equal(rows(path.join(e.source, 'workspace.sqlite')), 2);
  assert.equal(projectWriterAuthority(e.project).mode, 'transition');
  assertStopped(e, pid);
  const snap2 = path.join(e.base, 'snap2'); await exportSnapshot(e, e.source, snap2);
  const args2 = ['migrate', '--root', e.project, '--cutover-lisiere', e.source, '--mac-snapshot', snap2, '--legacy-plist', e.plist];
  const next = e.cli(args2).json.data; assert.equal(next.supersedes, plan.revision);
  const applied = e.cli([...args2, '--apply', '--revision', next.revision]).json.data;
  assert.equal(applied.completed, true); assert.equal(projectWriterAuthority(e.project).mode, 'context-room');
  assert.equal(fs.lstatSync(path.join(e.source, 'workspace.sqlite')).isDirectory(), true);
  log(t, 'E11', { refused: refused.message.trim().slice(0, 160), r1: plan.revision, superseding: next.revision });
});
