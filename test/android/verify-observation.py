#!/usr/bin/env python3
"""Opt-in real-Codex original-source image proof on a dedicated synthetic emulator."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true', required=True)
parser.add_argument('--serial', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--codex-state', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo) or not args.serial.startswith('emulator-') or not args.codex_state.resolve().is_dir():
    raise SystemExit('Use a new private output, an existing isolated Codex state and a dedicated emulator.')
adb = [str(Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb'), '-s', args.serial]
def run(argv, **options):
    return subprocess.run(argv, check=True, **options)
avd = run(adb + ['emu', 'avd', 'name'], capture_output=True, text=True).stdout.splitlines()[0]
if not avd.startswith('ContextRoom_'):
    raise SystemExit('Personal emulators and physical devices are not accepted.')
output.mkdir(parents=True, mode=0o700)
artifact = run(['python3', str(repo / 'scripts/check-android-artifact.py')], capture_output=True, text=True).stdout
(output / 'artifact.json').write_text(artifact)
for relative in ('debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk'):
    result = run(adb + ['install', '-r', str(repo / 'android/app/build/outputs/apk' / relative)], capture_output=True, text=True)
    if 'Success' not in result.stdout:
        raise RuntimeError('APK installation was not confirmed')
fixture_dir = output / 'fixture'
environment = dict(os.environ, CONTEXT_ROOM_TEST_REAL_AGENT='1', CONTEXT_ROOM_TEST_CODEX_STATE=str(args.codex_state.resolve()), CONTEXT_ROOM_TEST_OBSERVATION_TRACE='1')
with (output / 'fixture.log').open('w') as fixture_log:
    fixture = subprocess.Popen(['node', str(repo / 'test/android/owner-fixture.mjs'), str(fixture_dir)], cwd=repo, env=environment, stdout=fixture_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while not (fixture_dir / 'fixture.json').exists():
            if fixture.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('The isolated owner fixture did not become ready')
            time.sleep(.1)
        original = fixture_dir / 'project/docs/Owner.crnb'
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        run(adb + ['push', str(fixture_dir / 'ticket.json'), '/data/local/tmp/context-room-observation-ticket.json'], capture_output=True)
        with (output / 'OwnerObservationDeviceTest.log').open('w') as log:
            result = subprocess.run(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.OwnerObservationDeviceTest',
                '-e', 'fixture', '/data/local/tmp/context-room-observation-ticket.json', '-e', 'realAgent', 'true',
                'app.contextroom.tablet.preview.test/androidx.test.runner.AndroidJUnitRunner'], stdout=log, stderr=subprocess.STDOUT, timeout=300)
        log = (output / 'OwnerObservationDeviceTest.log').read_text()
        if result.returncode != 0 or 'OK (1 test)' not in log or 'FAILURES!!!' in log:
            with (output / 'device-diagnostic.log').open('w') as diagnostic:
                subprocess.run(adb + ['logcat', '-d', '-s', 'System.out:I', 'AndroidRuntime:E', 'chromium:E', '*:S'], stdout=diagnostic, stderr=subprocess.STDOUT)
            failure = subprocess.run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/native-observation-failure.png'], capture_output=True)
            if failure.returncode == 0:
                (output / 'native-observation-failure.png').write_bytes(failure.stdout)
            raise RuntimeError('Real native observation failed; inspect the retained evidence.')
        for name in ('native-original-observation', 'native-observation-stopped'):
            with (output / (name + '.png')).open('wb') as image:
                run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/' + name + '.png'], stdout=image)
        native = json.loads(run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/native-observation-proof.json'], capture_output=True, text=True).stdout)
        receipts = [json.loads(line) for line in (fixture_dir / 'observation-receipts.jsonl').read_text().splitlines()]
        images = [item for item in receipts if item['images'] == 1 and item.get('observation', {}).get('state') == 'live']
        assert images and all(item['objectCount'] == 0 and item['observation']['accepted'] is False for item in images), 'The real tool must carry an image of unfinished work absent from the scene'
        assert all(item['action'] == 'scene' for item in receipts), 'Observation must not mutate the notebook'
        assert hashlib.sha256(original.read_bytes()).hexdigest() == before, 'Observation and human working ink must not accept a file'
        proof = dict(native, sourceHead=run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout.strip(),
            dirty=bool(run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True).stdout),
            apk=json.loads(artifact), emulator=avd, realCodexImageReceipts=len(images), acceptedFileUnchanged=True, physicalBoox='not-tested')
        (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps(proof), flush=True)
    finally:
        if fixture.poll() is None:
            fixture.terminate()
            try:
                fixture.wait(timeout=15)
            except subprocess.TimeoutExpired:
                raise RuntimeError('The owned fixture did not shut down; it remains available for inspection.')
