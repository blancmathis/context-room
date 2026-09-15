#!/usr/bin/env python3
"""Pure recovery planning. No network, database writes, legacy service or agent.

Hash the captured Android JSON with Python's original Mac number semantics.
Never feed a Javascript number round trip into a historical receipt comparison.
"""
import base64
import copy
import hashlib
import json
import math
import sys
from lisiere_android_export import arguments_agree, decode_binary, json_object

LIMIT = 64 * 1024 * 1024


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(packed(value).encode('utf-8')).hexdigest()


def cell(value):
    if type(value) is dict and set(value) == {'integer'}:
        return int(value['integer'])
    if type(value) is dict and set(value) == {'base64'}:
        return base64.b64decode(value['base64'], validate=True)
    return value


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def number(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def exact_for_notebook(value, depth=0):
    require(depth <= 128, 'object-depth')
    if type(value) is int:
        require(abs(value) <= 9007199254740991, 'integer-not-representable-in-notebook')
    elif type(value) is float:
        require(math.isfinite(value), 'non-finite-number')
    elif type(value) is list:
        for item in value:
            exact_for_notebook(item, depth + 1)
    elif type(value) is dict:
        for item in value.values():
            exact_for_notebook(item, depth + 1)


def unique(rows, field):
    result = {}
    for row in rows:
        key = row[field]
        require(key not in result, 'duplicate-original-identity')
        result[key] = row
    return result


def parse_arguments(entry):
    row, wire = entry['row'], entry.get('wire')
    raw = cell(row['args'])
    require(type(raw) in (str, bytes), 'unreadable-original-arguments')
    original = decode_binary(raw) if type(raw) is bytes else json_object(raw, numbers=True)
    if wire is not None:
        require(wire.get('status') == 'decoded', 'native-arguments-unresolved')
        source = raw if type(raw) is bytes else raw.encode('utf-8')
        require(wire['id'] == row['id'] and wire['seq'] == str(cell(row['seq'])) and wire['operation'] == row['operation']
                and wire['sourceArgsSha256'] == hashlib.sha256(source).hexdigest() and wire['sourceArgsBytes'] == len(source),
                'native-argument-binding')
        arguments_agree(original, json_object(wire['argsJson'], numbers=True))
        return json_object(wire['argsJson']), 'retained-native-json'
    require(type(raw) is str, 'binary-needs-native-export')
    # Textual queue cells are already retained serialized arguments, not LSJ1.
    return json_object(raw), 'retained-text-cell'


def result_matches(prior, board_id, operation_id, operations, actor, history):
    result = json_object(prior['result'])
    require(result.get('board') == board_id and result.get('operationId') == operation_id
            and result.get('dryRun') is False and number(result.get('revision')) and result['revision'] > 0,
            'receipt-result-identity')
    received = unique(result.get('objects', []), 'id')
    require(set(received) == {op['id'] for op in operations}, 'receipt-result-object-set')
    for op in operations:
        expected = dict(op['value'], id=op['id'], revision=result['revision'], actor=actor) if op['value'] is not None else {
            'id': op['id'], 'revision': result['revision'], 'deleted': True}
        require(packed(received[op['id']]) == packed(expected), 'receipt-result-content')
    # Ordinary operations have one atomic history row. Progressive pen frames
    # do not: they must not be promoted to ordinary receipts by their ID alone.
    require(history is not None and history['board'] == board_id and history['actor'] == actor, 'receipt-history-missing')
    changes = json.loads(history['changes'])
    require(type(changes) is list, 'receipt-history-invalid')
    changes = unique(changes, 'id')
    require(set(changes) == set(received), 'receipt-history-object-set')
    for op in operations:
        change = changes[op['id']]
        expected = None if op['value'] is None else received[op['id']]
        require(change.get('afterRevision') == result['revision'] and packed(change.get('after')) == packed(expected), 'receipt-history-content')
    return result


def reconcile(data):
    require(data.get('version') == 1 and isinstance(data.get('actor'), str) and 0 < len(data['actor']) <= 160,
            'explicit-legacy-actor-required')
    board_id, actor = data['boardId'], data['actor']
    require(isinstance(board_id, str) and 0 < len(board_id) <= 512, 'exact-board-required')
    mac = data['mac']
    boards = unique(mac['boards'], 'id')
    original_board = boards.get(board_id)
    board = copy.deepcopy(original_board)
    objects = unique([copy.deepcopy(row) for row in mac['objects'] if row['board'] == board_id], 'id')
    receipts = unique(mac['operations'], 'id')
    histories = unique(mac['history'], 'id')
    creations = unique(mac['board_creations'], 'id')
    pen_jobs = unique(mac['pen_jobs'], 'id')
    entries = sorted(data['queue'], key=lambda entry: cell(entry['row']['seq']))
    require(len(entries) <= 100000, 'queue-too-large')
    unique([entry['row'] for entry in entries], 'id')
    require(len({cell(entry['row']['seq']) for entry in entries}) == len(entries), 'duplicate-queue-sequence')
    report, mapping, selected, assets, successor, blocked_objects = [], [], [], {}, {}, set()
    metadata_blocked = False
    for entry in entries:
        row = entry['row']
        summary = {'seq': str(cell(row['seq'])), 'id': row['id'], 'operation': row['operation'], 'status': 'retained-other',
                   'delivery': 'unconfirmed', 'selected': False}
        report.append(summary)
        try:
            args, evidence = parse_arguments(entry)
            summary['argumentEvidence'] = evidence
            op = row['operation']
            undo_of = None
            if op == 'board.undo':
                old = histories.get(args.get('id'))
                require(old is not None, 'undo-history-missing')
                relevant = old['board'] == board_id
            else:
                relevant = (args.get('id') == board_id if op == 'board.create' else args.get('board') == board_id)
            if op == 'asset.put':
                require(set(args) == {'data'} and type(args['data']) is str, 'asset-arguments')
                raw = base64.b64decode(args['data'], validate=True)
                require(0 < len(raw) <= 20 * 1024 * 1024, 'asset-size')
                sha = hashlib.sha256(raw).hexdigest()
                assets[sha] = args['data']
                summary.update(status='asset-retained', assetId=sha, bytes=len(raw))
                # Content address proves presence, not that this send succeeded.
                if sha in mac['assetHashes']:
                    summary['status'] = 'asset-present-on-mac'
                continue
            known = op in ('board.create', 'board.metadata', 'board.mutate', 'board.undo')
            if not relevant:
                if not known and not args.get('board'):
                    summary.update(status='requires-reconciliation', reason='unknown-operation-scope', blocksSelection=True)
                elif not known:
                    summary.update(status='retained-unsupported', reason='unknown-operation')
                continue
            selected.append(summary['seq'])
            summary['selected'] = True
            require(known, 'unknown-operation')
            if op == 'board.create':
                require(set(args) <= {'id', 'title', 'project', 'anchor', 'directory'}, 'unknown-creation-field')
                title, project, anchor = args.get('title'), args.get('project'), args.get('anchor') or None
                require(type(title) is str and bool(title.strip()) and (anchor is None or type(anchor) is dict), 'creation-identity')
                title = title[:200]
                h = digest([title, project, anchor] + ([args['directory']] if 'directory' in args else []))
                summary['requestDigest'] = h
                if board is not None:
                    receipt = creations.get(board_id)
                    require(receipt is not None and receipt['hash'] == h, 'creation-receipt-conflict')
                    summary.update(status='receipt-matched', delivery='recorded-request-match')
                else:
                    require('directory' in args or project is None, 'creation-directory-must-be-explicit')
                    directory = args.get('directory', '')
                    require(type(directory) is str and (project is not None or directory == ''), 'creation-directory')
                    board = {'id': board_id, 'title': title, 'project': project, 'anchor': packed(anchor) if anchor else None,
                             'directory': directory, 'revision': 0}
                    summary['status'] = 'pending-compatible'
                continue
            require(board is not None and number(board.get('revision')), 'canonical-board-missing')
            require(args.get('operationId') == row['id'], 'queue-operation-id-mismatch')
            if op == 'board.metadata':
                require(set(args) <= {'board', 'title', 'project', 'attach', 'expected', 'directory', 'operationId'}, 'unknown-metadata-field')
                expected, title, project, attach, directory = args.get('expected'), args.get('title'), args.get('project'), args.get('attach', False), args.get('directory')
                require(type(attach) is bool, 'metadata-attach')
                fields = ({'title'} if title is not None else set()) | ({'project'} if attach else set()) | ({'directory'} if directory is not None else set())
                require(type(expected) is dict and fields and set(expected) == fields, 'metadata-expected-fields')
                h = digest(['board.metadata', board_id, title, project, attach, expected, actor] + ([directory] if directory is not None else []))
                summary['requestDigest'] = h
                prior = receipts.get(row['id'])
                if prior:
                    require(prior['hash'] == h, 'receipt-payload-conflict')
                    result = json_object(prior['result'])
                    require(result.get('id') == board_id and number(result.get('revision')) and result['revision'] <= board['revision'], 'metadata-receipt-result')
                    for field in fields:
                        value = title[:200] if field == 'title' else project if field == 'project' else directory
                        require(result.get(field) == value, 'metadata-receipt-content')
                    summary.update(status='receipt-matched', delivery='recorded-request-match', macRevision=result['revision'])
                    continue
                require(not metadata_blocked and all(board.get(k) == v for k, v in expected.items()), 'metadata-concurrent-change')
                require(not attach or project == board.get('project') or directory is not None, 'attachment-directory-must-be-explicit')
                next_board = dict(board)
                if title is not None:
                    require(type(title) is str and title.strip(), 'metadata-title')
                    next_board['title'] = title[:200]
                if attach:
                    anchor = json.loads(board['anchor']) if board.get('anchor') else None
                    if anchor and project != board.get('project') and 'project' not in anchor:
                        anchor['project'] = board.get('project')
                        next_board['anchor'] = packed(anchor)
                    next_board['project'] = project
                if directory is not None:
                    require(type(directory) is str, 'metadata-directory')
                    next_board['directory'] = directory
                require(next_board.get('project') is not None or not next_board.get('directory'), 'free-memo-directory')
                if next_board != board:
                    next_board['revision'] += 1
                board = next_board
                summary.update(status='pending-compatible', importedRevision=board['revision'])
                continue
            if op == 'board.undo':
                require(set(args) <= {'id', 'operationId'}, 'unknown-undo-field')
                old = histories[args['id']]
                changes = json.loads(old['changes'])
                require(type(changes) is list, 'undo-history-invalid')
                operations = [{'id': c['id'], 'expectedRevision': c['afterRevision'], 'value': c['before']} for c in changes]
                undo_of = args['id']
            else:
                require(set(args) <= {'board', 'operationId', 'operations', 'dryRun'} and args.get('dryRun', False) is False, 'unknown-or-dry-mutation')
                operations = args.get('operations')
            require(type(operations) is list and 0 < len(operations) <= 20000, 'mutation-bounds')
            for change in operations:
                require(type(change) is dict and set(change) == {'id', 'expectedRevision', 'value'} and number(change['expectedRevision'])
                        and isinstance(change['id'], str) and 0 < len(change['id']) <= 150 and (change['value'] is None or type(change['value']) is dict), 'mutation-shape')
            unique(operations, 'id')
            # Digest ORIGINAL stored expected revisions. Do not search alternative
            # numbers until a hash happens to match a Mac receipt.
            h = digest([board_id, operations, actor, undo_of])
            summary['requestDigest'] = h
            prior = receipts.get(row['id'])
            if prior:
                require(prior['hash'] == h, 'receipt-payload-conflict')
                result = result_matches(prior, board_id, row['id'], operations, actor, histories.get(row['id']))
                require(result['revision'] <= board['revision'], 'receipt-newer-than-canonical-board')
                summary.update(status='receipt-matched', delivery='recorded-request-match', macRevision=result['revision'])
                for change in operations:
                    current = objects.get(change['id'])
                    require(current is not None and current['revision'] >= result['revision'], 'canonical-object-behind-receipt')
                    if current['revision'] == result['revision']:
                        actual = json.loads(current['data']) if current['data'] is not None else None
                        matched = next(item for item in result['objects'] if item['id'] == change['id'])
                        expected = None if matched.get('deleted') is True else matched
                        require(packed(actual) == packed(expected), 'canonical-object-receipt-content')
                    successor[change['id']] = result['revision']
                continue
            require(row['id'] not in pen_jobs, 'progressive-pen-needs-job-reconciliation')
            rewritten = []
            for change in operations:
                id = change['id']
                require(id not in blocked_objects, 'predecessor-unresolved')
                effective = max(change['expectedRevision'], successor.get(id, 0))
                current = objects.get(id)
                require((current['revision'] if current else 0) == effective, 'object-concurrent-change')
                exact_for_notebook(change['value'])
                rewritten.append((change, effective))
            revision = board['revision'] + 1
            for change, effective in rewritten:
                id, value = change['id'], change['value']
                after = None if value is None else dict(value, id=id, revision=revision, actor=actor)
                objects[id] = {'board': board_id, 'id': id, 'revision': revision, 'data': None if after is None else packed(after)}
                mapping.append({'operationId': row['id'], 'objectId': id, 'originalExpected': change['expectedRevision'],
                                'effectiveExpected': effective, 'importedRevision': revision,
                                'predecessorEvidence': 'confirmed-or-projected-first-successor' if id in successor else 'canonical-object'})
                successor[id] = revision
            board['revision'] = revision
            summary.update(status='pending-compatible', importedRevision=revision)
        except (ValueError, TypeError, KeyError, OverflowError, UnicodeError) as error:
            summary.update(status='requires-reconciliation', reason=str(error)[:240], blocksSelection=True)
            # Never let later local intents hide a conflicting earlier gesture.
            if summary['selected']:
                metadata_blocked |= row['operation'] in ('board.create', 'board.metadata')
                try:
                    blocked_objects.update(change['id'] for change in args.get('operations', []))
                except (TypeError, KeyError, AttributeError):
                    pass
    blocked = board is None or any(item.get('blocksSelection') for item in report)
    return {'version': 1, 'boardId': board_id, 'actor': actor, 'operations': report, 'selectedSeqs': selected,
            'blocked': blocked, 'board': board, 'objects': list(objects.values()), 'revisionMapping': mapping,
            'assets': assets, 'accepted': False, 'legacyQueueChanged': False,
            'effect': 'new-working-notebook-only', 'canonicalRevision': original_board['revision'] if original_board else None}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1)
        require(len(raw) <= LIMIT, 'reconciliation-input-too-large')
        result = reconcile(json_object(raw))
        output = packed(result).encode('utf-8')
        require(len(output) <= LIMIT, 'reconciliation-output-too-large')
        sys.stdout.buffer.write(output + b'\n')
    except Exception as error:
        # No input content, private file paths or traceback in a public CLI error.
        print('Reconciliation refused: ' + str(error)[:240], file=sys.stderr)
        sys.exit(1)
