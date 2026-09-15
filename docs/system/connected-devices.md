---
context_room:
  id: system.connected-devices
  depends_on: [system.runtime-profiles, assurance.review.human-authority]
---

# Connected devices

## Summary

Context Room can start an optional TLS listener for its Android client.
The Mac keeps the projects, working notebooks, durable operation receipts and
human review authority. Pairing explicitly selects either drawing in chosen
notebooks or operating the existing owner interface. An Android preview
provides both surfaces through a pinned native connection.

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

The client must verify the SHA-256 fingerprint of the TLS leaf certificate
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

An owner connection opens the existing Context Room UI in a retained Android
WebView. **Draw with the native pen** opens the same working notebook in the
native canvas; Android Back returns to the retained workspace. The same Mac
HTTP handlers, exact-project headers, folder rules and displayed human review
nonce remain authoritative. Autosave and a return from native drawing do not
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
Offline work remains available through **Carnets disponibles hors ligne**;
operating the full owner interface requires the connected Mac.

## Open the notebook on a tablet

For a paired device, **Open on [device name]** requests the currently displayed
notebook. The owner sees requested, deferred or confirmed opening separately.
A successful send does not mean the tablet displayed the notebook. The request
binds the original project, resource, location revision and minimum scene
revision, with one retained operation identifier for uncertain retries.

The foreground Android client defers while a gesture, text dialog or local save
is active, and while the current notebook still awaits its Mac receipts. Once
idle, it opens the exact requested notebook and confirms only after its attached,
visible native canvas draws the corresponding online scene. An actual native
toolbar or pointer action cancels a pending opening. Each device keeps its own
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

The native navigation routes are not exposed through the generic JavaScript
transport. The canvas callback supplies the applied receipt. Tests for the
server protocol and the browser status text are separate from the Android
rendering proof.

## Share a view or present a notebook

Views remain independent by default. In **Connect tablet**, the Mac owner
can choose **Share my view with [tablet]** or **Follow [tablet]**. The tablet
offers **Partager ma vue** and **Suivre le Mac**. Sharing and following are
mutually exclusive on each surface; both sides must choose their role.
The target includes the original project, notebook, path and location revision.
Following never opens another notebook automatically.

The receiving canvas fits the shared world area to its own aspect ratio.
The publisher sees an unconfirmed state until a receipt identifies the frame
and the area actually drawn. Native receipts come from the attached canvas;
the browser likewise reports after rendering. A later frame, another native
session or a new following action cannot reuse an earlier receipt. Sharing
expires after five seconds without a heartbeat. These ephemeral camera states
are discarded when the service restarts and never enter notebook operation
history, documentary review or accepted content.

A pen or finger contact, a tool or keyboard action immediately stops following
on that surface. A late network response cannot resume it or move the current
gesture. **Stop view sharing / following** and the native stop buttons return
to independent views. Hiding the browser or pausing the native app stops the
session; it is not restored automatically.

**Presentation** on the Mac and **Plein écran** on Android expand the canvas
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
freeze, acceptance/rejection, settings changes or agent endpoints. Browser
requests carrying Origin, Referer or Fetch Metadata are refused. The service
returns JSON and never renders a document or exposes a native HTML bridge.
Owner grants use the separate transport described above; they do not widen a
drawing grant or expose the old hosted runtime.

## Android preview

The Android application is in `android/`. It retains a native pressure canvas,
finger pan/zoom, shapes, text, selection and an optional BOOX raw-ink adapter.
The packaged JavaScript engine imports the same `NotebookClient` and revision
protocol as the desktop. It owns the durable outbox and gesture history; there
is no second Android synchronization or review engine.

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
That test uses a fresh synthetic Hub, configured Computer folder and real
documents. It checks native drawing round trips, file pickers and the existing
human file decision. Voice/conversation, personal-data migration, release
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
