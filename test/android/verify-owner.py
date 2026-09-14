#!/usr/bin/env python3
"""Run the real owner UI on a separate emulator, retaining private evidence."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo) or not args.serial.startswith('emulator-'):
    raise SystemExit('Use a new private evidence directory and an isolated emulator.')
adb = [str(Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb'), '-s', args.serial]
def run(argv, **options):
    try:
        return subprocess.run(argv, check=True, **options)
    except subprocess.CalledProcessError as error:
        if output.exists():
            with (output / 'command-failures.log').open('a') as log:
                log.write(str(error) + '\n')
                for value in (error.stdout, error.stderr):
                    if value:
                        log.write(value.decode(errors='replace') if isinstance(value, bytes) else value)
        raise
avd = run(adb + ['emu', 'avd', 'name'], capture_output=True, text=True).stdout.splitlines()[0]
if not avd.startswith('ContextRoom_'):
    raise SystemExit('Personal emulators and physical devices are not accepted by this fixture.')
output.mkdir(parents=True, mode=0o700)
fixture_dir = output / 'fixture'
fixture_log = (output / 'fixture.log').open('w')
fixture = subprocess.Popen(['node', str(repo / 'test/android/owner-fixture.mjs'), str(fixture_dir)], cwd=repo, stdout=fixture_log, stderr=subprocess.STDOUT)
try:
    deadline = time.monotonic() + 20
    while not (fixture_dir / 'fixture.json').exists():
        if fixture.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Owner fixture did not become ready; inspect fixture.log')
        time.sleep(.1)
    state = json.loads((fixture_dir / 'fixture.json').read_text())
    original = fixture_dir / 'project/docs/Owner.crnb'
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    artifact = run(['python3', str(repo / 'scripts/check-android-artifact.py')], capture_output=True, text=True)
    (output / 'artifact.json').write_text(artifact.stdout)
    for relative in ('debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk'):
        installed = run(adb + ['install', '-r', str(repo / 'android/app/build/outputs/apk' / relative)], capture_output=True, text=True)
        if 'Success' not in installed.stdout:
            raise RuntimeError('APK installation was not confirmed')
    run(adb + ['push', str(fixture_dir / 'ticket.json'), '/data/local/tmp/context-room-owner-ticket.json'], capture_output=True)
    def exported_names():
        entries = run(adb + ['shell', 'ls', '-1', '/sdcard/Download'], capture_output=True, text=True).stdout.splitlines()
        # Android may append its collision suffix after an unknown extension.
        return {name for name in entries if re.fullmatch(r'Owner(?: \(\d+\))?\.crnb(?: \(\d+\))?', name)}
    exports_before = exported_names()
    run(adb + ['shell', 'am', 'force-stop', 'app.contextroom.tablet.preview'], capture_output=True)
    started = time.monotonic()
    log_path = output / 'owner-workspace.log'
    with log_path.open('w') as log:
        result = subprocess.run(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.OwnerWorkspaceTest',
            '-e', 'fixture', '/data/local/tmp/context-room-owner-ticket.json', 'app.contextroom.tablet.preview.test/androidx.test.runner.AndroidJUnitRunner'], stdout=log, stderr=subprocess.STDOUT, timeout=150)
    if result.returncode != 0 or 'OK (1 test)' not in log_path.read_text() or 'FAILURES!!!' in log_path.read_text():
        with (output / 'owner-diagnostic.log').open('w') as log:
            subprocess.run(adb + ['logcat', '-d', '-s', 'System.out:I', 'chromium:E', '*:S'], stdout=log, stderr=subprocess.STDOUT)
        with (output / 'owner-failure.png').open('wb') as image:
            run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/owner-failure.png'], stdout=image)
        raise RuntimeError('Owner UI acceptance failed: ' + str(log_path))
    for name in ('owner-rendered-document', 'owner-native-drawing', 'owner-retained-workspace', 'owner-imported-image', 'owner-exported-notebook', 'owner-human-file-decision', 'owner-settings', 'owner-shared-review'):
        with (output / (name + '.png')).open('wb') as image:
            run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/' + name + '.png'], stdout=image)
    scene = json.loads(run(['node', '--input-type=module', '-e',
        "import {readNotebook} from './src/notebooks.mjs'; process.stdout.write(JSON.stringify(readNotebook(process.argv[1], 'owner-native-notebook')));",
        state['sourceRoot']], cwd=repo, capture_output=True, text=True).stdout)
    assert len(scene['document']['objects']) == 2 and scene['accepted'] is False
    assert any(obj['type'] == 'image' for obj in scene['document']['objects'])
    exported = exported_names() - exports_before
    assert len(exported) == 1, 'The system picker must create one new editable export'
    name = exported.pop()
    # exec-out preserves argv; shell quotes would become part of the filename.
    exported_bytes = run(adb + ['exec-out', 'cat', '/sdcard/Download/' + name], capture_output=True).stdout
    (output / 'exported-owner.crnb').write_bytes(exported_bytes)
    assert json.loads(exported_bytes) == scene['document'], 'The Android export must contain the exact acknowledged scene and image'
    assert hashlib.sha256(original.read_bytes()).hexdigest() == before, 'Autosave cannot accept the working notebook'
    (output / 'proof.json').write_text(json.dumps({
        'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout.strip(),
        'dirty': bool(run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True).stdout),
        'apk': json.loads(artifact.stdout), 'emulator': avd, 'durationSeconds': round(time.monotonic() - started, 2),
        'ownerWorkspace': 'passed', 'nativeObjectsOnMac': len(scene['document']['objects']),
        'acceptedFileUnchanged': True, 'physicalBoox': 'not-tested',
        'editableExportSha256': hashlib.sha256(exported_bytes).hexdigest()
    }, indent=2) + '\n')
    print('Real owner UI, rendered documents and native notebook round trip: passed', flush=True)
finally:
    if fixture.poll() is None:
        fixture.terminate()
        try:
            fixture.wait(timeout=15)
        except subprocess.TimeoutExpired:
            raise RuntimeError('The owned fixture did not shut down; it was left intact for inspection.')
    fixture_log.close()
