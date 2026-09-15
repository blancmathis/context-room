# Connected notebooks and Android convergence

## Summary

The implementation branch starts at `05f5ded92cc1158b8c5aea09f4836fd08f4de27f`, preserving the refactor and concurrent configuration/navigation stabilization. The notebook foundation includes an optional TLS device service and an Android preview with native drawing and the existing full owner interface, verified in an isolated emulator. The browser connects document/notebook conversations to real Codex, scoped edits, progressive drawing and recoverable task identities. Continuous voice has a real browser recognition/agent/playback check using synthetic microphone input. Direct dictation supports reviewed insertion into document and notebook drafts. Native Android capture, playback, background stop, original-recording recovery and local Whisper recognition have emulator checks using explicitly synthetic recognition input; physical microphone verification remains unfinished. Full convergence remains incomplete; this branch is not a deployed release.

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
- Shared submission displays the exact connected repository, project and document destination before publishing. It retains a frozen version and preparation identity through the existing Shared engine, verifies the delivered branch and state ref, and recovers a lost receipt without another publication. The source connection, exact document bytes and unrelated workspace changes are revalidated. File review and terminal acceptance remain separate human decisions.
- The existing human review decision accepts exactly the frozen notebook. Its later working scene is retained. A correction differing from the frozen scene requires explicit reconciliation.
- Notebook HTTP mutations pass the existing origin, exact-project and owner-authority checks. There is no agent acceptance endpoint.
- Remote notebook opening retains an exact target and request identifier. The Android client waits for a held gesture and its Mac receipts, confirms after native rendering, and lets a new human action cancel a pending opening. A stale session, deadline, changed target or queued previous scene cannot supply an applied receipt or populate another canvas.
- View sharing and following require explicit choices on the participating surfaces. They remain bound to one exact notebook, expire without a heartbeat and acknowledge the rendered area. Human input stops following immediately, including while a response is in flight. Desktop and Android presentation preserve a visible exit and the open notebook.
- A separate, explicitly selected owner pairing opens the existing Context Room interface through the pinned Android transport. The attached loopback runtime retains project/folder permissions and the normal human review nonce. Drawing credentials cannot gain this permission. The retained web workspace and native canvas operate on the same working notebook; document frames cannot use the owner bridge.
- A conversation retains its original project, file, selection and Codex task. Browsing another document does not retarget it. Notebook tools recheck object/location revisions; document replacements create a proposal through the existing local review engine. No agent tool can accept, reject or publish.
- Conversation sends have durable identities. Explicit recovery compares the original turn and input hash before restoring a response; it never silently resends. The server starts its owned Codex child only after an explicit connection or message action.

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
isolated emulator. Exact native opening receipts, optional
viewport following, presentation and the connected owner interface are
implemented. The owner file-picker round trip is verified on the emulator;
voice alongside the native pen is implemented with emulator checks. Explicit
original-source observation is implemented, including an unfinished native
shape identified by the real agent from its image. A recoverable private SQLite
export now preserves legacy database data with exact-revision checks. Selected
Mac notebooks import as editable working scenes with retained source copies,
identity mappings and restart receipts. Android draft/outbox reconciliation,
recording/handoff collection, writer cutover and release/upgrade packaging
remain to be implemented. The complete
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
