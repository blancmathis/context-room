/** Branch-only exact patch transport for a development client without Git network.
 * Tests have no write token. Publication creates an unattached commit, never a
 * branch update, merge, release, installation or personal-data migration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const repo = 'blancmathis/context-room', manifestPath = '.github/recovery-patch.json';
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== 'refs/heads/mathis/context-room-recovery-hardening-20260915') throw new Error('Wrong repository or branch.');
const token = process.env.CANDIDATE_TOKEN; delete process.env.CANDIDATE_TOKEN;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || typeof manifest.patch !== 'string' || manifest.patch.length > 12 * 1024 * 1024 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 200) throw new Error('Invalid bounded manifest.');
const paths = new Set();
for (const file of manifest.files) {
  if ((!/^(src|test|android|scripts|docs|schemas|bin)\/[a-zA-Z0-9_.\/-]+$/.test(file.path) && !['package.json', 'package-lock.json', 'README.md', 'PRODUCT.md', 'LICENSE', '.gitignore', 'RELAIS-CODEX-LOCAL.md'].includes(file.path)) || file.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(file.path) || !['100644', '100755'].includes(file.mode) || ![file.before, file.after].every(value => value === null || /^[a-f0-9]{40}$/.test(value))) throw new Error('Unsafe patch entry.');
  paths.add(file.path);
}
function verifyInputs() {
  for (const file of manifest.files) {
    let actual = null; try { actual = git('rev-parse', 'HEAD:' + file.path); } catch {}
    if (actual !== file.before) throw new Error('Source precondition changed: ' + file.path);
  }
}
function verifyOutputs() {
  const changed = git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
  if (changed.length !== paths.size || changed.some(file => !paths.has(file))) throw new Error('Unexpected staged path.');
  for (const file of manifest.files) {
    if (file.after === null) { if (fs.existsSync(file.path)) throw new Error('Deleted source remains.'); continue; }
    const stat = fs.lstatSync(file.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 24 * 1024 * 1024 || git('hash-object', '--', file.path) !== file.after || git('rev-parse', ':' + file.path) !== file.after || git('ls-files', '-s', '--', file.path).slice(0, 6) !== file.mode) throw new Error('Candidate bytes or mode changed: ' + file.path);
  }
}
async function api(endpoint, body) {
  if (!token) throw new Error('Publication credential is unavailable.');
  const response = await fetch('https://api.github.com/repos/' + repo + endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Candidate publication HTTP ' + response.status);
  return response.json();
}
const action = process.argv[2];
if (action === 'apply') {
  verifyInputs();
  const bytes = Buffer.from(manifest.patch, 'base64');
  if (bytes.toString('base64') !== manifest.patch || hash(bytes) !== manifest.sha256) throw new Error('Patch digest mismatch.');
  const patch = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  const target = path.join(process.env.RUNNER_TEMP, 'recovery-source.patch'); fs.writeFileSync(target, patch, { mode: 0o600 });
  git('apply', '--check', '--index', target); git('apply', '--index', target); verifyOutputs();
  console.log('Exact source preconditions and resulting hashes verified.');
} else if (action === 'test') {
  verifyInputs(); verifyOutputs();
  const run = args => execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 1_200_000 });
  for (const file of manifest.files) if (file.after && file.path.endsWith('.mjs')) run(['--check', file.path]);
  if (!Array.isArray(manifest.tests) || !manifest.tests.length || manifest.tests.length > 120 || manifest.tests.some(name => !/^test\/[a-zA-Z0-9_-]+\.test\.mjs$/.test(name))) throw new Error('Choose explicit contract test files.');
  run(['--test', '--test-concurrency=1', ...manifest.tests]);
  if (manifest.browser === 'recovery') for (const project of ['chromium-desktop', 'chromium-mobile', 'firefox-desktop', 'webkit-desktop']) run(['node_modules/@playwright/test/cli.js', 'test', '--project=' + project, 'test/e2e/notebooks.spec.mjs', 'test/e2e/real-proposal-workflows.spec.mjs', 'test/e2e/local-proposals.spec.mjs']);
  else if (manifest.browser !== false) throw new Error('Unknown browser campaign.');
} else if (action === 'publish') {
  verifyInputs(); verifyOutputs();
  if (git('rev-parse', 'HEAD') !== process.env.GITHUB_SHA || typeof manifest.message !== 'string' || manifest.message.length > 160 || /[\r\n]/.test(manifest.message)) throw new Error('Invalid candidate identity.');
  const entries = [];
  for (const file of manifest.files) {
    if (file.after === null) { entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: null }); continue; }
    const blob = await api('/git/blobs', { content: fs.readFileSync(file.path).toString('base64'), encoding: 'base64' });
    if (blob.sha !== file.after) throw new Error('Uploaded source differs.');
    entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
  }
  entries.push({ path: manifestPath, mode: '100644', type: 'blob', sha: null });
  const tree = await api('/git/trees', { base_tree: git('rev-parse', 'HEAD^{tree}'), tree: entries });
  git('rm', '--cached', '--', manifestPath);
  if (git('write-tree') !== tree.sha) throw new Error('Remote and tested trees differ.');
  const commit = await api('/git/commits', { message: manifest.message, tree: tree.sha, parents: [process.env.GITHUB_SHA] });
  const out = path.join(process.env.RUNNER_TEMP, 'recovery-candidate'); fs.mkdirSync(out, { recursive: true });
  execFileSync('git', ['archive', '--format=tar.gz', '--prefix=context-room/', '--output=' + path.join(out, 'context-room-source.tar.gz'), tree.sha]);
  const archiveSha256 = hash(fs.readFileSync(path.join(out, 'context-room-source.tar.gz')));
  fs.writeFileSync(path.join(out, 'candidate.json'), JSON.stringify({ commit: commit.sha, tree: tree.sha, parent: process.env.GITHUB_SHA, archiveSha256, files: manifest.files }, null, 2) + '\n');
  console.log('Candidate prepared: ' + commit.sha + '. No branch has moved.');
} else throw new Error('Choose apply, test or publish.');
