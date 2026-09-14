#!/usr/bin/env python3
"""Verify the preview APK on an explicitly named, isolated ContextRoom emulator."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', type=Path, required=True, help='New private evidence directory outside the repository')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo):
    raise SystemExit('Choose a new evidence directory outside the source repository.')
if not args.serial.startswith('emulator-'):
    raise SystemExit('This automatic fixture accepts only a separate Android emulator, never a physical device.')
sdk = Path(os.environ['ANDROID_HOME'])
adb = [str(sdk / 'platform-tools/adb'), '-s', args.serial]

def run(argv, **options):
    return subprocess.run(argv, check=True, **options)

avd = run(adb + ['emu', 'avd', 'name'], capture_output=True, text=True).stdout.splitlines()[0]
if not avd.startswith('ContextRoom_'):
    raise SystemExit('Use an isolated AVD whose name starts with ContextRoom_. Existing personal emulators are preserved.')
output.mkdir(parents=True, mode=0o700)
fixture_dir = output / 'fixture'
fixture_log = (output / 'fixture.log').open('w')
service = subprocess.Popen(['node', str(repo / 'test/android/fixture.mjs'), str(fixture_dir)], cwd=repo, stdout=fixture_log, stderr=subprocess.STDOUT)

try:
    deadline = time.monotonic() + 15
    while not (fixture_dir / 'fixture.json').exists():
        if service.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('Fixture did not become ready; inspect fixture.log')
        time.sleep(.1)
    fixture = json.loads((fixture_dir / 'fixture.json').read_text())
    apk = repo / 'android/app/build/outputs/apk/debug/app-debug.apk'
    test_apk = repo / 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'
    artifact = run(['python3', str(repo / 'scripts/check-android-artifact.py'), '--apk', str(apk)], capture_output=True, text=True)
    (output / 'artifact.json').write_text(artifact.stdout)
    for source in (apk, test_apk):
        result = run(adb + ['install', '-r', str(source)], capture_output=True, text=True)
        if 'Success' not in result.stdout:
            raise RuntimeError('APK installation was not confirmed')
    request = urllib.request.Request(fixture['ownerUrl'] + '/ticket', method='POST')
    with urllib.request.urlopen(request, timeout=10) as response:
        ticket = json.load(response)['path']
    run(adb + ['push', ticket, '/data/local/tmp/context-room-ticket.json'], capture_output=True)
    durations = {}
    navigation_receipts = {}
    view_receipts = {}

    def owner(route, method='GET', body=None):
        data = None if body is None else json.dumps(body).encode()
        with urllib.request.urlopen(urllib.request.Request(fixture['ownerUrl'] + route, method=method, data=data, headers={'content-type': 'application/json'}), timeout=10) as response:
            return json.load(response)

    def navigation_progress():
        stage_file = subprocess.run(adb + ['shell', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/navigation-stage.json'], capture_output=True)
        if stage_file.returncode != 0:
            return
        stage = json.loads(stage_file.stdout)
        if stage.get('serverId') != fixture['serverId']:
            return
        stage = stage['stage']
        current = owner('/navigation')
        next_stage = None
        if stage == 'drawingFirst':
            if current['online'] and 'firstRequested' not in navigation_receipts:
                navigation_receipts['firstRequested'] = owner('/open?target=second&operationId=fixture-first-opening', 'POST')
            if (current.get('command') or {}).get('status') == 'deferred':
                navigation_receipts['firstDeferred'] = current['command']
                next_stage = 'deferredFirst'
        elif stage == 'secondDisplayed':
            assert current['command']['status'] == 'applied', current
            assert current['command']['appliedTarget']['resourceId'] == 'android-second'
            navigation_receipts['firstApplied'] = current['command']
            next_stage = 'appliedFirst'
        elif stage == 'drawingSecond':
            if 'secondRequested' not in navigation_receipts:
                navigation_receipts['secondRequested'] = owner('/open?target=first&operationId=fixture-second-opening', 'POST')
            if current['command']['operationId'] == 'fixture-second-opening' and current['command']['status'] == 'deferred':
                navigation_receipts['secondDeferred'] = current['command']
                next_stage = 'deferredSecond'
        elif stage == 'cancelledSecond':
            assert current['command']['status'] == 'cancelled', current
            navigation_receipts['secondCancelled'] = current['command']
            next_stage = 'cancelledSecond'
        elif stage in ('viewIndependent', 'viewFollowing', 'viewStopped', 'tabletSharing'):
            sequence = 3 if stage == 'tabletSharing' else 2 if stage == 'viewStopped' else 1
            body = {'sequence': sequence, 'mode': 'follow' if stage == 'tabletSharing' else 'share',
                    'viewport': [3000, 3000, 800, 500] if stage == 'viewStopped' else [0, 0, 700, 480]}
            view = owner('/view', 'POST', body)
            if stage == 'viewIndependent':
                assert view['receipt'] is None
                next_stage = 'viewSourceReady'
            elif stage == 'viewFollowing' and view['receipt'] is not None:
                assert view['receipt']['target']['resourceId'] == 'android-acceptance'
                assert view['receipt']['sequence'] == 1 and view['receipt']['accepted'] is False
                view_receipts['nativeApplied'] = view['receipt']
                next_stage = 'viewApplied'
            elif stage == 'viewStopped':
                assert view['receipt'] is None
                next_stage = 'viewSourceChanged'
            elif stage == 'tabletSharing' and view['frame'] is not None:
                assert view['frame']['target']['resourceId'] == 'android-acceptance'
                view_receipts['tabletPublished'] = view['frame']
                next_stage = 'tabletViewReceived'
        if next_stage and navigation_receipts.get('lastOwnerStage') != next_stage:
            acknowledgement = output / 'navigation-owner.json'
            acknowledgement.write_text(json.dumps({'serverId': fixture['serverId'], 'stage': next_stage}))
            run(adb + ['push', str(acknowledgement), '/data/local/tmp/context-room-navigation-owner.json'], capture_output=True)
            navigation_receipts['lastOwnerStage'] = next_stage

    for phase in ('pairedNativeInkAndOfflineQueue', 'restartReplaysOfflineExactlyOnce', 'remoteOpeningPreservesInkAndHumanControl', 'nativeViewFollowingAndPresentation', 'nativeOpeningRejectsQueuedPreviousScene', 'nativeStorageBoundary'):
        # The target is the fixture preview only, on the checked, separate emulator.
        run(adb + ['shell', 'am', 'force-stop', 'app.contextroom.tablet.preview'], capture_output=True)
        started = time.monotonic()
        log_path = output / (phase + '.log')
        with log_path.open('w') as log:
            process = subprocess.Popen(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.NotebookDeviceTest#' + phase,
                       '-e', 'fixture', '/data/local/tmp/context-room-ticket.json',
                       'app.contextroom.tablet.preview.test/androidx.test.runner.AndroidJUnitRunner'], stdout=log, stderr=subprocess.STDOUT)
            while process.poll() is None:
                if time.monotonic() - started > 100:
                    raise RuntimeError('Android phase exceeded its deadline: ' + str(log_path))
                if phase in ('remoteOpeningPreservesInkAndHumanControl', 'nativeViewFollowingAndPresentation'):
                    navigation_progress()
                time.sleep(.35)
            if process.returncode != 0:
                raise RuntimeError('Android instrumentation command failed: ' + str(log_path))
        content = log_path.read_text()
        # am instrument can return process exit 0 for a failed JUnit test.
        if 'OK (1 test)' not in content or 'FAILURES!!!' in content:
            with (output / (phase + '-diagnostic.log')).open('w') as diagnostic:
                subprocess.run(adb + ['logcat', '-d', '-s', 'System.out:I', '*:S'], stdout=diagnostic, stderr=subprocess.STDOUT)
            (output / 'navigation-receipts.json').write_text(json.dumps(navigation_receipts, indent=2) + '\n')
            (output / 'view-receipts.json').write_text(json.dumps(view_receipts, indent=2) + '\n')
            raise RuntimeError('Android acceptance phase failed: ' + str(log_path))
        durations[phase] = round(time.monotonic() - started, 2)
        print(phase + ': passed', flush=True)
    for name in ('notebook-offline', 'notebook-recovered', 'notebook-remote-open', 'notebook-following', 'notebook-presentation'):
        with (output / (name + '.png')).open('wb') as image:
            run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/' + name + '.png'], stdout=image)
        if not (output / (name + '.png')).read_bytes().startswith(b'\x89PNG\r\n\x1a\n'):
            raise RuntimeError('Missing rendered Android capture')
    with urllib.request.urlopen(fixture['ownerUrl'] + '/scene', timeout=10) as response:
        scene = json.load(response)
    assert len(scene['document']['objects']) == 12
    assert scene['accepted'] is False
    assert not (fixture_dir / 'project/docs/Tablet.crnb').exists()
    second = owner('/scene?target=second')
    assert len(second['document']['objects']) == 3 and second['accepted'] is False
    assert not (fixture_dir / 'project/docs/Second.crnb').exists()
    assert navigation_receipts['firstApplied']['accepted'] is False
    assert navigation_receipts['secondCancelled']['accepted'] is False
    (output / 'navigation-receipts.json').write_text(json.dumps(navigation_receipts, indent=2) + '\n')
    assert view_receipts['nativeApplied']['accepted'] is False
    (output / 'view-receipts.json').write_text(json.dumps(view_receipts, indent=2) + '\n')
    proof = {'schemaVersion': 1, 'device': 'isolated Android emulator', 'avd': avd, 'physicalBoox': False,
             'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'durationsSeconds': durations,
             'canonicalObjects': 12, 'secondNotebookObjects': 3, 'nativeDisplayReceipt': True, 'humanCancelledOpening': True, 'accepted': False,
             'nativeViewReceipt': True, 'humanStoppedFollowing': True, 'nativePresentation': True,
             'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout.strip(),
             'sourceHasUncommittedChanges': bool(run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True).stdout.strip())}
    (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    shutil.copyfile(apk, output / 'Context-Room-preview.apk')
    print('Native drawing, local durability, process restart and canonical replay verified. ' + str(output), flush=True)
finally:
    service.terminate()
    try:
        service.wait(timeout=10)
    except subprocess.TimeoutExpired:
        service.kill()
        service.wait()
    fixture_log.close()
