/** Temporary branch-only patch materializer for restricted development clients.
 * It creates an unattached commit, never a ref update, merge, release or deployment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const repo = 'blancmathis/context-room';
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== 'refs/heads/mathis/context-room-android-convergence') throw new Error('Wrong repository or branch.');
const token = process.env.CANDIDATE_TOKEN; delete process.env.CANDIDATE_TOKEN;
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding:'utf8', maxBuffer:64*1024*1024 }).trim();
const manifest = JSON.parse(fs.readFileSync('.github/convergence-patch.json', 'utf8'));
if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.patchBlob) || !/^[a-f0-9]{64}$/.test(manifest.patchSha256) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 200) throw new Error('Invalid patch manifest.');
const paths = new Set();
for (const file of manifest.files) {
  if (!/^(src|test|android|scripts|docs|schemas|bin)\/[a-zA-Z0-9_.\/-]+$/.test(file.path) && !['package.json','package-lock.json','README.md','PRODUCT.md','LICENSE','.gitignore'].includes(file.path)) throw new Error('Patch path is outside the authorized source surface.');
  if (file.path.includes('..') || paths.has(file.path) || !['100644','100755'].includes(file.mode) || ![file.before,file.after].every(value => value === null || /^[a-f0-9]{40}$/.test(value))) throw new Error('Unsafe or duplicate patch entry.');
  paths.add(file.path);
}
async function api(endpoint, body) {
  const response = await fetch('https://api.github.com/repos/' + repo + endpoint, { method: body ? 'POST':'GET', headers:{ authorization:'Bearer ' + token, accept:'application/vnd.github+json', 'content-type':'application/json', 'x-github-api-version':'2022-11-28' }, ...(body ? {body:JSON.stringify(body)}:{}) });
  if (!response.ok) throw new Error('GitHub candidate operation failed with HTTP ' + response.status);
  return response.json();
}
function verifyInputs() {
  for (const file of manifest.files) {
    let actual = null;
    try { actual = git('rev-parse', 'HEAD:' + file.path); } catch {}
    if (actual !== file.before) throw new Error('Source precondition changed: ' + file.path);
  }
}
function verifyOutputs() {
  const changed = git('diff','--cached','--name-only','-z').split('\0').filter(Boolean);
  if (changed.length !== paths.size || changed.some(file => !paths.has(file))) throw new Error('The staged patch contains an unexpected path.');
  for (const file of manifest.files) {
    if (file.after === null) { if (fs.existsSync(file.path)) throw new Error('Deleted source still exists.'); continue; }
    const stat = fs.lstatSync(file.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 24*1024*1024) throw new Error('Expected bounded independent source file.');
    if (git('hash-object','--',file.path) !== file.after || git('rev-parse',':' + file.path) !== file.after) throw new Error('Candidate bytes changed: ' + file.path);
    if (git('ls-files','-s','--',file.path).slice(0,6) !== file.mode) throw new Error('Candidate file mode changed.');
  }
}
if (process.argv[2] === 'apply') {
  verifyInputs();
  const blob = await api('/git/blobs/' + manifest.patchBlob);
  if (blob.encoding !== 'base64' || blob.size > 8*1024*1024) throw new Error('Invalid bounded patch blob.');
  const compressed = Buffer.from(blob.content, 'base64');
  if (sha(compressed) !== manifest.patchSha256) throw new Error('Patch digest mismatch.');
  const patch = gunzipSync(compressed, {maxOutputLength:32*1024*1024});
  const target = path.join(process.env.RUNNER_TEMP, 'convergence-source.patch'); fs.writeFileSync(target, patch, {mode:0o600});
  git('apply','--check','--index',target); git('apply','--index',target); verifyOutputs();
  console.log('Exact source preconditions and resulting file hashes verified.');
} else if (process.argv[2] === 'publish') {
  verifyInputs(); verifyOutputs();
  if (git('rev-parse','HEAD') !== process.env.GITHUB_SHA) throw new Error('Checkout identity changed.');
  const parent = await api('/git/commits/' + process.env.GITHUB_SHA), entries = [];
  for (const file of manifest.files) {
    if (file.after === null) { entries.push({path:file.path,mode:file.mode,type:'blob',sha:null}); continue; }
    const blob = await api('/git/blobs', {content:fs.readFileSync(file.path).toString('base64'),encoding:'base64'});
    if (blob.sha !== file.after) throw new Error('Uploaded source hash differs.');
    entries.push({path:file.path,mode:file.mode,type:'blob',sha:blob.sha});
  }
  entries.push({path:'.github/convergence-patch.json',mode:'100644',type:'blob',sha:null});
  const tree = await api('/git/trees',{base_tree:parent.tree.sha,tree:entries});
  const message = String(manifest.message || 'feat(convergence): integrate verified sources');
  if (message.length > 160 || /[\r\n]/.test(message)) throw new Error('Invalid candidate title.');
  const commit = await api('/git/commits',{message,tree:tree.sha,parents:[process.env.GITHUB_SHA]});
  // Export only tracked source bytes. Runtime homes, credentials and dependency caches are absent.
  git('rm','--cached','--','.github/convergence-patch.json');
  const localTree = git('write-tree'); if (localTree !== tree.sha) throw new Error('Candidate tree differs from the audited index.');
  const out = path.join(process.env.RUNNER_TEMP,'convergence-candidate'); fs.mkdirSync(out,{recursive:true});
  execFileSync('git',['archive','--format=tar.gz','--prefix=context-room/','--output=' + path.join(out,'context-room-source.tar.gz'),localTree]);
  const archiveHash = sha(fs.readFileSync(path.join(out,'context-room-source.tar.gz')));
  fs.writeFileSync(path.join(out,'candidate.json'),JSON.stringify({commit:commit.sha,tree:tree.sha,parent:process.env.GITHUB_SHA,archiveSha256:archiveHash,files:manifest.files},null,2)+'\n');
  fs.writeFileSync(path.join(out,'SHA256SUMS'),archiveHash + '  context-room-source.tar.gz\n');
  console.log('Candidate prepared: ' + commit.sha + '. No branch has been moved.');
} else throw new Error('Choose apply or publish.');
