# Connected notebooks and Android convergence

## Summary

The implementation branch starts at `05f5ded92cc1158b8c5aea09f4836fd08f4de27f`, preserving the refactor and concurrent configuration/navigation stabilization. The two source checkpoints have been restored and desktop notebook verification has resumed. This remains an incomplete convergence branch, not a deployed release.

## Defines

The implementation state, contracts, preservation guard and synthetic verification evidence for connected notebooks and Android clients.

## Does not define

A second project catalog, a hosted service, a notes inbox, automatic documentary acceptance, an installed Android application, or a physical BOOX result.

## Completed contracts

- `.crnb` is a specifically recognized, self-contained editable notebook document. Arbitrary JSON and source code are not added to review coverage.
- Working objects and immutable operation frames live separately from the ordinary document and accepted asset ledger. Drawing and autosave never accept a document.
- Stable operation ids, exact per-object revisions, author provenance, deletion tombstones and location revisions support independent edits, durable receipts, targeted conflicts and selective undo.
- A frozen notebook contains its exact objects and embedded raster resources. Later working gestures cannot enter that frozen review.
- Local submission uses the existing local proposal engine, with only the relevant accepted notebook as its base. A durable preparation request resumes safely after interruption without duplicating proposals or replacing newer workspace bytes.
- The existing human review decision accepts exactly the frozen notebook. Its later working scene is retained. A correction differing from the frozen scene requires explicit reconciliation.
- Notebook HTTP mutations pass the existing origin, exact-project and owner-authority checks. There is no agent acceptance endpoint.

## Verification through this milestone

`npm exec --yes --package=node@24 -- node --test test/local_proposals.test.mjs test/document_assets.test.mjs test/notebook_protocol.test.mjs test/notebooks.test.mjs test/notebook_workflow.test.mjs` passed **32/32** with `umask 022`, matching the mode assumptions in existing fixtures. The same existing local-proposal fixtures fail under an inherited `umask 077` because their sources become mode 0600 while their supplied accepted base defaults to 0644. Exact mode assertions and application guards were not relaxed. The initial result is retained privately.

The tests include two independent writer processes, lost-response replay, stale/conflicting writes, selective human undo retaining agent provenance, symlink and corrupt-history rejection, immutable snapshots, interrupted preparation and a real isolated HTTP server through an exact human fixture review. No personal documents, services or devices are used as fixtures.

The initial complete-suite attempt used an unsupported Node runtime and was stopped; a clean-base Node 24 run also exposes existing failures/timeouts. Neither run is reported as a successful baseline. The complete branch suite, browser matrix, Android instrumentation and physical tests remain to be recorded separately.

## Preservation guard

R01–R06 retain the local service, exact worktrees, global Hub, authorized Computer folders and deterministic Health. R07–R15 retain accepted-only reads, direct human decisions, frozen local/Shared proposals, exact correction/rejection and indefinite default retention. R16–R21 retain a harness-independent CLI, per-reader freshness, explicit offline status, per-project skills and existing folder organization. R22–R25 extend formats and drawing without an HTML source editor or mandatory tablet. R26–R29 retain deterministic maintenance, retired hosted profiles, recoverable migration and explicit publication/installation boundaries.

## Remaining implementation sequence

The notebook protocol and local review foundation are implemented. The desktop drawing surface is connected and its real-server Chromium scenarios pass. Common device/session authority contracts, native Android cache/rendering, opt-in authenticated device transport, complementary navigation receipts, full remote parity, notebook Shared submission, scoped voice/agent integration, recoverable migration and Android packaging remain to be implemented. There is no Android project or APK in this checkpoint. The product's connected-device and physical acceptance criteria remain open.

## Gesture continuation

The portable client now persists pressure samples during a gesture, groups segmented strokes for selective undo/redo across restart, and preserves exact object revisions. Embedded-image outbox entries and a transactionally initialized browser identity use the same cache. Inert SVG exports retain pressure geometry and identify agent modifications of human-origin objects. See [verification](verification.md) for synthetic tests and the remaining proof boundaries. These primitives alone do not constitute a delivered tablet interface.

The folder chooser and retained canvas are wired to the existing local UI and
the `.crnb` file path. Frozen notebook corrections reuse the existing human
file decision route. Restored browser tests cover working ink, offline cache
reopening, frozen correction and accepted-only reads. Further tests and fixes
retain rapid successive strokes, their lift positions, ordered undo and every
failed stroke's recovery data. Concurrent lock publication waits for its
temporary link to disappear while retaining the rejection of persistent links.
See [verification](verification.md) for commands, observed results and remaining
checks. Existing compatibility data and installations are retained.
