#!/usr/bin/env python3
"""Verify the actual preview APK's identity, signature, permissions and shared code."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--apk', type=Path, default=root / 'android/app/build/outputs/apk/debug/app-debug.apk')
args = parser.parse_args()
sdk = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'

def command(*arguments):
    result = subprocess.run(arguments, check=True, text=True, capture_output=True)
    return result.stdout

permissions = command(str(sdk / 'aapt'), 'dump', 'permissions', str(args.apk))
assert "package: app.contextroom.tablet.preview" in permissions, 'Unexpected application identity'
assert re.findall(r"uses-permission[^\n]*name='([^']+)'", permissions) == ['android.permission.INTERNET'], 'Unexpected Android permission'
manifest = command(str(sdk / 'aapt'), 'dump', 'xmltree', str(args.apk), 'AndroidManifest.xml')
for attribute in ('allowBackup', 'usesCleartextTraffic'):
    assert re.search(r'android:' + attribute + r'\([^\n]+\)=\(type 0x12\)0x0\b', manifest), attribute + ' must be disabled'
signature = command(str(sdk / 'apksigner'), 'verify', '--verbose', str(args.apk))
assert 'Verified using v2 scheme (APK Signature Scheme v2): true' in signature
assets = {('assets/core/' + name): root / 'src' / name for name in ('notebook_client.mjs', 'notebook_protocol.mjs', 'notebook_gestures.mjs', 'notebook_native.mjs')}
assets.update({('assets/' + name): root / 'android/app/src/main/assets' / name for name in ('engine.html', 'engine.mjs', 'compat.mjs', 'owner-bridge.js')})
with zipfile.ZipFile(args.apk) as archive:
    assert len(archive.namelist()) == len(set(archive.namelist())), 'Duplicate APK entries'
    for entry, source in assets.items():
        assert archive.read(entry) == source.read_bytes(), 'APK does not contain the current shared engine: ' + entry
    assert not any(name.endswith(('.keystore', '.jks', '.key', '.p12')) for name in archive.namelist()), 'Signing material in APK'
print(json.dumps({'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'package': 'app.contextroom.tablet.preview',
                  'permissions': ['android.permission.INTERNET'], 'signatureV2': True, 'exactSharedAssets': len(assets)}))
