---
context_room:
  id: product.document-workflow
  depends_on:
    - product.model
    - assurance.review.human-authority
    - domains.shared.proposal-lifecycle
---

# Document workflow

## Summary

Agents read accepted documentation and prepare isolated changes through the CLI. Humans compare, correct, accept or reject files in Context Room. Local proposals use ordinary directories without requiring Git; Shared proposals use isolated Git worktrees and a separate final Git acceptance.

## Defines

Accepted local reads, local proposal behavior, direct-change recovery, editable notebooks, supported review formats, reader continuity, state migration and native drawing recovery and exact PNG corrections.

## Does not define

Shared Git delivery internals, authority protocol, required authoring conventions for other projects, or unimplemented universal document editing.

## Accepted reads

Normal `docs search` and `docs read` consume accepted versions. A modified or deleted accepted document remains readable at its previous accepted version. A new unaccepted document is absent. Being outside a watch rule does not make a file accepted. Drafts and submitted proposals are inspected through their explicit change handle, not injected into normal search.

Shared refresh resolves one immutable accepted revision per command. Offline responses disclose cached provenance. No model or background documentation researcher runs. Maintenance instructions belong in the user's agent prompt, such as AGENTS.md.

The CLI returns a generic reader token. Pass it through `--reader` to receive bounded updates for documents this reader previously encountered. An omitted token starts an independent reader; an unknown supplied token fails explicitly. An existing `--session` is optional. One agent never receives another reader's consumption history.

Context Room cannot hide physical files from programs reading the project directly. Its accepted-only guarantee applies to Context Room's normal documentation commands and projections.

## Local proposals

`changes begin` creates a full directory tree of accepted, editable, watched documentation and returns its path and change handle. It excludes unknown pending content and read-only resources. The agent edits normally inside that directory. Content-addressed base objects are shared across proposals. On filesystems that support it, independent copy-on-write files avoid copying unchanged disk blocks; there is an ordinary copy fallback. Drafts never share writable hard links with originals.

`changes status` reads current proposal state. `changes submit` freezes a manifest and puts its changed files in the Review Queue. A draft with existing file decisions cannot be silently resubmitted as another version.

The Hub also lists saved **Working drafts** separately from submitted reviews.
Open one to edit Markdown or plain text, save its working version, or preview
HTML visually. Saving never changes the ordinary document or accepted baseline.
**Submit for review** checks the exact saved workspace revision. A concurrent
edit or changed scope blocks replacement or submission, keeping the author's
unsaved text in the editor. Closing with unsaved changes requires saving or
undoing those unsaved edits. The connected owner tablet uses the same interface.
The integrated editor bounds a proposal to 256 working files and 64 MiB and an
opened text file to 16 MiB. Larger workspaces remain available to the CLI.

Accepting applies only the selected exact file delta. Saving a correction applies and accepts those corrected bytes. Rejecting an isolated file leaves its original unchanged. The remaining files retain their own pending decisions. The local proposal completes when all its files have decisions; it does not have an additional remote delivery step.

Application checks the project identity, scope, exact base, file mode, paths and staged Git state where relevant. The exact reviewed mode is explicitly applied to the new file descriptor, independently of the process umask; a concurrent permission-only origin change still blocks application. A conflicting external edit blocks application. A journal precedes the filesystem change; replaced bytes remain recoverable. Publication does not overwrite a file created concurrently at the destination. An interrupted application either resumes idempotently or reports recovery required.

## Direct changes

Existing workflows may still edit original files outside a proposal. Context Room detects changed watched files and keeps their accepted baseline separately. Human rejection restores that baseline, removes a newly added file, or restores a deletion/rename as appropriate, while preserving rejected content for recovery. It blocks a stale decision or incompatible staged Git state before changing bytes.

Keeping the UI closed does not authorize those edits. They are detected on the next scan. An ordinary filesystem read can still see them before review; agents needing isolation should use proposals.

## Review and formats

| Format | Human view | Human correction |
| --- | --- | --- |
| Markdown and plain document text | Accepted/proposed text and existing document view | Edit and save the exact file |
| HTML/HTM | Sandboxed rendered page; local proposal images and linked CSS are resolved from that exact proposal version | Agent edits source; human reviews the rendering, with no HTML source editor |
| Mermaid `.mmd` / `.mermaid` | Rendered diagram beside editable source | Edit diagram source; executable directives and external resources are blocked |
| Editable notebook `.crnb` | Frozen objects, pressure-aware ink and embedded raster assets, with author provenance | Correct the frozen scene, then decide that exact document |
| PNG, JPEG, WebP | Before/after image | Draw at native resolution, undo/redo strokes, save and accept |
| GIF, SVG and other recognized image assets | Before/after image where the browser decoder supports it | Review existing bytes; no animation or vector editing claim |
| PDF, DOCX, XLSX, PPTX | Changed binary resource and size; no integrated renderer promised | Accept/reject exact bytes; office content editing is not implemented |

Drawing is bounded to 16 million pixels; assets to 20 MiB. Larger or unsupported resources return an explicit limit, not a silent conversion. Supported binary changes use the same exact file decisions in Shared, followed by the separate proposal acceptance.

HTML resources are intentionally local and non-executable. Nested CSS resource URLs and arbitrary interactive HTML applications are not supported by the proposal preview. Missing resources are identified.

## Editable notebooks

The notebook action opens a retained working scene in an authorized ordinary
folder. Drawing, autosave and synchronization do not accept documentation.
Objects retain stable identity, revision and authorship; selective gesture
undo preserves independent edits. The original editable file and embedded
images remain exportable.

Connectors can retain explicit attachment sides and a routed return; text can
retain explicit line spacing. These properties survive editable-file export,
native editing and browser rendering. Selection outlines do not change the
style of the saved shapes.

Submitting freezes one exact version into the existing local or Shared
proposal lifecycle. Shared requires an existing connection and displays its
repository, project and destination before publishing. A lost response resumes
the retained submission, and a changed connection or newer proposal correction
blocks replacement. Later working ink stays outside the frozen review.
Correcting or accepting a proposal does not silently overwrite that later ink.

The [connected-device guide](../system/connected-devices.md) describes the
native Android preview, offline retention and restricted drawing permission.
The connected owner and [original-source conversations](conversations.md)
have their own scoped workflows and recovery checks. The preview does not
establish physical BOOX performance.

## Cleanup

Pending changes remain indefinitely unless the human decides otherwise. The cleanup dialog can preview and reject changes older than a chosen number of days, across all or selected projects. Automatic cleanup is initially off and requires an explicit human setting.

Selection binds exact revisions. Unknown age starts at first observation, not a guessed filesystem timestamp. A changed revision starts a new age. Drafts, unavailable items and stale selections are excluded or reported; a partial failure is recorded and is not reported as full success. Cleanup rejects changes rather than merely hiding the rows.

## Native drawing and retained transfer recovery

The PNG review action **Draw in Context Room** asks for an explicit editable
`.crnb` path in an existing permitted directory. It opens the native notebook
editor and its normal conversation/co-drawing controls; no Lisière CLI or service
is called. Preparation and autosave create a working scene, never an accepted PNG
or an accepted notebook. Scope, worktree and original review revision remain
bound throughout the session.

**Use saved drawing** freezes the exact editable scene and renders an inert SVG
to PNG at the original image dimensions. The person inspects that raster before
**Save and accept file** accepts exactly its bytes. Later working gestures are
not added to the frozen correction. Objects outside the original PNG crop remain
in the complete editable notebook; the interface states that distinction. The
existing integrated raster correction remains available alongside this action.

Original `.context-room/lisiere/sessions/<id>/` transfers are not restarted.
`migrate --legacy-session ID` inventories retained source, preview and structured
frames. Recovery requires an explicit frame and an unused ordinary `.crnb` path;
missing assets, object identities or revisions require reconciliation rather
than guessed content. See [Lisière recovery](../system/lisiere-migration.md) for
preview/apply and retained provenance. Old task identities remain history.

## Migration

For Lisière data, see the [private recovery export](../system/lisiere-migration.md).
It is separate from the existing Context Room control-state migration below.

Run `context-room migrate --root /path/to/project --format json` to inspect the compatibility migration. Apply the returned exact revision with `--apply --revision REVISION`. It backs up control-file bytes under `.context-room/migrations/workflow-v1/`, records a journal and installs the versioned workflow marker. Repeating it is idempotent and finishes an interrupted completion journal.

Existing baselines, drafts, Shared worktrees, Hub registrations and managed native links stay in place. Unknown configuration fields survive settings writes. Historical pending reviews without a separately recoverable accepted version are reported, not promoted to accepted truth. The prior files and Git history remain available for recovery.

Legacy Shared instruction manifests and commands remain as compatibility readers/managers, while documents and skills form the public model. Hosted runtime and integrated `ask` researcher entry points have been retired. Existing local Startup and Prompt Center capabilities remain available.

## Implementation evidence

The repository verification record at `docs/lifecycle/changes/active/refactor/verification.md` identifies the tests actually run, failures, and remaining physical checks. This working branch has not been packaged as an installed release or deployed.
