# Codex handoff: shared web interface and BOOX verification

## Summary

Continue the shared-interface branch based on verified main
`4560f6e056a6f673fe6d77f6f9d2914c00829c64`. This handoff does not authorize
installation over an existing app, a service cutover, replaying an old agent
request, publication of private evidence or acceptance of a document. The
source change does not claim completed physical replacement of Lisière.

## Defines

Exact source retrieval, isolated checks, reversible installation preparation
and remaining physical checks for this change.

## Does not define

A new product specification, a new inbox, relaxed project permissions,
independent native notebook menus or changed R01–R29 decisions. Read `AGENTS.md`
and its canonical references first.

## Retrieve without disturbing current work

Use the final source SHA recorded in the pull request / delivery, not an older
archive. Keep the existing checkout and any uncommitted changes untouched.

```bash
git clone https://github.com/blancmathis/context-room.git context-room-web-verification
cd context-room-web-verification
git fetch origin mathis/shared-web-pwa-20260917
git switch --create mathis/boox-shared-web-verification FETCH_HEAD
git rev-parse HEAD
git merge-base --is-ancestor 4560f6e056a6f673fe6d77f6f9d2914c00829c64 HEAD
git status --short
```

Compare HEAD to the final delivered SHA before running anything. Check whether
main has advanced; preserve newer commits rather than replacing them with the
base archive. No force push or automatic merge into main is authorized.

## Checks and exact evidence

```bash
npm ci
node --test test/web_app.test.mjs test/device_browser.test.mjs test/device_display.test.mjs
npm run test:web-app -- --project=chromium-desktop
npm run test:web-app -- --project=chromium-mobile
npm run test:web-app -- --project=firefox-desktop
npm run test:web-app -- --project=webkit-desktop
npm test
node bin/context-room.mjs doctor --root .
npm run package:privacy
npm pack --dry-run
```

Use a fresh private test HOME/Hub/device-state outside the repository for tests
that start a service. The PWA scenarios create their own synthetic fixtures;
the standalone Playwright configuration intentionally avoids unrelated Shared
Git setup. Do not relaunch blocked setup or an already passing suite without a
relevant change. Record command, exit status, source SHA and scope of each result.
Tests using Chromium pen events prove the received pressure values and journal
recovery, not digitizer latency or physical palm rejection.

The worker-update scenario replaces a synthetic worker generation while old
windows remain open, then restarts offline. The unit asset test separately
checks the complete content-versioned import cohort. Keep both distinctions in
the report. Inspect synthetic portrait, landscape and keyboard-height captures;
do not infer visibility or contrast from a passing build.

## Browser connection and reversible installation

Follow `docs/system/connected-devices.md`. Choose a reachable, private HTTPS
origin whose certificate chain the actual BOOX browser recognizes. Loopback
and the APK pin are not substitutes. Do not weaken TLS verification, import a
private key into a browser or commit certificate/key material. Start an isolated
runtime with all three `--device-browser-*` options plus `--device-host`; do not
replace the personal Hub. Pair the browser explicitly, first with a drawing
code and separately with an owner code. Confirm that the drawing code cannot
open the Hub, review or settings, and that revocation blocks later writes.

Open a synthetic notebook, verify application-cache readiness, then install
using the browser's PWA menu. Keep the normal browser path available for
rollback. Do not uninstall/clear either origin while it has local-only ink.
Before changing pairing or origin, export recovery and verify canonical Mac
receipts. Revocation is not erasure of already cached bytes.

For an APK test, use JDK 17, SDK/build-tools 35 and Node with the locked npm
runtime dependencies, then run `scripts/build-android.sh`. The default output
is a **separate preview signed with an isolated test key**, not the original
installed key. Do not uninstall an existing preview to get around a signature
mismatch. Inspect package/signing identities first; build locally with the
preserved matching key only after comparing its certificate to the installed
APK. Do not replace, regenerate or publish that key. The explicit legacy-recovery
profile remains separate and is not a normal shared-UI installation command.

For the normal `app.contextroom.tablet.preview` package, leave the original
keystore outside the checkout. Do not copy it into `.local/` and do not invoke
the test-key generator to prepare an installed-app upgrade. A private Gradle
initialization script outside Git can select the preserved file without
changing the build source or creating another key:

```groovy
// Save outside the repository; the environment contains a path, not key bytes.
allprojects {
    afterEvaluate { project ->
        if (project.path == ':app') {
            if (project.findProperty('contextRoomLegacyRecovery') == 'true')
                throw new GradleException('Do not mix normal preview and legacy recovery.')
            def location = System.getenv('CONTEXT_ROOM_PRESERVED_PREVIEW_KEY')
            if (!location) throw new GradleException('An existing preview key is required.')
            def preserved = new File(location)
            if (!preserved.isAbsolute() || !preserved.isFile())
                throw new GradleException('Use the existing absolute key path; do not generate a replacement.')
            project.android.signingConfigs.debug.storeFile = preserved
        }
    }
}
```

After setting that environment variable locally and `PRIVATE_SIGNING_INIT` to
the external script path, run Gradle directly (not the preview key generator):

```bash
(cd android && ./gradlew --no-daemon --console=plain \
  --init-script "$PRIVATE_SIGNING_INIT" :app:assembleDebug :app:assembleDebugAndroidTest)
python3 scripts/check-android-artifact.py
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs "$INSTALLED_APK_COPY"
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs android/app/build/outputs/apk/debug/app-debug.apk
```

Both package identity and signer fingerprint must match before an authorized
reversible update; stop on a mismatch or a different keystore alias/password.
The supplied configuration retains the existing preview signing convention;
it does not discover, change or prove the real installed identity. This
preserved-key build is a **local handoff procedure, not a build executed with
the user's key in this delivery**. For the old `fr.lisiere.android` package,
use only the separately documented original-key recovery profile and its
explicit higher-version check; do not substitute a preview or uninstall it.

Only use a dedicated emulator with an AVD name beginning `ContextRoom_` for
automated installs. Do not target an already running emulator from another
task or a physical device by default. `scripts/verify-android-ci.sh` creates
its own Linux CI-only Android 15 AVD and runs the actual shared owner UI test.
It refuses a non-CI environment and publishes only allowlisted synthetic
screenshots and proof, not pairing tickets or fixture databases. The other
historical verifier scenarios retain explicit legacy recovery coverage and
must not be relabelled as common-web performance proof. A build alone is not
an emulator pass.

## BOOX physical protocol

Use synthetic documents, notebooks and speech. Keep evidence outside Git.
Record device model, OS, WebView/browser version, screen mode, orientation,
network path, source SHA and APK fingerprint without publishing private
addresses or identifiers.

Verify two uses separately: draw concurrently on Mac and tablet in one notebook,
and operate the full Hub, authorized Computer folders, documents, notebook,
conversation, dictation and human review entirely from the tablet. Exercise
portrait/landscape, virtual keyboard, panels, all important tools, grayscale
contrast, presentation exit and visible local/confirmed/conflict states.

For offline proof, first open the notebook online. Disconnect Wi-Fi, draw with
varying pressure, close the app/process, reopen offline, add more ink, then
reconnect. Compare exact operation/object identities and pressure values on
the Mac; confirm no loss or duplicate and no accepted document. Repeat with an
application update waiting, more than one browser window, a lost receipt and a
revoked/replaced pairing. Keep original recovery caches and native journals.

Check independent views, explicit share/follow, real after-render confirmation,
human cancellation during an in-flight opening, and a held gesture. A late
response must not open another notebook, move an active gesture or redirect an
existing conversation. Confirm microphone and playback stop on pause/close.

Use the real connected agent only after an explicit new message. Verify a
co-drawing preserves human strokes and stays in the original notebook. Verify
reviewed dictation, original-source conversation, recorded audio recovery,
imports/exports and interruption recovery without replaying historical tasks.
Do not turn an agent result or autosave into a documentary acceptance.

Measure physical pen-to-ink latency, pressure feel, palm rejection, e-ink
comfort, audio quality and long sessions on the actual BOOX. Report raw methods
and observed values, not equivalence with BOOX's original app. The optional
BOOX fast adapter remains disabled unless separately measured and validated.

## Rollback

Close only the isolated runtime. Keep the original installation and signing
material untouched. Export unconfirmed PWA/new-web work before clearing anything.
Return to the existing personal service without copying an old backup over
newer canonical data. The legacy native recovery path remains available for
its original journals; changing the normal UI is not permission to purge them.
