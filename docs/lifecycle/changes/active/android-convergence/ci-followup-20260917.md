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
