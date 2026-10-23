#!/usr/bin/env bash
# Re-sign a built APK on the owner's Mac, then run the artifact checks. The key never leaves the Mac.
set -euo pipefail
umask 077
usage() {
  printf 'Usage: %s /abs/built.apk /abs/key.keystore /abs/new-output.apk [--upgrade-from /abs/original.apk]\n' "$0" >&2
  printf 'Needs ANDROID_HOME (build-tools 35.0.0), java (JDK 17, for apksigner) and node. Optional: CONTEXT_ROOM_KEY_ALIAS, CONTEXT_ROOM_KEY_PASSWORD (default: the Lisière key scheme).\n' >&2
  exit 2
}
[[ $# == 3 || ( $# == 5 && "$4" == --upgrade-from ) ]] || usage
apk="$1"; keystore="$2"; output="$3"; original=""
[[ $# == 5 ]] && original="$5"
for path in "$apk" "$keystore" "$output" $original; do
  [[ "$path" == /* ]] || { printf 'Use absolute paths: %s\n' "$path" >&2; exit 2; }
done
[[ -f "$apk" && -f "$keystore" ]] || { printf 'The APK and the key must exist.\n' >&2; exit 2; }
[[ -z "$original" || -f "$original" ]] || { printf 'The original APK must exist.\n' >&2; exit 2; }
[[ ! -e "$output" && -d "$(dirname "$output")" ]] || { printf 'Refusing an existing output or a missing folder: %s\n' "$output" >&2; exit 2; }
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
real_key="$(cd "$(dirname "$keystore")" && pwd -P)/$(basename "$keystore")"
[[ "$real_key" != "$project_root"/* ]] || { printf 'Refusing a signing key inside the repository.\n' >&2; exit 2; }
[[ -n "${ANDROID_HOME:-}" ]] || { printf 'Set ANDROID_HOME.\n' >&2; exit 2; }
tools="$ANDROID_HOME/build-tools/35.0.0"
work="$(mktemp -d "$(dirname "$output")/.sign-android-apk.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export CONTEXT_ROOM_KEY_PASSWORD="${CONTEXT_ROOM_KEY_PASSWORD:-android}"
"$tools/zipalign" -f -P 16 4 "$apk" "$work/aligned.apk"
"$tools/zipalign" -c -P 16 4 "$work/aligned.apk"
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias "${CONTEXT_ROOM_KEY_ALIAS:-androiddebugkey}" \
  --ks-pass env:CONTEXT_ROOM_KEY_PASSWORD --key-pass env:CONTEXT_ROOM_KEY_PASSWORD \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false --out "$work/signed.apk" "$work/aligned.apk"
package="$("$tools/aapt" dump badging "$work/signed.apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
checks=(--apk "$work/signed.apk" --package "$package")
[[ -z "$original" ]] || checks+=(--upgrade-from "$original")
python3 "$project_root/scripts/check-android-artifact.py" "${checks[@]}"
mv "$work/signed.apk" "$output"
printf '%s\n' "$output" >&2
