# PR 43: generated links and Android input evidence

## Summary

Bounded follow-up of `91cdcb828f097bc83d206aeaf74450d09aeead01` on
`mathis/shared-web-pwa-20260917`. Main was rechecked at
`4560f6e056a6f673fe6d77f6f9d2914c00829c64`; no merge, force push or personal
installation change is part of this work. This is a verification record, not
a new specification or a claim of physical BOOX acceptance.

## Failed checkpoint and diagnosis

CI run `35255035187` failed Node 24's existing test "agent context uses stable
project paths and refreshes canonical copies". Node 20 and Node 22.23.0 were
cancelled; the four browser jobs and Soak completed successfully. The canonical
agent context copies twelve current documents with their directory structure,
not the implementation lifecycle dossier. A new relative link in
`system/connected-devices.md` incorrectly addressed that absent dossier.
The reference is now explicitly a **source-repository path**, like the adjacent
lifecycle references. Canonical copies stay byte-identical and their actual
relative links stay closed within the installed context. Lifecycle records are
not promoted into the installed current authority merely to repair a link.

Convergence run `35255035215` built and verified the APK, but its owner UI test
failed at one object plus `saveState === 'confirmed'`. Artifact `10512169492`
contains `owner-failure.png` and the APK identity, not the private logcat or a
pointer trace. The screenshot shows a **Pixel Launcher is not responding**
system window over the common notebook. Underneath, the app reports
**Confirmed by the Mac, scene r0, 0 objects**. The shared notebook is rendered;
there is no recorded one-object scene awaiting confirmation. This is evidence
of a native input obstruction, not proof of a synchronization loss. The old
artifact alone cannot establish the exact instant the obstruction appeared.

The old helper checked only `UiAutomation.injectInputEvent`'s return value.
It did not prove that the owner held native input focus or that its canvas
received a Pointer Event. `evaluateJavascript` still reading the notebook did
not prove either condition. The fix isolates the unrelated Google launcher
only in the disposable CI AVD, and makes actual WebView receipt observable and
required. Android's ANR reporting is not disabled. Any remaining native input
obstruction fails explicitly; no uncertain stroke is automatically replayed.

## Regression boundaries

`test/agent_context_links.test.mjs` exercises the real context generator twice:
fresh copy and repair of an old copy containing the broken link. It checks the
whole generated link graph, exact canonical bytes, unchanged other copies and
idempotency. The original failing test is unchanged. Unit matrix fail-fast is
disabled so one runtime cannot cancel the other required Node results.

`OwnerPenProbe` is instrumentation-only. It checks native owner focus, the active
window, compositor readiness and hit-testing for all three pen coordinates.
It injects real Android stylus events once and observes trusted pen down/move/up
with the exact pressures. It never writes the scene, dispatches JS input or
replaces a renderer callback. The existing one-object, confirmed-state, pressure,
no-native-canvas, import/export and human-review assertions remain in place.
An additional pixel read proves the common canvas painted retained ink. The
Python verifier also checks the canonical host's one pressure stroke and the
exact exported two-object scene. `owner-input-proof.json` is bounded and contains
only fixed diagnostic fields, not UI text, URLs, tickets, credentials or journals.

## Execution and final evidence

Before pushing, static inspection of the twelve-document installed graph found
one missing relative target in the old source and none after this correction.
`node --check test/agent_context_links.test.mjs`, `bash -n
scripts/verify-android-ci.sh` and Python compilation of `verify-owner.py` passed.
The local container cannot resolve GitHub and its offline npm cache lacks the
locked `yaml` tarball. No local full-suite or Android pass is claimed. The source
was retrieved from the exact failed run's source artifact and both its outer
ZIP digest and inner archive checksum were verified against its source identity.

The final delivery and PR must record completed CI and convergence run IDs for
the final SHA. Source archive `SOURCE_COMMIT`, APK `SOURCE_COMMIT` and emulator
`proof.json.sourceHead` must agree. Pending/cancelled jobs are not accepted as
validation. Read this record together with the dated historical
[verification journal](verification.md) and the updated
[local handoff](codex-shared-web-handoff.md); older checkpoints keep their own
scope and result. Physical web-pen latency, palm rejection, e-ink, audio, trusted
browser HTTPS and long BOOX sessions remain local checks, not emulator results.

## Verification iteration: shared keyboard fixture

At `047cf526f6ba0446501a101e0ffc4410fd60a865`, convergence run `35261577288`
completed successfully: 134 contracts, repository diagnostics, package privacy,
APK verification and the full owner emulator scenario. The downloaded input
proof records owner focus, one trusted pen down/move/up, pressures 0.25/0.75,
rendered ink and a confirmed one-object scene; the host confirms the exact
editable two-object export and unchanged accepted file.

CI run `35261577355` exposed a pre-existing race in the visual-only keyboard
fixture. Its Chromium trace shows the keyboard attributes present immediately
after the synthetic tracker is installed and removed before the bounding-box
read. The test installed a second tracker on the same document while the real
tracker still listened to a late layout resize. The correction overrides the
visual viewport measurements read by the **single production tracker**, rather
than running a competing controller. Late window/visual resize and scroll events
are dispatched explicitly; the same strict top/bottom geometry assertions are
retained, and restoration must clear the state through the real listener.
Production viewport code and styles are unchanged. A standalone synthetic Node
event contract reproduced the competing trackers and passed with a single tracker
through late events and measurement restoration; this is not browser proof.
A local Chromium probe could
not navigate loopback (`ERR_BLOCKED_BY_ADMINISTRATOR`); no browser policy was
changed and no local browser success is claimed. The corrected scenario still
requires its actual four-browser CI execution on the final delivered SHA.


## Verification iteration: keep observation out of a held pen sequence

At `80170854016269a15c6b52437567ce6f5ba8842e`, CI run `35262499907`
completed with Node 20, Node 22.23.0, all four Browser QA jobs and Soak successful.
The generated-link regressions and original context-copy test passed on all
three Node versions. Node 24 alone failed the existing 80-file HTTP review
performance assertion: 939 ms against its unchanged 900 ms limit, with
`transaction;dur=929.1, projection;dur=0.1, events;dur=15.0`. Its other 108 of
109 test processes passed. This is not a recurrence of the document-link defect;
the failed performance run remains failed, and the final SHA must pass the full
matrix without increasing the budget.

Convergence run `35262499759` passed contracts, compilation and APK verification,
but failed its owner input test. Artifact `10514679900` now distinguishes the
stages: the owner retained native focus; the common canvas received trusted pen
DOWN and MOVE at pressures 0.25 and 0.75, followed by CANCEL rather than UP; the
one-object scene was already Mac-confirmed at r2. The screenshot shows retained
ink and Android text-selection handles on the inspector's Objects heading.
There is no evidence of a missing synchronized prefix in this run. The pixel
probe had not run: the old `renderedInk: false` initialization was not evidence
that the visible ink failed to render.

The instrumentation performed JS receipt polling, an accessibility-tree query
and proof-file IO between DOWN, MOVE and UP. Those operations can hold the injected
pen down far beyond its intended 40 ms cadence, consistent with the observed native
text-selection cancellation. The old proof lacks timestamps, so it cannot give
an exact long-press duration. The correction sends the same three native events
once, at the existing short cadence, and only then reads the passive event log
and writes the proof. Native focus and successful OS injection remain required
for every phase; all trusted down/move/up, exact pressure, absence-of-cancel,
canonical object/confirmation, painted-pixel, export and human-review assertions
are retained. No product renderer, synchronization, permission or gesture code
is changed for this instrumentation correction.

The bounded proof now records actual native injection offsets/durations and
received-event offsets, rather than inferring cadence from sleeps. These measure
the synthetic sequence, not physical digitizer latency. An unexecuted pixel
probe is explicitly `null`; only the existing pixel assertion can establish
`true`. A missing or cancelled phase still fails and is never replayed.

Local embedded-JavaScript syntax and diff checks are possible without Android.
The context-generator test cannot load here because the locked npm dependencies
are absent (`ERR_MODULE_NOT_FOUND: ajv`); do not report it as a local pass. Actual
Android compilation and the whole unchanged owner scenario must be checked in
the fresh CI emulator. The final delivery records their definitive result,
exact source identity and artifacts, separately from these failed checkpoints.
