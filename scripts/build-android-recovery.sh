#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# != 2 || ! -f "$1" || ! "$2" =~ ^[1-9][0-9]{0,9}$ ]]; then
  printf 'Usage: %s /absolute/path/to/original-lisiere.apk HIGHER_VERSION_CODE\n' "$0" >&2
  exit 2
fi
original_apk="$1"
version_code="$2"
[[ "$original_apk" == /* ]] || { printf 'Use the absolute original APK path.\n' >&2; exit 2; }
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root/android"
./gradlew --no-daemon --console=plain :app:assembleDebug :app:assembleDebugAndroidTest \
  -PcontextRoomLegacyRecovery=true -PcontextRoomLegacyVersionCode="$version_code"
python3 "$project_root/scripts/check-android-artifact.py" \
  --apk "$project_root/android/.local/legacy-recovery-build/app/outputs/apk/debug/app-debug.apk" --upgrade-from "$original_apk"
