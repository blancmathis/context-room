---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: file explorer and editor
  last_verified: 2026-08-08
  sources: [src/context_room.mjs, src/codex_composer_bridge.mjs, schemas/config.schema.json]
---

# File Explorer And Editor

## Purpose

The explorer and editor expose safe project documents and visual assets in one compact workspace. They are not a full filesystem browser.

## Example Flow

1. Pick a hub card or browse the explorer.
2. Open a project document or visual asset.
3. Read rendered Markdown, preview HTML or images, inspect a diagram source, or edit an allowed text file.
4. Save editable files with the UI or keyboard shortcut.

## Common Actions

- Browse, search, expand folders, or filter by all, watched, and not watched files.
- While a document is open, switch between **Location** and **Related**. Related uses the same deterministic graph to separate dependencies, dependents, references, backlinks, diagram appearances, and unresolved targets.
- Browse safe hidden files and `.context-room` by default; use **Preferences → Explorer and file behavior** to hide dotfiles and dotfolders.
- Use the workspace toolbar to return to the hub, navigate history, and act on the current file.
- Resize the desktop Explorer between 220 and 360 pixels by dragging its
  separator or using Arrow keys while the separator is focused. Context Room
  remembers the explicit width locally.
- Collapsing the Explorer expands the document without hiding the workspace
 toolbar. Wide layouts retain a compact 48-pixel rail; narrow layouts use a
 temporary drawer.
- Read embedded Mermaid diagrams without loading Mermaid on documents that do not contain one. Standalone `.mmd` and `.mermaid` files use the same adapter with Rendered, Source, and Split modes. Rendering uses strict security, removes interactive directives, and reconnects only recognized `cr://` document links.
- Open the document **Context** panel for complete metadata, every matching profile, identities, labeled connections, trust state, and structured Health issues. Unknown metadata remains visible in its original tree instead of being discarded.
- Opening a file, including one in another registered project or proposal
  room, never reopens a collapsed Explorer. Context Room still expands the
  file's ancestors and selects its location behind the closed rail.
- On a desktop pointer, touching the left screen edge temporarily reveals a
  closed Explorer. Moving away closes it again; using the Explorer control
  keeps it open and saves that explicit preference.
- Open project text files and visual assets; files outside `allowedPaths` stay read-only.
- Edit and save allowed files. HTML visual documents render directly; their source is changed by an agent and reviewed in the queue.
- Preview PNG, JPEG, GIF, WebP, AVIF, and SVG files directly. The reader shows their format, size, dimensions, and a fit/actual-size control.
- Open Mermaid, PlantUML, Graphviz, and draw.io source files (`.mmd`, `.mermaid`, `.puml`, `.plantuml`, `.dot`, `.gv`, and `.drawio`) as readable source documents.
- Select Markdown text with normal editor gestures: drag, Shift-click, double-click a word, or triple-click a line. Native Delete, Backspace, cut, copy, paste, undo, redo, and keyboard selection operate on that selection.
- Select text in the source editor, then use the floating **@ Codex** action above the selection or its configurable shortcut. Context Room adds a native, clickable file mention and the source line range to the active Codex composer without sending it or replacing the existing draft. Clean saved files omit the selected passage because Codex can read it from disk. An unsaved selection includes the selected bytes and labels them `unsaved`. If the local bridge is unavailable, Context Room copies the same compact reference instead.
- Create Markdown files and folders from the explorer.
- Select files or folders for bulk actions.
- Watch one file exactly, or choose a folder watch mode for one or more selected folders.
- Remove exact selected file watches or folder rules without changing the files themselves; an ancestor rule may still apply.
- Preview the exact current revisions of selected files or folder members, then delete them after confirmation. A changed member makes the whole deletion stale before any path is removed.
- Inspect Git diffs, hide them, or revert the current file diff. Revert is bound to the exact diff revision currently displayed.
- Keep navigating when Git diffs, pending reviews, or disk changes exist; resolve a disk conflict only before overwriting it.

## Rules

- `allowedPaths` is the edit boundary.
- `watchAllow` and `watchRules` form the review boundary.
- File reads and mutations follow the applicable physical-containment,
  exact-revision, and atomic-preflight rules in
  [Server boundary](../assurance/server-boundary.md).
  A stale delete or revert returns `409` and preserves the newer state.
- Explorer trees, menus, drawers, dialogs, controls, and status follow
  [Interface accessibility](../assurance/interface-accessibility.md).
- Secret-looking paths, dependency folders, and build outputs stay out. Supported visual assets are the only binary files exposed by the explorer.
- Binary images are read-only and never enter the text editor or text review queue. Edit and review their source diagram when one exists.
- `.git`, dependencies, caches, and build outputs stay excluded even when hidden files are shown. Sensitive environment files remain read-only and expose names only, never values.
- External startup files are shown through explicit startup surfaces. Other external files appear only when their `~/...` file or folder is explicitly present in `allowedPaths`.
- Pending changes never block navigation. A disk edit becomes a conflict only when the current editor buffer differs from the last successful save; otherwise it enters normal external review.
- A Codex reference uses the live editor buffer and labels unsaved content. Diff-review selections are excluded because deleted and replacement lines do not map unambiguously to the current file.
- Direct composer insertion requires Codex to run with a loopback-only renderer bridge. Context Room resolves the selected file inside its allowed path boundary, chooses only an exact native Codex file-mention match, and never submits the composer.
- File data, annotations, Git diff state, and review data load concurrently.
- File text appears as soon as it is read; slow Git diff or review work never holds the document behind a loading screen.
- Intentional hover or keyboard focus preloads file content and Git diff; repeated opens reuse the result until the file changes.
- The workspace toolbar and file actions replace one stable loading state together instead of appearing in stages.
- Markdown keeps its rich line rendering and shows discreet source line numbers in a narrow gutter; wrapped text keeps one number for its source line. Code, JSON, and large files use a lightweight text surface to keep opening fast.
- The reader uses the system interface font, a 65–76 character measure, and a
  calm continuous canvas. Themes change palette without changing controls,
  spacing, or navigation geometry.
- The Markdown overlay is visual only. The real text field owns pointer selection, clipboard commands, keyboard editing, undo history, and scrolling; the overlay mirrors its caret, selection, and viewport.
- HTML opens as a sandboxed visual preview. Scripts, forms, and external resources cannot run. Safe relative or `cr://` navigation is intercepted by the shell and resolved through Context Room instead of allowing the iframe to navigate itself.
- HTML previews inherit the active Context Room theme and its built-in visual components.
- Watched HTML changes use the same review queue and source diff as other watched files.
- Supported image files open in a fitted visual preview and can temporarily switch to their actual pixel size. SVG is treated as an image preview, not executable HTML.
- Mermaid source formats render locally. PlantUML, Graphviz, draw.io, and future formats use the versioned renderer registry; when an explicitly enabled local renderer is unavailable, Context Room always falls back to exact source and reports the missing renderer.
- Search rendering is frame-scheduled so typing stays responsive in large explorers.
- In a global room, selecting a project loads only its direct root children. A folder loads when it is expanded, pages are limited to 250 entries with folders first, and cached pages are isolated by project, worktree, and path. Each response carries a revision for freshness checks.
- Global project search uses paths and lightweight file metadata only. It does not read document bodies or summaries. Search waits 100 ms after typing and an obsolete request cannot replace the currently selected project.
- Right-clicking a local folder exposes **Link this skill location to shared…** when the selected project has a shared-context binding. The assistant imports only direct child folders with a standard skill entrypoint, previews conflicts, and leaves the source untouched until its `skills` proposal is accepted.

## Folder Watch Options

Watching a folder from its context menu or a bulk selection presents four choices:

| Explorer option | Config mode | Result |
| --- | --- | --- |
| Folder and all subfolders — current and future files | `recursive-live` | Watches eligible files now and later at any depth. This is the default. |
| Existing files in folder and subfolders | `recursive-current` | Takes a snapshot of eligible files at any depth. Later files and folders do not join it. |
| Existing files in this folder only | `direct-current` | Takes a snapshot of eligible immediate file children. Subfolder contents and future files stay out. |
| This folder only — current and future files | `direct-live` | Watches eligible immediate file children now and later. Subfolder contents stay out. |

Watching one file remains an exact one-click watch. Allowed folders remain visible in the Explorer even when they are empty, so a live rule can be applied before the first file exists. Folder rules govern files; Git and the review queue do not review empty directories. The recursive live option retains the folder rule, so a file created later inside a new deeply nested folder enters review as a new file.

The same four options apply to an external `~/...` folder only after that folder is explicitly listed in `allowedPaths`. External watches never expand the edit boundary. Because project Git cannot describe those changes, Context Room labels a first-seen external file as new, records the accepted content in its local review baseline, and compares later edits or deletion against that baseline.

For the persisted JSON contract, overlap rules, and snapshot shape, see [Agent configuration](../agent-configuration.md#watchrules).

## Source Map

- `isAllowedMemoryPath` enforces the edit boundary.
- `listMemoryFiles`, `listExplorerFiles`, and `listExplorerDirectories` build the focused file and review workspace. `listProjectExplorerPage` provides the progressive global-project Explorer without reading file content.
- `readMemoryFile` and `writeMemoryFile` handle normal file IO.
- `renderExplorerContextMenu`, `createMarkdownFile`, and `createFolder` handle explorer creation.
- `applyExplorerFolderWatchMode`, `showFolderWatchModeDialog`, `addSelectedToWatch`, and `removeSelectedFromWatch` apply the same four folder modes to context-menu and bulk actions.
- `deletePaths` handles bulk deletion separately from watch configuration.
- `renderViewer` renders preview, editor, diffs, conflicts, and annotations.
- `referenceCodexSelectionInCurrentTask` posts the selected path and line range to `/api/codex/reference`. `insertFileReferenceIntoActiveCodexComposer` creates the native file mention through the active loopback Codex renderer bridge; compact clipboard copy is the safe fallback when that bridge is unavailable.
- The renderer event and launcher pattern are compatible with the unofficial [Codex Deck bridge](https://github.com/dazer1234/codex-stream-deck). This is an internal Codex compatibility boundary and may require an update after a Codex release.
- `contextRoomVisualDocumentStyles` supplies themed HTML components without adding CSS to each document.
- `background_worker.mjs` keeps Git diff work off the HTTP and UI critical path.
