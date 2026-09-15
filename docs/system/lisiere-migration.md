---
context_room:
  id: system.lisiere-migration
  depends_on: [system.connected-devices, assurance.review.human-authority]
---

# Lisière recovery and migration

## Summary

Context Room exports a private, versioned snapshot of a legacy Mac workspace
or Android workspace database. Preview and apply compare the same content
revision. Export is read-only against the source and does not require the
Lisière executable or service. A selected canonical Mac board can then become
an editable, unaccepted working notebook. Selected Mac text drafts can become
Local working proposals; selected Android journals reconstruct their retained
text into the same workflow. Tablet outbox reconciliation and installation
cutover remain in progress.

## Defines

The recovery snapshot format, source compatibility, private export, exact
revision precondition, selected-board and text-draft import, and interrupted-operation recovery.

## Does not define

Human acceptance, installation on a personal device, project destination
mapping or switching the active writer. An export does not complete migration.

## Export

Python 3.9 or later with its standard `sqlite3` module is required. Select a
directory containing `workspace.sqlite` and an export destination outside that
directory. The destination's parent must exist. No registered project is needed.

```bash
context-room migrate --export-lisiere /path/to/legacy-workspace --output /path/to/private-snapshot
context-room migrate --export-lisiere /path/to/legacy-workspace --output /path/to/private-snapshot --apply --revision REVISION
```

Use the exact revision returned by the first command. The default and `--plan`
are previews. A changed source requires a fresh preview. An unrelated occupied
destination is refused; existing content is never overwritten. Keep exports
outside public repositories: they contain original documents and user history.

The helper reads a consistent SQLite transaction, including committed WAL data.
It accepts the recognized Mac and Android schemas at database version 0 or 1.
Unknown tables, columns and later versions are refused for explicit inspection.
The snapshot is bounded to 512 MiB, including Mac content-addressed assets.
Database-only exports keep format version 1. To include original Android audio,
select the old application's dictation directory explicitly:

```bash
context-room migrate --export-lisiere /path/to/android-databases --recordings /path/to/android-dictation --output /path/to/private-snapshot
context-room migrate --export-lisiere /path/to/android-databases --recordings /path/to/android-dictation --output /path/to/private-snapshot --apply --revision REVISION
```

This produces format version 2. Each retained recording keeps its original name,
byte count and SHA-256, with signed little-endian PCM metadata at 16 kHz mono.
The original two-minute/3,840,000-byte bound applies. Linked, odd-length,
oversized, unknown or changing files are refused. No microphone, recognition,
playback, authentication preferences or agent task is opened. Recordings remain
unassigned recovery data until their original context is reconciled; the
export never guesses a destination from a hashed filename.

`manifest.json` lists JSONL tables, column order, row counts, byte lengths and
SHA-256 hashes. Binary cells use a `base64` wrapper; integers outside JavaScript's
exact range use an `integer` decimal wrapper. Original drafts, deletion records,
queued operations and history remain recovery data, with `accepted: false`.
Binary Android cells stay exact. Draft recovery decodes their original journal
without replaying legacy requests.

Known pairing tokens and executable native-request grants are excluded. The
export does not read authentication preferences, private keys or integration
configuration. This does not remove sensitive material the user wrote in their
own content. Directory-based Android exports include recording files only with `--recordings`; native ZIP exports already declare and include their retained PCM files.
Earlier project handoff directories are not part of this database export.

## Recover an existing Android installation

The ordinary preview uses a separate application identity. To access data kept
inside an existing Lisière installation, the explicit recovery build uses the
same `fr.lisiere.android` identity and the preserved original signing key. It
packages the same Context Room source with a higher Android version code:

```bash
scripts/build-android-recovery.sh /absolute/path/to/original-lisiere.apk HIGHER_VERSION_CODE
```

JDK 17, Android SDK/build-tools 35 and the original key in
`~/.local/share/lisiere/signing/development.keystore` are required. The command
builds and checks the original/new package identities, signer and increasing
version. It does not install anything. Its APK is
`android/.local/legacy-recovery-build/app/outputs/apk/debug/app-debug.apk`;
ordinary preview output and signing remain separate. Keep signing material
outside Git. A different key cannot upgrade the existing installation.

After an authorized upgrade, **Récupérer Lisière** on the connection screen
opens an explicit local export. **Préparer une copie** retains the original
database, committed WAL or rollback journal, and original PCM recordings.
SQLite opens only a disposable copy for consistency and queue decoding.
Private authentication preferences are preserved by the upgrade and excluded
from the ZIP. The new app does not load their old connection or send the old
queue. A prepared copy survives activity recreation and picker cancellation.
**Enregistrer le fichier ZIP** saves it through Android's document picker;
the original data and private prepared copy stay on the device.

The ZIP is bounded to 512 MiB of source/derived data. Its final `manifest.json`
identifies every file by size and SHA-256. `derived/outbox-args.jsonl` retains
the original Android JSON serialization, including Float/Double formatting,
and binds each decoded row to its original argument bytes. Unreadable rows
remain explicit reconciliation items in the preserved database. Delivery is
never inferred. A partial preparation cannot replace a completed receipt;
changed or linked copies are refused when reopened.

This native recovery ZIP is a private transfer artifact, not a snapshot-format-1
Mac export. Context Room now converts it directly to a verified format-3 snapshot.
Queue reconciliation and proof of delivery remain separate from this conversion. The isolated emulator verifies native export and Mac
snapshot extraction from its checked contents. It does not establish a
personal-device upgrade, writer cutover or automatic rollback.


### Direct native ZIP conversion

Use the existing preview/apply protocol; no manual extraction or legacy service
is required:

```sh
context-room migrate --export-lisiere /path/to/android-recovery.zip --output /path/to/private-snapshot
context-room migrate --export-lisiere /path/to/android-recovery.zip --output /path/to/private-snapshot --apply --revision REVISION
context-room migrate --inspect-lisiere /path/to/private-snapshot --kind operations
```

Native container version 1, directory snapshot versions 1/2, and converted
snapshot version 3 have distinct contracts. Versions 1/2 keep their existing
content identity and remain readable. Version 3 retains the exact native
`derived/outbox-args.jsonl` and `derived/android-export-manifest.json`, alongside
exported SQLite rows and original PCM. Do not add `--recordings` to a ZIP input.

The converter checks the bounded final ZIP directory before extraction; rejects
unsafe paths, duplicate members, links, unsupported compression and incomplete
inventories; and verifies sizes, hashes, SQLite schema and PCM declarations.
SQLite WAL/rollback recovery runs only in an exclusive disposable copy. The
original ZIP, including its physical database journals, is never written. The
converted snapshot contains the committed SQLite view, not a replay of the old
outbox. Both the native source/derived budget and converted snapshot are bounded
to 512 MiB. SQLite JSONL envelopes are bounded to 48 MiB per row, allowing base64
for the original 32 MiB binary-cell bound; native serialized rows also have a
bounded JSON-escaping allowance.

Every derived operation is checked against its exact sequence, ID, operation,
original argument encoding and byte hash. Decoded arguments are compared with
the original typed values, preserving int64 and the Float/Double distinction.
The retained `argsJson` is never reconstructed through JavaScript numbers.
Floating-point verification is a typed round trip, **not proof of a unique
original wire serialization or Mac receipt**. Snapshot provenance records this
limit and `delivery: not-inferred`. Unknown rows remain non-executable recovery
records. No import accepts a document or acknowledges an old send.

Preview and apply bind the original ZIP SHA-256, not disposable directory
inodes. Copying the same ZIP bytes to a different ordinary file does not change
its revision. An occupied unrelated destination is refused. Interrupted export
journals and files can resume only an exact retained prefix, through locked
private file descriptors; no existing byte is replaced and no hard link is left
by a killed exporter. A changed or truncated completed snapshot is refused,
rather than silently repaired over potentially newer work.

Portable evidence is in `test/python/lisiere_android_export_test.py` and
`test/lisiere_android_export.test.mjs`: synthetic native-format archives, WAL and
hot rollback journals, original-byte/typed-argument tampering, bounded extraction,
occupied destinations and actual killed-process recovery. These are not an APK
execution or a physical BOOX test. This converter changes no Android source and
does not extend the scope of prior emulator evidence.

## Recovery

Export directories use mode 0700 and new files use 0600. A private staging area
is synced before publication. `export-journal.json` is published first, every
content file next and the completed `manifest.json` last. A consumer must verify
the manifest and every file hash before using the snapshot.

After interruption, repeat the same apply command with the same source revision
and destination. Existing files must match exactly; the exporter fills missing
files and refuses changed ones. Repeating a completed export is idempotent.
If the source has advanced, retain the partial export and preview into a new
destination. No retry replaces the original workspace or a newer destination.

## Inspect retained work

```bash
context-room migrate --inspect-lisiere /path/to/private-snapshot --kind boards
context-room migrate --inspect-lisiere /path/to/private-snapshot --kind drafts
```

The inventory reads a completed, verified snapshot without a registered project
or legacy executable. Kinds are `all`, `projects`, `boards`, `drafts`,
`conversations`, `operations` and `recordings`. Pages default to 50 entries;
`--limit` accepts 1–200. Pass the returned `pagination.nextCursor` through
`--cursor` to continue the same source and selection. A changed snapshot or
different selection invalidates that cursor.

Entries describe original identities and versions without printing full draft
or queued-message text. Record selectors identify exact retained content.
Android journal records and text seeds remain distinguishable, and other cache
rows stay accounted for in the table inventory. A retained operation is not
proof of delivery; recordings remain unassigned. Inspection cannot apply,
acknowledge, accept or restart work.

## Import a canonical Mac notebook

Choose the source board ID from the inventory and an unused
ordinary `.crnb` path in an existing Context Room project's writable, watched
folders. A free legacy board can use any such explicitly chosen destination;
there is no new inbox or project catalog.

```bash
context-room migrate --root /path/to/project --import-lisiere /path/to/private-snapshot --legacy-board BOARD_ID --path docs/Ideas.crnb
context-room migrate --root /path/to/project --import-lisiere /path/to/private-snapshot --legacy-board BOARD_ID --path docs/Ideas.crnb --apply --revision REVISION
```

Preview does not create directories, locks or documents. Apply checks the same
source, original project identity and configuration, then checks live write
authority again. An occupied path, changed source, conflicting notebook ID or
altered recovery record is refused. Keep the original full snapshot.

The importer retains original object IDs when the notebook protocol accepts
them, otherwise records a deterministic mapping. It retains object/deletion
revisions, all supported pen samples, original embedded raster bytes, connector
ports/routes and text spacing. Imported ink explicitly uses the legacy linear
pressure curve; new ink keeps the current soft curve. Browser, SVG and native
renderers use that retained choice. Missing assets/endpoints, unknown types,
cycles and data exceeding editable limits stop the import without truncation.
The original snapshot remains available for reconciliation.

Before publishing the working scene, apply retains the selected original board,
its rows, identity map and image assets under
`.context-room/migrations/lisiere-v1/`. Immutable plan, authorization, backup
and completion receipts permit interruption recovery. Other projects' content,
credentials and pending operation queues are not copied into this project.
The CLI also excludes migration records, working notebooks and legacy handoff
directories from ordinary Git staging through the project's local excludes.

Repeat the same apply command after interruption. Matching records are reused;
later human notebook edits remain intact. If project configuration changed,
obtain a fresh preview before resuming the same retained import. Changed backup
bytes require reconciliation and are never overwritten.

Import creates private working state, with explicit import provenance. It does
not create an ordinary `.crnb` file or an accepted baseline. Use the existing
notebook freeze/submission and human review workflow to produce and decide an
ordinary document. The migration receipts never substitute for that decision.

This command imports one canonical Mac board. Android outbox reconciliation,
recording-context recovery, old handoff import and automatic rollback
are separate unfinished work. It does not acknowledge an old operation, resume
an old agent task or switch off the legacy writer.

## Import a retained text draft

Choose the exact `selector` from the `drafts` inventory, an existing Context Room
project and a writable, watched `.md`, `.markdown`, `.txt`, `.html` or `.htm` path:

```bash
context-room migrate --root /path/to/project --import-lisiere /path/to/private-snapshot --legacy-draft SELECTOR --path docs/Recovered.md
context-room migrate --root /path/to/project --import-lisiere /path/to/private-snapshot --legacy-draft SELECTOR --path docs/Recovered.md --apply --revision REVISION
```

For a Mac snapshot, select its versioned draft row. For an Android snapshot,
select the `draftmeta:` journal or an earlier `dirtydraft:` pending record.
The importer reconstructs the original seed and ordered UTF-16 edits, including
LSJ1 binary records. A newer journal takes precedence over an earlier pending
record. A missing final delta, conflicting earlier seed or invalid epoch stops
the import; a standalone text seed cannot supply missing version authority.

Android recovery retains the exact selected records, original counters and
pending correction/merge backup alongside the reconstructed text. The private
copy contains only this document's journal, bounded to 32 MiB. A local
acknowledgement counter is retained as recorded; it does not prove delivery to
the Mac or authorize an old request. Other drafts, operation queues and
conversations remain in the full snapshot. Recovery neither acknowledges nor
sends them, and it does not claim writer cutover or synchronization.

An unused destination keeps recovery separate from existing work. Reusing the
original path requires its current bytes to match the legacy base hash and an
available accepted Context Room baseline. A changed or deleted original requires
reconciliation or another unused path. Text is retained exactly within a 16 MiB
UTF-8 limit; unfinished UTF-16 composition remains original recovery data.

Preview does not write. Apply retains the original selected record, its source
revision and its exact accepted base in the private migration store before
publishing an editing proposal through the existing Local engine. It does not
write the ordinary document, submit it or accept it. Initial working bytes and
proposal metadata are synced before successful acknowledgement.

Repeat the same command after interruption. The stable source-record identity
reuses its proposal even if unrelated legacy content changes in a later full
snapshot. Later human edits, submission and decisions remain intact. Changed
source records receive different identities; changed recovery bytes are refused.

The Hub's **Working drafts** opens saved Local proposals. Markdown and plain
text can be edited and saved there; HTML retains a sandboxed visual preview.
**Submit for review** freezes the displayed saved revision through the usual
Local workflow. It leaves the ordinary file untouched until human review.
The same interface is available through an authorized connected owner tablet.
The editor supports 256 working files and 64 MiB per proposal, with 16 MiB per
opened file. Larger workspaces remain on disk for the existing CLI workflow.

Android outbox reconciliation and recording attachment remain separate work.

## Import a retained conversation

Choose a `selector` from the `conversations` inventory and an existing readable
document or working notebook in the target project. Open or import the notebook
first. This is an explicit link to that destination; original per-message
contexts remain historical records and do not silently retarget it.

```sh
context-room migrate --root PROJECT --import-lisiere SNAPSHOT \
  --legacy-conversation SELECTOR --path docs/Original.md
context-room migrate --root PROJECT --import-lisiere SNAPSHOT \
  --legacy-conversation SELECTOR --path docs/Original.md \
  --apply --revision PREVIEW_REVISION
```

Preview is read-only. Apply retains the selected conversation's original
SQLite cells, task identity, events and Desktop requests in the private
conversation store outside the project. Integer and binary cells retain their
exact encodings. A separate readable projection combines identified response
deltas with their completed item, labels partial answers and keeps unknown
events in the full export. An inactive request is not taken as delivery proof.
Recovery supports an archive of up to 30 MiB; larger input is refused with its
original snapshot intact. Apply and interrupted-publication retries preserve
later human messages and their new task identity.

The default store is `~/.context-room/assistant`; an owner can use the same
`CONTEXT_ROOM_ASSISTANT_HOME` for the migration CLI and Mac runtime to select a
different private location. It must stay outside the project. Imports never
write accepted documents, start a provider, resume an old task or replay a send.

In the document or notebook's conversation, **Read retained messages** and
**Export original history** work without Codex. Export verifies every transfer
and the complete archive hash, rechecking access for each one-MiB chunk. A later
explicit new message or Voice action starts a separate Context Room task with
the original source tool and a read-only history tool. Historical contexts and
approvals cannot authorize new work. The original Lisière or Desktop task remains
unchanged; subsequent new messages resume the new Context Room task.

A Mac snapshot can contain only part of a Desktop task's transcript. Its
original task identity remains available; missing messages and unconfirmed
delivery are never invented. This import does not switch the legacy writer.

## Completion boundary

The old installation remains active and can receive later writes. This snapshot
is a point-in-time recovery copy, not a synchronization or single-writer fence.
Do not retire the old installation until imports, pending work, conversation
links, device identity and physical validation have their own receipts. The
convergence verification record at
`docs/lifecycle/changes/active/android-convergence/verification.md` in the
Context Room source repository tracks those open gates.

## Retained drawing-transfer sessions without a legacy runtime

Inside the selected original project, inspect one exact retained session:

```sh
context-room migrate --legacy-session ORIGINAL_SESSION_ID
context-room migrate --legacy-session ORIGINAL_SESSION_ID --session-frame board:REVISION --path docs/recovered-drawing.crnb
context-room migrate --legacy-session ORIGINAL_SESSION_ID --session-frame board:REVISION --path docs/recovered-drawing.crnb --apply --revision PREVIEW_REVISION
```

The inventory also offers `source` and retained `preview:REVISION` frames. Those
choices explicitly recover an embedded raster, not reconstructed editable pen
objects. A structured `board:REVISION` import requires exact original object IDs
and revisions; tombstones are retained and pressure samples use the normal legacy
board converter. Flat object projections and projections with an explicit `value`
are supported. An absent asset, unknown object format or missing revision is
refused for structured import; the original files remain available and no raster
fallback is silently substituted.

Preview binds the original `session.json`, selected frame, source PNG, exact
project location, configuration and destination. Apply retains those originals
and their ID mapping in a versioned recovery journal, imports a working notebook
through the existing native engine, and leaves accepted documentation untouched.
Repetition reuses the original import receipt without overwriting newer gestures.
Old task identities and uncertain sends remain historical; no provider task or
legacy queue is resumed. Symlinks and occupied unrelated destinations are refused.

This completes the native replacement of the former drawing connector calls,
not the Android/Mac pending-queue reconciliation. Android `board.create`,
`board.metadata`, `asset.put`, `board.mutate` and progressive frames still need
receipt-digest and revision-chain reconciliation before any operation can be
classified as delivered or safely applied. Native ZIP conversion and retained
transfer recovery are not substitutes for that missing migration function.

Preserved PCM recordings still have `context: unassigned` unless an original
binding is already available in their retained source. A filename hash is not
used to infer a document or conversation. The explicit audio-association
selection/review workflow remains implementation work; do not claim that
recording preservation alone delivers that workflow.

## Comparing the retained Android queue with Mac receipts

`migrate --reconcile-lisiere ANDROID_SNAPSHOT --mac-snapshot MAC_SNAPSHOT
--legacy-board BOARD_ID --legacy-actor ACTOR --path docs/Recovered.crnb`
previews a new working notebook. Both inputs must be complete private exports;
`ACTOR` is the exact original tablet identity, not inferred from an operation ID.
Apply only its exact `--revision` together with `--apply`.

The comparison uses the Mac request-digest contract with Python number semantics.
Native typed arguments are rechecked against their original SQLite cells. A
matching ordinary mutation requires its request digest, result, history and
compatible canonical object revisions, not simply a matching ID. The digest
match establishes the recorded normalized request, not a unique raw HTTP wire
serialization. Assets prove content presence, never delivery of an upload.

Compatible unsent mutations, metadata changes, creations, deletions and history
undo are projected in order into a **separate** editable working notebook. Each
object records original/effective preconditions and imported revision. Only the
first successor receives a predecessor's acknowledged/projected revision, as in
the original queue. Independent Mac work is preserved. Conflicts block import;
unknown operations and private progressive-pen jobs remain explicit recovery
items. No original queue entry is removed, acknowledged or sent.

The chosen destination must be unused and in the existing editable project
scope. Original selected records and revision/ID mapping are retained privately.
The header doubles as the immutable replay receipt: an interrupted retry keeps
later human edits. The existing Local/Shared submission and human review are
still required to publish accepted documentation. Cache-only drawings without
an interpretable queue, and private progressive-pen job reconciliation, are not
implemented by this comparison.

## Explicit original PCM associations

`migrate --import-lisiere SNAPSHOT --legacy-recording ORIGINAL_NAME.pcm
--path docs/Idea.md` previews an attachment to an existing authorized document or
working notebook. `--conversation-id ID` selects an existing conversation instead
of `--path`; the two are mutually exclusive. `--label` is optional. Apply with the
exact preview `--revision` and `--apply`.

The original SHA-256, sample count, selected source/version and conversation
identity are retained in the private assistant store outside the project.
The hashed filename is never used to guess a destination. Preview creates no
recording store, changed source bytes invalidate a pending preview, and replay
of a published link preserves newer source work. Files and bindings have strict
bounds, private permissions and immutable checksums. Corrupt or replaced data
requires explicit recovery from the original snapshot.

An existing conversation also offers **Recovered recordings**. The owner chooses
a private snapshot directory and exact PCM name, previews the association, then
chooses **Attach this exact recording**. Source-only attachments appear only in
conversations for that source; conversation-only attachments remain exclusive to
that conversation. **Load audio for review** creates a lossless WAVE envelope
and does not start playback. **Export original PCM** preserves original samples.
None of these operations transcribes, submits, sends, invokes Codex or changes
accepted documents. Closing/switching a conversation disposes the old audio.
This new browser/Android owner-WebView path requires execution validation; the
portable CLI, storage and HTTP contracts have independent synthetic tests.
