---
context_room:
  id: system.connected-devices
  depends_on: [system.runtime-profiles, assurance.review.human-authority]
---

# Connected devices

## Summary

Context Room uses one web interface on the computer, in an installable browser
webapp and inside the Android shell. The existing notebook editor, canvas,
tools, conversation and review components are shared source, not Java copies.
The Mac keeps canonical projects, working notebooks, durable receipts and human
review authority. Pairing explicitly selects drawing in chosen notebooks or
the complete owner interface. A trusted-HTTPS browser listener is opt-in and
separate from Android's certificate-pinned connection.

## Defines

Device service activation, pairing and revocation, drawing and owner permissions,
Android transport and storage, confirmed notebook opening, optional view
following and presentation, and their
relationship to notebook authority.

## Does not define

Human file decisions, conversation semantics, personal-device
installation or migration. See [original-source conversations](../features/conversations.md), [human authority](../features/review-authority.md)
and the active convergence at `docs/lifecycle/changes/active/android-convergence/index.md` in the Context Room source repository.

## Activation and pairing

`context-room hub`, `start` and `setup` accept `--device-host` with an explicit
IP address on the Mac and optional `--device-port` (default 4318). Without the
host option, no device listener or credential directory is created. The owner
Hub continues to listen only on loopback. Wildcard addresses are rejected.
For an isolated local transport check:

```bash
context-room start --root . --device-host 127.0.0.1 --device-port 4318
```

For another physical device, use the Mac's reachable LAN address instead of
loopback. The device options apply to a new Hub process. An already-running
Hub is preserved and reports that these options were not applied.

In a working notebook, **Connect tablet** opens the owner pairing interface.
Choose a device name and create a code. The one-use code expires in two minutes
and includes the server URL, certificate fingerprint and exact notebook grant.
Closing the pairing sheet cancels an unused code. A paired device appears in
the same sheet and can be disconnected there.

The native client must verify the SHA-256 fingerprint of the TLS leaf certificate
before sending the code or device credential. Pairing returns a new random
credential valid for 30 days. Revocation is checked on every authenticated
request and again after a body upload, before applying its changes.

## Operate Context Room from the tablet

On the Mac, open **Settings → Preferences → Connected devices**. Choose the
complete owner interface explicitly before creating its pairing code. This
separate permission covers the current Hub, registered projects, authorized
Computer folders, document readers, settings and human review decisions.
It is bound to the paired Mac identity. A drawing code cannot be upgraded to
owner access. Closing the pairing dialog cancels an unused code.

An owner connection opens the existing Context Room UI, notebook included.
Android retains this UI in a WebView; a paired browser uses the same modules.
There is no normal **Draw with the native pen** fork. Drawing-only connections
use the same notebook editor with unavailable owner actions hidden and refused
by the server. The same Mac
HTTP handlers, exact-project headers, folder rules and displayed human review
nonce remain authoritative. Autosave and a return from a working notebook do not
accept any file or proposal. The original frozen review remains available
underneath **Open working notebook**.

The owner transport can address only the running loopback server attached to
this device service. It cannot proxy an arbitrary URL or port, call agent
routes, or create another pairing. A fresh pairing always starts on the Mac.
Revocation prevents subsequent requests and delivery of delayed responses.
An already authorized operation may finish; an uncertain mutation is never
silently retried.

The Android origin includes both the Mac and device identities. Only the
trusted top-level owner UI can call its native message bridge; rendered
documents keep the existing inert frame boundary. Credentials remain in
native storage. UI reads pause while the native canvas is active, then resume;
runtime events replay through the existing cursor and event bus.

Image import and notebook export use Android's document picker from the
trusted owner surface. The user chooses each source or destination. A
document frame cannot open the picker. No broad storage permission is added.
**Install / offline notebooks** lists locally opened working notebooks. The
Android menu also exposes **Recover legacy native journals**. That explicit
recovery path retains the old engine, pressure canvas and write-ahead journals;
it is not a second normal UI. Operating the full Hub requires the connected Mac.

## Open the notebook on a tablet

For a paired device, **Open on [device name]** requests the currently displayed
notebook. The owner sees requested, deferred or confirmed opening separately.
A successful send does not mean the tablet displayed the notebook. The request
binds the original project, resource, location revision and minimum scene
revision, with one retained operation identifier for uncertain retries.

The common foreground display controller defers while a gesture, text dialog or local save
is active, and while the current notebook still awaits its Mac receipts. Once
idle, it opens the exact requested notebook and confirms only after its attached,
visible common canvas draws the corresponding online scene. An actual
tool, keyboard or pointer action cancels a pending opening. Each device keeps its own
viewport; opening does not enable presentation or viewport following.

Presence expires after 15 seconds without a foreground poll. An opening expires
after 30 seconds and is invalidated by a replacement client session, a service
restart, a newer opening, revocation or a changed target. The original request
and terminal receipt remain in private device state. This receipt records a
display event; it never freezes, submits or accepts notebook content.

Every native opening has its own identifier. Queued scene or opening events
from a previous notebook cannot populate the new canvas, select its scope or
advance its cache version. The visible scene must match the current scope
before drawing controls or an applied receipt become available.

The common `device-display.mjs` controller uses a narrow navigation bridge in
the APK and same-origin authenticated routes in the browser. A Web Lock elects
one navigation window per pairing; other windows still edit independently.
Only the common canvas callback supplies an applied receipt. These are display
receipts, not documentary decisions. Legacy native recovery keeps its previous
native-only transport. Software protocol proof is separate from physical
rendering and stylus-latency proof.

## Share a view or present a notebook

Views remain independent by default. In **Connect tablet**, the Mac owner
can choose **Share my view with [tablet]** or **Follow [tablet]**. The shared notebook offers **Device view mode → Share this view** or
**Follow the connected owner** on the paired device. Sharing and following are
mutually exclusive on each surface; both sides must choose their role.
The target includes the original project, notebook, path and location revision.
Following never opens another notebook automatically.

The receiving canvas fits the shared world area to its own aspect ratio.
The publisher sees an unconfirmed state until a receipt identifies the frame
and the area actually drawn. The shared browser and APK editor report only after the attached canvas
renders; legacy recovery retains its native render callback. A later frame, another native
session or a new following action cannot reuse an earlier receipt. Sharing
expires after five seconds without a heartbeat. These ephemeral camera states
are discarded when the service restarts and never enter notebook operation
history, documentary review or accepted content.

A pen or finger contact, a tool or keyboard action immediately stops following
on that surface. A late network response cannot resume it or move the current
gesture. **Stop view sharing / following** and **Independent views** return
to independent views. Hiding the browser or pausing the native app stops the
session; it is not restored automatically.

**Presentation** in the common editor expands the canvas
and hide editing chrome. The exit control remains visible. Escape/Back leaves
presentation while preserving the open notebook. Browsers without fullscreen
permission retain a viewport-sized presentation.

## Authority and protocol

Device protocol version 1 (`src/device_server.mjs`) admits notebook
open/read, targeted edits, selective undo, embedded raster assets, receipts and
exports. Existing notebook validation, filesystem safety, object revisions and
idempotent operations remain authoritative. Device authors are assigned by
the server; request bodies cannot impersonate another author.

Clients can negotiate ordered batches of up to 16 mutations for one notebook.
Each mutation keeps its own stable operation identifier and canonical receipt;
an individual conflict cannot hide another result. Retrying a lost batch reply
replays those identifiers without duplicating the working changes.

Drawing grants bind a registered project ID, its physical directory identity and exact
relative notebook paths. Current owner folder permissions are checked again
on use. Moving or replacing the project invalidates the grant. There is no
separate device project catalog and no arbitrary proxy to the local owner API.

This drawing permission does not admit proposal submission, relocation,
freeze, acceptance/rejection, settings changes or agent endpoints. On the native listener, browser
requests carrying Origin, Referer or Fetch Metadata remain refused. Its drawing
service returns JSON. The separate browser edge below does not widen this
native route allowlist.
Owner grants use the separate transport described above; they do not widen a
drawing grant or expose the old hosted runtime.

## Browser HTTPS and PWA installation

The Mac must be reachable at an exact HTTPS hostname and port recognized by the
tablet browser. Its loopback address points to the tablet when typed there.
An APK certificate fingerprint is not browser certificate trust. Provision a
current certificate chain for the chosen hostname using an owner-controlled
certificate authority trusted by the browser, or an already trusted issuer.
Keep the private key outside repositories, owner-only (mode 0600). Do not click
through certificate warnings, disable verification or use an HTTPS-error flag.
No public hosting or public exposure of project data is required.

Start a **separate test runtime** first; substitute the explicitly chosen
reachable IP, origin and private file paths, not the sample loopback transport:

```bash
node bin/context-room.mjs hub --device-host "$MAC_BIND_IP" --device-port 4318 \
  --device-browser-origin "$BROWSER_HTTPS_ORIGIN" \
  --device-browser-cert "$PRIVATE_CERTIFICATE_CHAIN" \
  --device-browser-key "$PRIVATE_CERTIFICATE_KEY"
```

All three browser options and `--device-host` are required together. The
browser origin contains HTTPS, hostname and optional port only. The listener
checks SAN identity, key match, dates, private-file permissions and a bounded
chain; these checks do **not** certify trust in a particular browser. The
ordinary Hub remains loopback-only; the optional browser and native listeners
reuse its exact registered projects and device authority. A running personal
Hub is not replaced or reconfigured by invoking this command again.

At the trusted browser origin, paste a fresh one-use code created on the Mac.
The code explicitly selects drawing-only or complete owner access. Each browser
pairing gets its own cookie and notebook account namespace. The credential is
`Secure`, `HttpOnly`, `SameSite=Strict`, host-only and absent from JavaScript,
IndexedDB and application caches. Writes require the exact origin and the
original pairing identity. An old window cannot send its outbox after another
pairing has replaced its cookie. Revocation uses the existing **Connected
devices** UI and takes effect on subsequent authenticated requests, including
checks after uploads and before notebook commits. Revocation is not remote
erasure of already stored local bytes.

Open **Install / offline notebooks** and wait for the application-cache status
before disconnecting. Use **Install Context Room**, or the browser's install
menu when offered. The manifest provides standalone launch and 192/512-pixel
icons. Installation availability and trust still need checking on the actual
BOOX browser. The APK uses its packaged offline entry, not a service worker
on its synthetic pinned origin.

## Offline reopening and application updates

The application cache contains only public interface bytes and a generic
offline entry. It does not cache the authenticated Hub HTML, nonces, API
responses, project documents, review pages or writes. Working notebook
snapshots, pressure samples, operation identifiers and gesture history use the
existing IndexedDB client. Application caching and notebook persistence are
separate states; IndexedDB alone is not an offline boot mechanism.

Open a working notebook while connected to record its exact origin, original
project/target project, resource and pairing. After disconnecting, new gestures
remain locally saved but unconfirmed by the Mac. Close and reopen the browser
or APK: **Install / offline notebooks** opens that saved scene using the same
editor. Reconnect to the original Mac and permission to deliver the retained
operations and reconcile receipts. A changed origin, project, server, pairing,
location revision or revoked permission must not redirect pending operations.
Review snapshots and older caches without a verified reconnect route remain
retained; they are not guessed into a working project. Export recovery before
clearing site data, changing pairing or removing the application.

The worker installs a complete content-versioned cohort or rejects the update.
It does not call `skipWaiting`, claim existing windows, reload an editor or
clear notebook storage. **Check application update** shows a waiting update;
finish saving, close all windows on that origin, then reopen. Controlled old
windows retain their old public modules. An unavailable old version fails
explicitly rather than importing a different build. Activation removes only
old application caches. A browser storage-persistence request is available,
but clearing site data or uninstalling can still remove local-only work.

The offline entry is a recovery surface for already available working
notebooks, not an offline Hub or agent. Conversations, canonical documents,
provider execution and human review require the connected Mac. Do not describe
software pointer-pressure tests as physical pen latency or palm rejection.

## Android preview

The Android application is in `android/`. Its normal route embeds the common
web notebook, including Pointer Events, pressure, tools, touch navigation and
IndexedDB. `scripts/prepare-android-web.mjs` packages the exact common modules,
styles, offline entry and their content version; `PackagedWeb` serves only that
allowlist. A different Mac build is fetched as an exact versioned cohort, never
silently mixed with packaged modules. An offline restart uses the packaged
entry and the existing notebook cache.

Native code retains certificate-pinned transport, encrypted credentials,
Android file pickers, audio capture/playback and lifecycle adaptation. The old
native pressure canvas and optional BOOX adapter remain reachable only through
legacy recovery until every original journal has an assured replacement.
No journal or older cache is deleted by this change. Web and native recovery
origins remain separate: an unsent legacy journal is not silently imported into
a new web cache or replayed under another pairing.

Only packaged engine assets have the drawing bridge. That engine cannot navigate
to arbitrary pages, render project HTML or fetch over the network itself.
The native transport checks the paired certificate fingerprint before sending
a code or credential and refuses redirects. Drawing routes and the separate
owner transport both enforce the explicit stored permission.
Credentials are encrypted with Android Keystore and stored outside Android
backup. Pairing another notebook retains the earlier connection and cache.

A native write-ahead journal retains each command until the shared client
commits its operation and command watermark atomically. A process restart
cannot apply that command twice. Cache identities include the server, account,
device and resource. Saved viewports remain local to the device. Conflicts and
unacknowledged work remain exportable; local saving and confirmation by the
Mac have different visible states.

Build from the source repository with JDK 17 and Android SDK/build-tools 35:

```bash
scripts/build-android.sh
```

The output is `android/app/build/outputs/apk/debug/app-debug.apk`, with the
separate application ID `app.contextroom.tablet.preview`. The script generates
an isolated development key in ignored local build state; it does not reuse
an installed application's signing identity. Dependency provenance is recorded
in `android/NOTICE.md`. The explicit [Lisière recovery build](lisiere-migration.md#recover-an-existing-android-installation)
retains an original installation's signing identity and data; it has a separate
output and emulator upgrade/export checks. Release packaging, personal-device
installation and physical BOOX validation remain separate gates.

For repeatable synthetic verification on a separately created emulator whose
AVD name starts with `ContextRoom_`:

```bash
python3 test/android/verify.py --serial emulator-5580 --output /tmp/context-room-android-proof
```

Choose a new output directory outside the source repository. The verifier
checks the AVD identity, installs only the preview, creates its own Mac fixture,
tests drawing, restart recovery, deferred remote opening, human cancellation,
opt-in following, native presentation and rejection of a queued previous scene,
and retains native screenshots, exact navigation receipts and logs.
It refuses physical devices. Run the separate owner acceptance with
`python3 test/android/verify-owner.py --serial emulator-5580 --output /tmp/context-room-owner-proof`.
Those earlier verifier scenarios use a fresh synthetic Hub and retain legacy
native recovery coverage. Normal-route proof must additionally inspect the
shared web canvas; historical native screenshots are not proof of that route. Voice/conversation, personal-data migration, release
signing and physical BOOX proof remain separate convergence work.

## Persistence and limits

Device authority (`src/device_authority.mjs`) stores its identity below
the private Hub state directory, alongside the host workspace, in `devices/`.
`--device-state` can choose another private directory outside a project.
The directory must be owned by the current account and inaccessible to other
users. Files use mode 0600, atomic publication and cross-process locks.
Linked, replaced, malformed or incompatible storage fails closed.

Only credential hashes are retained. The self-signed TLS identity persists
across restarts, has a one-year certificate lifetime and requires explicit
renewal when expired. Creating it requires OpenSSL. No key, pairing code or
device token belongs in Git, exports, document content or logs.

The service bounds pairing attempts, request rates, connections, upload sizes
and concurrent upload memory. It retains at most 32 active devices and 128
device records. Record cleanup and certificate renewal UI remain follow-up
work; exceeding these limits fails explicitly.

## Verification

Contract tests (`test/devices.test.mjs`) use real isolated HTTPS services,
verify a mismatched certificate pin is refused, exercise simultaneous Mac and
device edits, and restart the service before replaying a lost receipt. They
also check revocation during upload, expired credentials, replaced directories,
route and scope refusal, and the actual CLI launch.

Browser tests (`test/e2e/notebooks.spec.mjs`) exercise owner pairing, the separate
request/deferral/display states and revocation in Chromium, Firefox and WebKit.
`test/device_owner.test.mjs` checks explicit owner pairing, the running-runtime
restriction, exact project/folder/nonce enforcement, event cursors and revoked
delayed responses against real HTTP/TLS handlers.
`test/device_browser.test.mjs` adds strict certificate-chain, cookie, origin,
permission and replacement-pairing checks. `test/device_display.test.mjs` checks
common render receipts, pending-gesture deferral and cancellation.
`npm run test:web-app` uses independent synthetic browser fixtures for offline
process restarts, waiting-worker lifecycle, pressure and tablet layouts.
The isolated Android 15 CI verifier now exercises the normal shared WebView
owner path, including injected stylus pressure, Android import/export and frozen
human review. See the dated verification journal for the source SHA and actual
result. The source-repository handoff at
`docs/lifecycle/changes/active/android-convergence/codex-shared-web-handoff.md`
also specifies an external preserved-key signing procedure. This change-specific
record is not part of the installed canonical agent context; no original key
was used or replaced by the CI preview build.
Exact observations and the remaining
Android/physical-device gates are recorded in `docs/lifecycle/changes/active/android-convergence/verification.md` in the source repository.

### Retained recording owner verification

After building both preview APKs from the current checkout, the isolated
emulator-only verifier has an additional mode:

```bash
python3 test/android/verify-owner.py --serial emulator-SERIAL --output "$HOME/private-evidence/recording-run" --recording
```

Use a new output directory under the user home, outside the repository, because
the synthetic Shared cache must remain inside that home. The AVD name must begin
`ContextRoom_`; physical and personal devices remain refused. This mode prepares
an unlinked synthetic PCM and exercises document → conversation → explicit link
preview → attach → load without autoplay → system-picker export. The host then
checks the original PCM hash, original database and document, exact association,
and absence of any agent task. It does not exercise physical audibility,
microphone quality or real speech recognition. `OwnerRecordingTest.java` requires
a newly built instrumentation APK; an older successful preview build does not
validate that test or the new Mac-served interface. No execution result is claimed
until the instrumentation and host checks complete.
