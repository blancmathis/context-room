"""Read a bounded native Android recovery ZIP, never the installed legacy app.

The native v1 container is not a snapshot v1. Every member and SQLite cell is
checked before producing snapshot v3. Android's serialized arguments remain
bytes, not a JavaScript number round trip. Typed numeric agreement is deliberately
not a claim of original wire canonicalization, receipt or delivery.
"""
from contextlib import contextmanager, closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import tempfile
import zipfile

LIMIT = 512 * 1024 * 1024
ROW_LIMIT = 32 * 1024 * 1024
# A native JSON string can expand UTF-16 code units into six ASCII bytes.
WIRE_LIMIT = ROW_LIMIT * 6 + 16384
MANIFEST_LIMIT = 8 * 1024 * 1024
MAX_MEMBERS = 20005
MEDIA_TYPE = 'application/vnd.context-room.lisiere-android-export+json'
MEMBER = re.compile(r'workspace/workspace\.sqlite(?:-wal|-journal)?|recordings/[a-f0-9]{64}\.pcm|derived/outbox-args\.jsonl')
ANDROID_COLUMNS = {'android_metadata': 'locale', 'cache': 'key value',
                   'outbox': 'seq id operation args error',
                   'board_headers': 'board value', 'board_objects': 'board id value'}


def require(value, message):
    if not value:
        raise ValueError(message + ' The original Android ZIP is unchanged.')


def signature(info):
    return (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def integer(value, maximum=LIMIT):
    return type(value) is int and 0 <= value <= maximum


def no_links(value):
    for candidate in (value, *value.parents):
        require(not candidate.is_symlink(), 'Android recovery does not follow symbolic paths.')


class JsonNumber(str):
    """Retain the lexical number: bool, int64, -0 and Float are not conflated."""


def json_object(data, numbers=False):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'Duplicate Android export JSON key.')
            value[key] = item
        return value

    def invalid(_):
        raise ValueError('Non-finite Android export JSON number.')

    options = {'parse_int': JsonNumber, 'parse_float': JsonNumber} if numbers else {}
    if isinstance(data, bytes):
        data = data.decode('utf-8', errors='strict')
    value = json.loads(data, object_pairs_hook=pairs, parse_constant=invalid, **options)
    require(type(value) is dict, 'An Android export JSON object is required.')
    return value


class BinaryFloat:
    def __init__(self, bits, width):
        self.bits, self.width = bits, width
        self.value = struct.unpack('>f' if width == 4 else '>d', bits)[0]
        require(math.isfinite(self.value), 'Non-finite original Android number.')


def decode_binary(raw):
    """LSJ1 with original integer and Float/Double types, without reserialization."""
    require(5 <= len(raw) <= ROW_LIMIT and raw[:4] == b'LSJ1', 'Unknown original binary argument format.')
    offset, nodes = 4, 0

    def take(count):
        nonlocal offset
        require(0 <= count <= len(raw) - offset, 'Truncated original binary argument.')
        start = offset
        offset += count
        return raw[start:offset]

    def length():
        value = struct.unpack('>i', take(4))[0]
        require(0 <= value <= ROW_LIMIT, 'Invalid original binary length.')
        return value

    def text():
        return take(length() * 2).decode('utf-16-be', errors='surrogatepass')

    def read(depth):
        nonlocal nodes
        nodes += 1
        require(depth <= 256 and nodes <= 2000000, 'Original arguments exceed their structural bound.')
        kind = take(1)[0]
        if kind == 0:
            return None
        if kind == 3:
            return text()
        if kind in (4, 5):
            return kind == 4
        if kind == 6:
            return struct.unpack('>q', take(8))[0]
        if kind in (7, 8):
            width = 4 if kind == 7 else 8
            return BinaryFloat(take(width), width)
        require(kind in (1, 2), 'Unknown original binary argument type.')
        count = length()
        require(count <= len(raw) - offset, 'Truncated original argument collection.')
        if kind == 2:
            return [read(depth + 1) for _ in range(count)]
        result = {}
        for _ in range(count):
            key = text()
            require(key not in result, 'Duplicate original binary argument key.')
            result[key] = read(depth + 1)
        return result

    result = read(0)
    require(type(result) is dict and offset == len(raw), 'Invalid original binary argument envelope.')
    return result


def arguments_agree(original, wire):
    """Reject changed values and exact integers; never regenerate Android JSON.

    Floating agreement is a typed round trip, not a unique JSON serialization.
    Consumers must not infer a wire digest or delivery from this check alone.
    """
    nodes = floating = 0

    def compare(left, right, depth=0):
        nonlocal nodes, floating
        nodes += 1
        require(depth <= 256 and nodes <= 2000000, 'Derived arguments exceed their structural bound.')
        if isinstance(left, JsonNumber):
            # Android JSONTokener reads integral int64 tokens as Long, otherwise
            # as Double. Unsupported lenient JSON remains explicit, not guessed.
            try:
                if re.fullmatch(r'-?(?:0|[1-9][0-9]*)', left) and -2**63 <= int(left) < 2**63:
                    left = int(left)
                else:
                    left = BinaryFloat(struct.pack('>d', float(left)), 8)
            except (ValueError, OverflowError):
                return False
        if type(left) is dict:
            return type(right) is dict and left.keys() == right.keys() and all(compare(left[k], right[k], depth + 1) for k in left)
        if type(left) is list:
            return type(right) is list and len(left) == len(right) and all(compare(a, b, depth + 1) for a, b in zip(left, right))
        if isinstance(left, BinaryFloat):
            floating += 1
            if not isinstance(right, JsonNumber):
                return False
            try:
                value = float(right)
                if not math.isfinite(value):
                    return False
                # JSONObject.numberToString may emit a saturated Long at the
                # int64 boundary; this retains that original Android behavior.
                long_value = max(-(2**63), min(2**63 - 1, int(left.value)))
                if left.value == float(long_value) and str(right) == str(long_value) and left.value != 0:
                    return True
                return struct.pack('>f' if left.width == 4 else '>d', value) == left.bits
            except (ValueError, OverflowError, struct.error):
                return False
        if type(left) is int:
            # A 64-bit identity cannot be rounded into a neighboring operation.
            return isinstance(right, JsonNumber) and str(right) == str(left)
        return type(left) is type(right) and left == right

    require(compare(original, wire), 'Derived Android arguments differ from their original values or types.')
    return floating


def check_schema(database):
    rows = database.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
    tables = {name for name, kind, _, _ in rows if kind == 'table'}
    require({'cache', 'outbox'}.issubset(tables) and tables.issubset(ANDROID_COLUMNS), 'Unsupported Android database schema.')
    require(database.execute('PRAGMA user_version').fetchone()[0] in (0, 1), 'Unsupported Android database version.')
    for name, kind, table, sql in rows:
        require(kind == 'table' or kind == 'index' and table in tables, 'Unsupported Android database schema object.')
        if kind != 'table':
            continue
        require(sql and sql.lstrip().upper().startswith('CREATE TABLE '), 'Virtual Android tables are not supported.')
        columns = database.execute('PRAGMA table_xinfo("' + name + '")').fetchall()
        require({row[1] for row in columns} == set(ANDROID_COLUMNS[name].split()) and all(row[6] == 0 for row in columns),
                'Unsupported Android table columns.')
        if name == 'outbox':
            require(any(row[1] == 'seq' and row[2].upper() == 'INTEGER' and row[5] == 1 for row in columns),
                    'The original Android queue has no exact integer sequence.')


def check_queue(directory, manifest):
    """Bind every derived row, including undecodable rows, to its original cell."""
    database_path = directory / 'workspace/workspace.sqlite'
    with closing(sqlite3.connect(database_path.as_uri() + '?mode=rw', uri=True, timeout=10)) as database:
        database.execute('PRAGMA trusted_schema=OFF')
        # Journal recovery can write here, but this is an exclusive private copy.
        require(database.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'The copied Android database is incomplete.')
        check_schema(database)
        database.execute('PRAGMA query_only=ON')
        database.execute('BEGIN')
        source = database.execute('SELECT seq,id,operation,typeof(args),length(CAST(args AS BLOB)) FROM outbox ORDER BY seq')
        rows = decoded = floating_rows = 0
        with (directory / 'derived/outbox-args.jsonl').open('rb') as wire:
            for sequence, identity, operation, encoding, size in source:
                rows += 1
                require(rows <= 100000 and integer(sequence, 2**63 - 1), 'The original Android queue exceeds its recovery bound.')
                require(isinstance(identity, str) and isinstance(operation, str) and len(identity) <= 4096 and len(operation) <= 4096,
                        'Invalid original Android operation identity.')
                line = wire.readline(WIRE_LIMIT + 1)
                require(len(line) <= WIRE_LIMIT and line.endswith(b'\n'), 'The Android request inventory is incomplete or oversized.')
                row = json_object(line)
                require(row.get('seq') == str(sequence) and row.get('id') == identity and row.get('operation') == operation
                        and row.get('sourceEncoding') == encoding, 'A derived request has a different original identity.')
                require(row.get('status') in ('decoded', 'requires-reconciliation'), 'Unknown Android request recovery state.')
                has_hash = 'sourceArgsSha256' in row or 'sourceArgsBytes' in row
                if has_hash:
                    require(integer(size, ROW_LIMIT), 'Derived arguments exceed the original decoder limit.')
                    raw = database.execute('SELECT CAST(args AS BLOB) FROM outbox WHERE seq=?', (sequence,)).fetchone()[0]
                    require(type(row.get('sourceArgsBytes')) is int and row['sourceArgsBytes'] == size
                            and row.get('sourceArgsSha256') == hashlib.sha256(raw).hexdigest(),
                            'A derived request does not match its original argument bytes.')
                if row['status'] == 'decoded':
                    require(has_hash and encoding in ('blob', 'text') and isinstance(row.get('argsJson'), str),
                            'A decoded request is missing its original binding.')
                    original = decode_binary(raw) if encoding == 'blob' else json_object(raw, numbers=True)
                    floating_rows += arguments_agree(original, json_object(row['argsJson'], numbers=True)) > 0
                    decoded += 1
                else:
                    require('argsJson' not in row, 'An uncertain request cannot supply executable arguments.')
            require(wire.read(1) == b'', 'The derived queue includes an unbound request.')
    queue = manifest['queue']
    require(all(integer(queue.get(key), 100000) for key in ('rows', 'decoded', 'requiresReconciliation'))
            and queue['rows'] == rows and queue['decoded'] == decoded and queue['requiresReconciliation'] == rows - decoded,
            'The Android queue counts do not match the retained database.')
    return {'version': 1, 'rowBindings': 'exact-original-cells', 'arguments': 'typed-roundtrip',
            'floatingRows': floating_rows, 'wireBytes': 'retained-not-reconstructed', 'delivery': 'not-inferred'}


def check_envelope(original, size):
    """Bound central-directory parsing before ZipFile allocates its inventory."""
    require(size >= 22, 'Truncated Android ZIP.')
    original.seek(size - 22)
    end = original.read(22)
    require(end[:4] == b'PK\x05\x06', 'The native Android ZIP has no complete final directory.')
    disk, start_disk, disk_count, count, central_size, central_offset, comment = struct.unpack('<4H2LH', end[4:])
    require(disk == start_disk == comment == 0 and disk_count == count and 1 < count <= MAX_MEMBERS
            and central_size <= MANIFEST_LIMIT and central_offset + central_size == size - 22,
            'Unsupported, oversized or incomplete Android ZIP directory.')
    original.seek(0)
    return count, central_offset


@contextmanager
def read_android_export(source):
    source = Path(source).absolute()
    no_links(source)
    before = source.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= LIMIT + MANIFEST_LIMIT,
            'Select a bounded regular Android recovery ZIP without links.')
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as original:
        require(signature(os.fstat(original.fileno())) == signature(before), 'The Android ZIP changed while opening.')
        sha = hashlib.sha256()
        for data in iter(lambda: original.read(64 * 1024), b''):
            sha.update(data)
        count, central_offset = check_envelope(original, before.st_size)
        with zipfile.ZipFile(original) as archive, tempfile.TemporaryDirectory(prefix='context-room-android-export-') as temporary:
            directory = Path(temporary).resolve()
            members = archive.infolist()
            names = [item.filename for item in members]
            require(len(names) == count and len(names) == len(set(names)) and names[-1] == 'manifest.json',
                    'The Android ZIP is incomplete or has duplicate entries.')
            require(all(name == 'manifest.json' or MEMBER.fullmatch(name) for name in names), 'Unknown or unsafe Android ZIP entry.')
            end = 0
            for item in members:
                mode = stat.S_IFMT(item.external_attr >> 16)
                require(item.orig_filename == item.filename and not item.is_dir() and mode in (0, stat.S_IFREG)
                        and not item.flag_bits & (1 | 64) and item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        'Linked, encrypted or unsupported Android ZIP entry.')
                require(item.header_offset >= end and (item is not members[0] or item.header_offset == 0),
                        'Overlapping or reordered Android ZIP members.')
                original.seek(item.header_offset)
                header = original.read(30)
                require(len(header) == 30 and header[:4] == b'PK\x03\x04', 'Invalid Android ZIP local header.')
                name_size, extra_size = struct.unpack('<HH', header[26:30])
                require(original.read(name_size) == item.filename.encode('ascii'), 'The Android ZIP has inconsistent member names.')
                end = item.header_offset + 30 + name_size + extra_size + item.compress_size
                require(end <= central_offset, 'An Android ZIP member overlaps its final directory.')
            info = archive.getinfo('manifest.json')
            require(info.file_size <= MANIFEST_LIMIT, 'The Android export manifest is oversized.')
            with archive.open(info) as content:
                manifest_bytes = content.read(MANIFEST_LIMIT + 1)
            require(len(manifest_bytes) == info.file_size, 'The Android export manifest is incomplete.')
            manifest = json_object(manifest_bytes)
            require(type(manifest.get('version')) is int and manifest['version'] == 1 and manifest.get('mediaType') == MEDIA_TYPE
                    and manifest.get('sourcePackage') == 'fr.lisiere.android' and manifest.get('accepted') is False
                    and manifest.get('sourceUnchanged') is True and integer(manifest.get('exporterVersionCode'), 2147483647)
                    and manifest['exporterVersionCode'] > 0, 'Unsupported Android export manifest.')
            queue = manifest.get('queue')
            require(type(queue) is dict and queue.get('encoding') == 'android-org-json' and queue.get('delivery') == 'not-inferred',
                    'Unsupported Android queue metadata.')
            require(manifest.get('recordings') == {'encoding': 'pcm-s16le', 'sampleRate': 16000, 'channels': 1, 'context': 'unassigned'},
                    'Unsupported original Android recording metadata.')
            entries = manifest.get('files')
            require(type(entries) is list and len(entries) == len(names) - 1, 'The Android export inventory is incomplete.')
            listed, total = set(), 0
            # Validate every declaration before decompressing a single original.
            for entry in entries:
                require(type(entry) is dict and isinstance(entry.get('path'), str) and MEMBER.fullmatch(entry['path'])
                        and integer(entry.get('bytes')) and isinstance(entry.get('sha256'), str)
                        and re.fullmatch('[a-f0-9]{64}', entry['sha256']), 'Invalid Android ZIP file identity.')
                relative = entry['path']
                require(relative not in listed and relative in names, 'Duplicate or absent Android ZIP file.')
                listed.add(relative)
                total += entry['bytes']
                require(total <= LIMIT and archive.getinfo(relative).file_size == entry['bytes'], 'The Android ZIP exceeds its declared bounds.')
                if relative.startswith('recordings/'):
                    require(entry['bytes'] <= 16000 * 2 * 120 and entry['bytes'] % 2 == 0, 'Invalid original Android PCM length.')
            require(listed == set(names) - {'manifest.json'} and {'workspace/workspace.sqlite', 'derived/outbox-args.jsonl'}.issubset(listed),
                    'The Android recovery ZIP is missing required original data.')
            for entry in entries:
                target = directory / entry['path']
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                digest, size = hashlib.sha256(), 0
                with archive.open(entry['path']) as content, target.open('xb') as copied:
                    os.chmod(target, 0o600)
                    for data in iter(lambda: content.read(64 * 1024), b''):
                        size += len(data)
                        require(size <= entry['bytes'], 'An Android ZIP member grew during extraction.')
                        copied.write(data)
                        digest.update(data)
                require(size == entry['bytes'] and digest.hexdigest() == entry['sha256'], 'An Android ZIP member failed its content hash.')
            (directory / 'recordings').mkdir(exist_ok=True, mode=0o700)
            # Keep the native manifest exactly, including unknown descriptive
            # fields; do not replace it with a reconstructed JS representation.
            retained_manifest = directory / 'derived/android-export-manifest.json'
            retained_manifest.write_bytes(manifest_bytes)
            retained_manifest.chmod(0o600)
            verification = check_queue(directory, manifest)
            metadata = {'version': 1, 'mediaType': MEDIA_TYPE, 'sourcePackage': manifest['sourcePackage'],
                        'exporterVersionCode': manifest['exporterVersionCode'], 'sha256': sha.hexdigest(), 'bytes': before.st_size,
                        'queue': queue, 'verification': verification, 'delivery': 'not-inferred'}
            yield directory, metadata
            no_links(source)
            require(signature(os.fstat(original.fileno())) == signature(before) and signature(source.lstat()) == signature(before),
                    'The original Android ZIP changed during recovery.')
