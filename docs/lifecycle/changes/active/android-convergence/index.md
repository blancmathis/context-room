# Connected notebooks and Android convergence

## Summary

The implementation branch starts at `05f5ded92cc1158b8c5aea09f4836fd08f4de27f`, preserving the refactor and concurrent configuration/navigation stabilization. The notebook foundation now includes an optional TLS drawing service, owner pairing and a native Android drawing preview verified in an isolated emulator. Full convergence remains incomplete; this branch is not a deployed release.

## Defines

The implementation state, contracts, preservation guard and synthetic verification evidence for connected notebooks and Android clients.

## Does not define

A second project catalog, a hosted service, a notes inbox, automatic documentary acceptance, a personal-device installation, or a physical BOOX result.

## Completed contracts

- `.crnb` is a specifically recognized, self-contained editable notebook document. Arbitrary JSON and source code are not added to review coverage.
- Working objects and immutable operation frames live separately from the ordinary document and accepted asset ledger. Drawing and autosave never accept a document.
- Stable operation ids, exact per-object revisions, author provenance, deletion tombstones and location revisions support independent edits, durable receipts, targeted conflicts and selective undo.
- A frozen notebook contains its exact objects and embedded raster resources. Later working gestures cannot enter that frozen review.
- Local submission uses the existing local proposal engine, with only the relevant accepted notebook as its base. A durable preparation request resumes safely after interruption without duplicating proposals or replacing newer workspace bytes.
- The existing human review decision accepts exactly the frozen notebook. Its later working scene is retained. A correction differing from the frozen scene requires explicit reconciliation.
- Notebook HTTP mutations pass the existing origin, exact-project and owner-authority checks. There is no agent acceptance endpoint.

## Verification through this milestone

See [verification](verification.md) for the restored sources, exact test results,
failed attempts, performance investigation and remaining proof boundaries.
The [device service contract](../../../../system/connected-devices.md) owns
activation, credential persistence and the restricted drawing permission.

## Preservation guard

R01–R06 retain the local service, exact worktrees, global Hub, authorized Computer folders and deterministic Health. R07–R15 retain accepted-only reads, direct human decisions, frozen local/Shared proposals, exact correction/rejection and indefinite default retention. R16–R21 retain a harness-independent CLI, per-reader freshness, explicit offline status, per-project skills and existing folder organization. R22–R25 extend formats and drawing without an HTML source editor or mandatory tablet. R26–R29 retain deterministic maintenance, retired hosted profiles, recoverable migration and explicit publication/installation boundaries.

## Remaining implementation sequence

The notebook protocol, local review, desktop canvas, restricted drawing
transport and initial native Android cache/rendering are implemented. The
preview builds and its complementary drawing/restart path passes in an
isolated emulator. Full complementary navigation receipts, remote owner parity,
notebook Shared submission, scoped voice/agent integration, recoverable migration
and release/upgrade packaging remain to be implemented. The complete
connected-device and physical acceptance criteria remain open.

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
