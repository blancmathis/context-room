"""Versioned, read-only SQLite extraction for the Lisiere migration.

Uses only Python's standard library, never imports or starts the legacy service.
The output is private recovery data, not an accepted project document.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import tempfile

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
ANDROID_COLUMNS = {'cache': 'key value', 'outbox': 'seq id operation args error',
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


def snapshot(source, output=None):
    """One read transaction; plan and export have the same content revision."""
    source = checked_directory(source)
    database = source / 'workspace.sqlite'
    identity = regular(database)
    if identity.st_size > MAX_BYTES:
        raise ValueError('The legacy database exceeds the bounded snapshot size.')
    for suffix in ('-wal', '-shm'):
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
                    yield packed([encoded(cell) for cell in row]) + b'\n'

            entry = store('tables/' + name + '.jsonl', rows())
            tables.append({'name': name, 'columns': selected, 'schema': [{'name': row[1], 'type': row[2], 'primary': row[5]} for row in columns], 'rows': count[0], **entry})
        # Legacy raster resources are immutable content-addressed bytes. Android
        # compressed board objects and draft deltas remain exact SQLite cells.
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
        current = regular(database)
        if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('The original database was replaced during the snapshot.')
        manifest = {'version': VERSION, 'mediaType': 'application/vnd.context-room.lisiere-snapshot+json', 'kind': kind,
                    'databaseVersion': user_version, 'sourceIdentity': [identity.st_dev, identity.st_ino],
                    'tables': tables, 'files': files, 'excludedCredentials': excluded, 'accepted': False}
        return {**manifest, 'revision': digest(packed(manifest))}
    finally:
        connection.close()


def export(source, destination, expected_revision):
    if not expected_revision:
        raise ValueError('Preview the snapshot and supply its exact revision before exporting.')
    destination = Path(destination).absolute()
    parent = checked_directory(destination.parent)
    if destination.name in ('', '.', '..'):
        raise ValueError('Choose an exact new export directory name.')
    destination = parent / destination.name
    source = checked_directory(source)
    if destination.is_symlink() or destination.is_relative_to(source):
        raise ValueError('Choose a new private destination outside the original workspace.')
    if destination.exists() and not (destination / 'export-journal.json').is_file():
        raise ValueError('Choose a new private destination; this occupied directory is not an interrupted export.')
    staging = Path(tempfile.mkdtemp(prefix='.context-room-snapshot-', dir=parent))
    try:
        manifest = snapshot(source, staging)
        if manifest['revision'] != expected_revision:
            raise ValueError('The legacy workspace changed after its snapshot preview. Preview it again.')
        content = packed(manifest) + b'\n'
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

        def publish(relative, sha):
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            checked_directory(target.parent)
            try:
                os.link(staging / relative, target, follow_symlinks=False)
            except FileExistsError:
                regular(target)
                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'rb') as existing:
                    current = hashlib.sha256()
                    for chunk in iter(lambda: existing.read(1024 * 1024), b''):
                        current.update(chunk)
                if current.hexdigest() != sha:
                    raise ValueError('An interrupted export destination contains different data. Nothing was replaced.')
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)

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
    args = parser.parse_args()
    if args.action == 'export' and not args.output:
        parser.error('export requires --output and --revision')
    result = snapshot(args.source) if args.action == 'plan' else export(args.source, args.output, args.revision)
    print(json.dumps(result, ensure_ascii=False))
