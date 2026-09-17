#!/usr/bin/env bash
# Fresh, synthetic CI device only. Never selects a connected personal emulator.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "$(uname -s)" == Linux && -n "${RUNNER_TEMP:-}" ]] || {
  echo 'This runner is restricted to an ephemeral Linux GitHub Actions machine.' >&2; exit 2;
}
[[ -e /dev/kvm ]] || { echo 'KVM is unavailable; no emulator proof was obtained.' >&2; exit 2; }
sudo chmod a+rw /dev/kvm
sdkmanager 'emulator' 'system-images;android-35;google_apis;x86_64'
export ANDROID_AVD_HOME="$RUNNER_TEMP/context-room-avd"
mkdir -m 700 "$ANDROID_AVD_HOME"
printf 'no\n' | avdmanager create avd --name ContextRoom_SharedWeb --package 'system-images;android-35;google_apis;x86_64' --path "$ANDROID_AVD_HOME/ContextRoom_SharedWeb.avd"
cat >> "$ANDROID_AVD_HOME/ContextRoom_SharedWeb.avd/config.ini" <<'AVD'
hw.lcd.width=800
hw.lcd.height=1280
hw.lcd.density=160
hw.ramSize=2048
hw.keyboard=yes
AVD
emulator="$ANDROID_HOME/emulator/emulator"
adb="$ANDROID_HOME/platform-tools/adb"
"$emulator" -avd ContextRoom_SharedWeb -port 5554 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect > "$RUNNER_TEMP/shared-web-emulator.log" 2>&1 &
emulator_pid=$!
cleanup() { "$adb" -s emulator-5554 emu kill >/dev/null 2>&1 || true; wait "$emulator_pid" 2>/dev/null || true; }
trap cleanup EXIT
ready=false
for attempt in $(seq 1 120); do
  kill -0 "$emulator_pid" || { echo 'The owned CI emulator stopped before boot.' >&2; exit 2; }
  if [[ "$("$adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then ready=true; break; fi
  sleep 3
done
[[ "$ready" == true ]] || { echo 'The owned CI emulator did not boot within six minutes.' >&2; exit 2; }
"$adb" -s emulator-5554 shell settings put global window_animation_scale 0
"$adb" -s emulator-5554 shell settings put global transition_animation_scale 0
"$adb" -s emulator-5554 shell settings put global animator_duration_scale 0
"$adb" -s emulator-5554 shell input keyevent 82
set +e
python3 test/android/verify-owner.py --serial emulator-5554 --output "$RUNNER_TEMP/shared-web-owner-evidence"
result=$?
set -e
# Explicit publication allowlist: never copy tickets, fixture directories,
# certificates, signing keys, recordings or runtime databases into artifacts.
mkdir -m 700 "$RUNNER_TEMP/shared-web-owner-public"
for name in proof.json artifact.json owner-shared-drawing.png owner-rendered-document.png owner-retained-workspace.png owner-imported-image.png owner-exported-notebook.png owner-human-file-decision.png owner-settings.png owner-shared-review.png owner-failure.png; do
  [[ ! -f "$RUNNER_TEMP/shared-web-owner-evidence/$name" ]] || cp "$RUNNER_TEMP/shared-web-owner-evidence/$name" "$RUNNER_TEMP/shared-web-owner-public/$name"
done
if [[ "$result" != 0 ]]; then
  # Assertions and synthetic UI only; do not print fixture/configuration bytes.
  grep -E '^(INSTRUMENTATION_|FAILURES|Tests run:|java\.|org\.junit\.|androidx\.|Owner acceptance failed:)' "$RUNNER_TEMP/shared-web-owner-evidence/owner-workspace.log" | tail -45 || true
fi
exit "$result"
