"""Read-only reconciliation of the recorded legacy progressive-pen protocol.

A frame transaction wrote objects, the grouped history and a board event together.
The job descriptor was saved afterwards. It is NOT a per-frame request receipt,
nor an instruction to finish a stopped drawing. No geometry is generated here.
"""
import hashlib
import json
import math
import re


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def record(value):
    # Reject duplicate keys and nonfinite values, just like the recovery reader.
    from lisiere_android_export import json_object
    return json_object(value)


def sequence(value):
    if type(value) is dict and set(value) == {'integer'}:
        value = int(value['integer'])
    require(type(value) is int and value >= 0, 'pen-event-sequence')
    return value


def unique(items, key, reason):
    require(type(items) is list and len(items) <= 100000, reason)
    result = {}
    for item in items:
        require(type(item) is dict and type(item.get(key)) is str and item[key] not in result, reason)
        result[item[key]] = item
    return result


def reconcile_pen_jobs(mac, board_id):
    """Validate saved prefixes, including the transaction/descriptor crash window.

    Current canonical objects are never replaced with older descriptor objects.
    Missing per-frame contents are described, not manufactured from a job ID.
    """
    jobs = unique(mac.get('pen_jobs', []), 'id', 'duplicate-pen-job')
    histories = unique(mac['history'], 'id', 'duplicate-pen-history')
    objects = unique([o for o in mac['objects'] if o['board'] == board_id], 'id', 'duplicate-pen-object')
    board = next((b for b in mac['boards'] if b['id'] == board_id), None)
    frames, problems, reports = {}, [], []
    ordinary_ids = {r['id'] for r in mac.get('operations', [])}
    seen_seq = set()
    for event in sorted(mac.get('events', []), key=lambda e: sequence(e['seq'])):
        seq = sequence(event['seq'])
        require(seq not in seen_seq, 'duplicate-pen-event-sequence'); seen_seq.add(seq)
        if event.get('kind') != 'board' or event.get('entity') != board_id:
            continue
        try:
            data = record(event['data'])
            op_id = data.get('operationId', '')
            if not isinstance(op_id, str) or not op_id.startswith('pen:') or op_id in ordinary_ids and op_id in histories:
                continue
            match = re.fullmatch(r'pen:(.{1,100}):([1-9][0-9]{0,8})', op_id)
            require(match is not None, 'pen-frame-identity')
            job_id, n = match[1], int(match[2])
            require(job_id in jobs, 'pen-frame-job-missing')
            frames.setdefault(job_id, []).append({'number': n, 'seq': str(seq), 'revision': data.get('revision'),
                                                   'actor': data.get('actor'), 'operationId': op_id})
        except (ValueError, TypeError, KeyError):
            problems.append({'status': 'requires-reconciliation', 'reason': 'pen-event-invalid-or-orphaned',
                             'seq': str(seq), 'blocksSelection': True})
    for key, history in histories.items():
        if history.get('board') == board_id and key.startswith('pen:') and key[4:] not in jobs and key not in ordinary_ids:
            problems.append({'id': key, 'status': 'requires-reconciliation', 'reason': 'pen-history-job-missing', 'blocksSelection': True})
    for key, job in sorted(jobs.items()):
        report = {'id': key, 'board': board_id, 'status': 'requires-reconciliation', 'requestDelivery': 'unconfirmed',
                  'resumed': False, 'accepted': False, 'blocksSelection': True}
        reports.append(report)
        try:
            require(type(key) is str and 0 < len(key) <= 100 and job.get('board') == board_id
                    and type(job.get('actor')) is str and 0 < len(job['actor']) <= 160, 'pen-job-identity')
            require(type(job.get('digest')) is str and re.fullmatch('[0-9a-f]{64}', job['digest']), 'pen-job-digest')
            require(job.get('status') in ('drawing', 'completed', 'stopped', 'interrupted'), 'pen-job-status')
            require(board is not None and integer(board.get('revision')), 'pen-canonical-board-missing')
            data = record(job['data'])
            group = histories.get('pen:' + key)
            events = frames.get(key, [])
            require(len(events) <= 100000, 'pen-frame-count')
            previous_revision = 0
            for n, event in enumerate(events, 1):
                require(event['number'] == n, 'pen-frame-gap-or-duplicate')
                require(event['actor'] == job['actor'] and integer(event['revision'], 1)
                        and previous_revision < event['revision'] <= board['revision'], 'pen-frame-revision-or-actor')
                previous_revision = event['revision']
            final_frame = len(events)
            require(job['status'] != 'completed' or final_frame > 0, 'pen-completed-without-frame')
            changes = {}
            if events:
                require(group is not None and group.get('board') == board_id and group.get('actor') == job['actor']
                        and type(group.get('undone')) is int and group['undone'] in (0, 1), 'pen-group-identity')
                # The original group retains first before and latest after, not
                # the geometry of all intermediate frames.
                changes = unique(record('{"changes":' + group['changes'] + '}')['changes'], 'id', 'pen-group-changes')
                require(0 < len(changes) <= 128, 'pen-group-size')
                event_revisions = {e['revision'] for e in events}
                for oid, change in changes.items():
                    after, revision = change.get('after'), change.get('afterRevision')
                    require(set(change) == {'id', 'before', 'after', 'afterRevision'} and change['before'] is None,
                            'pen-new-object-precondition')
                    require(integer(revision, 1) and revision in event_revisions and type(after) is dict
                            and after.get('id') == oid and type(after.get('revision')) is int and after['revision'] == revision
                            and after.get('actor') == job['actor'] and after.get('deleted') is not True, 'pen-group-after')
                    current = objects.get(oid)
                    require(current is not None and integer(current.get('revision'), 1)
                            and revision <= current['revision'] <= board['revision'], 'pen-canonical-behind-prefix')
                    require(not group['undone'] or current['revision'] > revision, 'pen-undo-canonical-not-advanced')
                    if current['revision'] == revision:
                        require(current['data'] is not None and packed(record(current['data'])) == packed(after), 'pen-canonical-prefix-content')
                    elif current['data'] is not None:
                        value = record(current['data'])
                        require(value.get('id') == oid and type(value.get('revision')) is int and value['revision'] == current['revision'],
                                'pen-newer-canonical-identity')
                require(max(c['afterRevision'] for c in changes.values()) == previous_revision, 'pen-group-last-frame-missing')
            else:
                require(group is None, 'pen-group-without-frame')
            # A killed first frame may leave {} in pen_jobs. The atomic group
            # still proves exactly the reached prefix; never a completed job.
            if not data:
                require(job['status'] in ('drawing', 'interrupted') and final_frame <= 1, 'pen-empty-descriptor')
                descriptor = 'initial-save-interrupted'
            else:
                require(set(data) <= {'id', 'board', 'actor', 'lease', 'status', 'durationMs', 'frame', 'objects', 'tip', 'project', 'error'},
                        'pen-unknown-descriptor-field')
                require(all(data.get(k) == job[k] for k in ('id', 'board', 'actor')), 'pen-descriptor-identity')
                require(data.get('status') == job['status'] or job['status'] == 'interrupted' and data.get('status') == 'drawing',
                        'pen-descriptor-status')
                require(integer(data.get('frame')) and integer(data.get('durationMs'), 300) and data['durationMs'] <= 15000, 'pen-descriptor-counters')
                saved = unique(data.get('objects'), 'id', 'pen-descriptor-objects')
                saved_frame = data['frame']
                # A failed mutation increments the attempt counter before
                # reporting an error, but never publishes a frame event.
                failed_attempt = saved_frame == final_frame + 1 and job['status'] == 'interrupted' and type(data.get('error')) is dict
                require(saved_frame == final_frame or saved_frame == final_frame - 1 or failed_attempt, 'pen-descriptor-frame-gap')
                lagging = saved_frame == final_frame - 1
                require(not lagging or data['status'] == 'drawing', 'pen-terminal-before-later-frame')
                if not lagging:
                    require(set(saved) == set(changes), 'pen-descriptor-object-set')
                else:
                    require(set(saved) <= set(changes), 'pen-descriptor-object-set')
                for oid, value in saved.items():
                    revision = value.get('revision')
                    bound = final_frame - 1 if lagging else final_frame
                    require(integer(revision, 1) and revision in {e['revision'] for e in events[:bound]}
                            and value.get('actor') == job['actor'] and revision <= changes[oid]['afterRevision'], 'pen-descriptor-object-revision')
                    if revision == changes[oid]['afterRevision']:
                        require(packed(value) == packed(changes[oid]['after']), 'pen-descriptor-prefix-content')
                    else:
                        require(lagging, 'pen-descriptor-stale-content')
                descriptor = 'lagging-one-committed-frame' if lagging else 'failed-uncommitted-attempt' if failed_attempt else 'matched'
            newer = [oid for oid, c in changes.items() if objects[oid]['revision'] > c['afterRevision']]
            report.update(status='committed-prefix-retained' if events else 'no-committed-frame', blocksSelection=False,
                          recordedStatus=job['status'], descriptor=descriptor, receiptDigest=job['digest'],
                          historyHash=hashlib.sha256(group['changes'].encode()).hexdigest() if group else None,
                          lastCommittedFrame=final_frame, lastCommittedRevision=previous_revision or None,
                          frames=[{k: v for k, v in e.items() if k != 'actor'} for e in events],
                          objects=[{'id': oid, 'revision': c['afterRevision']} for oid, c in changes.items()],
                          newerCanonicalObjects=newer, undone=bool(group and group['undone']),
                          completedRequestProven=False,
                          effect='retain-canonical-scene-and-history-only')
        except (ValueError, TypeError, KeyError, OverflowError, UnicodeError) as error:
            report['reason'] = str(error)[:240]
    return {'version': 1, 'jobs': reports, 'problems': problems,
            'blocked': bool(problems) or any(r['blocksSelection'] for r in reports),
            'framesReplayed': False, 'agentStarted': False}


def outline(value):
    """The legacy pen's bounded shape path, used only to check a saved prefix."""
    kind = value.get('type')
    def coordinate(n):
        require(type(n) in (int, float) and math.isfinite(n) and abs(n) <= 1e6, 'pen-request-geometry')
        return n
    width = coordinate(value.get('width', 2))
    require(.2 <= width <= 40, 'pen-request-width')
    if kind == 'text':
        require(type(value.get('text')) is str and len(value['text']) <= 4000 and 8 <= coordinate(value.get('fontSize')) <= 80,
                'pen-request-text')
        coordinate(value.get('x')); coordinate(value.get('y'))
        return []
    if kind == 'ink':
        points = value.get('points')
        require(type(points) is list and 2 <= len(points) <= 2048, 'pen-request-points')
        output = []
        for p in points:
            require(type(p) is list and 2 <= len(p) <= 3, 'pen-request-point')
            output.append([coordinate(p[0]), coordinate(p[1]), max(.15, min(1, coordinate(p[2]) if len(p) == 3 else 1))])
        return output
    x, y, w, h = [coordinate(value.get(k)) for k in ('x', 'y', 'w', 'h')]
    if kind == 'rect':
        points = [[x, y], [x+w, y], [x+w, y+h], [x, y+h], [x, y]]
    elif kind == 'ellipse':
        points = [[x+w/2+w/2*math.cos(i*math.tau/64), y+h/2+h/2*math.sin(i*math.tau/64)] for i in range(65)]
    else:
        require(kind in ('arrow', 'connector'), 'pen-request-object-type')
        points, tip = [[x, y]], [x+w, y+h]
        if kind == 'connector' and value.get('route') == 'outside-left':
            offset = coordinate(value.get('routeOffset', 48)); require(0 < offset <= 10000, 'pen-request-route')
            lane = min(x, x+w)-offset; points += [[lane, y], [lane, y+h]]
        angle = math.atan2(tip[1]-points[-1][1], tip[0]-points[-1][0])
        delta, size = (.5, 12) if kind == 'connector' else (math.pi/6, 14)
        points += [tip, [tip[0]-size*math.cos(angle-delta), tip[1]-size*math.sin(angle-delta)], tip,
                   [tip[0]-size*math.cos(angle+delta), tip[1]-size*math.sin(angle+delta)]]
    return [p+[1] for p in points]


def path_prefix(saved, path):
    require(type(saved) is list and 0 < len(saved) <= len(path) and saved[0] == path[0], 'pen-saved-path-prefix')
    for index, point in enumerate(saved[1:], 1):
        require(type(point) is list and len(point) == 3, 'pen-saved-point')
        if point == path[index]:
            continue
        require(index == len(saved)-1, 'pen-saved-interior-point')
        a, b = path[index-1], path[index]
        axis = max(range(2), key=lambda n: abs(b[n]-a[n]))
        require(b[axis] != a[axis], 'pen-saved-zero-segment')
        t = (point[axis]-a[axis])/(b[axis]-a[axis])
        require(0 < t < 1, 'pen-saved-point-outside-segment')
        for n in range(3):
            predicted = a[n]+(b[n]-a[n])*t
            # Geometric consistency only; never a floating-point wire digest.
            # The exact request digest and saved source bytes are separate.
            require(type(point[n]) in (int, float) and math.isfinite(point[n])
                    and abs(predicted-point[n]) <= 8*max(math.ulp(float(predicted)), math.ulp(float(a[n])), math.ulp(float(b[n]))),
                    'pen-saved-point-not-on-segment')


def request_prefix_agrees(operations, history, completed):
    changes = record('{"changes":' + history['changes'] + '}')['changes'] if history else []
    saved = {c['id']: c['after'] for c in changes}
    require(set(saved) == {o['id'] for o in operations[:len(saved)]}, 'pen-request-prefix-order')
    total_points = 0
    for index, op in enumerate(operations):
        value, oid = op['value'], op['id']
        points = outline(value); total_points += len(points)
        require(total_points <= 8192, 'pen-request-total-points')
        if oid not in saved:
            continue
        full = dict(value, points=points) if value['type'] == 'ink' else value
        full = {k:v for k,v in full.items() if k not in ('id','revision','actor')}
        after = {k:v for k,v in saved[oid].items() if k not in ('id','revision','actor')}
        if packed(after) == packed(full):
            continue
        require(not completed and index == len(saved)-1 and points
                and set(after) == {'type', 'points', 'width'} and after['type'] == 'ink'
                and after['width'] == value.get('width', 2), 'pen-request-prefix-content')
        path_prefix(after['points'], points)
    require(not completed or len(saved) == len(operations), 'pen-completed-request-incomplete')


def match_pen_request(args, actor, job, report, history):
    """Only a captured expanded request can be compared with the job digest.

    The legacy descriptor omits the future plan. Layouts depended on the original
    font metrics. Neither IDs nor a similar final drawing reconstruct that input.
    A missing expanded input is missing evidence, not permission to run an agent.
    """
    require(job is not None and report is not None and not report['blocksSelection'], 'pen-job-evidence-missing')
    require(set(args) <= {'board', 'operationId', 'operations', 'durationMs'} and type(args.get('operations')) is list,
            'pen-original-expanded-request-required')
    data = record(job['data'])
    require(data and 'lease' in data and actor == job['actor'], 'pen-request-actor-or-lease-unavailable')
    require(args.get('board') == job['board'] and args.get('operationId') == job['id']
            and args.get('durationMs', 4000) == data['durationMs'], 'pen-request-identity-or-duration')
    ops = args['operations']
    require(0 < len(ops) <= 128, 'pen-request-operation-count')
    unique(ops, 'id', 'pen-request-object-ids')
    for op in ops:
        require(set(op) == {'id', 'expectedRevision', 'value'} and type(op['expectedRevision']) is int
                and op['expectedRevision'] == 0 and type(op['value']) is dict, 'pen-request-precondition')
    expected = hashlib.sha256(packed([args['board'], ops, args.get('durationMs', 4000), actor, data['lease']]).encode()).hexdigest()
    require(expected == job['digest'], 'pen-request-digest-conflict')
    require({o['id'] for o in report['objects']} <= {o['id'] for o in ops}, 'pen-request-prefix-identity')
    request_prefix_agrees(ops, history, job['status'] == 'completed')
    return expected
