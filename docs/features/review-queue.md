---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: review queue
  last_verified: 2026-07-26
  sources: [src/context_room.mjs, bin/context-room.mjs, docs/agent-configuration.md]
---

# Review Queue

## Purpose

The review queue shows watched documentation that needs verification before it becomes trusted context.

## Example Flow

1. Configure `watchAllow` and optional folder `watchRules`.
2. Open a queued file.
3. For a Git change, accept or reject each visible change, or use `Accept all` or `Reject all` even when only one change remains; the completed diff records the review.
4. When several files were removed together, expand the deletion set, inspect or narrow the selected paths, then confirm their removal once.
5. When Git has no diff, review the current document and use `Mark verified`.
6. Review newly discovered startup instructions and skills once; they return only when their content changes.

## Rules

- Review owns the final trust decision.
- Agents may surface the queue, but should never mark files verified for the user.
- Snooze is a visibility preference, never a review decision. It hides only the exact displayed local content hash or shared proposal head from Home until its return time. The item remains pending and is listed under **Settings → Review and trust → Snoozed reviews**.
- Snoozed reviews continue to block configured review gates and prevent a false all-clear state. A changed file hash or proposal head returns immediately; expiry or **Return now** also restores the item without changing its review state.
- Home selection can combine local file reviews with shared proposals. Its rejection action marks local files **Needs changes** without deleting them; shared proposal rejection follows the separate Git archive contract in [Global Context Room](context-hub.md).
- The owner can select one or several blocking checkpoints: commit, push, pull request, or merge. Commit, push, and local merge use managed Git hooks; hosted checks require provider wiring.
- `watchAllow` defines documents that require human verification for every current content hash. Git status supplies a diff when available, but never decides whether a document is trusted.
- A watched Git-clean document with no verified current hash stays in the queue. After verification it leaves immediately; any meaningful content change creates a new review even if the change has already been committed.
- An explicitly allowed `~/...` path follows the same scope using a Context Room review baseline because project Git does not own it. A folder entry keeps the compatible recursive live behavior.
- `watchRules` can narrow a folder to current-file snapshots, direct children, or both. Only live modes admit later files; only recursive modes admit subfolder files. See [Agent configuration](../agent-configuration.md#watchrules) for the canonical mode contract.
- The queue reviews files, not empty directories. A retained live folder rule makes eligible future files enter as new-file reviews.
- The first eligible file discovered under an external watch is labeled new and reviewed as a whole. Verification records its local baseline; later external modifications and reviewed-file deletions receive inline baseline diffs with synthetic `M` and `D` states.
- Legacy `reviewPaths` are merged into the watched scope when `allowedPaths` covers them. The next human Settings save removes the deprecated fields without widening the allowed boundary.
- Every project `AGENTS.md` is implicitly watched, even when nested outside configured documentation folders, and follows the same hash-based review rule.
- Every entrypoint exposed by Startup skills requires an initial review and hash-based re-review after changes.
- Context Room captures an untrusted observation baseline when an external startup resource is first discovered. An unchanged initial review uses whole-document acceptance or a non-destructive request-changes decision; an edit made before that decision already receives the normal inline diff.
- Changes that predate the first Context Room observation need an existing Git version, backup, or recovered snapshot; Context Room does not invent missing history.
- A startup resource already represented by a normal Git queue item is shown only once.
- The queue uses its normal risk, authority, and path order. Legacy `reviewPaths` array order has no effect.
- Reader-facing headings such as `Question: ...` are normal prose. Only explicit unresolved-task markers, including `[QUESTION]` or `<!-- QUESTION -->`, create an unresolved-question issue.
- `Mark verified` appears for any queued document with no meaningful Git diff. Git changes are completed through their inline diff.
- Mixed paragraph edits stay inline when changed words are at most 25% of the combined before and after text. Larger rewrites use separate paragraphs; simple additions or removals stay inline.
- Verified content is also recorded in the shared review ledger by canonical absolute path and content hash, so another Context Room watching the same file does not require a duplicate review.
- Updating only `context_room.last_verified` is not a review change: it stays out of the queue and inline diff, and syncs silently when the file is open.
- After the final inline decision, navigation waits until the review is saved.
- Pending review changes never block Hub, history, settings, reload, or another file. Partial decisions remain available when the file is reopened in the same session.
- Accepting or rejecting a change keeps the current reading position throughout the animation and final render.
- Review navigation is manual: use `Next review` to open another queued doc.
- High-confidence one-to-one renames stay a single `old path -> new path` review item. Unmatched deletions remain explicit.
- Two or more unmatched Git deletions are grouped into one expandable change set. New, modified, and rewritten replacement documents stay individually reviewable.
- Unmerged Git deletion conflicts stay individual and never enter the batch confirmation set.
- The deletion set loads pending paths on demand beyond the normal 80-item queue response, up to 5,000 at a time. After one very large set is confirmed, reopening loads the next pending set.
- `Confirm removals` never deletes files. It records that the selected paths are already absent and that their removal was intentional.
- Before saving a batch decision, the server checks that the loaded set key still matches, then rechecks that every selected path is still watched, Git-deleted, absent, and not recognized as a rename. A stale set must be reloaded; paths that change during the final write are skipped and remain visible for review.
- Required-review, canonical, agent-instruction, other high-authority, and uncertain-history deletions are marked `protected`, start unselected, and require a separate acknowledgement when included.
- Review trust records whether a resource was `present` or `absent` plus the last Git change for an absent path. When Context Room observes a restored path, it clears that deletion trust so a later deletion at the same path requires review again.
- Code and JSON should stay out of Markdown review unless the user explicitly wants them there.

## Source Map

- `buildDocQaReport` builds the queue.
- `isWatchedPath` resolves legacy paths and the most-specific structured folder rule before queue items are admitted.
- `buildDeletedReviewBatch` builds the current on-demand deletion page.
- `writeDeletedReviewBatchDecision` revalidates and records selected removals.
- `writeDocReviewDecision` records review decisions.
- `readGlobalReviewLedger` lets multiple Context Rooms trust the same absolute path and content hash.
- `readFileDiff`, `readReviewBaseFile`, and `startChangedFileInlineReview` power Git-backed and external-baseline review diffs.
- `context-room guard` and `review-only` report pending review without blocking; only strict mode can fail.
