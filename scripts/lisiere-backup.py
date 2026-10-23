#!/usr/bin/env python3
"""Verified backup of the original Lisière installation before the cutover.

Writes ONLY inside a new --output directory (mode 0700); reads everything else.
  - counts-before.json: read-only row counts and the number of Carnets/*.lisiere
  - workspace-online.sqlite: consistent sqlite3 online backup, same counts
  - lisiere-data.tgz: ~/.local/share/lisiere (without models/, listed in
    models.json), ~/Documents/Lisière, both launch-agent plists, the
    ~/.local/bin/lisiere link and its target; SHA256SUMS for every file
  - development.keystore: separate copy, same sha256
The archive is extracted into a temporary directory and checked against
SHA256SUMS. Live files (logs, the running workspace database) are listed as
volatile; the online copy covers the database. With --source-retained (the
companion stopped, step 7 bis) the retained workspace is compared in full.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

TABLES = ('boards', 'objects', 'conversations', 'messages', 'projects', 'proposals', 'drafts', 'recordings', 'devices')
LABELS = ('fr.lisiere.companion', 'fr.lisiere.updates')
VOLATILE_NAMES = {'service.log', 'updates-service.log'}
DATABASE = 'workspace.sqlite'


def sha256(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def open_source(database):
    uri = Path(database).resolve().as_uri()
    try:
        connection = sqlite3.connect(uri + '?mode=ro', uri=True, timeout=10)
        connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
        return connection
    except sqlite3.OperationalError:
        if Path(database).parent.name != '.source':
            raise
        return sqlite3.connect(database, timeout=10)


def readable_source(database, output):
    """A WAL database without its -shm file (the companion between connections)
    cannot be opened with mode=ro, and a normal connection would leave -wal/-shm
    in the Lisière folder. Without a -wal file the main file holds every commit,
    so a copy taken while size, mtime and the absent -wal stay unchanged is exact."""
    try:
        open_source(database).close()
        return database
    except sqlite3.OperationalError:
        pass
    wal = Path(str(database) + '-wal')
    stamp = lambda: (database.stat().st_size, database.stat().st_mtime_ns, wal.exists())
    first = stamp()
    if first[2]:
        raise ValueError('The Lisière database cannot be opened read-only. Retry the backup into a new directory.')
    os.mkdir(output / '.source', 0o700)
    copy = output / '.source' / DATABASE
    shutil.copyfile(database, copy)
    if stamp() != first:
        raise ValueError('The live database changed during the copy. Retry the backup into a new directory.')
    return copy


def counts(database, documents):
    connection = open_source(database)
    try:
        present = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        tables = {name: connection.execute('SELECT count(*) FROM "' + name + '"').fetchone()[0] for name in TABLES if name in present}
    finally:
        connection.close()
    carnets = documents / 'Carnets'
    notebooks = sorted(entry.name for entry in carnets.iterdir() if entry.is_dir() and entry.name.endswith('.lisiere')) if carnets.is_dir() else []
    return {'tables': tables, 'missingTables': [name for name in TABLES if name not in present], 'carnets': len(notebooks)}


def online_copy(database, destination):
    source = open_source(database)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('The online database copy failed its integrity check.')
    finally:
        target.close()
        source.close()
    os.chmod(destination, 0o600)


def members(home, data, documents, workspace, retained):
    """(path, arcname, volatile) for every entry, sorted, without following links."""
    entries, models = [], []
    volatile_workspace = None if retained else workspace

    def add_tree(root):
        for directory, folders, files in os.walk(root, followlinks=False):
            current = Path(directory)
            if current == data / 'models':
                folders[:] = []
                continue
            folders.sort()
            entries.append((current, current.relative_to(home).as_posix(), False))
            for name in sorted(files) + sorted(folder for folder in folders if (current / folder).is_symlink()):
                file = current / name
                if not (file.is_file() or file.is_symlink()):
                    continue
                volatile = name in VOLATILE_NAMES or (current == volatile_workspace and name.startswith(DATABASE))
                entries.append((file, file.relative_to(home).as_posix(), volatile))
    for file in sorted((data / 'models').rglob('*')) if (data / 'models').is_dir() else []:
        if file.is_file() and not file.is_symlink():
            models.append({'path': file.relative_to(home).as_posix(), 'bytes': file.stat().st_size, 'sha256': sha256(file)})
    add_tree(data)
    if documents.is_dir():
        add_tree(documents)
    for label in LABELS:
        plist = home / 'Library/LaunchAgents' / (label + '.plist')
        if plist.is_file():
            entries.append((plist, plist.relative_to(home).as_posix(), False))
    link = home / '.local/bin/lisiere'
    if link.is_symlink():
        entries.append((link, link.relative_to(home).as_posix(), False))
        target = link.resolve()
        if target.is_file():
            entries.append((target, 'link-target/' + target.name, False))
    return entries, models


def main():
    parser = argparse.ArgumentParser(description='Verified backup of the original Lisière installation.')
    parser.add_argument('--output', required=True, help='New private directory; refused if it exists.')
    parser.add_argument('--source-retained', help='Retained workspace (workspace.context-room-retired-<16 hex>) after the cutover.')
    args = parser.parse_args()
    home = Path.home().resolve()
    data, documents = home / '.local/share/lisiere', home / 'Documents/Lisière'
    keystore = data / 'signing/development.keystore'
    workspace = data / 'workspace'
    if args.source_retained:
        workspace = Path(args.source_retained).resolve()
        if workspace.parent != data or not workspace.name.startswith('workspace.context-room-retired-') or len(workspace.name) != 47:
            raise ValueError('--source-retained must be the retained workspace inside ~/.local/share/lisiere.')
    database = workspace / DATABASE
    if not database.is_file() or not keystore.is_file():
        raise ValueError('The Lisière workspace database or signing/development.keystore is missing.')
    output = Path(os.path.abspath(args.output))
    for protected in (data, documents):
        if output == protected or protected in output.parents:
            raise ValueError('The backup must be written outside the Lisière data it copies.')
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.mkdir(output, 0o700)
    except FileExistsError:
        raise ValueError('The backup destination already exists; choose a new directory.') from None
    os.chmod(output, 0o700)

    entries, models = members(home, data, documents, workspace, bool(args.source_retained))
    expected = sum(path.stat().st_size for path, _, _ in entries if path.is_file() and not path.is_symlink())
    free = shutil.disk_usage(output).free
    if free < 2 * expected + (64 << 20):
        raise ValueError(f'Not enough free space: about {2 * expected >> 20} MiB needed, {free >> 20} MiB free.')

    source = readable_source(database, output)
    before = counts(source, documents)
    (output / 'counts-before.json').write_text(json.dumps(before, indent=2, sort_keys=True) + '\n')
    online = output / 'workspace-online.sqlite'
    online_copy(source, online)
    shutil.rmtree(output / '.source', ignore_errors=True)
    copied = counts(online, documents)
    if copied['tables'] != before['tables']:
        raise ValueError('The live database changed during the online copy. Retry the backup into a new directory.')

    sums, volatile = [], []
    archive = output / 'lisiere-data.tgz'
    with tarfile.open(archive, 'w:gz') as tar:
        for path, arcname, is_volatile in entries:
            if path.is_file() and not path.is_symlink():
                sums.append((sha256(path), arcname))
                if is_volatile:
                    volatile.append(arcname)
            tar.add(path, arcname=arcname, recursive=False)
    (output / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for digest, name in sums))
    (output / 'models.json').write_text(json.dumps(models, indent=2) + '\n')
    shutil.copyfile(keystore, output / 'development.keystore')
    os.chmod(output / 'development.keystore', 0o600)
    key_sha = sha256(keystore)
    if sha256(output / 'development.keystore') != key_sha:
        raise ValueError('The keystore copy differs from the original.')

    listed = subprocess.run(['tar', '-tzf', str(archive)], capture_output=True, text=True, check=True).stdout.splitlines()
    if len(listed) != len(entries):
        raise ValueError(f'The archive lists {len(listed)} entries, {len(entries)} expected.')
    verify = Path(tempfile.mkdtemp(prefix='lisiere-backup-verify-'))
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar.getmembers():
                if member.name.startswith('/') or '..' in Path(member.name).parts:
                    raise ValueError('Unsafe archive member: ' + member.name)
            tar.extractall(verify)
        mismatched = [name for digest, name in sums if name not in volatile and sha256(verify / name) != digest]
        if mismatched:
            raise ValueError('Files changed during the backup: ' + ', '.join(mismatched[:10]))
        key_member = keystore.relative_to(home).as_posix()
        if sha256(verify / key_member) != key_sha:
            raise ValueError('The archived keystore differs from the original.')
    finally:
        shutil.rmtree(verify, ignore_errors=True)

    for file in output.iterdir():
        os.chmod(file, 0o600)
    result = {'version': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
              'output': str(output), 'workspace': str(workspace), 'retained': bool(args.source_retained),
              'counts': before, 'sourceCopied': source != database, 'onlineCopyCounts': copied['tables'],
              'archive': {'members': len(entries), 'files': len(sums), 'bytes': archive.stat().st_size, 'sha256': sha256(archive)},
              'volatile': volatile, 'modelsExcluded': len(models), 'keystoreSha256': key_sha,
              'plists': [label for label in LABELS if (home / 'Library/LaunchAgents' / (label + '.plist')).is_file()],
              'verified': True}
    (output / 'manifest.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    os.chmod(output / 'manifest.json', 0o600)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
