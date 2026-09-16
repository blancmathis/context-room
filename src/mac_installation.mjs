import fs from 'node:fs';
import path from 'node:path';
import { canonicalNotebookRoot, readNotebookBytes, writeNotebookBytes, readNotebookJson, notebookHash, stableNotebookJson } from './notebook_io.mjs';
import { packagePrivacyFindings } from '../scripts/check-package-privacy.mjs';

const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { code: 'mac_installation_conflict' }); };
const encode = value => Buffer.from(stableNotebookJson(value) + '\n');
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const safeRelative = value => typeof value === 'string' && value && !path.isAbsolute(value) && !value.includes('\\') && !/[\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const blocked = /(?:^|\/)(?:node_modules|\.git|\.local|__pycache__)(?:\/|$)|\.(?:pem|key|keystore|jks|p12|ttf|otf|woff2?)$/i;

function packageEntries(source) {
  const pkg = readNotebookJson(source, 'package.json');
  check(pkg?.name === 'context-room' && Array.isArray(pkg.files), 'Choose the complete Context Room package source.');
  const paths = new Set(['package.json', 'package-lock.json']);
  function visit(relative) {
    const target = path.join(source, relative), stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return;
    check(safeRelative(relative) && !blocked.test(relative) && !stat.isSymbolicLink(), 'An installation source contains a linked, generated or credential entry.');
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(relative + '/' + name);
    else { check(stat.isFile() && stat.nlink === 1, 'Only independent regular package files may be staged.'); paths.add(relative); }
  }
  for (const relative of pkg.files) { check(safeRelative(relative.replace(/\/$/, '')), 'Unsupported package allowlist entry.'); visit(relative.replace(/\/$/, '')); }
  let total = 0;
  const files = [...paths].sort().map(relative => {
    const bytes = readNotebookBytes(source, relative, 32 * 1024 * 1024); check(bytes !== null, 'A required package entry is absent: ' + relative);
    total += bytes.length; check(total <= 64 * 1024 * 1024, 'This installation source exceeds the 64 MiB staging bound.');
    return { path: relative, sha256: notebookHash(bytes), bytes: bytes.length, mode: fs.statSync(path.join(source, relative)).mode & 0o777 };
  });
  check(files.length <= 5000 && !packagePrivacyFindings({ root: source, files }).length, 'Package privacy audit failed; no installation kit was prepared.');
  check(files.some(f => f.path === 'bin/context-room.mjs') && files.some(f => f.path === 'src/mac_installation.mjs'), 'The installation runtime is incomplete.');
  return { pkg, files };
}

/** A private, self-verifying installation kit. Preparation never installs npm,
 * a model or a LaunchAgent, never starts a server and never migrates user state. */
export function prepareMacInstallation(source, { output, nodePath, whisperPath = null, modelPath = null, port = 4317, apply = false, expectedRevision } = {}) {
  canonicalNotebookRoot(source);
  check(typeof output === 'string' && path.resolve(output) === output && output !== source && !output.startsWith(source + path.sep), 'Choose a new private kit directory outside the source.');
  canonicalNotebookRoot(path.dirname(output));
  check(typeof nodePath === 'string' && path.isAbsolute(nodePath) && !/[\x00-\x1f]/.test(nodePath), 'Choose the exact absolute Node executable for the Mac.');
  check(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, 'Choose an explicit unprivileged loopback port.');
  for (const value of [whisperPath, modelPath]) check(value === null || typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'Optional local audio paths must be exact absolute paths.');
  const { pkg, files } = packageEntries(source);
  const manifest = { version: 1, kind: 'context-room-mac-installation', packageVersion: pkg.version, files, nodePath, whisperPath, modelPath, port,
    label: 'app.contextroom.local', accepted: false, modelDownloaded: false, dependenciesIncluded: false, activated: false };
  const revision = notebookHash(manifest), summary = { revision, packageVersion: pkg.version, files: files.length, output, nodePath, port, activated: false, dependenciesIncluded: false };
  if (!apply) return { ...summary, prepared: false };
  check(expectedRevision === revision, 'Installation sources or options changed after preview.');
  if (!fs.existsSync(output)) fs.mkdirSync(output, { mode: 0o700 });
  canonicalNotebookRoot(output);
  check(!(fs.statSync(output).mode & 0o077), 'Installation kits must be private.');
  const journalBytes = encode({ ...manifest, revision });
  const previous = readNotebookBytes(output, 'prepare-journal.json');
  check(previous ? previous.equals(journalBytes) : fs.readdirSync(output).length === 0, 'The kit directory is occupied by other work.');
  if (!previous) writeNotebookBytes(output, 'prepare-journal.json', journalBytes, { exclusive: true });
  for (const entry of files) {
    const bytes = readNotebookBytes(source, entry.path, 32 * 1024 * 1024);
    check(bytes && notebookHash(bytes) === entry.sha256, 'Source changed during staging.');
    const dest = 'runtime/' + entry.path, existing = readNotebookBytes(output, dest, 32 * 1024 * 1024);
    check(existing === null || existing.equals(bytes), 'A staged file has newer or different contents. Nothing was replaced.');
    if (existing === null) writeNotebookBytes(output, dest, bytes, { exclusive: true, mode: entry.mode });
  }
  const final = readNotebookBytes(output, 'manifest.json'); check(final === null || final.equals(journalBytes), 'The completed manifest changed.');
  if (!final) writeNotebookBytes(output, 'manifest.json', journalBytes, { exclusive: true });
  verifyMacInstallation(output, revision);
  return { ...summary, prepared: true, replayed: final !== null };
}

export function verifyMacInstallation(kit, expectedRevision) {
  canonicalNotebookRoot(kit);
  const raw = readNotebookBytes(kit, 'manifest.json', 8 * 1024 * 1024), journal = readNotebookBytes(kit, 'prepare-journal.json', 8 * 1024 * 1024);
  check(raw && journal?.equals(raw), 'The installation kit is incomplete.');
  const { revision, ...manifest } = JSON.parse(raw);
  check(revision === expectedRevision && notebookHash(manifest) === revision && manifest.version === 1 && manifest.kind === 'context-room-mac-installation'
    && manifest.label === 'app.contextroom.local' && Array.isArray(manifest.files) && manifest.files.length <= 5000, 'The exact installation manifest is invalid.');
  const allowed = new Set();
  for (const entry of manifest.files) {
    check(safeRelative(entry.path) && !blocked.test(entry.path) && !allowed.has(entry.path) && Number.isSafeInteger(entry.bytes)
      && entry.bytes >= 0 && entry.bytes <= 32 * 1024 * 1024 && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777, 'An installation entry is invalid.');
    allowed.add(entry.path);
    const bytes = readNotebookBytes(kit, 'runtime/' + entry.path, entry.bytes);
    check(bytes && bytes.length === entry.bytes && notebookHash(bytes) === entry.sha256
      && (fs.statSync(path.join(kit, 'runtime', entry.path)).mode & 0o777) === entry.mode, 'A staged runtime file changed: ' + entry.path);
  }
  function walk(folder = '') {
    for (const name of fs.readdirSync(path.join(kit, 'runtime', folder))) {
      const rel = folder ? folder + '/' + name : name, stat = fs.lstatSync(path.join(kit, 'runtime', rel));
      check(!stat.isSymbolicLink(), 'A staged runtime entry is linked.');
      if (stat.isDirectory()) walk(rel); else check(allowed.has(rel), 'An unexpected file appeared in the runtime.');
    }
  }
  walk();
  check(fs.readdirSync(kit).every(name => ['runtime', 'manifest.json', 'prepare-journal.json'].includes(name)), 'An unexpected file appeared beside the installation runtime.');
  return { ...manifest, revision, verified: true, activated: false };
}

/** Build the exact launch definition after local verification. The returned text
 * is inert; caller must explicitly save and bootstrap it on macOS. */
export function macLaunchAgent({ runtime, nodePath, home, whisperPath = null, modelPath = null, port = 4317 }) {
  for (const value of [runtime, nodePath, home]) check(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'Launch locations must be exact absolute paths.');
  check(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid local port.');
  const args = [nodePath, path.join(runtime, 'bin/context-room.mjs'), 'hub', '--no-local', '--port', String(port)];
  const environment = { PATH: [...new Set([path.dirname(nodePath), path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':') };
  for (const [key, value] of [['CONTEXT_ROOM_WHISPER_BIN', whisperPath], ['CONTEXT_ROOM_WHISPER_MODEL', modelPath]]) {
    check(value === null || typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'Invalid explicit local audio path.');
    if (value !== null) environment[key] = value;
  }
  // Successful exit (including an already running Hub) must not create a restart loop.
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
    + '<key>Label</key><string>app.contextroom.local</string>\n<key>ProgramArguments</key><array>' + args.map(arg => '<string>' + xml(arg) + '</string>').join('') + '</array>\n'
    + '<key>EnvironmentVariables</key><dict>' + Object.entries(environment).map(([key, value]) => '<key>' + key + '</key><string>' + xml(value) + '</string>').join('') + '</dict>\n'
    + '<key>WorkingDirectory</key><string>' + xml(runtime) + '</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>30</integer>\n'
    + '<key>StandardOutPath</key><string>' + xml(path.join(home, 'Library/Logs/ContextRoom.log')) + '</string>\n<key>StandardErrorPath</key><string>' + xml(path.join(home, 'Library/Logs/ContextRoom.log')) + '</string>\n</dict></plist>\n';
}
