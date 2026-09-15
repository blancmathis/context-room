"""Synthetic native-format ZIPs. No app, personal database, key or provider."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import warnings
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src'))
import lisiere_snapshot as snapshot
import lisiere_android_export as android


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def text(value):
    raw = value.encode('utf-16-be', errors='surrogatepass')
    return struct.pack('>i', len(raw) // 2) + raw


def binary(value):
    if value is None:
        return b'\x00'
    if type(value) is bool:
        return b'\x04' if value else b'\x05'
    if type(value) is int:
        return b'\x06' + struct.pack('>q', value)
    if type(value) is str:
        return b'\x03' + text(value)
    if type(value) is dict:
        return b'\x01' + struct.pack('>i', len(value)) + b''.join(text(k) + binary(v) for k, v in value.items())
    if type(value) is list:
        return b'\x02' + struct.pack('>i', len(value)) + b''.join(binary(v) for v in value)
    if type(value) is tuple and value[0] in (7, 8):
        return bytes([value[0]]) + struct.pack('>f' if value[0] == 7 else '>d', value[1])
    raise TypeError(value)


def write_zip(path, contents, manifest=None, entries=None, descriptor=False):
    files = [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in contents.items()]
    if manifest is None:
        rows = [json.loads(line) for line in contents['derived/outbox-args.jsonl'].splitlines()]
        count = sum(row['status'] == 'decoded' for row in rows)
        manifest = {'version': 1, 'mediaType': android.MEDIA_TYPE, 'sourcePackage': 'fr.lisiere.android',
                    'exporterVersionCode': 96, 'accepted': False, 'sourceUnchanged': True, 'files': files,
                    'queue': {'rows': len(rows), 'decoded': count, 'requiresReconciliation': len(rows) - count,
                              'encoding': 'android-org-json', 'delivery': 'not-inferred'},
                    'recordings': {'encoding': 'pcm-s16le', 'sampleRate': 16000, 'channels': 1, 'context': 'unassigned'}}
    else:
        manifest = json.loads(json.dumps(manifest))
        manifest['files'] = files
    class Stream(io.BytesIO):
        def seekable(self): return False
        def seek(self, *args): raise io.UnsupportedOperation('native streaming ZIP')
    stream = Stream() if descriptor else io.BytesIO()
    with warnings.catch_warnings(), zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        warnings.simplefilter('ignore', UserWarning)
        for name, data in (entries or list(contents.items())):
            archive.writestr(name, data)
        archive.writestr('manifest.json', packed(manifest) + b'\n')
    path.write_bytes(stream.getvalue())
    return manifest


def fixture(base, mode='wal', large=False):
    source = base / 'original'
    source.mkdir(mode=0o700)
    database = source / 'workspace.sqlite'
    connection = sqlite3.connect(database)
    connection.executescript('''
      PRAGMA user_version=1;
      CREATE TABLE android_metadata(locale TEXT);
      CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args BLOB,error TEXT);
      CREATE TABLE board_headers(board TEXT PRIMARY KEY,value BLOB);
      CREATE TABLE board_objects(board TEXT,id TEXT,value BLOB,PRIMARY KEY(board,id));
    ''')
    args = {'board': 'free-board', 'operationId': 'draw-1', 'revision': 9223372036854775807,
            'point': {'x': (7, 0.1), 'y': (8, 0.2), 'pressure': (7, 0.5)}, 'label': 'Ink 🖊️'}
    if large:
        args['data'] = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'x' * (3 * 1024 * 1024)).decode()
    raw = b'LSJ1' + binary(args)
    wire = '{"board":"free-board","operationId":"draw-1","revision":9223372036854775807,"point":{"x":0.1,"y":0.2,"pressure":0.5},"label":"Ink 🖊️"'
    if large:
        wire += ',"data":' + json.dumps(args['data'])
    wire += '}'
    records = [(9007199254740993, 'draw-1', 'board.mutate', raw, wire),
               (9007199254740994, 'unknown-2', 'future.operation', b'LSJ1\x7f', None)]
    connection.execute('INSERT INTO android_metadata VALUES(?)', ('en_US',))
    connection.execute('INSERT INTO cache VALUES(?,?)', ('draftdoc:p:Idea.md', 'committed original'))
    connection.executemany('INSERT INTO outbox VALUES(?,?,?,?,NULL)', [row[:4] for row in records])
    connection.commit()
    if mode == 'wal':
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA wal_autocheckpoint=0')
        connection.execute('UPDATE cache SET value=?', ('committed WAL original',))
        connection.commit()
    if mode in ('journal', 'hot'):
        connection.execute('PRAGMA journal_mode=PERSIST')
        connection.execute('UPDATE cache SET value=?', ('committed journal original',))
        connection.commit()
    if mode == 'hot':
        connection.close()
        script = '''import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=PERSIST'); c.execute('PRAGMA cache_size=2')
c.execute('BEGIN IMMEDIATE'); c.execute('UPDATE cache SET value=?', ('uncommitted dirty data'*50000,)); os._exit(0)
'''
        subprocess.run([sys.executable, '-B', '-c', script, str(database)], check=True, timeout=20)
    contents = {'workspace/workspace.sqlite': database.read_bytes()}
    for suffix in ('-wal', '-journal'):
        entry = Path(str(database) + suffix)
        if entry.exists(): contents['workspace/' + entry.name] = entry.read_bytes()
    # Native validation reads a COPY. This fixture likewise does not recover or
    # checkpoint the original journals merely to build the derived rows.
    lines = []
    for seq, identity, operation, raw, wire in records:
        row = {'seq': str(seq), 'id': identity, 'operation': operation, 'sourceEncoding': 'blob',
               'sourceArgsBytes': len(raw), 'sourceArgsSha256': hashlib.sha256(raw).hexdigest(),
               'status': 'decoded' if wire is not None else 'requires-reconciliation'}
        if wire is not None: row['argsJson'] = wire
        lines.append(packed(row) + b'\n')
    contents['derived/outbox-args.jsonl'] = b''.join(lines)
    contents['recordings/' + 'a' * 64 + '.pcm'] = b'\x00\x00\x01\x00' * 8000
    archive = base / 'android-recovery.zip'
    manifest = write_zip(archive, contents)
    if mode != 'hot': connection.close()
    return archive, contents, manifest


class AndroidExportContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='context-room-android-zip-test-')
        self.base = Path(self.temporary.name).resolve()
        self.archive, self.contents, self.native = fixture(self.base)
        self.original = self.archive.read_bytes()
        self.output = self.base / 'snapshot'

    def tearDown(self):
        self.temporary.cleanup()

    def plan(self):
        return snapshot.snapshot(self.archive)

    def apply(self, plan=None):
        plan = self.plan() if plan is None else plan
        return snapshot.export(self.archive, self.output, plan['revision'])

    def refused(self):
        with self.assertRaises((ValueError, OSError, sqlite3.DatabaseError, zipfile.BadZipFile, EOFError, UnicodeError)):
            self.plan()
        self.assertFalse(self.output.exists())

    def test_preview_apply_and_second_execution_keep_every_derivative_and_stable_identity(self):
        preview = self.plan()
        self.assertEqual(preview['version'], 3)
        self.assertFalse(preview['accepted'])
        self.assertEqual(preview['revision'], self.plan()['revision'])
        self.assertFalse(self.output.exists())
        copied = self.base / 'same-bytes-other-inode.zip'
        shutil.copyfile(self.archive, copied)
        self.assertEqual(preview['revision'], snapshot.snapshot(copied)['revision'])
        applied = self.apply(preview)
        self.assertEqual(applied, preview)
        before = {str(p.relative_to(self.output)): p.read_bytes() for p in self.output.rglob('*') if p.is_file()}
        self.assertEqual(self.apply(preview), applied)
        self.assertEqual(before, {str(p.relative_to(self.output)): p.read_bytes() for p in self.output.rglob('*') if p.is_file()})
        self.assertEqual(self.archive.read_bytes(), self.original)
        self.assertEqual((self.output / 'derived/outbox-args.jsonl').read_bytes(), self.contents['derived/outbox-args.jsonl'])
        self.assertIn(b'committed WAL original', (self.output / 'tables/cache.jsonl').read_bytes())
        self.assertIn(b'9007199254740993', (self.output / 'tables/outbox.jsonl').read_bytes())
        self.assertEqual(applied['androidExport']['verification']['floatingRows'], 1)
        for p in self.output.rglob('*'):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o700 if p.is_dir() else 0o600)
            if p.is_file(): self.assertEqual(p.stat().st_nlink, 1)

    def test_native_streaming_data_descriptors(self):
        write_zip(self.archive, self.contents, descriptor=True)
        self.apply()

    def test_clean_persist_and_hot_rollback_journals_are_recovered_only_on_private_copies(self):
        for mode in ('journal', 'hot'):
            with self.subTest(mode=mode):
                base = self.base / mode; base.mkdir()
                archive, contents, native = fixture(base, mode)
                original_db = (base / 'original/workspace.sqlite').read_bytes()
                original_journal = (base / 'original/workspace.sqlite-journal').read_bytes()
                self.assertIn('workspace/workspace.sqlite-journal', contents)
                if mode == 'hot': self.assertNotEqual(original_journal[:8], b'\0' * 8)
                plan = snapshot.snapshot(archive)
                snapshot.export(archive, base / 'snapshot', plan['revision'])
                recovered = (base / 'snapshot/tables/cache.jsonl').read_bytes()
                self.assertIn(b'committed journal original', recovered)
                self.assertNotIn(b'uncommitted dirty', recovered)
                self.assertEqual((base / 'original/workspace.sqlite').read_bytes(), original_db)
                self.assertEqual((base / 'original/workspace.sqlite-journal').read_bytes(), original_journal)

    def test_occupied_or_changed_destinations_are_not_overwritten(self):
        self.output.mkdir(mode=0o700)
        (self.output / 'recent-work').write_bytes(b'newer work')
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual((self.output / 'recent-work').read_bytes(), b'newer work')
        shutil.rmtree(self.output)
        self.apply()
        target = self.output / 'tables/cache.jsonl'
        target.write_bytes(b'newer content')
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(target.read_bytes(), b'newer content')

    def test_changed_source_requires_a_new_preview(self):
        preview = self.plan()
        native = {**self.native, 'exporterVersionCode': 97}
        write_zip(self.archive, self.contents, native)
        with self.assertRaisesRegex(ValueError, 'changed after'): self.apply(preview)
        self.assertFalse(self.output.exists())

    def test_killed_publication_resumes_a_partial_journal_without_hardlinks(self):
        plan = self.plan()
        code = '''import os,sys
sys.path.insert(0,sys.argv[1]); import lisiere_snapshot as s
write=os.write
def interrupted(fd,data):
 n=write(fd,data[:128]); os.fsync(fd); os.kill(os.getpid(),9); return n
publish=s._publish_snapshot_file
def publish_and_interrupt(*args,**kwargs):
 os.write=interrupted
 return publish(*args,**kwargs)
s._publish_snapshot_file=publish_and_interrupt
s.export(sys.argv[2],sys.argv[3],sys.argv[4])
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(ROOT / 'src'), str(self.archive), str(self.output), plan['revision']], timeout=30, capture_output=True)
        self.assertEqual(result.returncode, -9, result.stderr.decode())
        journal = self.output / 'export-journal.json'
        self.assertEqual(journal.stat().st_size, 128)
        self.assertEqual(journal.stat().st_nlink, 1)
        self.assertFalse((self.output / 'manifest.json').exists())
        self.apply(plan)
        self.assertEqual(journal.read_bytes(), (self.output / 'manifest.json').read_bytes())
        self.assertEqual(self.archive.read_bytes(), self.original)

    def test_different_partial_prefix_and_completed_truncation_fail_closed(self):
        self.apply()
        target = self.output / 'tables/cache.jsonl'
        saved = target.read_bytes()
        target.write_bytes(saved[:3])
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(target.read_bytes(), saved[:3])
        (self.output / 'manifest.json').unlink()
        target.write_bytes(b'wrong prefix')
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(target.read_bytes(), b'wrong prefix')

    def test_truncated_corrupt_and_false_hash_archives(self):
        self.archive.write_bytes(self.original[:-1]); self.refused()
        self.archive.write_bytes(b'not a ZIP'); self.refused()
        changed = dict(self.contents); changed['workspace/workspace.sqlite'] = b'broken sqlite bytes'
        write_zip(self.archive, changed); self.refused()
        native = self.native.copy()
        with zipfile.ZipFile(io.BytesIO(self.original)) as source, zipfile.ZipFile(self.archive, 'w') as target:
            for item in source.infolist():
                data = source.read(item.filename)
                if item.filename == 'manifest.json':
                    value = json.loads(data); value['files'][0]['sha256'] = '0' * 64; data = packed(value)
                target.writestr(item.filename, data)
        self.refused()

    def test_paths_duplicates_symlinks_and_manifest_key_collisions(self):
        for name in ('../escape', '/absolute', 'workspace/../escape', 'workspace\\escape', 'workspace//workspace.sqlite', 'recordings/unknown.pcm'):
            with self.subTest(name=name):
                entries = list(self.contents.items()) + [(name, b'unsafe')]
                write_zip(self.archive, self.contents, entries=entries); self.refused()
        entries = list(self.contents.items()) + [next(iter(self.contents.items()))]
        write_zip(self.archive, self.contents, entries=entries); self.refused()
        link = zipfile.ZipInfo('workspace/workspace.sqlite'); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        entries = [(link, b'/private/source')] + list(self.contents.items())[1:]
        write_zip(self.archive, self.contents, entries=entries); self.refused()
        write_zip(self.archive, self.contents)
        with zipfile.ZipFile(self.archive) as source:
            values = [(i.filename, source.read(i.filename)) for i in source.infolist()]
        with zipfile.ZipFile(self.archive, 'w') as target:
            for name, data in values:
                if name == 'manifest.json': data = b'{"version":1,' + data[1:]
                target.writestr(name, data)
        self.refused()

    def test_source_and_destination_links_are_refused(self):
        linked = self.base / 'linked.zip'; os.link(self.archive, linked)
        self.refused(); linked.unlink()
        linked.symlink_to(self.archive)
        with self.assertRaises(ValueError): snapshot.snapshot(linked)
        linked.unlink()
        self.output.symlink_to(self.base / 'elsewhere')
        with self.assertRaises((ValueError, OSError)): self.apply()
        self.assertTrue(self.output.is_symlink())

    def test_decompression_bound_is_checked_before_any_original_is_extracted(self):
        opened = []
        original_open = zipfile.ZipFile.open
        def traced(archive, name, *args, **kwargs):
            opened.append(name.filename if isinstance(name, zipfile.ZipInfo) else name)
            return original_open(archive, name, *args, **kwargs)
        with patch.object(android, 'LIMIT', 10000), patch.object(zipfile.ZipFile, 'open', traced): self.refused()
        self.assertEqual(opened, ['manifest.json'])

    def test_pcm_format_odd_size_and_oversized_audio_are_refused(self):
        audio = next(name for name in self.contents if name.startswith('recordings/'))
        for raw in (b'odd', b'\0' * (16000 * 2 * 120 + 2)):
            changed = {**self.contents, audio: raw}; write_zip(self.archive, changed); self.refused()
        native = json.loads(json.dumps(self.native)); native['recordings']['sampleRate'] = 48000
        write_zip(self.archive, self.contents, native); self.refused()

    def test_each_derived_row_is_bound_to_original_bytes_and_typed_arguments(self):
        changes = {'seq': '9007199254740992', 'id': 'other', 'operation': 'board.create', 'sourceEncoding': 'text',
                   'sourceArgsBytes': 1, 'sourceArgsSha256': '0' * 64, 'status': 'acknowledged',
                   'argsJson': '{"board":"different"}'}
        for key, value in changes.items():
            with self.subTest(key=key):
                rows = [json.loads(line) for line in self.contents['derived/outbox-args.jsonl'].splitlines()]
                rows[0][key] = value
                changed = {**self.contents, 'derived/outbox-args.jsonl': b''.join(packed(row) + b'\n' for row in rows)}
                write_zip(self.archive, changed); self.refused()
        for before, after in (('9223372036854775807', '9223372036854775806'), ('"x":0.1', '"x":0.2'), ('"pressure":0.5', '"pressure":true')):
            rows = [json.loads(line) for line in self.contents['derived/outbox-args.jsonl'].splitlines()]
            rows[0]['argsJson'] = rows[0]['argsJson'].replace(before, after)
            changed = {**self.contents, 'derived/outbox-args.jsonl': b''.join(packed(row) + b'\n' for row in rows)}
            write_zip(self.archive, changed); self.refused()

    def test_unknown_rows_stay_retained_and_cannot_claim_decoded_arguments(self):
        plan = self.plan()
        self.assertEqual(plan['androidExport']['queue']['requiresReconciliation'], 1)
        self.assertEqual(plan['androidExport']['delivery'], 'not-inferred')
        rows = [json.loads(line) for line in self.contents['derived/outbox-args.jsonl'].splitlines()]
        rows[1]['argsJson'] = '{}'
        changed = {**self.contents, 'derived/outbox-args.jsonl': b''.join(packed(row) + b'\n' for row in rows)}
        write_zip(self.archive, changed); self.refused()

    def test_missing_extra_out_of_order_rows_and_counts_are_refused(self):
        rows = self.contents['derived/outbox-args.jsonl'].splitlines(keepends=True)
        for bad in (rows[:1], rows + rows[:1], list(reversed(rows))):
            write_zip(self.archive, {**self.contents, 'derived/outbox-args.jsonl': b''.join(bad)})
            self.refused()
        native = json.loads(json.dumps(self.native)); native['queue']['decoded'] = 0
        write_zip(self.archive, self.contents, native); self.refused()

    def test_unknown_sqlite_tables_columns_views_and_future_versions(self):
        for sql in ('CREATE TABLE surprise(secret TEXT)', 'ALTER TABLE cache ADD COLUMN unexpected TEXT',
                    'CREATE VIEW surprise AS SELECT * FROM outbox', 'PRAGMA user_version=2'):
            with self.subTest(sql=sql):
                # Normalize our synthetic WAL first, then edit only a disposable fixture.
                with android.read_android_export(self.archive) as (copy, _):
                    database = sqlite3.connect(copy / 'workspace/workspace.sqlite')
                    try:
                        database.execute(sql); database.commit()
                        database.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                    finally:
                        database.close()
                    data = (copy / 'workspace/workspace.sqlite').read_bytes()
                contents = {k: v for k, v in self.contents.items() if not k.endswith(('-wal', '-journal'))}
                contents['workspace/workspace.sqlite'] = data
                write_zip(self.archive, contents); self.refused()
                self.archive.write_bytes(self.original)

    def test_large_binary_original_is_retained_without_javascript_number_reserialization(self):
        base = self.base / 'large'; base.mkdir()
        archive, contents, native = fixture(base, large=True)
        plan = snapshot.snapshot(archive)
        snapshot.export(archive, base / 'snapshot', plan['revision'])
        self.assertEqual((base / 'snapshot/derived/outbox-args.jsonl').read_bytes(), contents['derived/outbox-args.jsonl'])
        self.assertGreater(len(contents['derived/outbox-args.jsonl']), 4 * 1024 * 1024)

    def test_float_and_double_negative_zero_exact_int64_and_structure_limits(self):
        for tag in (7, 8):
            raw = android.decode_binary(b'LSJ1' + binary({'x': (tag, -0.0)}))
            android.arguments_agree(raw, android.json_object('{"x":-0}', numbers=True))
            with self.assertRaises(ValueError): android.arguments_agree(raw, android.json_object('{"x":0}', numbers=True))
        for raw in (b'LSJ1\x01\xff\xff\xff\xff', b'LSJ1\x01\x00\x00\x00\x01', b'LSJ1\x07\x7f\x80\x00\x00'):
            with self.assertRaises(ValueError): android.decode_binary(raw)
        nested = None
        for _ in range(258): nested = [nested]
        with self.assertRaises(ValueError): android.decode_binary(b'LSJ1' + binary({'x': nested}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        base = Path(sys.argv[2]).resolve(); base.mkdir(parents=True, exist_ok=True)
        archive, _, _ = fixture(base)
        print(json.dumps({'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
    else:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AndroidExportContracts))
        if not result.wasSuccessful(): sys.exit(1)
        print(str(result.testsRun) + ' Android ZIP contracts passed')
