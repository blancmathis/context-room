#!/usr/bin/env python3
"""Explicit real-Codex acceptance on a separate emulator and synthetic notebook."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true', required=True)
parser.add_argument('--serial', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--codex-state', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo) or not args.serial.startswith('emulator-'):
    raise SystemExit('Use a new private evidence directory and an isolated emulator.')
if args.codex_state and not args.codex_state.resolve().is_dir():
    raise SystemExit('The selected isolated Codex state must already exist.')
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
    installed = run(adb + ['install', '-r', str(repo / 'android/app/build/outputs/apk' / relative)], capture_output=True, text=True)
    if 'Success' not in installed.stdout:
        raise RuntimeError('APK installation was not confirmed')
fixture_dir = output / 'fixture'
environment = dict(os.environ, CONTEXT_ROOM_TEST_REAL_AGENT='1')
if args.codex_state:
    environment['CONTEXT_ROOM_TEST_CODEX_STATE'] = str(args.codex_state.resolve())
with (output / 'fixture.log').open('w') as fixture_log:
    fixture = subprocess.Popen(['node', str(repo / 'test/android/owner-fixture.mjs'), str(fixture_dir)], cwd=repo, env=environment, stdout=fixture_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while not (fixture_dir / 'fixture.json').exists():
            if fixture.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('The owner fixture did not become ready')
            time.sleep(.1)
        state = json.loads((fixture_dir / 'fixture.json').read_text())
        original = fixture_dir / 'project/docs/Owner.crnb'
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        run(adb + ['push', str(fixture_dir / 'ticket.json'), '/data/local/tmp/context-room-real-agent-ticket.json'], capture_output=True)
        run(adb + ['shell', 'am', 'force-stop', 'app.contextroom.tablet.preview'], capture_output=True)
        with (output / 'OwnerAgentDeviceTest.log').open('w') as log:
            result = subprocess.run(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.OwnerAgentDeviceTest',
                '-e', 'fixture', '/data/local/tmp/context-room-real-agent-ticket.json', '-e', 'realAgent', 'true',
                'app.contextroom.tablet.preview.test/androidx.test.runner.AndroidJUnitRunner'], stdout=log, stderr=subprocess.STDOUT, timeout=450)
        log = (output / 'OwnerAgentDeviceTest.log').read_text()
        if result.returncode != 0 or 'OK (1 test)' not in log or 'FAILURES!!!' in log:
            with (output / 'device-diagnostic.log').open('w') as diagnostic:
                subprocess.run(adb + ['logcat', '-d', '-s', 'System.out:I', 'AndroidRuntime:E', 'chromium:E', '*:S'], stdout=diagnostic, stderr=subprocess.STDOUT)
            captured = subprocess.run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/native-real-agent-failure.png'], capture_output=True)
            if captured.returncode == 0:
                (output / 'native-real-agent-failure.png').write_bytes(captured.stdout)
            raise RuntimeError('Real native agent acceptance failed; inspect OwnerAgentDeviceTest.log')
        for name in ('native-real-agent-progress', 'native-real-agent-complete'):
            with (output / (name + '.png')).open('wb') as image:
                run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/' + name + '.png'], stdout=image)
        native = json.loads(run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/native-real-agent-proof.json'], capture_output=True, text=True).stdout)
        (output / 'native.json').write_text(json.dumps(native, indent=2) + '\n')
        scene = json.loads(run(['node', '--input-type=module', '-e',
            "import {readNotebook} from './src/notebooks.mjs'; process.stdout.write(JSON.stringify(readNotebook(process.argv[1], 'owner-native-notebook')));",
            state['sourceRoot']], cwd=repo, capture_output=True, text=True).stdout)
        request = urllib.request.Request(state['ownerUrl'] + '/api/assistant/conversations/' + native['conversationId'])
        with urllib.request.urlopen(request, timeout=10) as response:
            conversation = json.load(response)
        (output / 'conversation.json').write_text(json.dumps(conversation, indent=2) + '\n')
        objects = scene['document']['objects']
        assert len(objects) == 4 and scene['accepted'] is False
        humans = [item for item in objects if item['createdBy']['kind'] == 'human']
        assert len(humans) == 2, 'Both native human strokes must survive stop, redirect and selective undo/redo'
        stopped = next(item for item in native['stopped']['objects'] if item['id'] == 'verification-agent-line')
        final = next(item for item in objects if item['id'] == stopped['id'])
        assert final['points'] == stopped['points'] and 80 < final['points'][-1][0] < 600, 'Only reached agent geometry may survive interruption'
        assert len([item for item in conversation['messages'] if item['role'] == 'user']) == 2
        assert conversation['operation']['status'] == 'completed' and native['playbackReceipts'] > 0
        assert hashlib.sha256(original.read_bytes()).hexdigest() == before, 'Working collaboration must never accept the notebook'
        proof = {'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout.strip(),
            'dirty': bool(run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True).stdout),
            'apk': json.loads(artifact), 'emulator': avd, 'provider': 'real local Codex',
            'firstUsefulNativeMs': native['firstUsefulMs'], 'totalMs': native['totalMs'],
            'nativeProgressiveTip': True, 'stopReachedInk': True, 'redirectOriginalConversation': True,
            'concurrentHumanStrokes': len(humans), 'selectiveUndoRedo': True, 'acceptedFileUnchanged': True,
            'playback': 'actual native AudioTrack completion, emulator volume muted',
            'playbackReceipts': native['playbackReceipts'], 'answer': conversation['messages'][-1]['text'],
            'physicalBooxAndAudibility': 'not-tested', 'recognitionThroughTablet': 'not-tested'}
        (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps(proof), flush=True)
    finally:
        if fixture.poll() is None:
            fixture.terminate()
            try:
                fixture.wait(timeout=15)
            except subprocess.TimeoutExpired:
                raise RuntimeError('The owned fixture did not shut down; it was left for inspection.')
