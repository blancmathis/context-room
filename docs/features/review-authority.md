---
context_room:
  id: assurance.review.human-authority
  depends_on:
    - strategy.context-room
    - domains.truth.layers
---

# Human Review Authority

## Summary

Humans own file review decisions and Shared proposal acceptance or rejection. Context Room preserves that authority through separated agent and owner surfaces, monotonic agent permissions, exact review evidence, and one-use terminal request binding.

## Defines

This document defines who may decide, what evidence a decision covers, the mandatory agent confirmation protocol, and limits of technical enforcement.

## Does not define

This document does not define queue ordering, diff rendering, Git delivery algorithms, identity-provider deployment, or conversational UX beyond the mandatory confirmation rule.

## Authority rules

1. A human decides whether each file change is accepted, rejected, or needs changes.
2. Individual file decisions are available only in the direct human interface.
3. A Shared proposal terminal decision is separate from its file decisions.
4. Agent-facing commands do not expose file decisions, proposal acceptance, proposal rejection, or verification.
5. Agent-controlled settings may widen review coverage but may not narrow owner-authorized coverage.
6. Snoozing changes visibility only; it does not change trust.
7. Recovered or damaged authority evidence is not silently trusted.

## Human corrections and cleanup

Saving a human correction through the document editor accepts that exact corrected file. It does not accept the rest of a proposal or perform the separate Shared terminal decision. Subsequent agent changes reappear in review.

Pending changes never expire by default. A human may request one-time rejection by age/project, or explicitly enable the same rule in the cleanup dialog. The stored rule is signed owner authority and is not an ordinary agent setting. Applying it performs real rejection with per-item receipts; unavailable, changed or conflicted revisions remain pending with an error.

## Agent confirmation protocol

Before an agent performs a multi-file review mutation or assists with a terminal proposal action:

1. it asks whether the user wants the exact action;
2. after the first affirmative answer, it restates the exact project, repository, proposal or file set, and effects;
3. it asks again;
4. it does nothing unless the user gives a second separate, unambiguous affirmative answer.

Confirmations do not transfer to another action, scope, proposal head, or retry.

This is a behavioral authority rule. The command surface reinforces it by withholding terminal commands, but the runtime cannot prove the semantic content of a conversation.

## Owner-authorized scope

Context Room stores the last owner-authorized review scope outside project configuration. Direct configuration changes that narrow the protected scope do not become effective automatically. They produce an authority issue until the owner saves the intended scope through the human Settings surface.

## File review evidence

Trusted evidence binds to exact resource state, including canonical path, content hash or absence, file mode where relevant, resource version, dependency versions where required, and owner-authority integrity.

A changed hash, restored deletion, changed mode or changed proposal head invalidates the old decision. Dependency links provide navigation; unchanged dependent documents are not added to review.

A review base write (`POST /api/docqa/review-baseline`) may carry `expectedContentHash`, the hash of the version the reviewer saw. When the file changed since, the write fails with 409 `review_revision_conflict` and the base stays as it was, so the newer change still shows in review. The review flow always sends it, because it saves decisions after the next file opens.

A local proposal file closed by "Compare with current file" is not a decision. When the project file already holds the agent's version, or the file is deleted on both sides, nothing is left to decide: the proposal records the file in `settledFiles` (who: the human, via `compare-current`; when; why: `already-in-project` or `deleted-both-sides`), writes no file and no review evidence, and shows it in the proposal view. A proposal whose files were all closed this way gets the status `settled`, never `accepted`, `rejected` or `resolved`.

## Receipts and undo

Each local file decision writes a signed receipt in the private review authority, outside the project. The receipt holds the exact version decided and the evidence it replaced. Writing the receipt index commits the decision. A decision interrupted before that point is undone by the next review writer. Until then, readers see the evidence from before the interrupted decision. A journal that cannot be verified closes review writes until it is repaired.

"Undo this acceptance" restores the evidence from before one local acceptance: the previous review entry, its baseline and the global ledger key, or their absence. It never changes the file or the Git index. The file goes back to review against the previous accepted version.

Undo is offered only for the latest decision on that file, within 30 days, for acceptances made in the file review or the Hub queue. It is refused when a newer decision exists, when the file, its mode, its Git index entry or its dependencies changed, or when a receipt or a kept baseline is missing or altered. Rejections, corrections, proposals, assets, Shared decisions and decisions made before receipts existed are not undoable. A bare "unverified" request to the local review route is refused. Retrying a request with the same request id returns its first result.

## Trust the current versions

A project with no accepted version yet can accept all its current files in one explicit human gesture: "Trust the current versions". It is never a default. The Hub offers it after "Add a project" and in the project's Documents card while no file has an accepted version. `project register` only reports the offer (`trustCurrentVersions`); agents cannot perform it.

- The person first sees the exact list and count of files: present in the project, with no review entry, not an asset, not already accepted in the review ledger of the Git top level (a parent location's acceptance is never replaced), and with staged Git content equal to the file. Files with different staged content stay in review. This list is the only count shown: the project card only says that the gesture is offered, and `project register` reports the same list's count. The dialog opens with the focus on Cancel.
- The confirmation sends that exact list with each content hash. The route needs the owner-interface nonce, like any review decision. If any listed file changed, or a new file joined the list, nothing is written and the request fails with `trust_current_stale`.
- The gesture accepts each file as it is now, in one review transaction. The baseline bundle that keeps the full text of every file is split into parts of about 4 MiB, each a complete bundle file; each accepted entry names its own part. It writes ONE signed receipt (`action: "trust-current"`) that names every part (`bundles`) and lists each file, its content hash, its ledger key and the ledger value it replaced. The receipt index stays at version 1: the receipt becomes the head of every ledger key it covers.
- A request id already used by a trust that was undone is refused with `trust_current_undone`: it never replays a receipt that no longer accepts anything.
- "Undo this trust" removes every acceptance of that gesture at once and restores each ledger key, or its absence. Files are not changed. Undo is refused after 30 days, or when a newer decision covers any of the files, or when any entry differs from the receipt. A file edited after the gesture does not block undo: there is no earlier accepted version to restore. The bundle parts are removed after the undo commits, once no entry names them; a part left by a crash names no accepted version and is removed by the next trust that writes it.
- One gesture takes at most 5 000 files. Above that, the list is refused before any file is read, with a sentence that says to register a smaller folder or review the files one by one.

## Size of the review records

Review control files have their own bound, 8 MiB per file, larger than the 750 KB limit for project files. `.context-room/review-state.json` and the review ledger at the Git top level grow by about 1 KB per accepted file, so they hold several thousand accepted files per location. Baseline bundles hold the full text of the files they keep; a trust splits its bundle into parts of about 4 MiB, so the text of the trusted files has no total bound (a file is at most 750 KB). Every review write refuses to pass the bound with `review_control_file_too_large` (413) before anything is written; the message says the review records would grow past 8 MB and what to do. Every rollback snapshot, rollback, undo and recovery reads these files up to that bound. The review journal holds a copy of up to three such files and is read up to 33 MiB: a trust journals its new parts as absent (small), and an undo keeps the parts out of the journal.

## Terminal request binding

The terminal UI requests a short-lived, one-use challenge bound to principal, review authority, action, repository, proposal branch, and exact head. The challenge is consumed before mutable terminal work begins. A retry requires a new challenge.

The loopback runtime proves continuity with the current owner-interface instance. Context Room does not introduce an additional Shared administrator role.

## Security limit

A nonce, challenge, and separated CLI block accidental or raw unauthorized requests. They do not prove physical human presence against an unrestricted process or browser automation running as the same OS user. Product claims must state this limit.

## Failure behavior

Missing, altered, replayed, expired, mismatched, recovered, or stale authority evidence fails closed. The user must reopen or rematerialize the review and establish fresh exact decisions.
