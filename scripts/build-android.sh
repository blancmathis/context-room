#!/usr/bin/env bash
set -euo pipefail
umask 077
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root/android"
if [[ ! -f .local/preview.keystore ]]; then
  mkdir -p .local
  keytool -genkeypair -keystore .local/preview.keystore -storepass android -keypass android \
    -alias androiddebugkey -dname 'CN=Context Room Preview' -keyalg RSA -keysize 2048 -validity 3650
fi
./gradlew --no-daemon --console=plain :app:assembleDebug :app:assembleDebugAndroidTest "$@"
printf '%s\n' "$project_root/android/app/build/outputs/apk/debug/app-debug.apk"
