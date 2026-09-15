"""Wholly synthetic job/frame transactions, without the legacy executor."""
import copy
import json
from pathlib import Path
import sqlite3
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from lisiere_reconcile import reconcile
from lisiere_reconcile_test import fixture, queue, raw, sha


def pen_fixture(status='stopped'):
    f = fixture()
    original = {'board': 'board', 'operationId': 'gesture', 'durationMs': 900, 'operations': [
        {'id': 'ink', 'expectedRevision': 0, 'value': {'type': 'ink', 'width': 2, 'points': [[0, 0, 1], [25, 0, 0.5], [100, 0, 1]]}}]}
    prefix = {'id': 'ink', 'type': 'ink', 'width': 2, 'points': [[0, 0, 1], [25, 0, 0.5]], 'revision': 3, 'actor': 'tablet'}
    early = dict(prefix, revision=1, points=[[0, 0, 1]])
    data = {'id': 'gesture', 'board': 'board', 'actor': 'tablet', 'lease': 'original-turn', 'status': status,
            'frame': 2, 'durationMs': 900, 'objects': [prefix], 'tip': [25, 0], 'project': None}
    f['mac']['pen_jobs'] = [{'id': 'gesture', 'board': 'board', 'actor': 'tablet', 'status': status,
                             'digest': sha(['board', original['operations'], 900, 'tablet', 'original-turn']), 'data': raw(data)}]
    f['mac']['history'] = [{'id': 'pen:gesture', 'board': 'board', 'actor': 'tablet', 'undone': 0, 'time': 1,
                            'changes': raw([{'id': 'ink', 'before': None, 'after': prefix, 'afterRevision': 3}])}]
    f['mac']['events'] = [{'seq': {'integer': str(9007199254740993 + n)}, 'kind': 'board', 'entity': 'board', 'time': 1 + n,
                         'data': raw({'revision': rev, 'operationId': 'pen:gesture:' + str(n + 1), 'actor': 'tablet'})}
                        for n, rev in enumerate([1, 3])]
    f['mac']['boards'][0]['revision'] = 4
    f['mac']['objects'] = [{'board': 'board', 'id': 'ink', 'revision': 3, 'data': raw(prefix)},
                          {'board': 'board', 'id': 'independent', 'revision': 4,
                           'data': raw({'id': 'independent', 'type': 'rect', 'x': 40, 'y': 40, 'w': 60, 'h': 50, 'revision': 4, 'actor': 'human'})}]
    return f, original, data, early


class PenRecoveryContracts(unittest.TestCase):
    def test_all_recorded_states_preserve_only_committed_geometry(self):
        for status in ['drawing', 'stopped', 'interrupted', 'completed']:
            with self.subTest(status=status):
                f, _, _, _ = pen_fixture(status); before = copy.deepcopy(f)
                result = reconcile(f); self.assertFalse(result['blocked'])
                proof = result['penRecovery']['jobs'][0]
                self.assertEqual(proof['recordedStatus'], status)
                self.assertEqual(proof['lastCommittedFrame'], 2)
                self.assertEqual(proof['lastCommittedRevision'], 3)
                self.assertEqual(proof['frames'][0]['seq'], '9007199254740993')
                self.assertFalse(proof['completedRequestProven'])
                self.assertFalse(result['penRecovery']['framesReplayed'])
                self.assertEqual(result['objects'], f['mac']['objects'])
                self.assertEqual(f, before); self.assertEqual(reconcile(f), result)

    def test_one_committed_frame_ahead_of_job_descriptor_recovers_group_not_stale_points(self):
        f, _, data, early = pen_fixture('drawing')
        data.update(frame=1, objects=[early], tip=[0, 0]); f['mac']['pen_jobs'][0]['data'] = raw(data)
        result = reconcile(f); self.assertFalse(result['blocked'])
        self.assertEqual(result['penRecovery']['jobs'][0]['descriptor'], 'lagging-one-committed-frame')
        self.assertEqual(json.loads(result['objects'][0]['data'])['points'][-1], [25, 0, 0.5])

    def test_crash_before_first_descriptor_and_before_any_frame(self):
        for frame_committed in [False, True]:
            f, _, _, early = pen_fixture('interrupted'); f['mac']['pen_jobs'][0]['data'] = '{}'
            f['mac']['events'] = f['mac']['events'][:1] if frame_committed else []
            f['mac']['history'] = f['mac']['history'] if frame_committed else []
            if frame_committed:
                f['mac']['history'][0]['changes'] = raw([{'id': 'ink', 'before': None, 'after': early, 'afterRevision': 1}])
                f['mac']['objects'][0].update(revision=1, data=raw(early))
            else: f['mac']['objects'] = f['mac']['objects'][1:]
            result = reconcile(f); self.assertFalse(result['blocked'])
            self.assertEqual(result['penRecovery']['jobs'][0]['lastCommittedFrame'], int(frame_committed))

    def test_failed_attempt_counter_is_not_a_committed_frame(self):
        f, _, data, _ = pen_fixture('interrupted'); data.update(frame=3, error={'code': 'conflict'})
        f['mac']['pen_jobs'][0]['data'] = raw(data)
        result = reconcile(f); self.assertFalse(result['blocked'])
        proof = result['penRecovery']['jobs'][0]
        self.assertEqual(proof['descriptor'], 'failed-uncommitted-attempt'); self.assertEqual(proof['lastCommittedFrame'], 2)

    def test_undone_group_requires_canonical_revisions_to_have_advanced(self):
        f, _, _, _ = pen_fixture()
        f['mac']['history'][0]['undone'] = 1
        result = reconcile(f)
        self.assertTrue(result['blocked'])
        self.assertEqual(result['penRecovery']['jobs'][0]['reason'], 'pen-undo-canonical-not-advanced')

    def test_restart_status_overlay_does_not_invent_completion(self):
        f, _, data, _ = pen_fixture('interrupted'); data['status'] = 'drawing'
        f['mac']['pen_jobs'][0]['data'] = raw(data)
        self.assertFalse(reconcile(f)['blocked'])
        data['status'] = 'completed'; f['mac']['pen_jobs'][0]['data'] = raw(data)
        self.assertTrue(reconcile(f)['blocked'])

    def test_newer_human_edit_or_deletion_survives_and_blocks_old_undo(self):
        for deletion in [False, True]:
            f, _, _, _ = pen_fixture()
            f['mac']['objects'][0].update(revision=4, data=None if deletion else raw({'id': 'ink', 'type': 'text', 'text': 'Recent human work', 'revision': 4}))
            before = copy.deepcopy(f['mac']['objects']); result = reconcile(f)
            self.assertFalse(result['blocked']); self.assertEqual(result['objects'], before)
            self.assertEqual(result['penRecovery']['jobs'][0]['newerCanonicalObjects'], ['ink'])
            queue(f, 'board.undo', {'id': 'pen:gesture', 'operationId': 'undo'})
            result = reconcile(f); self.assertTrue(result['blocked'])
            self.assertEqual(result['operations'][0]['reason'], 'object-concurrent-change'); self.assertEqual(result['objects'], before)

    def test_group_undo_uses_actual_last_object_revision_not_global_board_revision(self):
        f, _, _, _ = pen_fixture()
        queue(f, 'board.undo', {'id': 'pen:gesture', 'operationId': 'undo'})
        result = reconcile(f); self.assertFalse(result['blocked'])
        self.assertEqual(result['revisionMapping'][0]['effectiveExpected'], 3)
        self.assertIsNone(result['objects'][0]['data']); self.assertEqual(result['objects'][1], f['mac']['objects'][1])
        self.assertEqual(result['objects'][0]['revision'], 5)

    def test_previously_undone_prefix_is_history_not_current_content(self):
        f, _, _, _ = pen_fixture(); f['mac']['history'][0]['undone'] = 1
        f['mac']['objects'][0].update(revision=4, data=None)
        result = reconcile(f); self.assertFalse(result['blocked']); self.assertIsNone(result['objects'][0]['data'])
        self.assertTrue(result['penRecovery']['jobs'][0]['undone'])

    def test_gap_duplicate_wrong_actor_and_revision_are_conflicts(self):
        for variant in ['gap', 'duplicate', 'actor', 'revision', 'sequence', 'future']:
            with self.subTest(variant=variant):
                f, _, _, _ = pen_fixture()
                if variant == 'gap': f['mac']['events'].pop(0)
                elif variant == 'duplicate':
                    extra = copy.deepcopy(f['mac']['events'][-1]); extra['seq'] = {'integer': '9007199254740999'}; f['mac']['events'].append(extra)
                elif variant == 'sequence':
                    f['mac']['events'][-1]['seq'] = f['mac']['events'][0]['seq']
                    with self.assertRaises(ValueError): reconcile(f)
                    continue
                else:
                    value = json.loads(f['mac']['events'][-1]['data'])
                    value.update({'actor': 'other'} if variant == 'actor' else {'revision': 1 if variant == 'revision' else 99})
                    f['mac']['events'][-1]['data'] = raw(value)
                self.assertTrue(reconcile(f)['blocked'])

    def test_orphan_jobs_history_and_events_are_never_silently_dropped(self):
        for missing in ['pen_jobs', 'history', 'events']:
            f, _, _, _ = pen_fixture(); f['mac'][missing] = []
            self.assertTrue(reconcile(f)['blocked'])

    def test_changed_prefix_and_nonnew_before_refuse(self):
        for variant in ['before', 'after', 'canonical', 'descriptor', 'ahead']:
            f, _, data, _ = pen_fixture()
            changes = json.loads(f['mac']['history'][0]['changes'])
            if variant == 'before': changes[0]['before'] = {'revision': 2}
            if variant == 'after': changes[0]['after']['points'][-1][0] = 99
            f['mac']['history'][0]['changes'] = raw(changes)
            if variant == 'canonical': f['mac']['objects'][0]['data'] = f['mac']['objects'][0]['data'].replace('25', '99')
            if variant == 'descriptor': data['objects'][0]['points'][-1][0] = 99
            if variant == 'ahead': data['frame'] = 4
            f['mac']['pen_jobs'][0]['data'] = raw(data)
            self.assertTrue(reconcile(f)['blocked'])

    def test_multiple_objects_keep_their_own_last_frame_across_pen_lifts(self):
        f, _, data, early = pen_fixture()
        later = dict(data['objects'][0], id='next')
        data['objects'] = [early, later]; f['mac']['pen_jobs'][0]['data'] = raw(data)
        f['mac']['history'][0]['changes'] = raw([
            {'id': 'ink', 'before': None, 'after': early, 'afterRevision': 1},
            {'id': 'next', 'before': None, 'after': later, 'afterRevision': 3}])
        f['mac']['objects'][0].update(revision=1, data=raw(early))
        f['mac']['objects'].append({'board': 'board', 'id': 'next', 'revision': 3, 'data': raw(later)})
        queue(f, 'board.undo', {'id': 'pen:gesture', 'operationId': 'undo'})
        result = reconcile(f); self.assertFalse(result['blocked'])
        self.assertEqual([m['effectiveExpected'] for m in result['revisionMapping']], [1, 3])
        self.assertEqual(result['objects'][1], f['mac']['objects'][1])

    def test_request_hash_match_recovers_prefix_without_completing_tail(self):
        f, request, _, _ = pen_fixture(); queue(f, 'board.draw', request)
        result = reconcile(f); self.assertFalse(result['blocked'])
        self.assertEqual(result['operations'][0]['status'], 'pen-request-matched-prefix-retained')
        self.assertEqual(json.loads(result['objects'][0]['data'])['points'][-1][0], 25)
        self.assertEqual(result['board']['revision'], 4)
        self.assertFalse(result['legacyQueueChanged']); self.assertFalse(result['penRecovery']['agentStarted'])
        request['operations'][0]['value']['width'] = 3; f['queue'] = []; queue(f, 'board.draw', request)
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['operations'][0]['reason'], 'pen-request-digest-conflict')

    def test_consistent_but_different_history_cannot_match_original_job_request(self):
        f, request, data, _ = pen_fixture()
        prefix = data['objects'][0]; prefix['points'][-1] = [25, 12, 0.5]
        f['mac']['pen_jobs'][0]['data'] = raw(data)
        f['mac']['history'][0]['changes'] = raw([{'id': 'ink', 'before': None, 'after': prefix, 'afterRevision': 3}])
        f['mac']['objects'][0]['data'] = raw(prefix)
        queue(f, 'board.draw', request)
        result = reconcile(f); self.assertTrue(result['blocked'])
        self.assertIn(result['operations'][0]['reason'], ['pen-saved-point-not-on-segment', 'pen-saved-point-outside-segment'])

    def test_completed_job_requires_whole_expanded_request_when_that_request_is_present(self):
        f, request, data, _ = pen_fixture('completed')
        queue(f, 'board.draw', request)
        self.assertTrue(reconcile(f)['blocked'])
        data['objects'][0]['points'] = request['operations'][0]['value']['points']
        f['mac']['pen_jobs'][0]['data'] = raw(data)
        f['mac']['history'][0]['changes'] = raw([{'id': 'ink', 'before': None, 'after': data['objects'][0], 'afterRevision': 3}])
        f['mac']['objects'][0]['data'] = raw(data['objects'][0])
        self.assertFalse(reconcile(f)['blocked'])

    def test_missing_normalized_request_and_private_frame_never_fake_delivery(self):
        f, _, _, _ = pen_fixture()
        queue(f, 'board.draw', {'board': 'board', 'operationId': 'gesture', 'diagram': {'nodes': [['a', 'Original label']]}})
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['operations'][0]['reason'], 'pen-original-expanded-request-required')
        f['queue'] = []
        queue(f, 'board.mutate', {'board': 'board', 'operationId': 'pen:gesture:2', 'operations': [
            {'id': 'new', 'expectedRevision': 0, 'value': {'type': 'rect'}}]})
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(len(result['objects']), 2)


def export_fixture(directory):
    directory = Path(directory)
    f, _, data, early = pen_fixture('drawing')
    data.update(frame=1, objects=[early]); f['mac']['pen_jobs'][0]['data'] = raw(data)
    for name in ['mac', 'android']:
        (directory / name).mkdir(parents=True)
    with sqlite3.connect(directory / 'mac/workspace.sqlite') as db:
        for table, columns in {
            'projects': 'id TEXT PRIMARY KEY,name TEXT,root TEXT',
            'boards': 'id TEXT PRIMARY KEY,title TEXT,project TEXT,anchor TEXT,revision INTEGER,directory TEXT',
            'objects': 'board TEXT,id TEXT,revision INTEGER,data TEXT',
            'operations': 'id TEXT PRIMARY KEY,hash TEXT,result TEXT',
            'board_creations': 'id TEXT PRIMARY KEY,hash TEXT',
            'history': 'id TEXT PRIMARY KEY,board TEXT,actor TEXT,changes TEXT,time REAL,undone INTEGER',
            'events': 'seq INTEGER PRIMARY KEY,kind TEXT,entity TEXT,data TEXT,time REAL',
            'pen_jobs': 'id TEXT PRIMARY KEY,board TEXT,actor TEXT,digest TEXT,status TEXT,data TEXT',
        }.items():
            db.execute('CREATE TABLE ' + table + '(' + columns + ')')
            for row in f['mac'].get(table, []):
                row = {k: int(v['integer']) if isinstance(v, dict) and 'integer' in v else v for k, v in row.items()}
                db.execute('INSERT INTO ' + table + '(' + ','.join(row) + ') VALUES(' + ','.join('?' for _ in row) + ')', tuple(row.values()))
    with sqlite3.connect(directory / 'android/workspace.sqlite') as db:
        db.executescript('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT);')
    return f


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture': export_fixture(sys.argv[2])
    else: unittest.main()
