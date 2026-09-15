#!/usr/bin/env python3
"""Preserve an original signed APK's synthetic data through a real emulator upgrade."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--original-apk', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
resume = parser.add_mutually_exclusive_group()
resume.add_argument('--resume-from', type=Path, help='Resume only the exact owned, already-seeded fixture after an interrupted native check.')
resume.add_argument('--resume-export-from', type=Path, help='Recheck a retained successful native export and finish only the Mac stage.')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo) or not args.serial.startswith('emulator-'):
    raise SystemExit('Use a new private output directory and the dedicated emulator.')
sdk = Path(os.environ['ANDROID_HOME'])
adb = [str(sdk / 'platform-tools/adb'), '-s', args.serial]
package = 'fr.lisiere.android'
profile = repo / 'android/.local/legacy-recovery-build/app/outputs/apk'
apk = profile / 'debug/app-debug.apk'
test_apk = profile / 'androidTest/debug/app-debug-androidTest.apk'
def sha(data):
    return hashlib.sha256(data).hexdigest()
def run(argv, **options):
    result = subprocess.run(argv, capture_output=True, **options)
    if result.returncode:
        if output.exists():
            with (output / 'command-failures.log').open('ab') as log:
                log.write(('Command failed: ' + repr(argv) + '\n').encode())
                log.write(result.stdout + result.stderr)
        raise RuntimeError('Command failed; inspect the private command log.')
    return result.stdout
avd = run(adb + ['emu', 'avd', 'name']).decode().splitlines()[0]
if not avd.startswith('ContextRoom_'):
    raise SystemExit('This upgrade fixture refuses personal emulators and physical devices.')
output.mkdir(parents=True, mode=0o700)
artifact = json.loads(run(['python3', str(repo / 'scripts/check-android-artifact.py'), '--apk', str(apk), '--upgrade-from', str(args.original_apk)]))
(output / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
def install(file):
    assert b'Success' in run(adb + ['install', '-r', str(file)]), 'APK installation was not confirmed'
def private_file(relative):
    assert re.fullmatch(r'(?:databases|files|shared_prefs)/[a-zA-Z0-9_./-]+', relative) and '..' not in relative.split('/')
    return run(adb + ['exec-out', 'run-as', package, 'cat', relative])
def instrumentation(cls, mode, count=1, name=None):
    result = subprocess.run(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.' + cls,
        '-e', 'legacyRecoveryFixture', mode, package + '.test/androidx.test.runner.AndroidJUnitRunner'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    log_name = name or mode
    (output / (log_name + '-instrumentation.log')).write_bytes(result.stdout)
    success = ('OK (' + str(count) + (' test)' if count == 1 else ' tests)')).encode()
    if result.returncode or success not in result.stdout or b'FAILURES!!!' in result.stdout:
        if mode == 'verify':
            capture = subprocess.run(adb + ['exec-out', 'run-as', package, 'cat', 'files/legacy-recovery-failure.png'], capture_output=True)
            if capture.returncode == 0:
                (output / 'legacy-recovery-failure.png').write_bytes(capture.stdout)
        raise RuntimeError('Upgrade instrumentation failed; inspect ' + log_name + '-instrumentation.log')
installed = run(adb + ['shell', 'pm', 'list', 'packages', package]).decode().splitlines()
previous_output = args.resume_from or args.resume_export_from
if previous_output:
    previous_output = previous_output.resolve()
    previous = json.loads((previous_output / 'owned-fixture.json').read_text())
    assert previous['serial'] == args.serial and previous['emulator'] == avd
    assert previous['originalApkSha256'] == sha(args.original_apk.read_bytes())
    assert 'package:' + package in installed, 'The owned original application is missing'
    seed = previous['seed']
    original_files = previous['originalFiles']
    for file, expected in original_files.items():
        assert sha(private_file(file)) == expected, 'An owned original changed before recovery: ' + file
else:
    assert 'package:' + package not in installed, 'An existing Lisière installation is never reset or replaced by a new fixture; use its owned resume marker'
    install(args.original_apk)
    install(test_apk)
    instrumentation('LegacyUpgradeSeedTest', 'seed')
    seed = json.loads(private_file('files/recovery-upgrade-fixture.json'))
    required = ['databases/workspace.sqlite', 'databases/workspace.sqlite-wal', 'shared_prefs/workspace.xml', 'files/dictation/' + seed['recording']]
    original_files = {file: sha(private_file(file)) for file in required}
    assert len(private_file('databases/workspace.sqlite-wal')) > 2 * 1024 * 1024, 'The fixture must retain committed large WAL data'
marker = {'serial': args.serial, 'emulator': avd, 'originalApkSha256': sha(args.original_apk.read_bytes()), 'seed': seed, 'originalFiles': original_files}
(output / 'owned-fixture.json').write_text(json.dumps(marker, indent=2) + '\n')
def exported_names():
    entries = run(adb + ['shell', 'ls', '-1', '/sdcard/Download']).decode().splitlines()
    return {name for name in entries if re.fullmatch(r'context-room-lisiere-recovery(?: \(\d+\))?\.zip(?: \(\d+\))?', name)}
if args.resume_export_from:
    assert json.loads((previous_output / 'artifact.json').read_text()) == artifact, 'The tested native APK changed'
    for name, success in [('verify', b'OK (1 test)'), ('archive', b'OK (4 tests)'), ('resume', b'OK (1 test)')]:
        native = (previous_output / (name + '-instrumentation.log')).read_bytes()
        assert success in native and b'FAILURES!!!' not in native, 'No successful retained native check: ' + name
        (output / (name + '-instrumentation.log')).write_bytes(native)
    for name in ('legacy-upgraded-entry', 'legacy-recovery-ready', 'legacy-recovery-exported', 'legacy-recovery-cancelled'):
        (output / (name + '.png')).write_bytes((previous_output / (name + '.png')).read_bytes())
    exported = (previous_output / 'tablet-recovery.zip').read_bytes()
else:
    exports_before = exported_names()
    install(apk)
    install(test_apk)
    for file, expected in original_files.items():
        assert sha(private_file(file)) == expected, 'The APK upgrade changed original data: ' + file
    instrumentation('LegacyRecoveryTest', 'verify')
    instrumentation('LegacyRecoveryArchiveTest', 'verify', 4, 'archive')
    instrumentation('LegacyRecoveryResumeTest', 'verify', 1, 'resume')
    for name in ('legacy-upgraded-entry', 'legacy-recovery-ready', 'legacy-recovery-exported', 'legacy-recovery-cancelled'):
        (output / (name + '.png')).write_bytes(private_file('files/' + name + '.png'))
    exports = exported_names() - exports_before
    assert len(exports) == 1, 'The picker must create one new explicit export'
    exported = run(adb + ['exec-out', 'cat', '/sdcard/Download/' + exports.pop()])
(output / 'tablet-recovery.zip').write_bytes(exported)
with zipfile.ZipFile(output / 'tablet-recovery.zip') as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)) and names[-1] == 'manifest.json'
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['version'] == 1 and manifest['mediaType'] == 'application/vnd.context-room.lisiere-android-export+json'
    assert manifest['sourcePackage'] == package and manifest['exporterVersionCode'] == 96 and manifest['accepted'] is False
    assert set(names) == {entry['path'] for entry in manifest['files']} | {'manifest.json'}
    unpacked = output / 'unpacked'
    unpacked.mkdir(mode=0o700)
    total = 0
    for entry in manifest['files']:
        relative = entry['path']
        assert re.fullmatch(r'workspace/workspace\.sqlite(?:-wal|-journal)?|recordings/[a-f0-9]{64}\.pcm|derived/outbox-args\.jsonl', relative)
        total += entry['bytes']
        assert total <= 512 * 1024 * 1024 and archive.getinfo(relative).file_size == entry['bytes']
        data = archive.read(relative)
        assert sha(data) == entry['sha256']
        target = unpacked / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.write_bytes(data)
        target.chmod(0o600)
        if relative.startswith('workspace/'):
            assert sha(data) == original_files['databases/' + relative.split('/')[1]]
        if relative.startswith('recordings/'):
            assert sha(data) == original_files['files/dictation/' + relative.split('/')[1]]
    assert not any('shared_prefs' in name or 'credentials' in name for name in names)
    requests = [json.loads(line) for line in archive.read('derived/outbox-args.jsonl').splitlines()]
    assert len(requests) == 3 and manifest['queue']['decoded'] == 2 and manifest['queue']['requiresReconciliation'] == 1
    assert manifest['queue']['delivery'] == 'not-inferred'
    first = requests[0]
    assert first['seq'] == seed['sequence'] and first['sourceArgsSha256'] == seed['rawArgsSha256']
    assert sha(first['argsJson'].encode('utf-8')) == seed['androidArgsSha256'], 'Native serialization must preserve the original Android Float/Double request text'
    assert first['sourceArgsBytes'] > 2 * 1024 * 1024, 'The binary row must exceed Android CursorWindow size'
    assert requests[2]['status'] == 'requires-reconciliation' and 'argsJson' not in requests[2]
for file, expected in original_files.items():
    assert sha(private_file(file)) == expected, 'Recovery changed the original application data: ' + file
# The existing recovery reader must also consume the exported WAL on the Mac.
snapshot = output / 'mac-snapshot'
cli = ['node', str(repo / 'bin/context-room.mjs'), 'migrate', '--export-lisiere', str(unpacked / 'workspace'), '--recordings', str(unpacked / 'recordings'), '--output', str(snapshot)]
preview = json.loads(run(cli, cwd=output))['data']
completed = json.loads(run(cli + ['--apply', '--revision', preview['revision']], cwd=output))['data']
assert completed['exported'] is True and completed['kind'] == 'android-workspace'
(output / 'proof.json').write_text(json.dumps({'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip(),
    'dirty': bool(run(['git', 'status', '--porcelain'], cwd=repo)), 'emulator': avd, 'apk': artifact,
    'originalFilesUnchanged': True, 'preferencesPreservedAndExcluded': True, 'committedWalRetained': True,
    'archiveContractsPassed': 4, 'recreationAndPickerCancellation': True,
    'androidArgsMatchOriginal': True, 'unreadableOriginalRetained': True, 'macSnapshotVersion': completed['version'],
    'zipSha256': sha(exported), 'bytes': len(exported), 'resumedMacStage': bool(args.resume_export_from),
    'physicalBoox': 'not-tested'}, indent=2) + '\n')
print('Original APK upgrade, native recovery export and Mac snapshot: passed', flush=True)
