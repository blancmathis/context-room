"""Synthetic source/receipt contracts; no legacy installation or provider."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from lisiere_reconcile import reconcile
from lisiere_android_export_test import binary


def raw(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(value):
    return hashlib.sha256(raw(value).encode()).hexdigest()


def fixture():
    return {'version': 1, 'boardId': 'board', 'actor': 'tablet', 'queue': [], 'mac': {
        'boards': [{'id': 'board', 'title': 'Original', 'project': None, 'directory': '', 'anchor': None, 'revision': 0}],
        'objects': [], 'operations': [], 'history': [], 'board_creations': [], 'pen_jobs': [], 'assetHashes': []}}


def queue(f, op, args, id=None):
    id = id or args.get('operationId', 'entry-' + str(len(f['queue'])))
    entry = {'row': {'seq': len(f['queue']) + 1, 'id': id, 'operation': op, 'args': raw(args), 'error': None}}
    f['queue'].append(entry)
    return entry


def mutation(f, id, expected=0, value=None, object_id='shape'):
    value = {'type': 'rect', 'x': 0, 'y': 0, 'w': 40, 'h': 30} if value is None else value
    return queue(f, 'board.mutate', {'board': 'board', 'operationId': id,
                                    'operations': [{'id': object_id, 'expectedRevision': expected, 'value': value}]})


def record(f, entry, revision):
    args = json.loads(entry['row']['args']); ops = args['operations']
    objects = [dict(op['value'], id=op['id'], actor='tablet', revision=revision) if op['value'] is not None else
               {'id': op['id'], 'revision': revision, 'deleted': True} for op in ops]
    receipt = {'id': entry['row']['id'], 'hash': sha(['board', ops, 'tablet', None]), 'result': raw({
        'board': 'board', 'revision': revision, 'operationId': entry['row']['id'], 'objects': objects, 'dryRun': False})}
    f['mac']['operations'].append(receipt)
    f['mac']['history'].append({'id': entry['row']['id'], 'board': 'board', 'actor': 'tablet', 'changes': raw([
        {'id': op['id'], 'before': None, 'after': obj if op['value'] is not None else None, 'afterRevision': revision}
        for op, obj in zip(ops, objects)]), 'undone': 0})
    f['mac']['boards'][0]['revision'] = revision
    f['mac']['objects'] = [{'board': 'board', 'id': op['id'], 'revision': revision, 'data': raw(obj) if op['value'] is not None else None}
                            for op, obj in zip(ops, objects)]
    return receipt


class ReconciliationContracts(unittest.TestCase):
    def test_lost_response_and_first_successors_use_proven_revisions(self):
        f = fixture(); first = mutation(f, 'first'); record(f, first, 3)
        f['mac']['boards'][0]['revision'] = 4
        f['mac']['objects'].append({'board': 'board', 'id': 'independent', 'revision': 4,
                                   'data': raw({'type': 'text', 'text': 'Keep Mac work', 'id': 'independent', 'revision': 4})})
        mutation(f, 'second'); mutation(f, 'third')
        result = reconcile(f)
        self.assertFalse(result['blocked']); self.assertEqual([op['status'] for op in result['operations']], ['receipt-matched', 'pending-compatible', 'pending-compatible'])
        self.assertEqual([m['effectiveExpected'] for m in result['revisionMapping']], [3, 5])
        self.assertEqual(result['board']['revision'], 6)
        self.assertEqual(result['objects'][1], f['mac']['objects'][1])
        self.assertEqual(reconcile(f), result)
        self.assertEqual(f['mac']['boards'][0]['revision'], 4)

    def test_same_id_different_content_never_acknowledges(self):
        f = fixture(); entry = mutation(f, 'first'); record(f, entry, 1)['hash'] = '0' * 64
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['operations'][0]['reason'], 'receipt-payload-conflict')
        self.assertEqual(result['operations'][0]['delivery'], 'unconfirmed')

    def test_concurrent_same_object_does_not_follow_old_ack(self):
        f = fixture(); first = mutation(f, 'first'); record(f, first, 2); mutation(f, 'second')
        f['mac']['boards'][0]['revision'] = 3; f['mac']['objects'][0]['revision'] = 3
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['operations'][1]['reason'], 'object-concurrent-change')
        self.assertEqual(result['revisionMapping'], [])

    def test_receipt_result_and_history_are_not_inferred_from_id(self):
        for broken in ('result', 'history'):
            with self.subTest(broken=broken):
                f = fixture(); entry = mutation(f, 'first'); receipt = record(f, entry, 1)
                if broken == 'result': receipt['result'] = receipt['result'].replace('"board":"board"', '"board":"other"')
                else: f['mac']['history'] = []
                self.assertTrue(reconcile(f)['blocked'])

    def test_duplicate_queue_identity_and_sequence_refuse(self):
        f = fixture(); mutation(f, 'first'); f['queue'].append(copy.deepcopy(f['queue'][0]))
        with self.assertRaises(ValueError): reconcile(f)
        f['queue'][1]['row']['id'] = 'other'
        with self.assertRaises(ValueError): reconcile(f)

    def test_free_memo_creation_metadata_and_delete_are_retained(self):
        f = fixture(); f['mac']['boards'] = []
        queue(f, 'board.create', {'id': 'board', 'title': 'Free memo', 'project': None, 'directory': ''})
        queue(f, 'board.metadata', {'board': 'board', 'operationId': 'rename', 'title': 'Renamed', 'expected': {'title': 'Free memo'}})
        mutation(f, 'draw')
        queue(f, 'board.mutate', {'board': 'board', 'operationId': 'delete', 'operations': [{'id': 'shape', 'expectedRevision': 0, 'value': None}]})
        result = reconcile(f); self.assertFalse(result['blocked']); self.assertEqual(result['board']['title'], 'Renamed')
        self.assertIsNone(result['objects'][0]['data']); self.assertEqual(result['objects'][0]['revision'], 3)

    def test_create_requires_original_hash_not_similar_title(self):
        f = fixture(); entry = queue(f, 'board.create', {'id': 'board', 'title': 'Original', 'project': None})
        self.assertTrue(reconcile(f)['blocked'])
        f['mac']['board_creations'] = [{'id': 'board', 'hash': sha(['Original', None, None])}]
        self.assertEqual(reconcile(f)['operations'][0]['status'], 'receipt-matched')

    def test_metadata_conflict_does_not_reclassify_location(self):
        f = fixture(); queue(f, 'board.metadata', {'board': 'board', 'operationId': 'rename', 'title': 'New', 'expected': {'title': 'Stale'}})
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['board']['title'], 'Original')

    def test_asset_presence_is_not_a_delivery_receipt(self):
        f = fixture(); data = bytes(range(256)) * 8192; hash = hashlib.sha256(data).hexdigest()
        queue(f, 'asset.put', {'data': base64.b64encode(data).decode()}); f['mac']['assetHashes'] = [hash]
        result = reconcile(f); self.assertEqual(result['operations'][0]['status'], 'asset-present-on-mac')
        self.assertEqual(result['operations'][0]['delivery'], 'unconfirmed'); self.assertEqual(base64.b64decode(result['assets'][hash]), data)

    def test_undo_uses_retained_before_and_exact_after_revision(self):
        f = fixture(); entry = mutation(f, 'first'); record(f, entry, 2); f['queue'] = []
        queue(f, 'board.undo', {'id': 'first', 'operationId': 'undo'})
        result = reconcile(f); self.assertFalse(result['blocked']); self.assertIsNone(result['objects'][0]['data'])
        f['mac']['objects'][0]['revision'] = 3
        self.assertTrue(reconcile(f)['blocked'])

    def test_old_history_undo_is_never_rebased_over_a_later_queued_gesture(self):
        f = fixture(); first = mutation(f, 'first'); record(f, first, 2)
        mutation(f, 'later-gesture')
        queue(f, 'board.undo', {'id': 'first', 'operationId': 'undo-old'})
        result = reconcile(f)
        self.assertTrue(result['blocked'])
        self.assertEqual(result['operations'][-1]['reason'], 'object-concurrent-change')
        self.assertEqual(result['objects'][0]['revision'], 3)
        self.assertIsNotNone(result['objects'][0]['data'])

    def test_history_undo_does_not_manufacture_an_android_successor_ack(self):
        f = fixture(); first = mutation(f, 'first'); record(f, first, 2); f['queue'] = []
        queue(f, 'board.undo', {'id': 'first', 'operationId': 'undo'})
        mutation(f, 'later', expected=2)
        result = reconcile(f)
        self.assertTrue(result['blocked'])
        self.assertEqual(result['operations'][0]['status'], 'pending-compatible')
        self.assertEqual(result['operations'][1]['reason'], 'object-concurrent-change')

    def test_progressive_pen_is_not_an_ordinary_receipt(self):
        f = fixture(); mutation(f, 'pen-frame'); f['mac']['pen_jobs'] = [{'id': 'pen-frame', 'board': 'board'}]
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['operations'][0]['reason'], 'progressive-pen-needs-job-reconciliation')

    def test_unknown_and_undecodable_work_stays_explicit(self):
        f = fixture(); queue(f, 'future.operation', {'opaque': 'keep'})
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(len(result['operations']), 1)
        f['queue'][0]['row']['args'] = '{broken'
        self.assertTrue(reconcile(f)['blocked'])

    def test_native_float_negative_zero_and_int64_preserve_hash_semantics(self):
        f = fixture()
        args = {'board': 'board', 'operationId': 'native', 'operations': [{'id': 'shape', 'expectedRevision': 0,
                 'value': {'type': 'rect', 'x': (7, 0.1), 'y': (8, -0.0), 'w': 40, 'h': 30, 'originalCount': 9223372036854775807}}]}
        original = b'LSJ1' + binary(args)
        wire_text = '{"board":"board","operationId":"native","operations":[{"id":"shape","expectedRevision":0,"value":{"type":"rect","x":0.1,"y":-0.0,"w":40,"h":30,"originalCount":9223372036854775807}}]}'
        row = {'seq': {'integer': '9007199254740993'}, 'id': 'native', 'operation': 'board.mutate', 'args': {'base64': base64.b64encode(original).decode()}}
        wire = {'seq': '9007199254740993', 'id': 'native', 'operation': 'board.mutate', 'status': 'decoded', 'sourceArgsBytes': len(original),
                'sourceArgsSha256': hashlib.sha256(original).hexdigest(), 'argsJson': wire_text}
        f['queue'] = [{'row': row, 'wire': wire}]
        result = reconcile(f); self.assertTrue(result['blocked'])
        self.assertEqual(result['operations'][0]['requestDigest'], sha(['board', json.loads(wire_text)['operations'], 'tablet', None]))
        self.assertIn('integer-not-representable', result['operations'][0]['reason'])
        wire['argsJson'] = wire_text.replace('9223372036854775807', '9223372036854775806')
        self.assertTrue(reconcile(f)['blocked']); self.assertNotIn('requestDigest', reconcile(f)['operations'][0])

    def test_bad_batch_never_partially_projects(self):
        f = fixture(); entry = mutation(f, 'batch')
        args = json.loads(entry['row']['args']); args['operations'].append({'id': 'other', 'expectedRevision': 99, 'value': None})
        entry['row']['args'] = raw(args)
        result = reconcile(f); self.assertTrue(result['blocked']); self.assertEqual(result['objects'], [])
        self.assertEqual(result['board']['revision'], 0)


if __name__ == '__main__':
    unittest.main()
