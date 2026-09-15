"""Synthetic real SQLite files; never opens personal Lisiere data."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lisiere_snapshot', Path(__file__).resolve().parents[2] / 'src/lisiere_snapshot.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='context-room-legacy-snapshot-')
        self.base = Path(self.temporary.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir(mode=0o700)
        self.database = self.source / 'workspace.sqlite'

    def tearDown(self):
        self.temporary.cleanup()

    def mac(self):
        db = sqlite3.connect(self.database)
        db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,root TEXT);
          CREATE TABLE boards(id TEXT PRIMARY KEY,title TEXT,project TEXT,anchor TEXT,revision INTEGER);
          CREATE TABLE objects(board TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(board,id));
          CREATE TABLE drafts(project TEXT,path TEXT,device TEXT,base TEXT,content TEXT,version INTEGER,PRIMARY KEY(project,path,device));
          CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT,token TEXT,created REAL);
          CREATE TABLE pairs(token TEXT PRIMARY KEY,expires REAL);
          CREATE TABLE native_requests(id TEXT PRIMARY KEY,conversation TEXT,text TEXT,context TEXT,grant_hash TEXT,prompt TEXT,active INTEGER);
          INSERT INTO projects VALUES('project','Synthetic project','/synthetic/project');
          INSERT INTO boards VALUES('board','Ideas','project','{"path":"docs/Idea.md"}',4);
          INSERT INTO objects VALUES('board','deleted',2,NULL);
          INSERT INTO objects VALUES('board','stroke',4,'{"type":"ink","points":[[10,20,0.7]]}');
          INSERT INTO drafts VALUES('project','docs/Idea.md','old-device','base-hash','Unsent human draft',7);
          INSERT INTO devices VALUES('old-device','Synthetic tablet','PAIRING_VALUE_NOT_CONTENT',1.0);
          INSERT INTO pairs VALUES('ONE_USE_VALUE_NOT_CONTENT',99.0);
          INSERT INTO native_requests VALUES('request','old-conversation','Original unsent question','{"path":"docs/Idea.md"}','GRANT_HASH_NOT_CONTENT','COMMAND_WITH_GRANT_NOT_CONTENT',1);
        ''')
        db.commit()
        return db

    def table(self, manifest, name, directory):
        table = next(item for item in manifest['tables'] if item['name'] == name)
        return [dict(zip(table['columns'], json.loads(line))) for line in (directory / table['path']).read_text().splitlines()]

    def test_mac_wal_snapshot_preserves_data_and_excludes_operational_credentials(self):
        with self.mac() as db:
            original = self.database.read_bytes()
            wal = Path(str(self.database) + '-wal').read_bytes()
            plan = snapshot.snapshot(self.source)
            output = self.base / 'export'
            exported = snapshot.export(self.source, output, plan['revision'])
            self.assertEqual(exported, plan)
            self.assertEqual(self.table(exported, 'objects', output)[0]['data'], None)
            self.assertEqual(self.table(exported, 'drafts', output)[0]['content'], 'Unsent human draft')
            self.assertEqual(self.table(exported, 'native_requests', output)[0]['text'], 'Original unsent question')
            contents = b''.join(file.read_bytes() for file in output.rglob('*') if file.is_file())
            for secret in [b'PAIRING_VALUE_NOT_CONTENT', b'ONE_USE_VALUE_NOT_CONTENT', b'GRANT_HASH_NOT_CONTENT', b'COMMAND_WITH_GRANT_NOT_CONTENT']:
                self.assertNotIn(secret, contents)
            self.assertEqual(self.database.read_bytes(), original)
            self.assertEqual(Path(str(self.database) + '-wal').read_bytes(), wal)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            for file in output.rglob('*'):
                if file.is_file():
                    self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(db.execute('SELECT count(*) FROM devices').fetchone()[0], 1)

    def test_changed_revision_refuses_export_and_keeps_destination_absent(self):
        with self.mac() as db:
            plan = snapshot.snapshot(self.source)
            db.execute("UPDATE drafts SET content='Later human draft',version=8")
            db.commit()
            with self.assertRaisesRegex(ValueError, 'changed after'):
                snapshot.export(self.source, self.base / 'stale', plan['revision'])
            self.assertFalse((self.base / 'stale').exists())
            self.assertFalse(list(self.base.glob('.context-room-snapshot-*')))

    def test_android_compressed_objects_and_exact_large_integer_survive(self):
        with sqlite3.connect(self.database) as db:
            db.executescript('''PRAGMA user_version=1;
              CREATE TABLE android_metadata (locale TEXT);
              INSERT INTO android_metadata VALUES('fr_FR');
              CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT);
              CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);
              CREATE TABLE board_headers(board TEXT PRIMARY KEY,value TEXT);
              CREATE TABLE board_objects(board TEXT,id TEXT,value TEXT,PRIMARY KEY(board,id));''')
            payload = b'\x00\x1f\x8bcompressed-stroke\xff'
            db.execute('INSERT INTO board_objects VALUES(?,?,?)', ('board', 'stroke', payload))
            db.execute('INSERT INTO cache VALUES(?,?)', ('draftdoc:project:Idea.md', 'Unsent draft 🖊️'))
            db.execute('INSERT INTO outbox VALUES(?,?,?,?,?)', (9007199254740993, 'op', 'board.mutate', '{"expectedRevision":4}', 'uncertain'))
        plan = snapshot.snapshot(self.source)
        output = self.base / 'android'
        snapshot.export(self.source, output, plan['revision'])
        self.assertEqual(base64.b64decode(self.table(plan, 'board_objects', output)[0]['value']['base64']), payload)
        self.assertEqual(self.table(plan, 'outbox', output)[0]['seq'], {'integer': '9007199254740993'})
        self.assertEqual(self.table(plan, 'cache', output)[0]['value'], 'Unsent draft 🖊️')
        self.assertEqual(self.table(plan, 'android_metadata', output), [{'locale': 'fr_FR'}])

    def test_asset_identity_and_bytes_are_verified(self):
        with self.mac():
            assets = self.source / 'assets'
            assets.mkdir()
            data = b'Original synthetic asset bytes'
            sha = hashlib.sha256(data).hexdigest()
            file = assets / sha
            file.write_bytes(data)
            plan = snapshot.snapshot(self.source)
            output = self.base / 'assets-export'
            snapshot.export(self.source, output, plan['revision'])
            self.assertEqual((output / 'assets' / sha).read_bytes(), data)
            file.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'content identity'):
                snapshot.snapshot(self.source)

    def test_symbolic_database_assets_and_destination_are_refused(self):
        with self.mac():
            alias = self.base / 'alias'
            alias.symlink_to(self.source, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symbolic'):
                snapshot.snapshot(alias)
            assets = self.source / 'assets'
            assets.symlink_to(self.base / 'missing', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symbolic'):
                snapshot.snapshot(self.source)
            assets.unlink()
            plan = snapshot.snapshot(self.source)
            with self.assertRaisesRegex(ValueError, 'symbolic'):
                snapshot.export(self.source, alias / 'nested', plan['revision'])

    def test_existing_destination_is_never_replaced(self):
        with self.mac():
            plan = snapshot.snapshot(self.source)
            output = self.base / 'occupied'
            output.mkdir()
            (output / 'human.txt').write_text('Keep this file')
            with self.assertRaisesRegex(ValueError, 'new private destination'):
                snapshot.export(self.source, output, plan['revision'])
            self.assertEqual((output / 'human.txt').read_text(), 'Keep this file')

    def test_interrupted_export_resumes_exactly_and_rejects_changed_destination_bytes(self):
        with self.mac():
            plan = snapshot.snapshot(self.source)
            output = self.base / 'recoverable'
            original_link = os.link
            calls = [0]
            def interrupt(*args, **kwargs):
                calls[0] += 1
                if calls[0] == 4:
                    raise OSError('Synthetic publication interruption')
                return original_link(*args, **kwargs)
            with patch.object(os, 'link', interrupt):
                with self.assertRaisesRegex(OSError, 'Synthetic publication'):
                    snapshot.export(self.source, output, plan['revision'])
            self.assertTrue((output / 'export-journal.json').is_file())
            self.assertFalse((output / 'manifest.json').exists())
            self.assertEqual(snapshot.export(self.source, output, plan['revision']), plan)
            self.assertEqual(snapshot.export(self.source, output, plan['revision']), plan)
            for entry in plan['files']:
                self.assertEqual(hashlib.sha256((output / entry['path']).read_bytes()).hexdigest(), entry['sha256'])
            modified = output / plan['files'][0]['path']
            modified.write_text('Later independent change')
            with self.assertRaisesRegex(ValueError, 'different data'):
                snapshot.export(self.source, output, plan['revision'])
            self.assertEqual(modified.read_text(), 'Later independent change')

    def test_unknown_schema_is_not_silently_dropped(self):
        with self.mac() as db:
            db.execute('CREATE TABLE unknown_future_state(value TEXT)')
            db.commit()
            with self.assertRaisesRegex(ValueError, 'Unsupported legacy database schema'):
                snapshot.snapshot(self.source)
            db.execute('DROP TABLE unknown_future_state')
            db.execute('ALTER TABLE drafts ADD COLUMN future_edit_journal TEXT')
            db.commit()
            with self.assertRaisesRegex(ValueError, 'Unsupported columns'):
                snapshot.snapshot(self.source)

    def test_future_version_and_absent_preview_are_refused(self):
        with self.mac() as db:
            with self.assertRaisesRegex(ValueError, 'exact revision'):
                snapshot.export(self.source, self.base / 'unplanned', None)
            db.execute('PRAGMA user_version=99')
            with self.assertRaisesRegex(ValueError, 'Unsupported legacy database version'):
                snapshot.snapshot(self.source)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SnapshotContracts))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(str(result.testsRun) + ' legacy snapshot contracts passed')
