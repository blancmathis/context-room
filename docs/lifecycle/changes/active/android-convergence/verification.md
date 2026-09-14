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

## Open product gates

Both complete tablet modes, exact remote
application receipts,
context-bound real dictation/conversation/co-drawing, data migration and final
removal of the external compatibility dependency remain implementation work.
The verified Android installation is an emulator preview. It does not establish
full remote owner authority, physical Wi-Fi behavior or BOOX pen/palm latency.

The full application smoke/layout/accessibility/performance/soak release matrix
has not been rerun for this recovery milestone. Notebook-specific checks do not
stand in for it. Installation/signature migration, physical BOOX testing and
personal-data migration have not been performed.
