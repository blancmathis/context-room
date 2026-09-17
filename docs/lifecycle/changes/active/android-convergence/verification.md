# Android convergence verification

## Summary

This journal preserves checkpoint-specific macOS, browser, emulator and portable
proofs. Those historical successes do not validate later commits. The dated shared-web continuation below is the current execution boundary;
older consolidated matrices describe their own checkpoints.
It separates source packaging from a completed product or personal installation.

## Defines

Observed checkpoint restoration, notebook contract tests, browser scenarios,
regression results and the remaining implementation boundaries.

## Does not define

Human acceptance of personal documents or personal-device installation,
a migration of personal data, or physical
BOOX performance. A synthetic agent operation is not a real provider call.

## Shared-web continuation — 2026-09-17

Base main was checked through GitHub and `git ls-remote`:
`4560f6e056a6f673fe6d77f6f9d2914c00829c64`. Work uses a dedicated
`mathis/shared-web-pwa-20260917` branch in a new clone, not an old archive or the
personal installation. No historical request or real agent call is replayed.

The implementation switches both Android permissions to the existing common
web notebook, packages that same source for APK offline boot, adds the PWA
public-asset cache and exact recovery route, and provides a separate optional
browser HTTPS edge using the existing device authority. Legacy native journals
and their recovery engine remain retained. R01–R29 and human acceptance
boundaries are unchanged. See the canonical [connection contract](../../../../system/connected-devices.md)
and [local handoff](codex-shared-web-handoff.md).

### Local execution observed before CI

- Dependency installation completed from the lockfile.
- `test/devices.test.mjs` and `test/device_owner.test.mjs`: **19/19 passed**
  after the transport authorization extraction. Later common-display additions
  require their own checks; this is not a claim that an old run covers them.
- Initial `test/web_app.test.mjs` and `test/device_browser.test.mjs`: **6/7
  passed**. The remaining test supplied a deliberately wrong Host header that
  also changed Node's TLS server name; TLS correctly refused it before the
  intended HTTP assertion. The fixture was corrected to an alternate valid
  certificate name so the HTTP exact-host rejection can be tested separately.
  The failed run is not recorded as passing.
- The initial three public-asset/version/recovery-route tests subsequently
  passed in isolation. Later additions are not included in that count.
- `test/device_display.test.mjs`: **6/6 passed**, covering common-canvas-only
  receipts, pending ink, human cancellation, exact view targets, stale frames,
  paused/review-only sources and revocation. These are software simulations of
  display events, not physical pen measurements.
- The ordinary Playwright setup failed on its synthetic Shared Git fetch
  deadline before these PWA scenarios ran. The independent PWA configuration
  then reached test discovery, but its local process exceeded the execution
  limit without an assertion result during severe Mac load. Neither attempt
  proves browser rendering or offline restart. They were not repeatedly
  relaunched unchanged.
- The first standalone APK-asset preparation exceeded its local execution
  limit. This is not an APK build or an emulator result.

Repository CI results and final checks must be read at the delivered source
SHA; a queued job is not a pass. The browser suite contains a real persistent
Chromium process restart, received pen-pressure checks, same-identifier
resynchronization, a waiting-worker replacement and separate common tablet
layouts. Its synthetic worker replacement tests update lifecycle; the asset
contract separately checks the content-versioned module cohort.

### First PR CI checkpoint

For `08fc30c62c3f5c71684ca15070c0c2c4645d1117`, convergence run
`35248801871` completed with **122/122 contract tests**, package privacy
(**178 package files**) and both preview/instrumentation APK builds passing.
The preview has package `app.contextroom.tablet.preview`, signature v2, and only
Internet and microphone permissions. This first artifact checker checked the
eight legacy shared-engine assets; follow-up verification additionally compares
the complete packaged common web cohort to source. No emulator ran in that job.

CI run `35248801921` passed the Chromium mobile browser job and the shared
notebook layouts in Chromium desktop and WebKit. The Chromium cold-restart test
first inspected a progressive stroke prefix rather than waiting for the full
Mac receipt; it was corrected to wait for the same required pressure samples.
Firefox reported a 44-pixel target as 43.999996 pixels; the assertion now allows
only 0.001 pixel numerical rounding. These changes do not waive pressure or
44-pixel accessibility requirements. The initial runs remain recorded as failed.

The existing WebKit layout suite also failed when the expected human-acceptance
confirmation dialog did not appear. Its captured state shows the real server
refusing incomplete human review, while this geometry-only fixture intended to
intercept that response. The default mock-based browser configuration now blocks
service workers so `page.route` owns these synthetic requests; the independent
PWA configuration explicitly allows workers and verifies their real lifecycle.
This follows Playwright's network-interception boundary; no product permission
or human-review rule was relaxed. The corrected run, rather than this failed
checkpoint, is the relevant regression proof.

### Physical gates remain open

No new physical BOOX result, real-agent co-drawing, physical microphone test,
long session or equivalence with the BOOX application is claimed for this
shared-web change. Earlier native physical results do not validate the web
canvas. Browser-recognized HTTPS on the actual tablet, installation behavior,
pen latency, palm rejection, e-ink contrast/comfort and real audio remain in the
handoff. Any produced preview uses an isolated test key, not an assertion of
compatibility with an installed signing identity.

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
This interface is served by the Mac runtime. The full local regression at
`b77cc67` passes **88/88** test processes. Hosted run `34931262047` found a
separate Shared repository-claim race on Node 20; the other Node jobs were
cancelled by that failure. It is not a complete hosted pass.

## Stable Shared repository identity claims

Concurrent proposal creation exposed unnecessary replacement of a valid private
repository identity file on every refresh. A regression against unchanged
`b77cc67` confirms that its inode was replaced. Valid private claims now retain
their inode; the existing identity validation, hard-link refusal and private-mode
repair remain in place. The identity suite and exact concurrent-creation test
pass on the isolated corrected checkout. Hosted run `34933207082` then passes
Node 20, 22.23.0, 24 and Soak. Its WebKit workspace endurance check reports one
registration access-control page error; the following run passes all four
browser jobs. Neither run is a complete hosted pass.

## Retained legacy conversations and explicit continuation

The migration CLI now retains a selected canonical Mac conversation outside the
project and links it to a chosen document or working notebook. It preserves
original SQLite cells, task identity, per-message contexts, unknown events,
partial responses and unconfirmed Desktop requests. Import and viewing do not
start a provider. A later explicit message or Voice action creates a separate
scoped Context Room task with read-only access to the retained history; it does
not resume the old task or replay an old request. Desktop transcripts absent
from the snapshot remain absent, with their original identity retained.

The focused store, recovery, owner HTTP/runtime and CLI checks pass **26/26**.
They include exact int64/binary context, long-message paging, interrupted
archive/binding/provenance publication, changed preview refusal, later human
continuation retention, source revocation, foreign-project refusal, forged
browser import metadata and export revocation between one-MiB chunks. The CLI
links an actual working notebook without writing its ordinary file or accepting
it. A first CLI test read errors from stdout; it was corrected to the existing
stderr error contract.

The conversation/import browser matrix passes **24/24** across Chromium
desktop/mobile, Firefox and WebKit. A first pagination assertion expected a
finished, hidden button to remain in the accessibility tree; the corrected
assertion tracks that same control through hiding. The final expanded export
scenario passes **4/4**, including multiple byte-identical download chunks and
an explicitly synthetic native-save cancellation. Accessibility checks pass.
Mobile inspection led to grouping the retained records in a collapsible panel.
The final mobile rendering was inspected. These are browser checks, not native
or physical-device export proof.

Real local Codex reads the imported first message through its history tool,
reads the linked notebook and adds the requested rectangle and exact original
text as two canonical working objects. It creates one new task and never resumes
the recorded legacy identity. The original synthetic database and independent
document remain unchanged, and no ordinary notebook is written. The first check
reaches useful ink in 13,253 ms. After codec changes, the first rerun stopped
before provider startup because its assertion preceded history readiness; the
readiness condition was corrected. The final real-provider run passes in
14,189 ms with source-file hashes retained in its private proof. The drawing
latency objective remains open.

Doctor, package privacy, package dry-run, layout audit, Android rebuild and
artifact verification pass. The preview APK remains SHA-256
`55dde71ed0c0b18c14952e519a2020415f60c526576bc2fbf7e311c86b3b9623`, with its
v2 signature and eight exact shared assets. Full regression at `676ef9e` passes
89/90 processes. Local and hosted Node checks identify the same obsolete test
expectation: the migration argument error now includes conversations alongside
boards and drafts. The corrected structured-error assertion and all six draft
tests pass. A complete hosted result for this correction remains pending.

The native owner interface also reads and exports the retained conversation
through the real pinned transport and Android system file picker. The completed
instrumentation test and host-side byte check pass: the 1,103,362-byte original
history spans multiple transport chunks and retains its exact SHA-256. Reading
and exporting leave the current task, operation and messages empty; the ordinary
notebook is unchanged. The final emulator rendering was inspected. The first
attempt clicked the document's Save control before the picker appeared; the
test now waits for a visible, enabled control in Android DocumentsUI. This is
an emulator proof, not a physical BOOX result. The existing full native owner
workflow also passes with this helper, including image import and byte-identical
editable notebook export through the system picker.

The isolated full regression at `626c4d7` passes **90/90** test processes. Hosted
run `34935226099` also passes the complete Node 20/22.23.0/24, four-browser and
Soak matrix, together with both convergence checks.

## Retained Android text journals

The existing draft import now accepts an exact Android journal or earlier pending
record. It reconstructs the retained UTF-16 edits and preserves the selected raw
records, counters and pending correction backups before creating a Local editing
proposal. Unknown delivery stays explicit, and neither the original SQLite
database nor its operation queue is changed. A newer journal blocks fallback to
an older pending text. A divergent or unknown original base requires a separate
destination instead of replacing the current Mac document.

The final combined archive, Mac draft and Android draft regression passes
**20/20**. It covers binary deltas, version gaps, exact BOM/CRLF, partial journals,
earlier conflicting seeds, unfinished composition, interrupted completion,
preserved later human edits, changed snapshots and the actual CLI permissions.
The Android draft browser workflow passes **4/4** across Chromium desktop/mobile,
Firefox and WebKit, including editing, saving, reopening, explicit submission
and a separate human review correction. Accessibility checks pass and the
mobile rendering was inspected.

The real pinned owner transport on the isolated Android emulator also opens
the recovered draft from the Hub, saves a new edit on the Mac and reopens its
exact content after reload. Instrumentation and the host byte checks pass;
the source database and accepted notebook are unchanged, and the recovered
ordinary file remains absent. The first test attempted its second click in the
departing document; the corrected check waits for the new page before reopening.
The final native rendering was inspected. Both APK builds and artifact checks
pass with the unchanged preview hash above. Physical BOOX testing remains open.

The isolated full regression at `90f004f` passes **91/91** processes and both
convergence checks pass. Hosted Node, Chromium, Firefox and Soak checks pass;
the WebKit navigation smoke repeats the registration access-control error from
`b0a8387`. Its trace places a simulated-clock callback in the departing document
during browser Back. This scenario has no simulated-time assertion, so it now
uses the browser's own timers. The duration/Soak scenarios retain their explicit
clock controls. The unchanged local WebKit check passes three repetitions,
consistent with the intermittent hosted failure; the corrected real-timer
check passes **12/12** across all four configurations with three repetitions
each. Error guards and navigation assertions remain in place. At `e22b2a0`,
all three Node jobs and all four hosted browser configurations pass in run
`34939886132`; its Soak and final gate are still pending.

## Original Android identity and native recovery export

The explicit recovery build retains the original `fr.lisiere.android` package
and verifies the original signer and a higher version code. The ordinary
preview keeps its own identity, key and output. An original version-95 APK
seeded a synthetic real Android database with committed WAL larger than 2 MiB,
an int64 operation sequence, Float/Double arguments, a text draft, an unreadable
binary request and original PCM. It was upgraded to version 96; later recovery
revisions reused that exact retained fixture without resetting or downgrading it.

The final recovery APK is SHA-256
`7f3a18fa7256e39a50e0e241fbceb1824a253f9e7106f4b789335f30ac234847`.
Native export through the actual DocumentsUI picker passes. The Mac verifies
the complete ZIP inventory and hashes, original database/WAL/PCM preservation,
excluded-but-preserved authentication preferences, and exact original Android
JSON serialization of the large binary row. The unreadable request remains
explicit. The first Mac snapshot step exposed Android's `android_metadata`
table; the reader now retains that known locale table and the retained export
completes successfully. Unknown schema remains refused.

Four additional native archive contracts pass: completed-copy integrity,
future-version/unknown-recording refusal without replacing the saved receipt,
linked or occupied-file protection, bounded decoding and explicit malformed-row
retention. They exposed Android's clean PERSIST journal, which is now preserved
and checked on a disposable database copy. The platform itself refuses hard-link
creation in this emulator; the test retains that distinction. Activity recreation,
actual picker cancellation and reopening the exact prepared copy also pass.
The entry, exported state and cancelled-state renderings were inspected.

The focused SQLite, recording and Android-draft regression passes **12/12**,
including nine Python snapshot contracts. Both APK variants build and pass
signature/permission/shared-source verification. The ordinary preview APK is
SHA-256 `934f324c1e092be6e9bb4713b9f6545ef5d651033012de4ca3dcb592faa31cf6`.
Its existing owner workflow regression also passes: rendered documents, native
drawing, image import, exact file-picker export and synthetic human/Shared
review retain the accepted original. Doctor, package privacy and package
dry-run pass. This milestone's full hosted result remains a separate check.
No personal installation or migration is claimed.

## Open product gates

The final current coverage matrix at the end of this journal supersedes older
pending-work statements. Historical rows retain their original input commits.
The browser and Soak failures reported for early PR #42 checkpoints are no longer
open at remote base `b41e8945786cd5821e7adb45695fb6b271849336`: its complete CI and
convergence runs succeeded. Later recovery work has separate local evidence.

Physical BOOX trials, personal-device upgrades and personal migration have never
been established by an APK compilation. The portable coordinator's synthetic
cutover proof does not establish the macOS production service shutdown, and its
safe rollback pause is not a functional downgrade to an old uncertain writer.

## 2026-09-15 — post-merge native ZIP recovery checkpoint

The current public main was rechecked at `1a2cdcec1435d60cd8d07a3762a369e066508ce1`; work is isolated on `mathis/context-room-recovery-hardening-20260915`. Native ZIP v1 now converts through `migrate --export-lisiere` to snapshot v3, preserving native derivatives, int64 cells and PCM. No queue delivery or document acceptance is inferred. The canonical format and remaining receipt boundary are described in `docs/system/lisiere-migration.md`.

Targeted evidence (Node 26.3.1, Python 3.14.6, `umask 022`): 18 synthetic native-ZIP Python contracts passed, including WAL/hot rollback recovery and a real SIGKILL during publication; all 9 existing directory-snapshot Python contracts passed; the 2 new Node library/security tests passed. The old interruption fixture now interrupts `_publish_snapshot_file` rather than removed hard-link publication; its interruption, exact resumption, hashes and newer-byte preservation assertions are unchanged.

The installed CLI test and full suite are not validated by this checkpoint. An interrupted dependency installation left `yaml/index.js` absent; the resulting module-load errors are not classified as product or umask failures. The separately runnable local-proposal and initial-proposal baseline had 17 passing tests under `umask 022`. Android source is unchanged; no new APK, emulator execution, real-provider timing or BOOX evidence is claimed here.

## 2026-09-15 — post-merge native runtime delivery

Public base: `1a2cdcec1435d60cd8d07a3762a369e066508ce1`.
Code and test checkpoint: `98c437035970344e9b44d6e857d81bafd0dbcc2e` on
`mathis/context-room-recovery-hardening-20260915`, PR #42. Subsequent delivery
metadata does not retroactively change the input commit of an older proof.

### Completed code and bounded proofs

- Native Android ZIP ingestion: `7af7f0c1271cdc081eaa64e80e0e727ba9cec284`.
  Eighteen Python ZIP contracts, nine existing directory-snapshot contracts,
  the Node reader/inventory and installed ZIP CLI pass in the first checkpoint's
  CI Node matrix. Native v1 containers produce snapshot v3; directory v1/v2
  compatibility remains. The exact retained Android argument string is not
  reserialized through JavaScript numbers. Typed Float/Double agreement is not
  a unique wire-canonicalization or Mac-delivery proof.
- Exact reviewed permissions: `21f2ed06039199e555c524600906611453969df0`.
  Before the fix, an explicit reviewed `0644` became `0600`, and `0755` became
  `0700`, under `umask 077`. The new descriptor is now explicitly chmod'ed to the
  reviewed mode. Four regression contracts include two successive proposals for
  each mode and a concurrent permission-only origin change that must still fail.
- Native drawing and original transfer recovery:
  `9f7452945ae41b5bd2c4186857a9cb47ccebaf6a`.
  The compatibility connector uses actual native notebook creation, mutation,
  frozen SVG/PNG review and explicit old-frame recovery, not a stub, replayed
  agent or external companion. Eight module contracts cover scope/occupancy,
  current edits, exact original source, unknown assets/revisions, deletion
  tombstones, retained frames, interruption and bounded raster cropping.
- Optional local audio diagnostics: the same native-runtime commit plus
  `8b6f0e7adf785ebd6dd99b39263cb1834ed05298` for scoped CLI output.
  Executable and readable nonempty regular model checks replace model-path-only
  native readiness. Four diagnostics contracts and seven existing audio
  contracts pass. Nothing is installed, downloaded, played or sent to a provider.
- The combined seven-file targeted Node run passed **40/40** with `umask 022`,
  Node 26.3.1 and Python 3.14.6. It does not include the newly added installed
  CLI contracts or browser PNG-review scenario; those require the delivery CI.
  Syntax and whitespace checks passed. Initial new-fixture errors (an assumed
  uncropped SVG margin and a noncanonical macOS temporary path) were corrected;
  production bounds and canonical-path requirements were not weakened.

First-checkpoint CI: run **34949046038**, head `7af7f0c…`, tested PR merge commit
`8edca1386c709f5771c330b5f93237ef44482a65`. Node 20, 22.23 and 24 passed, including
Node 22 package checks; Chromium desktop/mobile, Firefox and WebKit passed the
browser jobs. The Soak job **failed**: its multi-day navigation test passed, but
`ux-endurance.spec.mjs:1142` failed at the second-window `openProjectFile` call
(line 1219), with “Expand notes in Explorer”, expected `true`, observed `missing`.
Artifact `playwright-soak-34949046038-1` retains the failure evidence. Its analysis
is not complete; the test has not been removed, relaxed or classified as flaky.

The historical Chromium slow-activation test passed in this first-checkpoint
run without a browser-product change. That is not proof that the historical
failure is fixed. The original full macOS failure set was not reproduced in a
complete dependency installation: missing `yaml/index.js` stopped those imports.
Only the separately runnable local proposal baseline passed 17/17 under the
prescribed mask. No conclusion attributes every original failure to umask.

## 2026-09-15 — historical consolidated delivery 56aa6c7

### Exact identity and evidence boundary

This section records the historical 56aa6c7 delivery. The current two-topic
continuation and matrix follow below; these older results keep their own inputs. The one delivery HEAD is recorded in the ZIP's
`livraison/SOURCE_COMMIT` and `livraison/DELIVERY.json`, the ZIP Git comment, and
the bundle's single branch reference. The distribution copy of this section has
the full HEAD in its heading. Source files are exact Git bytes, without export
substitution; the versioned document does not embed its own commit hash.

Remote baseline remains `b41e8945786cd5821e7adb45695fb6b271849336` on
`mathis/context-room-recovery-hardening-20260915`, PR 42 open/draft, not merged.
The last retained original local commit is
`f6cee69d0f698f3db279ec0d7c610cbc38bae8c6`. The original local commit object
`36e8180ea03ab640fc8ba489bcfe72259613aeef` was missing from its incremental bundle.
Its two supplied files were recovered byte-for-byte in
`170918d44a40517324a264477fe6c6523a05d7cd`; this is **not** a claim to have recovered
the original commit metadata or original SHA. The closing commit changes only
documents. No manual source-file supplement is required after bundle restoration.
The incremental bundle requires public b41; no other refs or private Git history
are included.

### Results actually available

Evidence labels are shared with `RELAIS-CODEX-LOCAL.md`:

| Evidence | Source input | Terminal / limit |
| --- | --- | --- |
| E01 | Public b41; CI 34966764884 / convergence 34966764731 | Historical success: three Node jobs, four browsers, Soak/gate and Android build. No attribution to subsequent commits. |
| E02 | Campaign attributed to 0b932ab by the retained relay | Preserved npm log ends at **101/102 test processes**, overall failure. Shared shard: 40/41, missing ssh-keygen before security assertions. The log itself does not embed a HEAD. |
| E03 | Unchanged b41 prerequisite control | Preserved single-case log: **0/1**, same missing-OpenSSH error. Not skipped or simulated. |
| E04 | Mac CLI fix 22b998d, per retained relay | Preserved focused log: **4/4**, including actual kit preview/apply/verify/repeat. Not a new full suite. |
| E05 | Retained Shared 36e8180 file inputs | Preserved negative control **0/2** and corrected **2/2**; delivered source/test hashes match those supplied files. Not rerun during packaging. |
| E06 | Previously launched `umask 022; CI=1 npm test` at 36e8180 | No terminal recovered. Restored environment has no active test process or corresponding final log. No restart; no inferred full total or success from intermediate observations. |
| E07 | Prior relay's browser / Gradle attempt | Administrator block before UI; missing Gradle 8.11.1 cache and DNS failure before compilation. Raw logs not retained here; failures reported, not reproduced or bypassed. |
| E08 | Present source consolidation | Object/file equality, Git restoration, artifact inventories/hashes and package checks are recorded in the delivery receipts. These checks are not a new business-test campaign. |

E02 did not cover the later Shared guards. E04 verifies the later Mac-script
change; E05 verifies only its two new Shared scenarios. This is composed, partial
evidence with a known failing process and a missing later terminal, **not a green
full suite on the delivered HEAD**. Assertions, performance goals, review
controls and the original test runner were not reduced. No OpenSSH, browser,
Gradle or full-suite attempt was made during consolidation.

The current Shared guard checks enrolled writer authority during creation/reuse,
notebook publication and immediately before push; repository-scoped publication
also respects the proposal's original project. A pause keeps a prepared commit
local, preserves later bytes and produces no remote success receipt. The
recovered code is in `src/shared_context.mjs`; its two tests are in
`test/shared_writer_authority.test.mjs`. No further functional change was added.

### Original-scope gaps versus local checks and extra capabilities

The full progressive legacy pen-job receipt reconciler is still absent (C/V14).
The requested application-controlled true-agent latency work has not delivered
a measured improvement over 13.402/14.189 seconds toward ten seconds (F/V17).
Mac delivery provides a verified source-kit generator, inert plist and local
procedure, not a demonstrated installed/activated product (E/C01/V02).

Code already exists for ordinary queue reconciliation, tablet-cache choice,
retained transfers, private PCM associations, standard-service cutover and safe
pause/resume. The missing browser PCM, Darwin/launchctl, clean Mac installation,
current Android instrumentation, authenticated-provider and BOOX tests are listed
separately in the relay. **Physical BOOX validation remains original scope.**

The rollback pauses enrolled writes without restoring older bytes or replaying
old requests; it does not reactivate Lisière. A fully automatic bidirectional
legacy downgrade, universal custom-installation support, repair of unknown or
replaced fences, and a generic unattended updater were not explicitly required
and are not silently added as new acceptance criteria. These boundaries do not
prove that the specified standard migration is complete. A tablet without the
connected Mac, separate Inbox, hosted service, Office editor and paid speech
fallback are outside or contrary to the original request. No such expansion was
introduced. See relay §7 for the precise separation.

### Historical coverage matrix at 56aa6c7

This is the archived 56-row matrix for 56aa6c7, not the current status. “Preserved” records code/invariant
review and only the evidence attributed above. It is not current-head or physical
validation. E08 is packaging proof; E01–E05 remain tied to their actual inputs.
A successful subset never closes a broader criterion.

#### C01–C08 — product outcome

| ID | State | Evidence | Limit / remaining work |
| --- | --- | --- | --- |
| C01 | Partial delivery | Native connector, deterministic CLI, Mac kit generator and standard-service cutover exist. E02/E04 cover portable subsets. | Only kit/plist preparation is delivered. Installed Mac activation and clean-install behavior remain unverified; an automatic updater is not an added acceptance requirement. |
| C02 | Implemented; scoped proof | Editable notebooks, queue projection and explicit tablet-cache copies retain working state and provenance (E02). | Full progressive legacy pen-job receipt reconciliation is absent; no new real-provider trial. |
| C03 | Implemented; UI untested | Explicit source/conversation PCM links, exact bytes, authorization and no automatic send/playback have CLI/HTTP evidence at 0b932ab (E02). | Current browser and owner-WebView recording flow not executed (E07). |
| C04 | Preserved | Baseline complementary mode, per-object revisions, display receipts and independent views are unchanged. | No new simultaneous physical Mac/BOOX session. |
| C05 | Inherited plus prepared | Owner transport and human review preserved; new OwnerRecordingTest and fixture are present. | A prepared native test is not a passed test; current instrumentation has not compiled or run. |
| C06 | Baseline build only | The b41 baseline APK was built and its eight production assets match the delivery files. | No current instrumentation build or APK execution; Gradle failure was before compilation (E07). |
| C07 | Preserved | Recovery uses explicit ordinary project paths and the existing conversation panel. | No Inbox, alternate catalog or separate ideas application introduced. |
| C08 | Partial | Recovery copies, private retirement, journal replay and recent-work preservation have synthetic evidence; Shared pause guard adds E05. | Full migration/replacement not established. Progressive job reconciliation is missing; physical acceptance remains in scope. |

#### R01–R29 — grooming preservation

| ID | State | Evidence | Limit / remaining work |
| --- | --- | --- | --- |
| R01 | Preserved | Local canonical service remains; no hosted or paid fallback added. | Production macOS service shutdown/activation still needs verification. |
| R02 | Preserved; scoped evidence | b41 browser/Soak result E01; Hub/report process success in 0b932ab campaign E02. | No terminal complete campaign for the later code and no current-head browser execution. |
| R03 | Preserved | Root identity, source revision, exact worktree/path and explicit destination remain bound. | No automatic project/worktree destination guessing. |
| R04 | Preserved | Existing Projects/Computer and device scopes retained; migration paths use canonical files and scope predicates. | No new general remote filesystem grant. |
| R05 | Preserved | No Hub reset, catalog or shell button; synthetic cutover asserts configuration bytes unchanged. | Not proof for every customized personal Hub. |
| R06 | Preserved | Writer/audio doctor diagnostics are deterministic; paused doctor is read-only and remains usable. | Optional dependency status is not document acceptance or inference. |
| R07 | Preserved | Queue/cache imports create only working headers; ordinary files and accepted corpus remain unchanged. | New browser flows require execution in an authorized browser environment. |
| R08 | Preserved | No agent accept/reject or migration authorization tool was introduced. | Only synthetic human-review contracts were executed. |
| R09 | Preserved | Existing exact frozen correction and independent terminal decision routes remain. | Browser drawing/review success is verified at b41, not the new UI input. |
| R10 | Preserved | Imports reuse importNotebookDraft; later submission uses existing Local/Shared engines. | No alternative tablet proposal engine. |
| R11 | Extended; targeted proof | Shared exact revision/terminal assertions retained; writer authority now guards create/reuse and pre-push, including original project scope (E05: 2/2). | E02 Shared security case failed for missing ssh-keygen. Later full-suite terminal is unavailable (E06). |
| R12 | Preserved | Reconciliation/PCM working imports need no Git repository at the project destination. | Git remains necessary for Shared, not Local working scenes. |
| R13 | Preserved | Direct-change and integrity tests retained; new imports do not overwrite ordinary files. | No new physical sleep/restart evidence. |
| R14 | Extended | Exact undo preconditions and safe rollback pause preserve newer working files; E02/E05 are scoped evidence. | Rollback means pause/resume, not restoring the legacy writer or a bidirectional format migration. |
| R15 | Preserved | No age-based discard or cleanup of original history/PCM was added. | Retention does not mean every unknown source is automatically interpretable. |
| R16 | Preserved | Normal migration CLI and deterministic helpers remain harness-independent. | A real agent is still required only for explicit generative collaboration. |
| R17 | Preserved | Accepted-search and provenance owners were not replaced; targeted recovery summaries avoid full text. | No broader search-completeness claim. |
| R18 | Preserved | Snapshot/config/root revisions bind previews; ordinary Shared freshness assertions are unchanged. | No receipt is manufactured from an ID or similar content. |
| R19 | Preserved | Old queues remain unchanged and unacknowledged; native offline code unchanged. | Physical Wi-Fi interruptions are not exercised by SQLite tests. |
| R20 | Preserved | Per-project skills and original owner authority remain effective. | A synthetic attempt to reduce startupSkills scope was detected, not bypassed. |
| R21 | Preserved | No front matter or corpus reorganization imposed; explicit .crnb recovery destinations only. | Recovery metadata remains outside ordinary documentation. |
| R22 | Extended | Queue/tablet copies are editable; PCM can be read as exact bytes or a lossless WAV envelope. | No Office editor; missing raster assets refuse conversion. |
| R23 | Preserved | HTML still renders without a human code editor. | No new HTML browser test result beyond the baseline. |
| R24 | Extended | Local-only cached ink can become a separate structured working copy with explicit revision mapping. | Imported revision is not presented as an original Mac receipt. |
| R25 | Preserved | Native connector replaces external runtime; recovery reads retained formats without launching Lisière. | Cutover helper can stop the recognized original service only on explicitly authorized apply. |
| R26 | Preserved | No automatic researcher/subagent, paid transcription or model download; linking does not invoke inference. | Real-provider timing/acoustic quality remain unmeasured. |
| R27 | Preserved | No hosted-hub/review/remote profile restored; personal-device service stays opt-in. | Kit LaunchAgent does not implicitly expose a device listener. |
| R28 | Extended; partial | Original bytes, mappings, private retirement, recorded phases and Shared pre-push pause guard preserve recent work/configuration. | Standard-layout Darwin behavior still untested. Unknown/custom or replaced fences fail closed, not automatically repaired. |
| R29 | Delivery consolidated | Same local branch, source ZIP and incremental bundle bound to one HEAD; supplied Shared files integrated byte-for-byte. | Remote PR remains at b41. Original 36e8180 object was not retained; restored code has a new commit identity. No push or merge. |

#### V01–V19 — acceptance evidence

| ID | State | Evidence | Limit / remaining work |
| --- | --- | --- | --- |
| V01 | Scoped audit | All 29 grooming rows retained and reviewed; delivery changes only documentation after exact Shared reassembly. | Static review and historical contracts are not current-head UI or native validation. |
| V02 | Partial; preparation not installation | Kit source integrity and default CLI path E04; historical synthetic doctor statement is attributed in the relay. | Operational clean Mac install/activation/reboot and one coherent running service are not demonstrated. |
| V03 | Inherited only | Device/owner/notebook production inputs preserved; eight baseline embedded assets match. | No new simultaneous Mac/Android drawing and rendered-receipt execution. |
| V04 | Inherited plus unexecuted test | b41 complete drawing/review/PNG scenarios E01; PCM owner instrumentation prepared. | No new end-to-end owner PCM scenario execution. |
| V05 | Partial synthetic proof | Snapshot publication, journalled cutover, repeated import/PCM apply and lost-response cases have earlier scoped tests E02. | Does not establish current native closure/network interruption behavior. |
| V06 | Extended; partial | Digest/result/history mismatches, successor conflicts, stale undo, queue duplicates and explicit cache selection covered at 0b932ab. | Private progressive pen-job reconciliation absent; arbitrary unknown jobs are retained, not acknowledged. |
| V07 | Inherited; performance work open | Prior notebook agent/undo/stop contracts retained; no replay claimed as generation. | No delivered, measured application-side fix for the true-agent first-useful-result delay in this continuation. Authenticated trials remain to perform. |
| V08 | Scoped proof | Working imports do not write ordinary accepted files (E02); b41 frozen review excludes later gestures (E01). | New recording UI and full final source still lack a complete execution record. |
| V09 | Extended; partial proof | Local/Shared exact assertions retained; E05 verifies pause refusal and locally retained prepared commits without push. | E02 is globally failing; E03 reproduces OpenSSH prerequisite failure at b41; E06 terminal not recovered. |
| V10 | Extended; UI/native untested | PCM storage, CLI, HTTP, hashes and source control have E02 evidence without provider creation. | No new browser/Android PCM, real microphone/acoustic playback or provider trial. |
| V11 | Preserved | Existing rendered formats/HTML and notebook asset-resolution tests retained. | No invented Office/PDF editing expansion. |
| V12 | Scoped historical proof | Accepted-only corpus, reader integrity and Shared cache processes passed in E02 at 0b932ab. | Do not relabel those successes as a complete suite at the delivery HEAD; physical offline behavior not rerun. |
| V13 | Extended; bounded | Origin/nonce/scope/path/source guards retained; writer pause/pre-push behavior has E05. | Operational enrolled-writer boundary is not protection against a local administrator deliberately starting a different writer. |
| V14 | Partial | Synthetic queue/cache/PCM recovery, retirement, recorded-phase recovery and pause preserving newer data have E02/E05. | Progressive jobs unsupported; full standard-installation Mac migration not tested. Functional downgrade is not claimed and was not an explicit bidirectional-migration requirement. |
| V15 | Inherited plus unexecuted instrumentation | Production identity/signature/client compatibility preserved; dedicated-emulator guard and new recording class retained. | No current instrumentation compilation or signed upgrade/interruption execution. |
| V16 | Inherited plus untested UI | b41 layout/smoke/accessibility E01; new recording screenshot/axe scenario exists. | Administrator browser block E07; no new captures or Android ergonomic proof. |
| V17 | Target open | b41 Soak/performance historical success; existing performance assertions retained. | 13.402/14.189-second true-agent reference exceeds ten seconds; no new measured application improvement. BOOX ink/voice/memory remain untested. |
| V18 | Not tested — initial scope | No physical result claimed. | BOOX pressure, palm, latency, ghosting, microphone/speaker, interruption, Wi-Fi/sleep and comfort are required local tests, not out-of-scope extensions. |
| V19 | Packaging finalized; validation partial | ZIP/bundle share one verified HEAD and exact source tree; inventory/hashes/privacy/restore in E08. E02/E04/E05 retain their distinct inputs. | Incremental bundle requires b41. No final full-suite terminal, current native instrumentation build or current-head remote CI. No release. |


## 2026-09-15 — current progressive recovery and first-result delivery

This is the current state, based on exact delivery
`56aa6c78262dc338dfcd6b44826a9416a722617e`, without widening its two requested topics.
The delivery HEAD/tree are in SOURCE_COMMIT / DELIVERY.json and the bundle ref;
this versioned document does not pretend to contain its own future commit hash.
The relay owns restoration and remaining local command details.

Software commits: `cf8ca7b2eb3705b02d545ea7367c4fa5abed1b58` (progressive evidence),
`c8c82e8267faaa7bc35480d957cee081d6dc5336` (latency), `934e8ff1420d771b2d8c1f6fd0d84556d993ef7d` (preserved synchronous
authorization), `b936be5d7d69896aecfb2478735e1b5de7f0ca4e` (bounded compact-path comparison). Closure changes only documents after the relevant tests.

| Evidence | Exact input | Terminal / scope |
| --- | --- | --- |
| P01 | Progressive helper and actual SQLite/export/import tests, included in F01 | 17/17 Python, 3/3 Node including that Python runner. No old provider execution. |
| P02 | Compact paths and final progressive recovery at b936be5d7d69896aecfb2478735e1b5de7f0ca4e, included in F02 | 19/19 Python and 3/3 Node tests (including that Python runner); no legacy provider call; no reconstructed/imported tail. |
| L01 | Provider shutdown correction, targeted transport/latency/provider tests | 24/24. Earlier immediate-termination trial 22/24 preserved; same natural-exit assertions pass after one EOF event-loop opportunity. |
| F01 | 35-file scoped regression at c8c82e8; masks/commands/hashes in receipt | 182/183 tests, exit 1; one failure retained; recorded synchronous-scope regression, not waived. |
| F02 | Same affected assertions and final paths at b936be5d7d69896aecfb2478735e1b5de7f0ca4e | 68/68 tests across 12 files, exit 0; no skips or weakened assertions; only affected session/source/HTTP dependencies rerun, not an unchanged general campaign. |
| D01 | Software file hashes preserved through documentation-only closure | Syntax/package/privacy, source inventory and isolated bundle/ZIP equality recorded in delivery receipts. |

E01–E07 above remain historical and keep their own inputs. In particular, green
b41 CI does not validate these commits; old 101/102 npm result stays failing and
36e8180's old terminal stays missing. No OpenSSH/browser/Gradle/provider retry here.
F01/F02 form explicitly scoped evidence, not a new full npm test or remote CI.

Recovered jobs are never resumed. Frame transaction evidence is distinguished from
the separately saved descriptor, including one-frame lag and failed attempts.
Canonical newer objects/tombstones and exact grouped undo preconditions are retained.
Font-dependent compact layouts without original normalized plans remain missing evidence; absent
intermediate frame geometry is not recreated. A coherent saved prefix without the
original request can be imported as working data, not proof of full completion.

The unnecessary second restricted process, inactive-probe grace, initial 250 ms
text coalescing and history-catalogue send gate are removed under their documented
conditions. Stage timing separates application/provider boundaries and local tool
work; it cannot measure pure inference or client painting. No new real-provider
latency is claimed. Clean Mac installation, operational Darwin migration, PCM UI,
Android instrumentation and physical BOOX remain initial acceptance work. A
bidirectional legacy downgrade and universal custom-installation repair are not
added as new requirements. The current matrix follows; subsets do not close a row.

### Local continuation checkpoint — 2026-09-16

The downloaded source at `1901566439617acc0429ac6687dd74d85f3b26f1` matched
all 370 Git blobs in the ZIP. The bundle prerequisite and CRC checks passed.
Receipts, captures, recordings and private migration data stay outside Git.
These local observations supersede the earlier unexecuted Mac/native statements.

| Proof | Observed result | Boundary |
| --- | --- | --- |
| M01 | macOS archive/snapshot/cutover: 20 targeted tests passed after distinguishing open files from incomplete visibility and allowing the real `sha256` column. | Native process-visibility refusals remain enforced. Hosted Linux uses a private PID namespace as the ordinary runner user. |
| M02 | PCM playback/export: four browser profiles and owner Android passed after appending the missing disclosure summary. | Exact PCM bytes, no autoplay/send and original files unchanged; synthetic recovery fixtures. |
| M03 | Signed APK rebuilt, signature V2 and eight embedded assets checked. SHA-256 `934f324c1e092be6e9bb4713b9f6545ef5d651033012de4ca3dcb592faa31cf6`. Owner, drawing, import/export and review instrumentation passed. | Production APK bytes are unchanged; changed instrumentation is separate. No physical BOOX claim. |
| M04 | Real Codex browser and native calls passed, including progressive ink, stop/redirection, human-ink preservation and source-bound document proposal. Native proof records clean `d14e64d`. | First useful result: 12,394 ms native, 14,048 ms browser, 21,247 ms detailed verifier. These are different scenarios, not a benchmark distribution. Ten-second target remains unmet. |
| M05 | Actual local Whisper dictation returned the expected text in 2,038 ms. Real Codex answer, macOS synthesis, Web Audio receipt and continuous Voice resume/end passed. | Synthetic microphone input and muted output; no physical acoustic proof. The historical Voice verifier hardcoded `dirty: true`; it now measures Git state. |
| M06 | Native PCM capture/playback, permission dialog, simultaneous voice/pen, original conversation retention, background stop and recording recovery passed. | Permission tests now target PermissionController explicitly while file-picker tests remain restricted to DocumentsUI. |
| M07 | Private kit and production installation verified at `eadc14c`: activation, service restart, HTTP readback, zero-issue recovery-project doctor, retained notebooks/history and actual Codex catalogue. Independent Whisper model and TLS listener verified. | Machine reboot and physical BOOX pairing are not tested. Private installed-file digests and service receipts remain local; later source revisions require their own installation check. |
| M08 | Selected original notebooks and conversation records recovered; a pending legacy proposal retained as an editing copy. Original bytes and historical identities preserved, no acceptance or old-task replay. | Physical device cache/outbox/recordings and final single-writer retirement remain open. No private data is published as evidence. |
| M09 | Direct Voice panel regression fixed and original desktop/mobile checks both passed. | Full CI is required on the final PR head. Prior green browser/convergence jobs are checkpoint evidence only. |
| M10 | WebKit caught 4.43:1 contrast in small Shared-skills step text. The stronger theme text token passes the unchanged responsive accessibility scenario in all four profiles (4/4). | Prior successes did not establish sufficient contrast margin. No accessibility rule or budget was removed. |

The full local suite passed 105/105 processes; its run started before the scoped
corrections, which have separate passing checks. Final hosted CI is a separate
gate; consult [PR 42](https://github.com/blancmathis/context-room/pull/42) at its
exact head, not an earlier green run. A previous Soak file-open measurement
exceeded its unchanged two-second budget (2.843 s); the next run at `eadc14c`
passed. This does not erase the earlier timing failure or guarantee every host.
The CI process namespace does not change
test assertions, time budgets, production code, user authority or process checks.

### Current coverage — 56 initial criteria

#### C01–C08 — product outcome

| ID | State | Evidence | Limit / remaining work |
| --- | --- | --- | --- |
| C01 | Installed Mac checkpoint verified | M07 verifies the kit, production service and recovered-source UI. | Reboot and physical acceptance remain open; later installed versions need their own receipt. |
| C02 | Implemented; real-provider proof | P01/P02/F01/F02 plus M04 native progressive ink, stop/redirection and human-ink preservation. | Unavailable historical tails are not regenerated; physical BOOX remains open. |
| C03 | Browser and emulator verified | M02 checks PCM selection/playback/export in four browser profiles and Android owner. | Actual BOOX recordings and acoustics remain open. |
| C04 | Emulator and real-provider verified | M03/M04/M06 retain independent views, source identity and native writing during Voice. | Simultaneous physical Mac/BOOX session remains open. |
| C05 | Owner emulator verified | M02/M03 exercise actual owner UI, file picker, review and recovery. | Physical ergonomics and network/sleep require the BOOX. |
| C06 | APK built and checked | M03 signed artifact and executed instrumentation. | Installation on the physical BOOX remains open. |
| C07 | Preserved | Recovery uses explicit ordinary project paths and the existing conversation panel. | No Inbox, alternate catalog or separate ideas application introduced. |
| C08 | Selected recovery performed | M08 preserves original notebooks, history and the pending proposal without acceptance. | Device-only queues/PCM and single-writer retirement remain open. |

#### R01–R29 — grooming preservation

| ID | State | Evidence | Limit / remaining work |
| --- | --- | --- | --- |
| R01 | Preserved | Local canonical service remains; no hosted or paid fallback added. | Production macOS service shutdown/activation still needs verification. |
| R02 | Preserved; scoped evidence | b41 browser/Soak result E01; Hub/report process success in 0b932ab campaign E02. | No terminal complete campaign for the later code and no current-head browser execution. |
| R03 | Preserved | Root identity, source revision, exact worktree/path and explicit destination remain bound. | No automatic project/worktree destination guessing. |
| R04 | Preserved | Existing Projects/Computer and device scopes retained; migration paths use canonical files and scope predicates. | No new general remote filesystem grant. |
| R05 | Preserved | No Hub reset, catalog or shell button; synthetic cutover asserts configuration bytes unchanged. | Not proof for every customized personal Hub. |
| R06 | Preserved | Writer/audio doctor diagnostics are deterministic; paused doctor is read-only and remains usable. | Optional dependency status is not document acceptance or inference. |
| R07 | Preserved; current scoped proof | Real SQLite-to-notebook import remains working only; later edits survive repeat/lost acknowledgment (P01/P02/F01/F02). | Human freeze/submission and decision remain separate; no implicit accepted file. |
| R08 | Preserved | No old request, job or frame sent to an agent. Provider tools remain restricted; no accept/reject capability (L01/F02). | Synthetic transport evidence is not a real-account validation. |
| R09 | Preserved | Existing exact frozen correction and independent terminal decision routes remain. | Browser drawing/review success is verified at b41, not the new UI input. |
| R10 | Preserved | Imports reuse importNotebookDraft; later submission uses existing Local/Shared engines. | No alternative tablet proposal engine. |
| R11 | Preserved; scoped regression | Shared exact pre-push writer guard from prior delivery included in F01; no code change to Shared. | OpenSSH configuration case remains historically blocked; no full CI claimed. |
| R12 | Preserved | Reconciliation/PCM working imports need no Git repository at the project destination. | Git remains necessary for Shared, not Local working scenes. |
| R13 | Preserved | Direct-change and integrity tests retained; new imports do not overwrite ordinary files. | No new physical sleep/restart evidence. |
| R14 | Extended; scoped proof | Progressive group undo uses each last object revision; newer edits/deletions win. Undone groups need advanced revisions (P01/P02/F01/F02). | Rollback scope unchanged: pause/resume, not a functional legacy downgrade. |
| R15 | Preserved | No age-based discard or cleanup of original history/PCM was added. | Retention does not mean every unknown source is automatically interpretable. |
| R16 | Preserved | Normal migration CLI and deterministic helpers remain harness-independent. | A real agent is still required only for explicit generative collaboration. |
| R17 | Preserved | Accepted-search and provenance owners were not replaced; targeted recovery summaries avoid full text. | No broader search-completeness claim. |
| R18 | Preserved | Job descriptor, grouped history and frame events distinguished; original int64 cells retained, no ID-only delivery claim. | Absent intermediate geometry and original normalized request bytes cannot be manufactured. |
| R19 | Preserved | Old queues remain unchanged and unacknowledged; native offline code unchanged. | Physical Wi-Fi interruptions are not exercised by SQLite tests. |
| R20 | Preserved | Per-project skills and original owner authority remain effective. | A synthetic attempt to reduce startupSkills scope was detected, not bypassed. |
| R21 | Preserved | No front matter or corpus reorganization imposed; explicit .crnb recovery destinations only. | Recovery metadata remains outside ordinary documentation. |
| R22 | Extended | Queue/tablet copies are editable; PCM can be read as exact bytes or a lossless WAV envelope. | No Office editor; missing raster assets refuse conversion. |
| R23 | Preserved | HTML still renders without a human code editor. | No new HTML browser test result beyond the baseline. |
| R24 | Extended | Recover actual committed progressive prefix; independent canonical work and tombstones retained (P01/P02/F01/F02). | New runtime timings distinguish a point from a nonzero reached segment, not hardware display proof. |
| R25 | Preserved | Native connector replaces external runtime; recovery reads retained formats without launching Lisière. | Cutover helper can stop the recognized original service only on explicitly authorized apply. |
| R26 | Preserved | No background generation or new agent. Initialization reuses only an already verified restricted child (L01/F02). | Protocol timing fixtures do not launch an authenticated model. |
| R27 | Preserved | No hosted-hub/review/remote profile restored; personal-device service stays opt-in. | Kit LaunchAgent does not implicitly expose a device listener. |
| R28 | Extended | Crash between frame transaction and descriptor save, failed attempt counters and idempotent working import covered (P01/P02/F01/F02). | No source overwrite; malformed/orphaned evidence blocks explicit recovery. |
| R29 | Local continuation delivered to PR | Exact source restoration and checkpoint receipts M01–M09. | Read final PR checks for publication state; no npm release or physical acceptance inferred. |

#### V01–V19 — acceptance evidence

| ID | State | Evidence | Limit / remaining work |
| --- | --- | --- | --- |
| V01 | Preservation audit | All 29 grooming requirements retained; targeted CI environment and UI corrections documented above. | Whole-product acceptance still needs the remaining device gates. |
| V02 | Mac installation verified | M07 activation, restart, source integrity, doctor and original-source UI. | Final production receipt is private; machine reboot not tested. |
| V03 | Native and real-provider proof | M03/M04/M06 actual emulator geometry, native pen, voice and acknowledgments. | Physical pressure, palm rejection and e-ink comfort untested. |
| V04 | Owner PCM executed | M02/M03 actual native WebView, playback/export and file-picker checks. | No physical BOOX evidence. |
| V05 | Extended synthetic proof | Lost import acknowledgment, delayed descriptor, failed frame attempt and repeated recovery preserve original and recent bytes (P01/P02/F01/F02). | Does not establish Android process/network behavior physically. |
| V06 | Extended; actual file tests | Frame gaps/duplicates/orphans, digest/prefix conflicts, object revisions, exact undo and newer human deletion tests (P01/P02/F01/F02). | Missing original normalized request is explicit evidence conflict; no approximate queue replay. |
| V07 | Real agent passed; speed target open | M04 covers real generation, progressive geometry, stop and redirection. | First useful native result 12.394 s; ten-second target unmet. |
| V08 | Current scoped proof | Working import and ordinary acceptance remain separate; real local/shared freeze/review dependencies tested in F01. | No final-head browser/native rendering acceptance claimed. |
| V09 | Full CI gate retained | Targeted platform checks M01 and unmodified review assertions. | Final full npm and hosted head checks must pass before merge. |
| V10 | Browser and native audio executed | M02/M05/M06 actual recognition, Codex, synthesis, playback receipts, microphone and recovery. | Synthetic browser input and muted emulator output do not prove physical acoustics. |
| V11 | Preserved | Existing rendered formats/HTML and notebook asset-resolution tests retained. | No invented Office/PDF editing expansion. |
| V12 | Scoped historical proof | Accepted-only corpus, reader integrity and Shared cache processes passed in E02 at 0b932ab. | Do not relabel those successes as a complete suite at the delivery HEAD; physical offline behavior not rerun. |
| V13 | Actual account exercised | M04/M05 verify real local Codex with existing scope restrictions and inherited-MCP isolation. | Not an adversarial local-admin security proof. |
| V14 | Selected personal recovery complete | M08 retains original private source records and pending review state. | Device-only data and retirement remain open; missing evidence cannot be reconstructed. |
| V15 | Current instrumentation built and run | M03/M06 signed install, native owner/PCM/audio/pen checks. | Physical-device upgrade and interruption remain open. |
| V16 | Rendered browser/native verified | M02/M03/M09/M10 rendered UI, four-profile accessibility and direct Voice regression. | Final whole-suite browser checks remain a separate gate; BOOX ergonomics open. |
| V17 | Measured; target open | M04: native 12.394 s; browser 14.048 s; detailed agent 21.247 s, with setup measured separately. | No sub-ten-second claim or silent model/effort downgrade. |
| V18 | Not tested — initial scope | No physical result claimed. | BOOX pressure, palm, latency, ghosting, microphone/speaker, interruption, Wi-Fi/sleep and comfort are required local tests, not out-of-scope extensions. |
| V19 | Exact source and signed APK | Source equality plus M01–M09 local evidence. | Final global CI, final installation and physical-device acceptance must not be inferred from package checks. |
