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
parser.add_argument('--upgrade-from', type=Path, help='Require a higher-version, identically signed upgrade of this original Lisière APK.')
args = parser.parse_args()
sdk = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'

def command(*arguments):
    result = subprocess.run(arguments, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(Path(arguments[0]).name + ' failed: ' + result.stderr.strip()[-2000:])
    return result.stdout

expected_package = 'fr.lisiere.android' if args.upgrade_from else 'app.contextroom.tablet.preview'
permissions = command(str(sdk / 'aapt'), 'dump', 'permissions', str(args.apk))
assert 'package: ' + expected_package + '\n' in permissions, 'Unexpected application identity'
expected_permissions = ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO']
assert re.findall(r"uses-permission[^\n]*name='([^']+)'", permissions) == expected_permissions, 'Unexpected Android permission'
manifest = command(str(sdk / 'aapt'), 'dump', 'xmltree', str(args.apk), 'AndroidManifest.xml')
for attribute in ('allowBackup', 'usesCleartextTraffic'):
    assert re.search(r'android:' + attribute + r'\([^\n]+\)=\(type 0x12\)0x0\b', manifest), attribute + ' must be disabled'
signature = command(str(sdk / 'apksigner'), 'verify', '--verbose', str(args.apk))
assert 'Verified using v2 scheme (APK Signature Scheme v2): true' in signature
upgrade = {}
if args.upgrade_from:
    def apk_identity(file):
        badging = command(str(sdk / 'aapt'), 'dump', 'badging', str(file))
        match = re.search(r"^package: name='([^']+)' versionCode='(\d+)'", badging)
        assert match, 'Missing APK identity'
        certificates = command(str(sdk / 'apksigner'), 'verify', '--print-certs', str(file))
        signers = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)$', certificates, re.M)
        assert len(signers) == 1, 'Recovery requires one verified signing identity'
        return match[1], int(match[2]), signers[0]
    old_package, old_version, old_signer = apk_identity(args.upgrade_from)
    new_package, new_version, new_signer = apk_identity(args.apk)
    assert old_package == new_package == expected_package and old_signer == new_signer, 'The original application signing identity must be preserved'
    assert new_version > old_version, 'Recovery must upgrade the original APK without a downgrade or data reset'
    upgrade = {'upgradeFromVersionCode': old_version, 'versionCode': new_version, 'originalSignerSha256': old_signer}
assets = {('assets/core/' + name): root / 'src' / name for name in ('notebook_client.mjs', 'notebook_protocol.mjs', 'notebook_gestures.mjs', 'notebook_native.mjs')}
assets.update({('assets/' + name): root / 'android/app/src/main/assets' / name for name in ('engine.html', 'engine.mjs', 'compat.mjs', 'owner-bridge.js')})
with zipfile.ZipFile(args.apk) as archive:
    assert len(archive.namelist()) == len(set(archive.namelist())), 'Duplicate APK entries'
    for entry, source in assets.items():
        assert archive.read(entry) == source.read_bytes(), 'APK does not contain the current shared engine: ' + entry
    assert not any(name.endswith(('.keystore', '.jks', '.key', '.p12')) for name in archive.namelist()), 'Signing material in APK'
print(json.dumps({'apkSha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(), 'package': expected_package,
                  'permissions': expected_permissions, 'signatureV2': True, 'exactSharedAssets': len(assets), **upgrade}))
