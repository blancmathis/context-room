#!/usr/bin/env python3
"""Explicit local-Whisper acceptance with synthetic PCM on a separate emulator."""
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
parser.add_argument('--model', type=Path, required=True)
parser.add_argument('--sample', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
if output.exists() or output.is_relative_to(repo) or not args.serial.startswith('emulator-'):
    raise SystemExit('Use a new private evidence directory and an isolated emulator.')
if not args.model.resolve().is_file() or not args.sample.resolve().is_file():
    raise SystemExit('Supply an existing local Whisper model and a synthetic mono PCM16 WAVE sample.')
adb = [str(Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb'), '-s', args.serial]
def run(argv, **options):
    return subprocess.run(argv, check=True, **options)
avd = run(adb + ['emu', 'avd', 'name'], capture_output=True, text=True).stdout.splitlines()[0]
if not avd.startswith('ContextRoom_'):
    raise SystemExit('Personal emulators and physical devices are not accepted.')
output.mkdir(parents=True, mode=0o700)
pcm = output / 'synthetic-input.pcm'
run(['node', '--input-type=module', '-e',
     "import fs from 'node:fs'; import {readPcm16Wave} from './src/local_audio.mjs'; fs.writeFileSync(process.argv[2], readPcm16Wave(fs.readFileSync(process.argv[1])), {mode:0o600});",
     str(args.sample.resolve()), str(pcm)], cwd=repo, capture_output=True)
artifact = run(['python3', str(repo / 'scripts/check-android-artifact.py')], capture_output=True, text=True).stdout
(output / 'artifact.json').write_text(artifact)
for relative in ('debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk'):
    installed = run(adb + ['install', '-r', str(repo / 'android/app/build/outputs/apk' / relative)], capture_output=True, text=True)
    if 'Success' not in installed.stdout:
        raise RuntimeError('APK installation was not confirmed')
run(adb + ['shell', 'pm', 'revoke', 'app.contextroom.tablet.preview', 'android.permission.RECORD_AUDIO'], capture_output=True)
remote_sample = '/data/local/tmp/context-room-synthetic-recognition.pcm'
remote_ticket = '/data/local/tmp/context-room-owner-dictation-ticket.json'
run(adb + ['push', str(pcm), remote_sample], capture_output=True)
fixture_dir = output / 'fixture'
environment = dict(os.environ, CONTEXT_ROOM_TEST_WHISPER_MODEL=str(args.model.resolve()))
with (output / 'fixture.log').open('w') as fixture_log:
    fixture = subprocess.Popen(['node', str(repo / 'test/android/owner-fixture.mjs'), str(fixture_dir)], cwd=repo, env=environment, stdout=fixture_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while not (fixture_dir / 'fixture.json').exists():
            if fixture.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('The owner dictation fixture did not become ready')
            time.sleep(.1)
        original = fixture_dir / 'project/docs/Guide.md'
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        run(adb + ['push', str(fixture_dir / 'ticket.json'), remote_ticket], capture_output=True)
        with (output / 'OwnerDictationDeviceTest.log').open('w') as log:
            result = subprocess.run(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'app.contextroom.tablet.OwnerDictationDeviceTest',
                '-e', 'fixture', remote_ticket, '-e', 'realSpeech', 'true', '-e', 'sample', remote_sample,
                'app.contextroom.tablet.preview.test/androidx.test.runner.AndroidJUnitRunner'], stdout=log, stderr=subprocess.STDOUT, timeout=300)
        log = (output / 'OwnerDictationDeviceTest.log').read_text()
        if result.returncode != 0 or 'OK (1 test)' not in log or 'FAILURES!!!' in log:
            with (output / 'device-diagnostic.log').open('w') as diagnostic:
                subprocess.run(adb + ['logcat', '-d', '-s', 'System.out:I', 'AndroidRuntime:E', 'chromium:E', '*:S'], stdout=diagnostic, stderr=subprocess.STDOUT)
            captured = subprocess.run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/native-dictation-failure.png'], capture_output=True)
            if captured.returncode == 0:
                (output / 'native-dictation-failure.png').write_bytes(captured.stdout)
            raise RuntimeError('Native recognition acceptance failed; inspect OwnerDictationDeviceTest.log')
        for name in ('native-recognized-original-dictation', 'native-dictation-reload-and-maximum'):
            with (output / (name + '.png')).open('wb') as image:
                run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/' + name + '.png'], stdout=image)
        native = json.loads(run(adb + ['exec-out', 'run-as', 'app.contextroom.tablet.preview', 'cat', 'files/native-dictation-proof.json'], capture_output=True, text=True).stdout)
        assert hashlib.sha256(original.read_bytes()).hexdigest() == before, 'Dictation must not change the source file'
        assert native['silentMaximumPreservedDraft'] and native['reviewedDraftReloaded'] and native['originalRecordingAcknowledged']
        proof = {'sourceHead': run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True).stdout.strip(),
            'dirty': bool(run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True).stdout),
            'apk': json.loads(artifact), 'emulator': avd, 'native': native,
            'samplePcmSha256': hashlib.sha256(pcm.read_bytes()).hexdigest(), 'recognition': 'real local Whisper',
            'sourceFileUnchanged': True, 'physicalMicrophoneSpeechAndBoox': 'not-tested'}
        (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps(proof), flush=True)
    finally:
        if fixture.poll() is None:
            fixture.terminate()
            try:
                fixture.wait(timeout=15)
            except subprocess.TimeoutExpired:
                raise RuntimeError('The owned fixture did not shut down; it was left for inspection.')
