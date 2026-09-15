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
Lisière executable or service. Import and installation cutover remain in progress.

## Defines

The recovery snapshot format, source compatibility, private export, exact
revision precondition and interrupted-export recovery.

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

`manifest.json` lists JSONL tables, column order, row counts, byte lengths and
SHA-256 hashes. Binary cells use a `base64` wrapper; integers outside JavaScript's
exact range use an `integer` decimal wrapper. Original drafts, deletion records,
queued operations and history remain recovery data, with `accepted: false`.
Compressed Android cells stay exact and have not yet been replayed or imported.

Known pairing tokens and executable native-request grants are excluded. The
export does not read authentication preferences, private keys or integration
configuration. This does not remove sensitive material the user wrote in their
own content. Android recording files and earlier project handoff directories
are not yet part of this database export.

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

## Completion boundary

The old installation remains active and can receive later writes. This snapshot
is a point-in-time recovery copy, not a synchronization or single-writer fence.
Do not retire the old installation until imports, pending work, conversation
links, device identity and physical validation have their own receipts. The
[convergence verification record](../lifecycle/changes/active/android-convergence/verification.md)
tracks those open gates.
