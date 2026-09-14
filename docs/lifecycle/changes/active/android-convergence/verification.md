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
authenticated agent/audio behavior, a migration of personal data, or physical
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

## Open product gates

Context-bound real dictation/conversation/co-drawing, data migration and final
removal of the external compatibility dependency remain implementation work.
The verified Android installation is an emulator preview. It does not establish
physical Wi-Fi behavior or BOOX pen/palm latency.

The full application smoke/layout/accessibility/performance/soak release matrix
has not been rerun for this recovery milestone. Notebook-specific checks do not
stand in for it. Installation/signature migration, physical BOOX testing and
personal-data migration have not been performed.
