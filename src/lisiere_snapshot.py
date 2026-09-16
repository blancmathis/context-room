"""Versioned, read-only SQLite extraction for the Lisiere migration.

Uses only Python's standard library, never imports or starts the legacy service.
The output is private recovery data, not an accepted project document.
"""
import argparse
import base64
import hashlib
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile
import time


VERSION = 1
MAX_BYTES = 512 * 1024 * 1024
MAC_COLUMNS = {
    'projects': 'id name root favorite opened origin codex_id position available',
    'boards': 'id title project anchor revision opened directory',
    'board_creations': 'id hash', 'objects': 'board id revision data',
    'operations': 'id hash result', 'history': 'id board actor changes time undone',
    'events': 'seq kind entity data time',
    'proposals': 'id project path base content status actor time',
    'proposal_payloads': 'id sha256 bytes', 'proposal_origins': 'id content device',
    'document_operations': 'id hash proposal', 'review_intents': 'proposal temp device inode started',
    'review_recovery': 'proposal state time', 'context': 'device data time',
    'drafts': 'project path device base content version',
    'conversations': 'id project thread title created', 'messages': 'seq conversation kind data time',
    'native_bindings': 'id thread',
    'native_requests': 'id conversation device digest text context grant_hash prompt expires active additions observation images',
    'pen_jobs': 'id board actor digest status data',
    'desktop_submissions': 'id project thread digest state result created updated',
    'devices': 'id name token created', 'pairs': 'token expires',
}
ANDROID_COLUMNS = {'android_metadata': 'locale', 'cache': 'key value', 'outbox': 'seq id operation args error',
                   'board_headers': 'board value', 'board_objects': 'board id value'}
# A native request's generated prompt contains its old executable grant. Keep
# original text/context/history, never transfer that grant to a new runtime.
OMIT = {'devices': {'token'}, 'native_requests': {'grant_hash', 'prompt'}}


def encoded(value):
    if isinstance(value, bytes):
        return {'base64': base64.b64encode(value).decode('ascii')}
    if isinstance(value, int) and abs(value) > 9007199254740991:
        return {'integer': str(value)}
    return value


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def regular(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Migration requires regular files, without symbolic links.')
    return info


def checked_directory(value):
    value = Path(value).absolute()
    for candidate in (value, *value.parents):
        if candidate.is_symlink():
            raise ValueError('Migration does not follow symbolic source or destination directories.')
    if not value.is_dir():
        raise ValueError('The selected migration directory does not exist.')
    return value.resolve(strict=True)


def _snapshot_directory(source, output=None, recordings=None):
    """One read transaction; plan and export have the same content revision."""
    source = checked_directory(source)
    recordings = checked_directory(recordings) if recordings is not None else None
    database = source / 'workspace.sqlite'
    identity = regular(database)
    if identity.st_size > MAX_BYTES:
        raise ValueError('The legacy database exceeds the bounded snapshot size.')
    for suffix in ('-wal', '-shm', '-journal'):
        sidecar = Path(str(database) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            regular(sidecar)
    files, tables, excluded = [], [], []
    total = 0

    def store(relative, chunks):
        nonlocal total
        sha, count = hashlib.sha256(), 0
        destination = None
        if output:
            file = output / relative
            file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination = file.open('xb')
            os.chmod(file, 0o600)
        try:
            for chunk in chunks:
                total += len(chunk)
                count += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError('The legacy snapshot exceeds 512 MiB; keep the original and split its migration explicitly.')
                sha.update(chunk)
                if destination:
                    destination.write(chunk)
            if destination:
                destination.flush()
                os.fsync(destination.fileno())
        finally:
            if destination:
                destination.close()
        entry = {'path': relative, 'bytes': count, 'sha256': sha.hexdigest()}
        files.append(entry)
        return entry

    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10)
    try:
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        schema = dict(connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
        kind = 'mac-workspace' if {'boards', 'projects', 'objects'}.issubset(schema) else 'android-workspace' if {'cache', 'outbox'}.issubset(schema) else None
        known = MAC_COLUMNS if kind == 'mac-workspace' else ANDROID_COLUMNS
        if kind is None or set(schema) - set(known):
            raise ValueError('Unsupported legacy database schema. The original is unchanged.')
        if recordings is not None and kind != 'android-workspace':
            raise ValueError('An explicit recordings directory belongs to an Android workspace snapshot.')
        user_version = connection.execute('PRAGMA user_version').fetchone()[0]
        if user_version not in (0, 1):
            raise ValueError('Unsupported legacy database version. The original is unchanged.')
        for name in sorted(schema):
            if not schema[name].lstrip().upper().startswith('CREATE TABLE '):
                raise ValueError('Virtual legacy tables are not supported.')
            columns = list(connection.execute('PRAGMA table_info("' + name + '")'))
            if {row[1] for row in columns} - set(known[name].split()):
                raise ValueError('Unsupported columns in legacy table ' + name + '. The original is unchanged.')
            if name == 'pairs':
                excluded.append({'table': name, 'rows': connection.execute('SELECT count(*) FROM pairs').fetchone()[0], 'reason': 'pairing credentials'})
                continue
            selected = [row[1] for row in columns if row[1] not in OMIT.get(name, set())]
            omitted = [row[1] for row in columns if row[1] in OMIT.get(name, set())]
            if omitted:
                excluded.append({'table': name, 'columns': omitted, 'reason': 'credentials and executable grants'})
            primary = [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]]
            names = ','.join('"' + column + '"' for column in selected)
            order = ','.join('"' + column + '"' for column in primary) or 'rowid'
            count = [0]

            def rows():
                for row in connection.execute('SELECT ' + names + ' FROM "' + name + '" ORDER BY ' + order):
                    count[0] += 1
                    line = packed([encoded(cell) for cell in row]) + b'\n'
                    if len(line) > 48 * 1024 * 1024:
                        raise ValueError('An archived SQLite row exceeds the bounded recovery reader. Keep its original for explicit reconciliation.')
                    yield line

            entry = store('tables/' + name + '.jsonl', rows())
            tables.append({'name': name, 'columns': selected, 'schema': [{'name': row[1], 'type': row[2], 'primary': row[5]} for row in columns], 'rows': count[0], **entry})
        # Legacy raster resources are immutable content-addressed bytes. Android
        # binary board objects and draft deltas remain exact SQLite cells.
        assets = source / 'assets'
        if kind == 'mac-workspace' and (assets.exists() or assets.is_symlink()):
            checked_directory(assets)
            paths = sorted(assets.iterdir())
            if len(paths) > 20000:
                raise ValueError('Too many legacy assets for one bounded snapshot.')
            for file in paths:
                if len(file.name) != 64 or any(character not in '0123456789abcdef' for character in file.name):
                    raise ValueError('An unfinished or unknown legacy asset needs inspection before export.')
                info = regular(file)
                if info.st_size > 20 * 1024 * 1024:
                    raise ValueError('A legacy asset exceeds its original format limit.')
                descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'rb') as content:
                    opened = os.fstat(content.fileno())
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise ValueError('A legacy asset was replaced while opening it.')
                    entry = store('assets/' + file.name, iter(lambda: content.read(1024 * 1024), b''))
                if entry['sha256'] != file.name:
                    raise ValueError('A legacy asset does not match its content identity.')
        recording_inventory = None
        if recordings is not None:
            directory_identity = recordings.stat()
            paths = sorted(recordings.iterdir())
            if len(paths) > 20000:
                raise ValueError('Too many legacy recordings for one bounded snapshot.')
            retained = []
            for file in paths:
                if not file.name.endswith('.pcm') or len(file.stem) != 64 or any(character not in '0123456789abcdef' for character in file.stem):
                    raise ValueError('An unknown legacy recording needs inspection before export.')
                info = regular(file)
                if info.st_nlink != 1 or info.st_size > 16000 * 2 * 120 or info.st_size % 2:
                    raise ValueError('A legacy recording is linked, incomplete or exceeds its original two-minute limit.')
                descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'rb') as content:
                    opened = os.fstat(content.fileno())
                    def recording_signature(value):
                        return (value.st_dev, value.st_ino, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
                    if recording_signature(opened) != recording_signature(info):
                        raise ValueError('A legacy recording changed while opening it.')
                    entry = store('recordings/' + file.name, iter(lambda: content.read(64 * 1024), b''))
                    if recording_signature(os.fstat(content.fileno())) != recording_signature(info) or recording_signature(regular(file)) != recording_signature(info) or entry['bytes'] != info.st_size:
                        raise ValueError('A legacy recording changed during the snapshot. Retain the original and preview again.')
                retained.append(entry['path'])
            after = checked_directory(recordings).stat()
            if (after.st_dev, after.st_ino) != (directory_identity.st_dev, directory_identity.st_ino) or sorted(recordings.iterdir()) != paths:
                raise ValueError('The legacy recordings directory changed during the snapshot.')
            recording_inventory = {'encoding': 'pcm-s16le', 'sampleRate': 16000, 'channels': 1,
                                   'sourceIdentity': [directory_identity.st_dev, directory_identity.st_ino], 'paths': retained}
        current = regular(database)
        if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('The original database was replaced during the snapshot.')
        manifest = {'version': 2 if recordings is not None else VERSION, 'mediaType': 'application/vnd.context-room.lisiere-snapshot+json', 'kind': kind,
                    'databaseVersion': user_version, 'sourceIdentity': [identity.st_dev, identity.st_ino],
                    'tables': tables, 'files': files, 'excludedCredentials': excluded, 'accepted': False}
        if recording_inventory is not None:
            manifest['recordings'] = recording_inventory
        return {**manifest, 'revision': digest(packed(manifest))}
    finally:
        connection.close()



def snapshot(source, output=None, recordings=None):
    """Directory formats v1/v2 stay compatible; native ZIPs produce stable v3."""
    source = Path(source).absolute()
    if source.is_dir():
        return _snapshot_directory(source, output, recordings)
    if recordings is not None:
        raise ValueError('An Android ZIP already declares its recordings; do not combine it with --recordings.')
    from lisiere_android_export import read_android_export
    with read_android_export(source) as (copy, native):
        manifest = _snapshot_directory(copy / 'workspace', output, copy / 'recordings')
        manifest.pop('revision')
        manifest['version'] = 3
        # Disposable inode numbers cannot invalidate the next apply. The exact
        # original archive bytes, including journals and derived JSON, bind it.
        manifest['sourceIdentity'] = ['android-export-sha256', native['sha256']]
        manifest['recordings']['sourceIdentity'] = ['android-export-sha256', native['sha256'], 'recordings']
        manifest['androidExport'] = native
        total = sum(entry['bytes'] for entry in manifest['files'])
        for relative in ('derived/outbox-args.jsonl', 'derived/android-export-manifest.json'):
            original = copy / relative
            size = original.stat().st_size
            total += size
            if total > MAX_BYTES:
                raise ValueError('The converted Android snapshot exceeds 512 MiB. Keep the original ZIP for explicit reconciliation.')
            sha = hashlib.sha256()
            destination = None
            if output:
                target = output / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                destination = target.open('xb')
                os.chmod(target, 0o600)
            try:
                with original.open('rb') as content:
                    for chunk in iter(lambda: content.read(64 * 1024), b''):
                        sha.update(chunk)
                        if destination:
                            destination.write(chunk)
                if destination:
                    destination.flush()
                    os.fsync(destination.fileno())
            finally:
                if destination:
                    destination.close()
            manifest['files'].append({'path': relative, 'bytes': size, 'sha256': sha.hexdigest()})
        return {**manifest, 'revision': digest(packed(manifest))}


def _publish_snapshot_file(source, target, expected_sha, resume=True):
    """Publish/resume an exact prefix through a pinned private parent directory.

    Nothing is replaced, and no hard link can survive a killed exporter. Locks
    serialize competing exporters, not unrelated human filesystem changes.
    """
    checked_directory(target.parent)
    expected_parent = target.parent.stat()
    parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parent = os.fstat(parent_fd)
        if (parent.st_dev, parent.st_ino) != (expected_parent.st_dev, expected_parent.st_ino) or parent.st_mode & 0o077 or parent.st_uid != os.getuid():
            raise ValueError('The private export directory changed. Nothing was replaced.')
        flags = os.O_RDWR | os.O_NOFOLLOW
        try:
            fd = os.open(target.name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            visible = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(visible.st_mode):
                raise ValueError('A linked or special export destination cannot be resumed.')
            fd = os.open(target.name, flags, dir_fd=parent_fd)
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ValueError('Another export still owns this exact destination. Retry after it finishes.')
                    time.sleep(0.02)
            before = os.fstat(fd)
            visible = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            size = source.stat().st_size
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid()
                    or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > size
                    or (before.st_dev, before.st_ino) != (visible.st_dev, visible.st_ino)
                    or not resume and before.st_size != size):
                raise ValueError('The export destination has different data, links or permissions. Nothing was replaced.')
            with source.open('rb') as expected:
                remaining = before.st_size
                while remaining:
                    current = os.read(fd, min(64 * 1024, remaining))
                    if not current or current != expected.read(len(current)):
                        raise ValueError('An interrupted export contains different data. Nothing was replaced.')
                    remaining -= len(current)
                checked = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (checked.st_size, checked.st_mtime_ns, checked.st_ctime_ns):
                    raise ValueError('The interrupted export changed while checking its prefix.')
                for chunk in iter(lambda: expected.read(64 * 1024), b''):
                    pending = memoryview(chunk)
                    while pending:
                        written = os.write(fd, pending)
                        if written <= 0:
                            raise OSError('The snapshot copy did not advance.')
                        pending = pending[written:]
            os.fsync(fd)
            after = os.fstat(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            sha = hashlib.sha256()
            for chunk in iter(lambda: os.read(fd, 64 * 1024), b''):
                sha.update(chunk)
            visible = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            checked = os.fstat(fd)
            checked_directory(target.parent)
            current_parent = target.parent.stat()
            if (sha.hexdigest() != expected_sha or after.st_size != size or checked.st_nlink != 1
                    or (after.st_mtime_ns, after.st_ctime_ns) != (checked.st_mtime_ns, checked.st_ctime_ns)
                    or (after.st_dev, after.st_ino) != (visible.st_dev, visible.st_ino)
                    or (parent.st_dev, parent.st_ino) != (current_parent.st_dev, current_parent.st_ino)):
                raise ValueError('The exported file or directory changed during publication. Retain its journal for reconciliation.')
        finally:
            os.close(fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def export(source, destination, expected_revision, recordings=None):
    if not expected_revision:
        raise ValueError('Preview the snapshot and supply its exact revision before exporting.')
    destination = Path(destination).absolute()
    parent = checked_directory(destination.parent)
    if destination.name in ('', '.', '..'):
        raise ValueError('Choose an exact new export directory name.')
    destination = parent / destination.name
    source = Path(source).absolute()
    if source.is_dir():
        source = checked_directory(source)
    recordings = checked_directory(recordings) if recordings is not None else None
    if destination.is_symlink() or destination.is_relative_to(source) or recordings is not None and destination.is_relative_to(recordings):
        raise ValueError('Choose a new private destination outside the original workspace.')
    if destination.exists() and not (destination / 'export-journal.json').is_file():
        raise ValueError('Choose a new private destination; this occupied directory is not an interrupted export.')
    staging = Path(tempfile.mkdtemp(prefix='.context-room-snapshot-', dir=parent))
    try:
        manifest = snapshot(source, staging, recordings)
        if manifest['revision'] != expected_revision:
            raise ValueError('The legacy workspace changed after its snapshot preview. Preview it again.')
        content = packed(manifest) + b'\n'
        if len(content) > 8 * 1024 * 1024:
            raise ValueError('The recovery manifest exceeds its bounded reader size.')
        for name in ('export-journal.json', 'manifest.json'):
            file = staging / name
            with file.open('xb') as output:
                os.chmod(file, 0o600)
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
        try:
            destination.mkdir(mode=0o700)
        except FileExistsError:
            checked_directory(destination)
            if destination.stat().st_mode & 0o077 or not (destination / 'export-journal.json').is_file():
                raise ValueError('The occupied destination is not a private interrupted export.')

        # Refuse unrelated occupants, including symlinks and extra directories.
        allowed = {entry['path'] for entry in manifest['files']} | {'manifest.json', 'export-journal.json'}
        directories = {str(Path(rel).parent) for rel in allowed} - {'.'}
        for folder, children, names in os.walk(destination, followlinks=False):
            base = Path(folder).relative_to(destination)
            for name in children:
                child = Path(folder) / name
                checked_directory(child)
                if str(base / name) not in directories:
                    raise ValueError('The occupied export contains an unrelated directory. Nothing was replaced.')
            for name in names:
                if str(base / name) not in allowed:
                    raise ValueError('The occupied export contains an unrelated file. Nothing was replaced.')
                regular(Path(folder) / name)
        completed = False
        complete_marker = destination / 'manifest.json'
        if complete_marker.exists():
            regular(complete_marker)
            descriptor = os.open(complete_marker, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as existing:
                completed = existing.read(len(content) + 1) == content

        def publish(relative, sha):
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if completed and not target.exists():
                raise ValueError('A completed snapshot lost a file. Nothing was replaced; preserve it for reconciliation.')
            _publish_snapshot_file(staging / relative, target, sha, resume=not completed)

        publish('export-journal.json', digest(content))
        for entry in manifest['files']:
            publish(entry['path'], entry['sha256'])
        # The complete marker is published last. A retry checks each existing
        # byte stream and only fills missing entries from the same source revision.
        publish('manifest.json', digest(content))
        return manifest
    finally:
        shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'export'))
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--recordings', type=Path)
    args = parser.parse_args()
    if args.action == 'export' and not args.output:
        parser.error('export requires --output and --revision')
    result = snapshot(args.source, recordings=args.recordings) if args.action == 'plan' else export(args.source, args.output, args.revision, args.recordings)
    print(json.dumps(result, ensure_ascii=False))
