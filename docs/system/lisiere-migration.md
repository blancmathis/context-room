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
Local working proposals. Tablet reconciliation and installation
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
Binary Android cells stay exact and have not yet been replayed or imported.

Known pairing tokens and executable native-request grants are excluded. The
export does not read authentication preferences, private keys or integration
configuration. This does not remove sensitive material the user wrote in their
own content. Android recording files are included only with `--recordings`.
Earlier project handoff directories are not part of this database export.

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

This command imports one canonical Mac board. Android draft/outbox reconciliation,
recording-context recovery, old handoff import and automatic rollback
are separate unfinished work. It does not acknowledge an old operation, resume
an old agent task or switch off the legacy writer.

## Import a canonical Mac text draft

Choose the exact `selector` from the `drafts` inventory, an existing Context Room
project and a writable, watched `.md`, `.markdown`, `.txt`, `.html` or `.htm` path:

```bash
context-room migrate --root /path/to/project --import-lisiere /path/to/private-snapshot --legacy-draft SELECTOR --path docs/Recovered.md
context-room migrate --root /path/to/project --import-lisiere /path/to/private-snapshot --legacy-draft SELECTOR --path docs/Recovered.md --apply --revision REVISION
```

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

Android journal/outbox reconciliation and recording attachment
are separate from this canonical Mac text import.

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
