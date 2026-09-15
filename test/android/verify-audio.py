#!/usr/bin/env python3
"""Real native audio APIs plus the connected owner UI, on an isolated emulator."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--native-pen', action='store_true', help='Verify conversation and microphone alongside the native pen')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo) or not args.serial.startswith('emulator-'):
    raise SystemExit('Use a new private evidence directory and an isolated emulator.')
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
def instrument(class_name, fixture=None, tests=1):
    command = adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.' + class_name]
    if fixture:
        command += ['-e', 'fixture', fixture]
    command += ['app.contextroom.tablet.preview.test/androidx.test.runner.AndroidJUnitRunner']
    log_path = output / (class_name + '.log')
    with log_path.open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=150)
    expected = f'OK ({tests} test' + ('s)' if tests != 1 else ')')
    if result.returncode != 0 or expected not in log_path.read_text() or 'FAILURES!!!' in log_path.read_text():
        with (output / 'device-diagnostic.log').open('w') as log:
            subprocess.run(adb + ['logcat', '-d', '-s', 'System.out:I', 'AndroidRuntime:E', 'chromium:E', '*:S'], stdout=log, stderr=subprocess.STDOUT)
        raise RuntimeError('Native audio acceptance failed: ' + str(log_path))
instrument('NativeAudioDeviceTest', tests=2)
if args.native_pen:
    instrument('InkProgressDeviceTest')
run(adb + ['shell', 'pm', 'revoke', 'app.contextroom.tablet.preview', 'android.permission.RECORD_AUDIO'], capture_output=True)
fixture_dir = output / 'fixture'
with (output / 'fixture.log').open('w') as fixture_log:
    fixture = subprocess.Popen(['node', str(repo / 'test/android/owner-fixture.mjs'), str(fixture_dir)], cwd=repo, stdout=fixture_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while not (fixture_dir / 'fixture.json').exists():
            if fixture.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('The owner audio fixture did not become ready')
            time.sleep(.1)
        run(adb + ['push', str(fixture_dir / 'ticket.json'), '/data/local/tmp/context-room-owner-audio-ticket.json'], capture_output=True)
        instrument('OwnerNotebookConversationDeviceTest' if args.native_pen else 'OwnerAudioDeviceTest', '/data/local/tmp/context-room-owner-audio-ticket.json')
        images = ('native-voice-and-pen', 'native-direct-dictation', 'native-conversation-retained-owner') if args.native_pen else ('owner-audio-recording', 'owner-audio-recovered')
        for name in images:
            with (output / (name + '.png')).open('wb') as image:
                run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/' + name + '.png'], stdout=image)
        (output / 'proof.json').write_text(json.dumps({
            'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout.strip(),
            'dirty': bool(run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True).stdout),
            'apk': json.loads(artifact), 'emulator': avd, 'actualPcmCapture': True, 'actualPlaybackFrames': True,
            'permissionDialog': True, 'backgroundStopAndOriginalRecovery': not args.native_pen, 'reloadRecovery': not args.native_pen,
            'voiceWithNativePen': args.native_pen, 'retainedOwnerNotebookAndConversation': args.native_pen,
            'nativeProgressGeometry': args.native_pen,
            'directNativeDictationAndVoice': args.native_pen,
            'voiceForegroundAndBackgroundStop': True, 'nativeSpeechEndpointContract': True,
            'physicalMicrophoneAndAudibility': 'not-tested', 'recognitionThroughTablet': 'not-tested'
        }, indent=2) + '\n')
        print('Native PCM capture/playback and owner recovery: passed', flush=True)
    finally:
        if fixture.poll() is None:
            fixture.terminate()
            try:
                fixture.wait(timeout=15)
            except subprocess.TimeoutExpired:
                raise RuntimeError('The owned fixture did not shut down; it was left for inspection.')
