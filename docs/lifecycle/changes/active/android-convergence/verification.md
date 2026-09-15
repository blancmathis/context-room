# Android convergence verification

## Summary

The recovered notebook implementation and its local corrections have been
verified on macOS with Node 22.23.0. This is evidence for a working desktop
notebook foundation, an optional restricted TLS drawing service and a native
Android drawing preview verified in an isolated emulator. The
complete connected-device product is not delivered.

## Defines

Observed checkpoint restoration, notebook contract tests, browser scenarios,
regression results and the remaining implementation boundaries.

## Does not define

Human acceptance of personal documents or personal-device installation,
a migration of personal data, or physical
BOOX performance. A synthetic agent operation is not a real provider call.

## Restoration on 2026-09-14

Main remains `05f5ded92cc1158b8c5aea09f4836fd08f4de27f`. Both checkpoint
manifests and their file digests were verified before restoration. The source
archives match their Git trees exactly: 187 files for `22c7a16803e27ba11e9049c26f8862ff0cfc705b`,
195 files for `62cbd331e9b9a761d7504ac49e07f26aa6cdc92e`.

The original commits were retained through their Git bundle and merged with
the remote transport-only continuation `c63b9c2a629de5c0f4e6e3f31efc4759cc4bb601`
in an isolated checkout. No existing installation or private project data was
used as a test fixture.

## Notebook checks

Use `umask 022`, preserving the existing exact file-mode assertions:

```bash
node --test test/notebook*.test.mjs test/local_proposals.test.mjs test/document_assets.test.mjs
npx --no-install playwright test test/e2e/notebooks.spec.mjs --reporter=line
```

The restored checkpoint first passed 53 contract tests and three Chromium
desktop scenarios. Its corrections now pass **59 contract tests** and **16
browser scenarios** across Chromium desktop, Chromium mobile, Firefox and
WebKit. No tests are skipped in these checks.

The browser scenarios use real isolated Context Room servers and cover:

- a growing stroke before pen-up, an independent synthetic agent edit, and
  selective undo/redo;
- a frozen local proposal, correction of that exact snapshot, human fixture
  acceptance and exclusion of later working ink from the accepted file;
- IndexedDB recovery after disconnecting and reopening, retaining operation
  identifiers until canonical receipts arrive;
- rapid strokes while local persistence is deliberately delayed;
- grayscale rendering, visible 44-pixel button targets and automated WCAG A/AA
  checks. Desktop and narrow-screen captures were inspected.

The pen continuation fixes immediate successive pen-down events being consumed
by a previous stroke's unfinished save. It retains lift coordinates, ordered
undo across tool changes and recovery suffixes from every failed stroke.

A second reproduced failure involved two independent writers observing the
temporary hardlink used to publish a lock atomically. The same transition can
affect immutable frames. Path checks now briefly wait for publication to finish
before reading; persistent hardlinks and symlinks still fail closed. Controlled
two-process publication tests verify both the transition and the retained
refusal. No linked file is admitted to a notebook critical section or read.

The first WebKit run observed the initial point's receipt before the subsequent
moving-prefix receipt. Its test now waits for the intended growing-prefix
condition while the pen remains down, using the unchanged assertion and test
budget. The subsequent complete 16-scenario run passes. This does not measure
physical stylus latency.

## Existing regression suite

`npm test` completed with **63 of 64 test processes passing**. Every Shared
shard, including its exclusive performance check, passed. The single failing
assertion was:

```text
Context Hub reopens a fresh exact legacy proposal room through the prepared fast path
Observed: 365 ms. Required: less than 300 ms.
```

The same test passed in isolation at **198 ms**, with its original assertions,
using:

```bash
node --test --test-name-pattern='^Context Hub reopens a fresh exact legacy proposal room through the prepared fast path$' test/context_hub.test.mjs
```

This isolated result did not turn the full parallel run into a successful run.
The preceding session's reported unspecified Shared failure was not reproduced
by this full run.

At commit `4aa10e45532515cc03d81df420a5766988dae1d2`, GitHub run
`34849738136` passed Node 20 and 24, all four browser jobs and soak. Node 22
failed the separate direct exact-review reopening assertion after restart:
404 ms against the unchanged 300 ms requirement. The CI gate therefore failed.

Local profiling reproduced this timing failure and identified synchronous Git
membership attestation outside the existing reported timing spans. The same
three current Git directory queries now run in one process, with a fallback
for ambiguous newline-containing paths. Physical directory and `.git` identity
checks remain live on each call. No binding or authority is cached or relaxed.
The direct review timing header and assertion diagnostics now include the
binding check. A subsequent isolated direct-review test passed at 80 ms warm
and 225 ms after restart. This is an observed local result, not a replacement
for CI on the new commit. Earlier timing failures remain recorded privately.
The Hub legacy fast-path check also passed at 197 ms after the batching change.

`node bin/context-room.mjs doctor --root .` exited successfully; external startup
advisories remain visible. Package privacy, package dry-run and whitespace
checks pass with this delivery checkpoint. The existing Node 20/22/24
and browser CI matrices are retained.

## Restricted drawing-device milestone

The [device service](../../../../system/connected-devices.md) now uses the
existing notebook engine through a separate, optional TLS listener. Seven
initial contract tests pass for one-use and expiring pairing, hashed credentials,
certificate pin refusal, exact notebook grants, server-assigned authorship,
replay after a service restart, concurrent Mac edits, replaced directories,
revocation during upload, rate limits and owner/agent route refusal. An
additional actual-CLI startup check passes after adding the device flags to
the CLI option registry.

An additional two-process test holds the actual notebook lock, revokes the
device after its upload reaches that lock, then permits the writer to proceed.
The write is refused and the scene remains unchanged. Permission checks inside
the notebook critical section re-read device authority rather than trusting
the earlier upload authentication. The first test harness used an incorrect
lock path; it was corrected to use the exported storage prefix.

The existing CLI registry and contract regression run, together with the
eight device checks available at that point, passed 39 tests. The additional
revocation-under-lock check passed separately. Doctor, package privacy
(114 packaged files), relative documentation links and whitespace checks pass.
The final complete device test file then passed all nine checks without skips.

A 21-test regression run also passed across devices, notebook workflow, Hub
root/worktree capabilities, loopback security and retired runtime checks.
These are isolated synthetic projects; no personal pairing or running Hub was
changed.

The browser matrix passed its existing 16 notebook scenarios and exposed a
hidden pairing-code field in all four new scenarios. The field inherited the
old generic textarea hiding rule. Its scoped display rule is corrected. The
four pairing scenarios now pass across Chromium desktop/mobile, Firefox and
WebKit, including accessible owner pairing, cancellation and revocation.
Desktop and narrow captures were inspected. Layout CSS audit passes. The
cancel test waits for the actual HTTP receipt and asserts refusal without
mutating the authority inside a polling condition.

## Native Android milestone

The Android project builds a signed preview and instrumentation APK with
JDK 17, Gradle 8.11.1, Android platform/build-tools 35 and the existing BOOX
pen SDK version 1.5.4. Manifest conflicts and duplicate vendor C++ libraries
were resolved explicitly. The merged preview manifest requests only Internet;
unrelated permissions inherited from the SDK are removed. APK signature v2
verification passes.

The preview APK with SHA-256
`29a346c0113cb77bb26c2d4d6d2528cdbb27c00300f1857576e9f532e61e0d1b`
was installed only on a new, isolated API 35 ARM64 tablet emulator. Its sources
were the then-uncommitted Android milestone on top of `c0e9965`; the private
proof records that distinction explicitly.

Three native instrumentation phases pass through real TLS and the packaged
portable notebook client. They prove certificate-pin refusal, native pairing,
display of Mac objects, growing canonical ink before pen-up, server-assigned
human provenance, eight durably queued offline gestures, recovery after the
application process stops, and selective undo/redo without duplication. The
Mac ends with exactly eleven working objects and no accepted ordinary file.
Native offline and synchronized screenshots were inspected. The storage phase
also verifies encrypted credentials, tamper refusal, retained connections and
ordered durable native commands. Total phase durations were 21.68 s, 15.99 s
and 0.99 s, including startup and all checks; these figures are not pen latency
measurements. The packaged seven engine assets match the current sources
byte for byte, and the copied APK has a verified v2 signature and Internet-only
permissions.

A preceding run passed the data assertions but rendered a blank canvas. Visual
inspection traced this to Android's missing-value `optDouble` returning NaN
for optional object rotation. Rendering now uses a finite zero default. Native
pixel assertions check both the Mac rectangle and tablet ink; all three phases
and both inspected captures pass with the corrected APK above. The preceding
data-only result is not treated as a successful rendered milestone.

The first individual-request recovery attempt exceeded its unchanged 25-second
condition budget; the remaining gestures reached the Mac in the following
attempt. This was not proven data loss or a definitive conflict. Negotiated
mutation batches now reduce the request count while retaining individual
receipts. A new, complete two-phase fixture run passes. Batch unit/integration
checks also cover a lost entire response, wrong-scope acknowledgements,
targeted conflicts, stable replay and documentary authority. Together with
the native adapter and portable client/device regressions, that run passes
24 checks. An earlier broader notebook/gesture/device run passed 32 checks.

The final complete notebook, device, local-proposal and document-asset contract
run passes 77 checks without skips, under the documented `umask 022`. The
complete notebook and owner-pairing browser matrix passes all 20 scenarios
across Chromium desktop/mobile, Firefox and WebKit.

The native write-ahead journal and the shared client's atomic command watermark
are exercised separately for process-death replay, sequence gaps, duplicate
undo and storage failure. The Android storage/Keystore boundary has its own
instrumentation case. The verifier checks JUnit output explicitly, because
`am instrument` can return exit code zero even when a test fails.

The CI run for `c0e9965` exposed a missing generated agent-guide dependency:
`runtime-profiles.md` linked to the new device guide, which was not in the
managed bundle. That guide is now included from the same asset manifest;
the exact generated-link regression passes. The WebKit boot fixture also
allowed an event-driven full catalogue to bypass the held initial catalogue.
It now holds both catalogue sources while asserting the same loading state.
The focused boot case passes in all four browsers. Hosted checks on the new
commit still need to finish.

The first hosted Android job at `511d4ba` failed during environment setup
because `sdkmanager` was absent from PATH. The workflow now explicitly installs
the Android command-line tools with a pinned setup action before requesting
platform and build-tools 35. This setup correction requires a new hosted run;
it does not change the locally verified APK.

At `7eedb3899b795b2feb186cac33a46a51c68a5f72`, hosted CI run `34865450467`
passes Node 20/22.23.0/24, all four browser QA jobs, performance, sustained
navigation and the final CI gate. Convergence run `34865450493` also passes
the notebook contracts and the signed Android build/artifact verification.
These successful runs resolve the earlier hosted failures for that exact
Android checkpoint. They do not validate later uncommitted Shared additions.

## Shared notebook milestone

Notebook submission now uses the existing Shared proposal creation,
publication, scope policy, review and terminal delivery engine. The owner sees
the connected repository, project and relative document path before submitting.
A retained preparation id binds the original connection and frozen bytes. A
pre-push check records the exact prepared commit and refuses changes introduced
by a rebase. Delivered branch and active-state refs are fetched and verified
before a receipt is reported. No new review engine or acceptance endpoint is
introduced.

Seven synthetic Shared contract scenarios pass against isolated local bare
repositories. They cover the exact frozen scene, later working ink, correction
and separate human acceptance, accepted-only ordinary reads, receipt recovery
after delivery, refusal to overwrite a newer workspace correction, connection
changes, a clean rebase over independently accepted context, unrelated edits,
and a substituted symbolic-link destination. Repeating a submission after
terminal acceptance returns its historical receipt without recreating a branch.
The real owner HTTP route requires the displayed Shared target.

The Shared submission browser scenario passes in Chromium desktop/mobile,
Firefox and WebKit. Desktop and narrow-screen captures were inspected.
The subsequent full run passes all 84 notebook/device/local-proposal/asset
contract checks and all 24 notebook browser scenarios. The Android build is
up to date; its unchanged APK passes the artifact boundary check. Package
privacy passes after using the existing construction for the synthetic Git
author address. Hosted checks for the new Shared commit remain a separate gate.
The first fixture attempt exposed a lexical `/var` versus physical `/private/var`
test-home mismatch on macOS; the fixture now retains its configured home alias,
and notebook writes resolve the already-validated Shared worktree physically.
The contract fixture also closes its server before removing only its own
read-only snapshots. The earlier failed setup/cleanup runs do not count as
successful verification.

At Shared commit `1f8811a2e9c4b465d51b2d41bb7bd309a274292e`, hosted run
`34867901737` passes all three Node versions and all four browser jobs.
The sustained navigation job fails its unchanged maximum file-opening budget:
2,488 ms observed against less than 2,000 ms. The CI gate therefore fails.
Convergence run `34867901963` passes its contracts and Android artifact job.
The sustained-navigation failure remains under investigation; the earlier
green checkpoint does not turn this commit into a green release.

## Native opening receipts

The owner can request a notebook on a paired drawing tablet and observe
requested, deferred and applied states. The native receipt binds the exact
project/resource/path/location and a displayed canonical scene revision. It is
sent by the native canvas callback, outside the JavaScript transport. The
client waits for a held gesture and its current Mac receipts, and a native
toolbar action can reclaim the view. Server tests also cover retired sessions,
supersession, expiry, revocation and recovery of an interrupted control-pointer
publication without another request.

The complete focused contract run passes **87 tests without skips**. The
opening/pairing browser scenario passes in all four browser configurations,
including its accessibility check; the narrow-screen capture was inspected.
The subsequent complete notebook browser matrix passes all **24 scenarios**
in 2.7 minutes. Doctor, the generated agent-guide regression, package privacy
(118 packaged files), package dry-run and the staged secret scan pass.

APK SHA-256 `c6cc2373e075b54de63f557f490528d412623133a6f541ef5ffb39a47e2a79e5`
passes four instrumentation phases in two consecutive fresh emulator fixtures.
The first run takes 18.75 s / 16.98 s / 26.62 s / 1.82 s, including startup.
The retained native screenshots include the second notebook and its ink.
Both fixtures end with twelve objects in the first notebook, three in the
second, an applied opening receipt and a human-cancelled return request.
Neither notebook becomes an accepted ordinary file. The generic WebView
transport is separately checked to refuse native navigation receipts.

An initial driver attempt misread `adb exec-out` success when the stage file
did not yet exist; the driver now uses the shell protocol's actual exit code.
A subsequent attempt timed out waiting for the first native display receipt.
Targeted failure diagnostics were added and the next two complete runs pass;
the earlier unconfirmed attempt remains a recorded failure, with no claim
that its cause has been established. This is emulator evidence, not a physical
BOOX or Wi-Fi result.

## Navigation performance follow-up

The trace of the Shared checkpoint's sustained-navigation failure shows a
slow file-row appearance during a worktree change. The eventual file read is
under 9 ms; concurrent Hub requests wait while synchronous registry work
occupies the server. An eight-cycle local diagnostic reproduces the unchanged
2,000 ms file-opening failure at 2,388 ms. CPU sampling attributes 11.75 seconds
of that run to registry lock-record synchronization.

The fallback catalogue now obtains its snapshot, live project records and
Shared repository records under one normal registry lock. Refresh scheduling
reads freshness without constructing another fallback catalogue. Recovery,
physical root identity, live project-control checks and durable lock publication
remain intact. The same eight-cycle diagnostic passes both soak scenarios;
sampled registry synchronization falls to 7.66 seconds. This short diagnostic
does not replace the default fifteen-minute sustained run.

The complete Hub regression passes **72 tests without skips**, including
replacement-directory refusal and snapshot invalidation. Eight existing exact
agent-navigation scenarios pass in all four browser configurations. A hosted
Chromium run at `568511d` encountered `ECONNRESET` before receiving an HTTP
response for the stable-id navigation command. That test's API client now
retries only a transport reset, once, with the same id; HTTP response and exact
visible-workspace assertions remain unchanged. The connection reset's cause
has not been established. Soak passes at that commit, but its browser failure
still makes hosted run `34871837645` fail. Measurements are now attached before
the soak's final assertions, preserving diagnostics when a budget fails.

## View following and native opening isolation

The view exchange uses the existing drawing authority and native foreground
poll, with short-lived camera state separate from notebook persistence.
Server contracts cover explicit consent, opposite sharing/following roles,
exact locations, stale sequences, competing owner windows, five-second expiry,
new native sessions, bounded world areas and revocation. A display receipt
records the rendered area and cannot be reused for a new following action.

Four focused browser scenarios pass across Chromium desktop/mobile, Firefox
and WebKit, including a delayed response after human input, the separate
unconfirmed/displayed states, presentation and accessibility. Desktop and
narrow-screen captures were inspected. An initial route harness released its
interception while it was still being handled; it now waits for completion.
The first mobile assertion compared canvas height even though status text
changed that height. It now checks the exact camera translation and scale,
preserving the requirement that a late response cannot move the human view.

The first native run reproduced the intermittent opening failure. Its retained
state had the second notebook's current scope but the first notebook's scene
and cache version; the screenshot showed the first scene under the second
path. A JavaScript event already queued on Android's main thread could arrive
after the native opening reset. Its larger, unrelated cache version then
excluded the new notebook's scenes. Each opening now carries a native request
identifier through scene/opened/error events. Scope checks also guard rendering
and readiness. A deterministic instrumentation case injects the previous
scene at that precise transition, with the largest possible cache version,
and verifies that the second notebook still opens correctly.

APK SHA-256 `9d703e970b73aedd1dc38e6363f322446de4561e2e2de888b64b31ca5ebfc07d`
passes all six phases in a fresh emulator fixture: drawing/offline durability,
process replay, deferred opening/cancellation, optional following/presentation,
queued-scene isolation and native storage. Durations are 14.90 / 14.87 / 26.15 /
18.36 / 8.16 / 0.72 seconds, including startup. The fixture verifies a real
native rendering receipt, immediate finger cancellation, refusal of a later
camera update, presentation exit and no silent restoration after pause. The
Mac retains twelve objects in the first notebook and three in the second;
neither is an accepted ordinary file. Native following and fullscreen captures
were inspected. Signature v2, Internet-only permissions and the seven exact
shared engine assets pass artifact verification. These are emulator results.

The complete notebook/device/view/local-proposal/asset run passes **92 tests
without skips**. All **28 notebook browser scenarios** pass across the four
browser configurations in 3.2 minutes. Doctor, the generated agent-guide
regression, layout CSS audit, package privacy (120 files) and package dry-run
also pass.

At `73f607ba6e075f420c8d2a2738d5895b97cadca7`, hosted run `34874609818`
passes soak and all four browsers, but Node 20 fails the existing stale-lock
symlink test: `filesystem_lock_busy` instead of `filesystem_lock_unsafe_sidecar`.
The CI gate fails. A local default-duration soak in a detached checkout also
fails unchanged latency budgets after 225 cycles: maximum project opening
3,137 ms and file opening 2,934 ms. The complete measurements and traces are
retained privately. Neither the earlier short profile nor hosted soak alone
resolves this local performance gate.

The stale-lock path wrote and synchronized a temporary contender before
discovering an existing reclaim record. It now inspects that record first,
using the same stale-generation recovery and identity checks; publication
races retain the existing `EEXIST` recovery path. All twelve filesystem-lock
tests pass with their original deadlines and assertions, including the
unsafe-sidecar refusal. Full regression and hosted verification of this
correction remain separate checks.

## Connected owner interface milestone

An explicitly selected owner pairing opens the existing Context Room UI in a
separate retained Android WebView. The native connection reaches only the
attached loopback runtime. Existing project/folder rules and human review
nonces remain authoritative. The restricted drawing permission cannot enter
this transport; an owner cannot silently create another pairing. Rendered
documents remain inert and their frames cannot use the native owner bridge.
Both pending upload bodies and response buffers have aggregate bounds.

The real HTTP/TLS owner contracts pass, including invalid paths/headers, exact
project and nonce requirements, current folder permission, event cursors,
revocation before a delayed response and release of the aggregate upload
budget. The notebook/device/local-proposal/asset group passes 96 tests before
the additional upload-budget regression; all five owner tests then pass.
All 32 notebook browser scenarios pass across desktop Chromium, mobile
Chromium, Firefox and WebKit, including explicit owner pairing and accessibility.

The emulator owner acceptance passes in 44.730 seconds. It operates the real
Hub, configured synthetic Computer folder, project search, Markdown reader,
inert HTML reader, notebook explorer entry, local frozen review and settings.
It opens native pen input, confirms the stroke on the Mac and returns to the
retained working notebook. Image selection uses the Android document picker;
the image reaches the Mac before export. The saved editable notebook equals
the acknowledged canonical scene, including both objects and its embedded
image. A human UI file decision accepts the original frozen document while
later working ink and the image remain separate. It also opens the exact Shared
review URL returned by the Mac, including its missing trailing slash, and checks
the frozen scene and object. A WebView visual-state receipt precedes its screenshot;
the rendered Shared drawing was inspected. All six complementary drawing phases
also pass, including restart/replay, opening conflicts, view following and storage
boundaries.

Verified preview APK:
`8da6afe206615026781101480d22cf6b834a75621bdd7f228c1b4cc1f28bfa71`.
Its eight packaged engine/transport assets match the source, its v2 signature
verifies and its only Android permission is Internet. This is an emulator
installation, not a physical BOOX result or a published release.

Earlier attempts found a missing notebook Explorer entry, a missing path
from frozen review to the working notebook, a hidden pairing-code textarea
and background owner reads that could report a spurious error. These product
issues were corrected. The file-picker tests also needed the real Android
accessibility action and filename suffix behavior. One attempt exported
locally saved work before the image was acknowledged; final acceptance waits
for the Mac receipt and checks the saved bytes. The first Shared checks stopped
at page/DOM presence and captured the page before the drawing was painted. The
final check waits for the visible geometry and a committed WebView visual state.
An intermediate attempt to require this receipt for every capture timed out;
that failed run remains retained independently of the final successful check.

Direct core-suite runs initially reached the personal Shared registry because
only Hub storage was isolated. Both bounded background-worker tests failed in
the pre-owner commit as well, then passed unchanged with isolated Shared
storage. The suite now owns both temporary stores and makes only its own
read-only snapshot directories removable during cleanup. The core suite
passes through the normal runner. Doctor and package privacy pass.
The full serial test run passes 68 of 69 processes. Its 80-file durable HTTP
acceptance takes 1,562 ms against the unchanged 900 ms assertion and fails.
Transaction time is 1,544.6 ms, including 260.6 ms for events; projection time is
0.7 ms. This is an open performance failure, alongside the existing navigation
latency gate. Hosted checks for this milestone remain separate.

At `54340b9`, hosted Node 20, 22.23 and 24 checks pass. The mobile view-following
scenario fails because its simulated tablet acknowledges only viewport sequence
3, while toolbar/status reflow publishes sequence 4 with a different height.
The retained trace confirms that the server correctly leaves the new viewport
unconfirmed. The fixture now follows and acknowledges subsequent frames, as the
native client does; three consecutive mobile runs pass. The production receipt
checks and deadlines are unchanged. A separate local HTTP performance run passes
at 724 ms; it does not erase the full-suite failure above.

## Agent and local audio foundations

The dedicated Codex stdio provider uses the existing account. Before any model
turn, it verifies that shell, apps, plugins, additional agents, web search and
every inherited MCP server are disabled for that child process. Codex CLI
configuration tables merge rather than replace: an empty MCP table is
insufficient. Quoted override segments also create a different key in the tested
CLI, so unsupported server names fail closed. Global/Desktop configuration is
not rewritten. A cold, separate metadata database did not initialize reliably;
the product provider uses the account's configured store rather than copying it.

A real fresh Codex task creates a three-step notebook diagram and a progressive
ink stroke. Nine agent-authored objects and six durable pen positions are
observed. The human object, accepted ordinary file and other project stay
unchanged. First useful geometry takes 22,133 ms and the complete turn 26,377 ms:
the ten-second simple-diagram objective is not met. The generated SVG was
rendered and inspected; provenance labels still need visual refinement. This
proves the model/engine path, not its app controls or physical pen display.

A separate real connection resumes that exact Codex task, recalls the diagram
and original human text, and leaves the scene unchanged. Private conversation
bindings and send identities have focused tests for duplicate requests, original
project scope, task reuse, interruption, revoked access and uncertain process
termination. Uncertain sends are not automatically replayed. The subsequent
interface milestone below connects those paths and adds explicit recovery.

Local Whisper recognizes a synthetic French recording word for word in 2,031 ms.
macOS speech produces the exact requested reply as 24 kHz mono PCM16 WAVE,
lasting 3,643 ms. These tests invoke the real speech programs and a separate
copy of the model weights. They do not use a physical microphone and do not
claim playback. Audio scratch files are removed; a transcript is never sent
automatically. The 18 provider, notebook-agent, audio and conversation-store
contract tests pass. Standard tests do not invoke a model account.

## Scoped conversation interface

Document Discuss/Dictate and notebook selection controls open a persistent
conversation panel. Its captured API retains the exact project and source
through navigation and notebook closing. Saved conversations can be selected
explicitly. Model choices come from the actual account after an explicit
connection action; stopping targets the original turn. Original selections are
retained even if selected objects are later removed. Current notebook revisions
are read before edits, and document replacements become frozen local proposals
through the existing review engine. Ordinary files and acceptance are unchanged.

Thirty-five focused contracts cover source selection, HTTP owner/origin/project
guards, proposal preparation, duplicate sends, provider isolation, progressive
ink, recovery and exclusive audio control. Eight browser scenarios pass across
Chromium desktop/mobile, Firefox and WebKit, including scoped navigation,
same-task continuation, stop, canonical notebook edits and accessibility of
the conversation panel. Failures during development exposed an empty-session
read, an incorrect loaded-document guard and a missing keyboard focus target;
these are fixed. A test initially tried to click a model control inside a closed
disclosure; its corrected interaction preserves the application behavior.

Real Codex is also verified through the browser UI in an isolated synthetic
project. It creates three notebook objects, including a progressive stroke,
then proposes an edit to the original Markdown while another document is
displayed. Both ordinary Markdown files remain byte-for-byte unchanged. The
notebook conversation survives server restart and explicit history selection.
The first proof script reached the completed notebook turn but used the wrong
notebook-list field; the corrected continuation reuses that recorded turn
instead of generating it again. Rendered notebook and document panels were
inspected. This run has no valid first-geometry latency measurement.

A separate real provider connection reads the earlier exact completed turn
through paginated history, checks its recorded input hash, and recovers the
172-character answer without generation or a new task. Recovery fails closed
when the original turn cannot be matched uniquely.

Audio uses one expiring controller across surfaces. Explicit takeover requires
the current epoch; stale clients cannot prepare, read or acknowledge audio.
Recognition and exact-answer speech are asynchronous jobs so the tablet bridge
does not wait for a long HTTP response. Dictation remains a reviewable composer
draft and never sends automatically. Browser capture and speech controls are
wired, but their microphone/playback path, continuous conversation, durable
recording recovery and native Android audio still need end-to-end verification.

The preview APK rebuilds and retains its existing native permissions and shared
assets. On the preceding foundation commit, the complete serial local suite
reports 71/73 processes passing. One synthetic Shared fetch exceeds its
1,000 ms discovery budget; one repeated Context snapshot produces a different
hash. Its CI passes Node 20/22/24, mobile Chromium, Firefox, WebKit and soak,
but the desktop browser suite loses an ambiguous-project notice to “ready”.
The follow-up identifies and fixes the Hub race: a runtime snapshot that
supersedes the initial catalogue now resolves an ambiguous alias as well as a
unique project. A deterministic browser regression reproduces the missing
warning before the fix. Closing an offline notebook also no longer imports an
unused conversation module, which had caused an unhandled network failure in
all four CI browsers.

The focused browser matrix completes 19/20 scenarios; one mobile worker exits
inside Node/V8 module loading. That exact mobile scenario passes on its focused
rerun. All four offline notebook and eight conversation scenarios pass. The
Shared discovery trace isolates approximately 750 ms in the macOS
`git-upload-pack` developer-tool launcher. Its synthetic helper now invokes
`git upload-pack` directly; the existing one-second budget and two-connection
assertion pass unchanged. The Context snapshot anomaly does not reproduce in
the five-test module or six consecutive inspected snapshots. The fresh complete
run on `dc6fb172044e6389dd989c6d1fc55ea0fd7be7cd` passes **75/75 test
processes**. CI run `34900810518` also passes all nine jobs: Node 20/22/24,
the four browser profiles, soak and the final gate.

## Native audio and original composer recovery

The Android preview uses actual `AudioRecord` and `AudioTrack`, an explicit
runtime microphone permission, and the existing trusted main-frame bridge.
Capture writes bounded PCM in the private application directory and syncs it
during recording. The original conversation and source hash remain attached.
The native controller expires, rejects stale epochs and closes on backgrounding.
Playback confirms reached frames instead of treating prepared bytes as heard.

The real emulator component test passes capture, exact PCM recovery, wrong-source
rejection, playback completion, background stop, old-epoch refusal and removal
only after acknowledgment. The connected owner UI test also passes its Android
permission dialog, backgrounding, recovery in the original conversation and
reload with the retained recording. It never sends a message to Codex. The
existing owner Hub/document/review/native-drawing/file-picker round trip passes
again with the same APK. Its SHA-256 is
`10cd87ece566ce9b73a9bc94c736a503303e44ad5c500bc995e5aae1bda366f0`;
signature v2 and eight exact shared assets pass. Permissions are now Internet
and microphone; no background audio service is added.

Sixteen browser scenarios pass across all four profiles. They cover original
source preservation, explicit sends with a synthetic test provider, restored
drafts, original-history selection, late recording completion after Stop, and
playback receipts fenced by the current operation. The audio-ordering fixture
is explicitly synthetic; the Android tests exercise the real Java bridge and
platform audio APIs. Sixteen focused HTTP, device-owner and asset contracts also
pass. Empty messages no longer consume panel space, the microphone state remains
visible, and long panel content scrolls normally.

The first owner audio scenario found that Discuss inherited the Save block for
a document awaiting review. It now permits discussing that exact current disk
version while retaining the Save/review restrictions and external-conflict gate.
Another run reached the existing 32-connection retention limit after repeated
synthetic pairings. The isolated emulator's old encrypted pairing vault was
archived reversibly with its Keystore and notebook caches intact; the limit was
not weakened. The ensuing native and owner scenarios pass. Rendered capture and
recovery panels were inspected.

These native checks do not establish physical microphone quality, audible BOOX
output or speech recognition through the tablet. Real Mac recognition and speech
preparation are proven separately above. The full local run at
`0352a5682fe7e8d8db4d1642bc7c4e56079ed602` finishes **74/75 processes**:
the new conversation guide was missing from generated agent context. CI run
`34903905751` finds the same broken link on Node 20; the Node 22/24 jobs are
cancelled by the matrix, while all four browsers and soak pass. The copy manifest
and its source guide now retain valid generated links; the focused canonical-copy
test passes. A fresh complete checkpoint is still required.

## Continuous voice and browser recording recovery

Explicit Voice uses speech endpoints to delimit a phrase, local Whisper to
recognize it, the original Codex task to respond, and exact local speech passages
for playback. It listens again after playback. A phrase spoken while the agent
works stops the exact original turn before redirection. During speaker playback,
the microphone is off and **Interrupt and speak** resumes listening explicitly.
This is not proof of acoustic echo cancellation or hands-free speaker barge-in.

Twenty-eight scenarios pass across Chromium desktop/mobile, Firefox and WebKit:
original source/history, dictation and playback ordering, unfinished browser
recording recovery, continuous voice, interruption, resumed listening and late
transcription after End voice. Browser chunks are journaled separately from the
composer, every half second. An out-of-order chunk is refused without replacing
the prior journal, and another source's audio is neither recovered nor removed.
Twelve focused audio, session and runtime tests pass, including a stale stop
request refusing to stop a later turn.

A separate real browser run uses a finite synthetic MediaStream and then silence.
Actual capture and endpoint detection produce one Whisper transcript, one real
Codex turn, one local macOS speech passage and one completed Web Audio receipt.
Listening resumes and the explicit End voice stops it. The original Markdown
stays byte-for-byte unchanged. Output is muted; physical input and audibility are
not tested. The recognizer substitutes one word in the synthetic French prompt;
the test does not claim word-perfect recognition. A separate manual-dictation
run also passes real capture, Whisper, explicit Send, Codex and browser playback.
Both rendered answer panels were inspected.

The Android endpoint component passes with actual PCM capture/playback. The owner
test revealed two readiness assumptions: a reload could still expose the old DOM,
and the conversation history could still be loading. The test now requires a
new page and restored source identity. Product controls also wait for the saved
draft/history before enabling microphone or send actions. A further owner run
found that backgrounding stopped native capture before the HTTP release could
reach the Mac. Pending releases now survive reload with their exact client and
epoch, without taking over another surface's controller. The final **32 scenarios**
pass across all four browsers, including background release across reload. The corrected Android
owner test passes permission, capture, recovery, reload, explicit Voice capture and
foreground/background stop. Its two native component tests pass as well. The APK
SHA-256 is `8eaca6a3bdbdfd9cf7a4c3703939dddc185fa86b66e77d2b15e149ee9d56e929`;
signature v2, eight exact shared assets, Internet and microphone permissions pass.
The recovered owner panel was visually inspected. Recognition and a real Codex
voice turn through Android remain separate proof gates.

## Retained native conversation and scope continuity

The owner preview can place its existing conversation WebView alongside the
native pen, retaining the original notebook dialog and its working state. It
uses the same conversation, scoped API, microphone controller and recovery code.
Wide screens put the panel beside the canvas; smaller screens put it below.
During Voice, the visible End voice and interruption controls remain near the
conversation instead of below the inactive text composer.

Forty scenarios pass across Chromium desktop/mobile, Firefox and WebKit. They
include return to the retained notebook, original-source dictation/voice and
recovery of a prior preview's equivalent root scope. Explicitly clearing a
composer cannot resurrect an older alias. Other project/worktree scopes remain
distinct. Thirteen focused audio/session/runtime contracts pass.

The Android owner round trip passes again: Hub, documents, Local and Shared human
review, native pen, system image picker, exact editable export and return to the
retained workspace. Four audio/pen component and owner tests pass, including
actual foreground microphone capture while a native stylus gesture reaches the
Mac, background stop and preserved conversation text. A geometry test refuses a
tip for an absent/future point, a moved object, expired progress or a completed
stroke. Rendered Voice controls and the native canvas were inspected.

All six complementary-mode phases pass: native drawing, durable offline work,
process restart, exact replay, remote opening, view following and presentation,
stale-opening rejection and native storage boundaries. The first run found an
empty coordination JSON while `adb push` was replacing the test receipt. The
fixture now publishes that receipt through a temporary file and atomic rename;
the full six-phase rerun passes. This changes test coordination, not device
permissions or product deadlines.

The complete local regression at `589354054b6b9152a3afec208bdfd805e5483177`
passes **76/76 processes**. Both convergence CI runs pass. Its main CI run
`34907254117` passes Node 20 and 22, all four browsers and soak, but Node 24
times out cleaning an old Worker's lock while a live successor owns it. Cleanup
now checks whether the old generation needs removal before writing a coordinated
record, and still rechecks identity under coordination before every removal.
A deterministic no-write probe reproduces the unnecessary write before the fix.
The twelve lock tests pass with preservation and global-deadline coverage;
the 52 revision-integrity tests also pass. The first focused run retained two
old test assumptions that every no-op must contend; those now distinguish
unrelated successors from actual pending cleanup without relaxing deadlines.
Current-commit full CI remains a separate gate.

## Real native agent, interruption and speech

The explicit `test/android/verify-agent.py --run` helper connects a synthetic
notebook and separate emulator to the actual local Codex provider. The native
tip appears after **13,402 ms** for a new progressive ink request. Native human
writing continues while it draws. Stop retains only the reached prefix; a second
message in the original conversation adds an ellipse without replacing that
prefix or either human stroke. Native undo/redo affects the human gesture while
preserving the independent agent objects. The ordinary notebook file remains
unchanged and unaccepted.

The exact real answer is synthesized on the Mac and played through Android's
AudioTrack, with one receipt after frame completion and no microphone capture.
Emulator volume is muted; this verifies native playback completion, not physical
audibility. Total time through both turns and playback is **40,993 ms**. Rendered
progress and final native scenes were inspected. The first useful result still
misses the sub-ten-second objective; no replay is substituted for a new request.

The verified application APK SHA-256 remains
`0049bc2884ab530545761f990adef2fc5197ae12385f2d90faf4610400ad9ef2`:
signature v2, eight exact shared assets, Internet and microphone permissions
pass. The owner interface is served by the Mac. The screenshots revealed that
Stop agent was below the fold in a short conversation panel; it now stays in the
sticky heading while an agent turn is active. Browser verification covers that
small-panel control independently from the real provider turn.

## Direct dictation and native recognition

Document and notebook controls now start compact dictation or Voice directly.
Reviewed dictation can be copied into the unchanged original Markdown/text
draft or a retained notebook text draft. Copying does not save a document,
create a notebook object or send an agent message. Original-source checks
refuse a changed editor, project, file or notebook text draft; normal human
undo remains available. Success messages use a neutral status area. Silence
does not append a newline or otherwise change an existing draft.

The current focused matrix passes **64 browser scenarios**: 48 voice/dictation
checks and 16 conversation checks across Chromium desktop/mobile, Firefox and
WebKit. It includes real double-click handling, original-source navigation,
explicit draft insertion and notebook addition, Voice-to-Dictate switching,
silence and answers longer than 24 speech passages. Consumed playback drops
its PCM payload while retaining an exact request receipt. The 15 focused
audio/runtime/session contracts pass. Doctor and package privacy pass.

The four Android native audio/progress/owner checks pass with **Dicter** and
**Parler** alongside the pen. Closing compact dictation stops capture and
returns the native canvas space. The additional explicit
`test/android/verify-dictation.py --run` check passes real local Whisper
recognition through the owner transport. It first starts real native capture,
then substitutes a synthetic voice sample into that fixture's stopped recording.
The transcript returns in **4,930 ms**, stays in the original conversation and
survives WebView reload. Only saved text acknowledges removal of the native
recording. A separate maximum-size **3,840,000-byte** silent recording traverses
the same path without changing that draft or sending an agent message. The
ordinary source file remains unchanged. Both rendered results were inspected.
This is transport and local-recognition evidence with synthetic input, not a
physical microphone-speech claim.

The application APK SHA-256 is
`7075e8ff3539a7e0cbb75023ed7d1b2d84912847428b74eb281670ae51366308`;
signature v2, all eight exact shared assets, Internet and microphone permissions
pass. The first recognition harness selected a document without entering its
project in the Hub; the corrected test uses the actual project/file navigation.

The complete local regression for `4f159afcfc63fffed1f27b57248df1fa6cec2d71`
finishes **75/76 processes**. CI `34910248215` fails the same Settings-search
test: its extracted function fixture also evaluated unrelated browser bindings
and raised `window is not defined`. The test now extracts only the catalog and
search functions, retaining every original assertion; its focused rerun passes.
That CI's four browser jobs and soak pass, as do both convergence runs. A full
regression and CI on the new checkpoint remain separate gates.

## Bounded provider residency and original history

The provider's 64 resident-task limit now bounds simultaneous loaded work,
rather than the lifetime number of conversations. Acquiring a task protects it
until its send or recovery finishes. Inactive tasks leave memory only after an
explicit provider unsubscribe receipt; their private original bindings remain
on disk. Active and uncertain turns cannot be chosen. Exact recovery also
clears a missed completion before permitting another turn in that task.

All **18 provider/session contracts** pass. They include more than 64 distinct
conversations with a two-entry cache, serialized simultaneous starts, protection
before dispatch and during generation, unsubscribe failure, uncertain outcomes,
and release after a source failure. An opt-in actual-Codex check with a one-entry
cache unloads the completed original task, opens an empty temporary task and
resumes the exact original identity. Its second generated answer correctly
recalls a synthetic marker from the first exchange; the later request does not
repeat that marker or replay the prior input. Both unloads are confirmed by the
real provider. No personal task is used.

## Notebook controls and complete-regression follow-up

CI `34913392115` at `0fcfd073daaccd2cb42b9d2cda5ba1dda782b2c8`
passes all three Node versions, Firefox, Chromium mobile and soak. Its gate
still fails: WebKit catches an object button detached during the tactile-size
check, and Chromium desktop retains a pending pen upload while the test removes
network interception. The existing size, save, scope and timing assertions remain.

A deterministic keyboard-focus test reproduces the object-list problem. The
list now reuses controls for stable object identities and reads the current
object revision when a control is activated. Unchanged polling and independent
scene additions retain focus. The view-following fixture keeps interception
installed while pen receipts are in flight; the CI trace places the stranded
upload immediately after interception is disabled. Failure diagnostics now
capture the live notebook before fixture cleanup.

The twelve targeted checks pass across all four browsers, including their
44-pixel targets and automated accessibility checks. The subsequent complete
notebook matrix passes **36 scenarios** across those browsers. The grayscale
WebKit and Chromium presentation captures were inspected. Doctor, package
privacy, dry-run and the Android preview build pass.

The complete local run for that checkpoint passes **75/76 processes**. Its sole
failure is a synthetic Git clone exceeding the unchanged one-second proposal
discovery budget under parallel load. The exact test passes in isolation.
The runner now schedules that CLI contract file exclusively, like the existing
Shared performance probe, without widening the product budget or assertion.

The subsequent complete run at `3251c1fddcab961a546a0f3040da8f5abc816541`
passes **76/76 processes**. CI `34915027228` passes all Node versions, Firefox,
Chromium mobile, WebKit and soak. Chromium desktop still finds a synthetic
accessibility fixture inconsistent with its server: opening the fake review
refreshes the real catalog and removes that client-only item. The test now
returns its seeded catalog on that refresh; its role and focus assertions stay
unchanged. Convergence verification `34915027261` passes.

## Explicit original-source observation

The existing document read and notebook scene tools now include an explicitly
shared draft excerpt or viewport image. A source-only browser capture and the
native owner bridge feed bounded, expiring memory on the Mac. The provider
sends authorized images as actual image content in the existing tool response,
so earlier conversations keep their original task and tool identities.

Core and HTTP checks pass **28 tests**, covering explicit activation, original
scope, current document base, moved notebooks, image limits, ordered frames,
takeover, revocation, expiry and image transport. The new browser scenarios
pass **12/12** across Chromium desktop/mobile, Firefox and WebKit. An early
fixture incorrectly expected an active ink stroke to be absent from the scene;
ink prefixes are intentionally saved during drawing. The corrected case uses
an unfinished shape and retains the assertion that observation does not commit it.

`test/android/verify-observation.py --run --serial <isolated-emulator>
--codex-state <private-test-state> --output <new-private-directory>` verifies
the actual owner UI, native shape, pinned transport and real Codex. The first
run passes in **44.41 s**: the answer is **Ellipse**, with two actual image tool
receipts while the canonical scene has zero objects. The original accepted
file stays unchanged; a foreign project is refused; backgrounding stops
sharing without automatically resuming it. The first observed turn takes
**23,614 ms**. This verifies image understanding, not low-latency turn initiation
or physical BOOX behavior. Screenshot inspection then moved the sharing control
into the sticky header so it stays accessible while scrolling.
The repeated native check after that layout change also passes, with three
real image receipts and a **26,310 ms** turn. Both updated captures were inspected;
the sharing control is visible and the resumed activity reports sharing off.

The combined conversation, Voice and preview matrix then passes **75/76**
scenarios. Its mobile failure shows that an inactive sharing button enlarged
compact Voice over the document's Dictate action. Preview activation now lives
in the expanded conversation; an active preview retains its stop control.
All **20 targeted scenarios** pass across the four browsers after that fix,
including the existing Voice switch, review accessibility, takeover and the
sharing button's viewport visibility during scrolling. Mobile and Firefox
captures were inspected. Doctor, package privacy, dry-run and the secret scan
pass; the Android artifact has a verified v2 signature and eight exact shared
assets. Complete local regression passes **77/77** at `a0b75e4`.

Hosted CI at that commit passes the three Node versions, soak and three browser
jobs, but Chromium desktop finds a Hub navigation defect: Back cancels proposal
opening in state while the controls stay disabled if no local report has loaded.
The browser regression now explicitly reproduces that condition. Shared Hub
controls render independently of the local report; all **16 targeted browser
scenarios** pass after correction, across the four browsers. The pre-fix failure
and CI trace are retained. Hosted CI remains a separate completion gate.

An already consumed preview may remain in Codex history. Disabling sharing
prevents new observations and cannot erase that earlier context.

## Private legacy snapshot export

`context-room migrate --export-lisiere <workspace> --output <private-directory>`
previews a recognized SQLite workspace without loading Lisière. Applying its
exact revision publishes a recoverable private snapshot, with the completed
manifest last. Original data and unacknowledged work remain unchanged.
The [snapshot contract](../../../../system/lisiere-migration.md) defines its
format and the remaining import boundary.

Nine contracts use real synthetic SQLite files, including committed WAL data,
Android binary cells and exact large integers, credentials exclusion, retained
drafts/deletions, asset identity, version refusal, changed source, symbolic paths,
occupied destinations and an injected publication interruption followed by
resume, repeat and destination-conflict refusal. The installed CLI performs a
preview, apply and repeat without a registered project or old executable.
The actual control-state migration CLI also exposed two existing dispatch
omissions (`--revision` and native apply); both are corrected and covered.
All **35 targeted Node checks**, including the nine Python contracts, pass.
Doctor, package privacy, package dry-run, APK rebuild and artifact verification
pass. No personal database, Android application or pairing was changed.

This milestone exports database recovery data. It does not yet import editable
notebooks, replay Android drafts/outboxes, collect recording files or old project
handoffs, or switch the active writer. The complete regression and hosted CI
at `af37bea` reports **77/78**: the sole failure is a generated agent-context
link to the new migration document, which was missing from the canonical copy
list. Hosted Node 20 finds the same issue; all four hosted browser jobs and
soak pass. The canonical list is corrected and its focused regression passes.
One convergence job fails only while uploading its already verified APK to
GitHub (403); the other execution passes, and the failed job passes on retry.
At `092e9ca`, both convergence workflows pass. The complete affected local
application suite passes **236/236** after the generated-context correction.

## Recovery readers and retained visual properties

The import preparation now checks a completed export's manifest, journal,
inventory, every byte count/hash, independent file identity and row count.
Tables stream through bounded UTF-8 records. Binary SQLite cells and int64
values remain exact; the LSJ1 reader preserves Java UTF-16 code units, including
an unfinished surrogate. Draft recovery replays only the captured epoch/version
in UTF-16 order and refuses missing seeds/final deltas, wrong identities,
invalid ranges and incomplete text. It does not send or acknowledge any work.
Six recovery contracts use actual synthetic SQLite exports and mutation cases.

Notebook objects now retain connector sides/routes and explicit text line
spacing through normalization, the native adapter and editable export. Browser
and SVG renderers follow the routed path; Android uses the retained spacing.
Twenty-three focused core checks pass, then the complete notebook/recovery
contract group passes **77/77**. The new scenario passes in all four browsers.
The actual native Canvas check passes on the dedicated emulator; its path and
text baselines match the expected values and its rendered bitmap is retained.
The APK is rebuilt with a verified v2 signature and eight exact shared assets.

Visual inspection then finds selection dashes leaking into later browser paints.
Each object paint now resets that style. Eight targeted browser checks pass
after the correction, including a solid-line pixel check and existing tactile
accessibility. The corrected mobile canvas and native bitmap are inspected.
Complete notebook-browser regression then passes **40/40** across the four
browsers. The checkpoint at `e86780e` passes **80/80** complete local test
processes, the full hosted CI and both hosted convergence workflows.
These are preparation and rendering proofs, not a
completed import, Android outbox replay or a physical BOOX check.

## Recoverable canonical notebook import

`migrate --import-lisiere` now converts one selected Mac board from a fully
verified recovery export into a private working notebook. Preview is read-only;
apply binds the source, original project identity, destination and current
configuration. Original rows, deletion records, ID mapping and exact selected
assets are retained before atomic notebook publication. Immutable phase
receipts recover interruption without replacing later human work or creating
an accepted baseline. A changed configuration requires a fresh preview.

The converter preserves supported object IDs/revisions, all supported pressure
samples, text baselines/spacing, connector routes and original raster bytes.
Unsupported or over-limit content is refused with its source snapshot intact.
Imported ink retains the legacy linear pressure curve; the native renderer now
also matches the portable soft curve for new ink. The shared editing protocol
retains this property through native edits and file export.

The targeted contracts cover actual SQLite export/import through
the CLI, source tampering, mid-import permission revocation, occupied paths,
altered retained records, source isolation, exact image bytes and interrupted
backup/header/completion publication. Repeating after later human edits keeps
those edits. Actual Git checks confirm that private working scenes, migration
records and old handoff directories are excluded from ordinary staging.
An additional regression restores and deletes valid inherited JavaScript names
such as `valueOf`, then checks that a different restorer cannot replace the
original author. Dictionary lookups now use own entries for these IDs.

The 40-check notebook browser run initially reports **36/40**: the new pressure
pixel assertion expected black while the fixture used the normal dark-gray
brush. The corrected darkness/width assertion passes in all four browsers.
A separate four-browser scenario opens a recovered notebook from the existing
folder chooser, draws new human ink and verifies that original ink, provenance,
tombstones and unaccepted state remain intact. Inspecting that mobile canvas
reveals small white holes where stroke bodies overlap their end caps. Matching
the path winding fixes those holes; browser pixel checks now cover both ends.

Two actual native instrumentation checks pass on the dedicated emulator:
retained presentation/pressure and progressive ink. The rendered bitmap is
inspected. The rebuilt preview APK has SHA-256
`ad2ae0c34727ad4f55e5344d93ef186f30c853dbf6725606e99281fa828f7ffa`,
a verified v2 signature and eight exact shared assets. The subsequent identity
fix rebuild also verifies those properties at APK SHA-256
`55dde71ed0c0b18c14952e519a2020415f60c526576bc2fbf7e311c86b3b9623`.
That APK is installed over the dedicated preview without clearing its data;
both native instrumentation checks pass again.
These are emulator and
browser proofs; physical pen/microphone behavior and personal migration remain
unverified. The complete local regression at `6bc128f` reports **82/83** test
processes passing. The only failure occurs when the stalled-push rejection test
times out during its preceding Git fetch while other Shared suites run. The
same exact test passes in isolation with its unchanged one-second limit. The
runner now isolates that timing contract, as it already does the acceptance
performance contract. No product timeout or assertion is relaxed.

## Retained Android recordings and earlier drafts

The snapshot CLI accepts an explicit Android dictation directory and writes a
version-2 inventory containing the original PCM bytes and their hashes. Readers
still accept version-1 database snapshots. Recording files must be independent,
bounded original PCM files and remain unchanged throughout the read. Format
metadata retains 16 kHz, mono, signed little-endian samples. Export does not read
authentication preferences, open a microphone, recognize speech or send text.

Four recording contracts pass using synthetic PCM and actual SQLite/CLI
execution: preview/apply/repeat, exact multi-buffer bytes, unchanged original
database, modified backup refusal, stale source, symlinks, odd/oversized data,
unknown filenames and a recording modified during reading. Earlier pending
draft recovery also retains exact UTF-16 text and large clock strings without
inventing an epoch or delivery acknowledgement. Conflicting seeds, malformed
clocks, missing identity and damaged newer journals remain explicit conflicts.
The eight recovery-reader contracts pass. These retained files and texts still
need context mapping and pending-operation reconciliation before writer cutover.
The combined recovery, real CLI and argument regression passes **39/39**.
Doctor, package privacy and package dry-run pass for this follow-up. Its full
regression remains pending.

The complete isolated regression at `0a0e997` then passes **85/85** test
processes, including both isolated timing contracts. The full hosted CI and
both convergence workflows at `6bc128f` pass, including Node 20, 22.23.0 and
24, all four browser jobs and soak.

## Recovery source inventory

The read-only inventory now lists source projects, boards, drafts, conversation
records, pending operations and unassigned recordings. Bounded pages use a
cursor tied to the completed snapshot revision and selected kind. Exact record
selectors change when retained content changes; full draft and queued-message
text is not printed. Large SQLite operation sequence numbers remain exact.

Eleven focused import, recording and inventory tests pass. They include actual
SQLite snapshots and the CLI without project registration, complete pagination,
free-board identity, changed source/selection refusal and read-only apply refusal.
Inventory is preparation for pending-work reconciliation, not a delivery receipt
or automatic context assignment.
The combined recovery, import, inventory and CLI-argument regression passes
**40/40**; Doctor and package privacy also pass.

## Canonical Mac text draft recovery

Selected versioned Mac drafts now retain their original text, source record,
snapshot revision and accepted base before creating an editing proposal through
the existing Local engine. Its ordinary document and accepted version remain
unchanged. An interrupted initial write or lost acknowledgement resumes the
same proposal; later human edits and later submission are preserved. An unchanged
record in a later full snapshot reuses the original preparation rather than
capturing a newer accepted base.

The initial ten draft/proposal tests found two incorrect expectations of the
existing submitted status; both were corrected to the engine's `submitted`
contract. Thirty focused recovery/proposal/CLI checks then pass. After adding
the integrated draft editor, 21 core checks and the six draft import/owner HTTP
checks pass. The HTTP checks cover owner nonce, origin, exact project, stale
save/submission, missing revision and separation from human acceptance.

The first browser pass found the global textarea rule hiding the working text;
the scoped display rule is corrected. Subsequent browser validation found a
missing working-draft field in the Hub's compact projection after reload.
All full/catalog/paginated projections now retain the separate working-draft
inventory. The queue explicitly distinguishes unaccepted working drafts from
submitted review work. A real HTTP regression covers all three projections.

The final focused core/CLI regression passes **34/34**. Exact working file modes
also survive a restrictive process umask: the previous temporary writer used
the masked mode, and now applies the requested mode before syncing. The owner
HTTP fixture uses isolated registries throughout startup and shutdown. Its
initial temporary registration in the default Hub was removed through the
registry API, with other project entries verified unchanged.

The recovered Markdown and HTML browser flows pass **8/8** across Chromium
desktop/mobile, Firefox and WebKit. They exercise saved-draft reopening,
explicit submission, separate human acceptance and retained original source
bytes. Markdown editing and review correction preserve UTF-8 BOM and CRLF;
opening a textarea no longer falsely marks that text changed. HTML remains a
sandboxed rendering without a source editor. Mobile and desktop screenshots
were inspected. Owner-dialog accessibility checks pass; HTML uses the analyzer's
single-page mode and excludes the original document iframe after WebKit twice
stalled while creating the analyzer's auxiliary page. The iframe's actual
heading rendering remains separately checked.
The existing correction/HTML rejection/drawing review scenario also passes
**4/4** across the browser configurations. Doctor, package privacy, package
dry-run and the layout CSS audit pass.

Android build and artifact verification pass. The unchanged packaged preview
remains SHA-256 `55dde71ed0c0b18c14952e519a2020415f60c526576bc2fbf7e311c86b3b9623`,
with its valid v2 signature and eight exact shared assets. The new draft
interface is served by the Mac owner runtime. This check does not add physical
device evidence. The complete local regression at `dfa78fb` passes **86/87**
test processes. Its sole failure was the stalled-fetch test's one-second
wall-clock bound under concurrent Git-heavy suites; the unchanged test passes
in isolation. The runner now isolates that check without relaxing its deadline.

The full hosted CI at `dfa78fb` passes (run `34930070069`), including Node
20, 22.23.0 and 24, all four browser jobs and soak. Both convergence workflows
also pass (`34930070098`, `34930067816`).

## Complete original-source history

Saved history now filters every retained conversation by its exact project,
source and notebook location before pagination. Reopening also filters the
captured selection before choosing the latest conversation. This removes the
earlier 500-file directory cutoff. A continuation is tied to that source and
list revision; a changed list requires explicit refresh. Paging and refresh
preserve the selected conversation and its unsent composer text and never
connect to a provider.

The nine store tests pass, including 624 retained conversations spanning two
projects, distinct selections, changed notebook locations and stale or malformed
continuations. The first browser regression exposed numeric parsing of the
notebook location hash. The corrected route retains its exact string identity.
All **20 conversation scenarios** then pass across Chromium desktop/mobile,
Firefox and WebKit. The pagination scenario reaches 71 matching conversations
among 572 retained records, keeps an older selected conversation outside the
first page and preserves text across a changed-list refusal and explicit refresh.
The mobile rendering was inspected. Owner HTTP/runtime checks, Doctor, layout,
package privacy and the package dry-run also pass.

The Android preview rebuild and artifact verification pass with unchanged
SHA-256 `55dde71ed0c0b18c14952e519a2020415f60c526576bc2fbf7e311c86b3b9623`.
This interface is served by the Mac runtime. Full regression and hosted results
for this history change remain pending.

## Open product gates

Data migration and final removal of the
external compatibility dependency remain implementation work. Native dictation,
original-recording recovery and recognition have the emulator checks above.
Real native agent
conversation, actions, interruption and playback have the separate check above.
The verified Android installation is an emulator preview. It does not establish
physical Wi-Fi behavior or BOOX pen/palm latency.

The latest complete hosted application matrix passes at `dfa78fb`; later
changes need their own regression and hosted result. Notebook-specific checks
do not stand in for that matrix. Installation/signature migration, physical BOOX testing and
personal-data migration have not been performed.
