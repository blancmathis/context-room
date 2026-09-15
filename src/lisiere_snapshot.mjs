import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./lisiere_snapshot.py', import.meta.url));
function failure(code, message, cause) { return Object.assign(new Error(message, { cause }), { code }); }

/** Private recovery export, never starts the legacy service or accepts documents. */
export async function exportLisiereSnapshot({ source, output, recordings, apply = false, expectedRevision } = {}) {
  if (typeof source !== 'string' || !source || typeof output !== 'string' || !output)
    throw failure('migration_arguments', 'Choose --export-lisiere <workspace directory or native Android ZIP> and --output <private snapshot directory>.');
  if (apply && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)))
    throw failure('migration_revision', 'Preview the Lisière snapshot first, then use --apply --revision <exact revision>.');
  if (recordings !== undefined && (typeof recordings !== 'string' || !recordings))
    throw failure('migration_arguments', 'Choose the exact legacy Android dictation directory with --recordings.');
  source = path.resolve(source); output = path.resolve(output);
  const args = ['-B', script, apply ? 'export' : 'plan', '--source', source];
  if (recordings !== undefined) args.push('--recordings', path.resolve(recordings));
  if (apply) args.push('--output', output, '--revision', expectedRevision);
  let result;
  try { result = await execute('python3', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) {
    if (error.code === 'ENOENT') throw failure('migration_python_unavailable', 'Lisière SQLite export needs Python 3.9 or later with its standard sqlite3 module. Install it locally, then retry the same preview.', error);
    const detail = String(error.stderr || '').trim().split('\n').at(-1)?.slice(0, 600);
    throw failure('migration_snapshot_failed', detail || 'The bounded SQLite snapshot did not finish. The original workspace is unchanged; retain any export journal for retry.', error);
  }
  let manifest;
  try { manifest = JSON.parse(result.stdout); } catch (error) { throw failure('migration_snapshot_format', 'The SQLite helper returned an invalid snapshot manifest.', error); }
  if (![1, 2, 3].includes(manifest.version) || manifest.mediaType !== 'application/vnd.context-room.lisiere-snapshot+json' || !/^[a-f0-9]{64}$/.test(manifest.revision || ''))
    throw failure('migration_snapshot_format', 'Unsupported legacy snapshot manifest. The original workspace is unchanged.');
  return { ...manifest, source, output, exported: apply, accepted: false,
    next: 'This is a private recovery snapshot. Import and a single-writer cutover are separate steps; the legacy installation remains unchanged.' };
}
