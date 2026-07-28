---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: Codex Prompt Center
  last_verified: 2026-07-23
  sources: [src/codex_prompt_center.mjs, src/context_room.mjs, schemas/codex-prompt-catalog-v1.schema.json, schemas/codex-prompt-overrides-v1.schema.json, schemas/codex-prompt-publication-state-v2.schema.json, schemas/codex-prompt-runtime-receipt-v2.schema.json, test/codex_prompt_center.test.mjs]
---

# Codex Prompt Center

## Purpose

Codex Prompt Center is the Context Room editor for prompt targets published by a compatible local Codex runtime. It does not guess which modes or model prompts exist. The installed runtime owns the catalog; Context Room renders every group and target it receives.

Open **Settings → Codex prompts**, then select **Open prompt editor**. The catalog is loaded only when this dedicated editor opens, so prompt discovery does not slow normal project startup or compete with the review queue.

## Compatibility Prerequisite

This integration currently targets OpenAI Codex tag [`rust-v0.145.0`](https://github.com/openai/codex/tree/rust-v0.145.0), source commit [`25af12f7e61572b0bc18ddb1008be543b91519b0`](https://github.com/openai/codex/commit/25af12f7e61572b0bc18ddb1008be543b91519b0), with companion release [`v1.0.0`](https://github.com/Swarek/codex-default-no-assumptions/tree/v1.0.0) and its [`patches/codex-prompt-overrides-rust-v0.145.0.patch`](https://github.com/Swarek/codex-default-no-assumptions/blob/v1.0.0/patches/codex-prompt-overrides-rust-v0.145.0.patch). A stock build does not publish this contract. Follow that pinned release README to install the Apple Command Line Tools that provide `/usr/bin/python3`, build, and install the compatible runtime, then fully restart Codex before opening Prompt Center.

Installing the compatible runtime is the one-time prerequisite. After that, normal prompt changes happen in Context Room: save the override, fully restart Codex, and create a new task. Rebuilding is needed only when installing a different Codex version or changing the runtime patch itself.

A compatible runtime creates:

```text
$CODEX_HOME/prompt-overrides/catalog.json
```

The file must be private mode `0600`, use `schemaVersion: 1`, publish `runtimeVersion` and `groups`, and carry a valid typed `catalogRevision`. Prompt Center fails closed and remains read-only when that diagnostic file is absent, insecure, malformed, or from another protocol version. This file check proves compatibility only; the per-process receipt described below is still required to prove what a running Codex process loaded.

## Editing Flow

1. Select a runtime-published target.
2. Compare **Official**, **Effective after restart**, and **Runtime loaded**.
3. Edit the complete **Effective after restart** text.
4. Inspect the exact, non-normalized diff.
5. Select **Save override**.
6. Quit Codex completely (`⌘Q` on macOS), reopen it, then create a new task.

**Restore official** always asks for confirmation, then removes the saved override for that target. It does not copy an old upstream prompt over the current catalog.

The three surfaces have distinct meanings:

- **Official** is the current baseline published by the installed Codex build.
- **Effective after restart** is the desired text after applying the current registry to the official baseline. A read-only target shadowed by explicit Codex configuration instead shows the runtime-published effective text.
- **Runtime loaded** is reconstructed per process from that process's immutable catalog snapshot plus its exact concrete target hash. It proves only what the local runtime resolved and loaded for that target. It does not prove that a collaboration mode was selected, that the target entered a particular task's assembled context, or that it was sent to a model. Receipt files never contain prompt text.

The catalog is intentionally broader than the editor. Context Room discovers groups and statuses from the runtime rather than maintaining its own list. Every target belongs to one authority class:

- **Editable here**: the runtime publishes an official baseline, an effective value, `editable: true`, `securityClass: local_user_editable`, an allowed editable runtime status, and one coherent override strategy. Only model-base, developer, local compaction, and selectable collaboration targets can enter this class.
- **Configurable elsewhere**: another local Codex configuration or task-history surface owns the value. Prompt Center shows the owner and read-only reason instead of competing with it.
- **Protected**: security-, protocol-, enforcement-, lifecycle-, platform-, or client-owned instructions are metadata-only. Prompt text and hashes are not published to Context Room.
- **Server-owned**: a remote service owns the instruction. The target is metadata-only and cannot be replaced locally.

The platform-supplied system prompt and remote/server compaction instructions cannot be read or replaced through this local integration. Prompt Center shows only their metadata and read-only reason. This boundary is enforced by both the JSON catalog contract and Context Room's runtime checks; a forged `editable: true` flag is rejected.

In the Codex 0.145.0 compatibility contract, Default and Plan are `selectable` and editable. Pair Programming and Execute are `dormant` and read-only. `selectable` describes a runtime-supported template; it does not assert which mode a task selected. Bundled, cached, and configured model targets can be editable when the runtime also marks them `local_user_editable`.

Raw-provider model targets can also be `catalogued` before their runtime is active—for example, a Bedrock model discovered from provider configuration. `catalogued`, bundled, cached, and configured model targets can be editable only when the runtime also supplies the complete local-user-editable contract.

## Exact Overlays

Context Room stores an exact contextual replacement instead of a permanent copy of the whole upstream prompt:

```json
{
  "targetId": "example/target",
  "officialHash": "sha256:…",
  "patches": [
    {
      "before": "Exact official text",
      "after": "Exact replacement text",
      "expectedMatches": 1
    }
  ],
  "replacement": null
}
```

The editor first derives one deterministic contextual span from the longest shared prefix and suffix. If that span is ambiguous or cannot reproduce the draft exactly, it falls back to one bounded full-document patch. Codex still requires exactly one source match. If an upstream update changes the official hash or anchor, Prompt Center reports a conflict instead of silently loading stale instructions.

The runtime publishes `overrideStrategy` for each editable target. A non-empty baseline normally uses `patch`; an intentionally empty baseline uses `replacement`. Context Room does not infer this rule from a target name. Targets without published official content cannot use the full-text editor because Context Room cannot derive a safe overlay.

A wildcard model override always has `targetId: model/base/*`, `officialHash` omitted or `null`, one or more patches, and `replacement: null`; it cannot bind to one official model hash or replace multiple baselines wholesale. Its catalog row is read-only pattern metadata with `kind: model_base`, `runtimeStatus: pattern`, `securityClass: advanced_pattern`, `targetPattern: model/base/{modelSlug}`, and no prompt text or hash. `sourceTargetId` is either `null` or `model/base/*` when that wildcard override is active. Saving one concrete target back to its official text materializes an exact concrete no-op patch. Exact target precedence then neutralizes the wildcard for that model without deleting or weakening the wildcard for other models.

Runtime-detected conflicts remain recoverable. The catalog publishes `overrideConflict: { code, message, sourceTargetId }` with one of the current codes `official_hash_mismatch`, `strategy_mismatch`, `patch_anchor_mismatch`, `effective_prompt_too_large`, or `target_became_personality_dependent`. Context Room shows the exact runtime message. Normal drift conflicts on a trusted editable target can be repaired by saving a corrected exact override or removing the conflicting source. A model target that became personality-dependent stays read-only, but its stale exact override remains removable so the user can migrate to a personality-qualified target. A stale runtime conflict disappears from the desired state as soon as the current manifest resolves cleanly; the runtime-loaded surface still requires a restart to change.

An explicit Codex developer, compact, or model prompt configuration has higher priority than the registry. The runtime publishes that target as `shadowed_by_explicit_config`, `editable: false`, and `securityClass: config_shadowed`, with the explicit configuration in the effective surface. A resumed task can similarly publish `shadowed_by_session_history` with `securityClass: session_history` because its historical base prompt remains fixed for conversation consistency. Context Room never applies a saved registry override over either read-only value, but an exact stale registry entry remains removable.

## Concurrency And Validation

Every new validation and save request rechecks:

- catalog revision;
- official hash;
- current override hash;
- target editability;
- target presence and catalog-published override strategy;
- `securityClass: local_user_editable` and an explicitly allowed editable runtime status;
- exact overlay result;
- 28 KiB UTF-8 prompt limit;
- 8,192-token estimate limit using `ceil(UTF-8 bytes / 4)`;
- 16 MiB aggregate manifest limit.
- manifest revision increment within JavaScript's maximum safe integer.

A stale edit returns `409 Conflict`. The browser preserves only genuinely modified drafts while it loads the new baseline, so the user can compare and retry instead of losing text or overwriting another change. A manual catalog refresh and every successful global manifest mutation invalidate cached target details; untouched drafts reset to the newly published effective text, while modified drafts remain available for deliberate review against that new baseline.

The editor shows live UTF-8 byte and estimated-token counts. A draft above either runtime limit cannot be saved. Above 1,000 estimated tokens, **Save override** requires an explicit high-context confirmation because that target can consume substantial context whenever the runtime uses it. The server requires the corresponding boolean acknowledgement too; a client cannot bypass the confirmation by calling the API directly.

An override whose target disappeared, changed strategy, or became read-only is shown and counted as a conflict instead of making the whole Prompt Center unavailable. New saves remain blocked until an orphaned or structurally incompatible entry is removed, while **Restore official** remains available. Runtime-reported conflicts remain editable only when the runtime still publishes trusted editable authority; migration conflicts can deliberately be read-only and removable instead.

After the atomic manifest rename succeeds, a later receipt-refresh failure cannot turn that commit into a false save failure. The API returns the committed target with `commitWarning`; the UI reports that the override was saved while its runtime-loaded status remains temporarily unavailable.

Because the global Context Room and temporary exact-proposal review services can
expose the same global Prompt Center, a private lock directory serializes the
final revalidation and atomic manifest replacement across processes. Its
`owner.json` binds the lock to a PID, that process instance's start time when
available, and a random generation token. A verified live owner is never
evicted because of age and produces `409`.

Every owner or reclaimer whose recorded start time is `null` first receives a 30-second incomplete-record grace period. After that grace, Context Room compares the current process start with the owner record timestamp: a process that predates the record remains a live owner, while a valid later start proves a reused PID. If that start remains unavailable, malformed, or throws while the PID is alive, Context Room fails safe and keeps the lock blocking.

Stale-lock recovery creates `.reclaim` inside that exact lock directory with exclusive `wx` creation. The reclaimer then rereads the directory, owner, and claim identities through the same paths. When every identity still matches, it atomically renames that generation to a unique private retired path before cleanup. Release uses the same generation-retirement transition after verifying its owner and the absence of a reclaim claim. A successor can therefore claim the canonical lock path immediately without being deleted by delayed cleanup of the retired generation; a second live or fresh reclaimer still receives `409`.

Read-only targets remain visible with the runtime-provided reason. The UI does not hardcode `Default`, `Plan`, model names, or any other target ID.

## Private Storage

Prompt state belongs to Codex, not to a Context Room project:

```text
$CODEX_HOME/prompt-overrides/
├── catalog.json
├── overrides.json
├── last-known-good.json
├── .publication-state.json    # runtime-owned publication ordering; read-only here
├── .context-room-write.lock/
│   ├── owner.json
│   └── .reclaim              # present only during stale-lock recovery
└── runtime/
    ├── <pid>.json
    └── <pid>.<catalog-hash-hex>.catalog.json
```

`$CODEX_HOME` defaults to `$HOME/.codex`.

**.publication-state.json** is a schema-v2 file owned by the compatible Codex runtime. It serializes multi-process catalog publication through registry and owner generations and uses mode `0600`. Context Room reads it only to verify runtime receipts; it never writes, restores, deletes, or exposes it as an editable prompt.

Security rules:

- the storage root and owned directories use mode `0700`;
- state files use mode `0600`;
- reads reject roots or runtime directories that are not `0700`, and reject catalog, manifest, publication-state, receipt, or snapshot files that are not `0600`;
- sensitive files are opened once with `O_NOFOLLOW`, validated with `fstat` on that same descriptor, read with a hard byte bound, and decoded as fatal UTF-8 before JSON parsing;
- writes use a private temporary file, `fsync`, and atomic rename;
- before each changed save or restore, `last-known-good.json` receives an atomic private copy of the previous manifest;
- a manifest revision at `9007199254740991` is rejected before backup or rename because it cannot be incremented safely;
- symbolic storage roots, state files, and runtime receipts are refused;
- browser requests contain opaque target IDs, never filesystem paths;
- Prompt Center requires a loopback socket peer and the active loopback host, rejects an incompatible `Origin` or `Referer` and explicit cross-site requests, and permits local clients that omit those browser headers;
- every mutation, including one from a headerless local client, requires both the active project identity and the random page nonce;
- prompt text never enters `.context-room/config.json`, the review ledger, Git, runtime receipts, or logs;
- Context Room never edits `config.toml` automatically.

Catalogs, immutable runtime snapshots, `overrides.json`, and `last-known-good.json` contain plaintext prompt content. Mode `0600` prevents access by other OS users, but any process running as the same user can still read it. Never put passwords, API keys, access tokens, private keys, or other secrets in a prompt override.

**Restore official** removes the active override, but the previous text can remain in `last-known-good.json` and older runtime snapshots until they are replaced or garbage-collected. Context Room does not currently provide a destructive purge button. For a recoverable full reset, quit every Codex and Context Room process, move the entire `prompt-overrides` directory to a new private backup path beside it, restart the patched Codex build, and verify that it generated a fresh official catalog before recreating any wanted overrides. Keep that backup private and delete it only after independent verification.

`catalog.json` publishes target metadata plus nullable `officialText`, `officialHash`, `effectiveText`, and `effectiveHash`, `overrideStrategy`, `securityClass`, optional `overrideConflict`, and optional source target ID. Protected and server-owned targets publish all four content fields as `null`. The catalog is the current discovery and editing surface; it is not evidence of what an older running process loaded.

Context Room rejects missing or unknown catalog fields, mismatched text/hash presence, incoherent authority metadata, or an editable target without a complete effective value. An editable target with `sourceTargetId: null` must have an effective value exactly equal to its official baseline; any changed effective value requires explicit runtime-published override provenance.

Context Room rebuilds the runtime's typed canonical JSON in fixed field order and recomputes `catalogRevision` before trusting the catalog. It does not trust `editable: true` alone: only one of the four allowed editable kinds with `securityClass: local_user_editable`, an allowed runtime status, full content, and the baseline-compatible override strategy opens the editor.

Each verified Codex app-server process writes a schema-v2 hash-only receipt and references one immutable catalog snapshot. The receipt includes a positive JavaScript-safe `publicationGeneration` and the exact macOS process-generation identity `processStartIdentity: darwin-proc-bsdinfo-v1:<boot-session-uuid>:<tvsec>:<tvusec>`. The boot-session UUID is lowercase `kern.bootsessionuuid`; `tvsec` is positive and `tvusec` comes from `proc_pidinfo(PROC_PIDTBSDINFO)`, zero-padded to six digits. `catalogFile` is a strict basename bound to the receipt PID and the snapshot's raw SHA-256. The snapshot must be a regular non-symlink file with mode `0600`; its raw hash, logical `catalogRevision`, and runtime version must match the receipt. Dead or non-Codex PIDs are ignored before their receipt is parsed.

Receipt freshness is also bound to the current process instance. Context Room invokes only Apple's absolute `/usr/bin/python3` path with a minimal environment, never a `python3` resolved from `PATH`.

Its `ctypes` helper validates the exact `proc_pidinfo` result size, PID, positive start second, and bounded microseconds. It also bounds the `kern.bootsessionuuid` buffer to 128 bytes before allocation and requires an ASCII canonical UUID before lowercasing it.

The reader compares this identity with the receipt before opening the snapshot, then obtains it again after snapshot validation and requires the tuple to remain unchanged. If `/usr/bin/python3` is absent or not executable, or if exact identity is unavailable or changes, runtime-loaded state fails closed as unverified.

Context Room also strictly requires the receipt load timestamp plus the receipt and snapshot modification times to be no older than the process start. There is no grace window: even a receipt from one second before the verified process start is rejected.

Every snapshot read is bracketed by two reads each of the receipt and **.publication-state.json**. The verification order is process identity A, receipt R1, publication state S1, snapshot, receipt R2, publication state S2, then process identity B. R1 and R2 must be byte-identical. Both states must be strictly valid, and the owner generation for that receipt's PID must stay unchanged; unrelated `nextGeneration`, `globalOwnerGeneration`, registry-generation, or other PID owner changes do not invalidate the proof. Each relevant owner must equal the receipt's exact `publicationGeneration`.

Publication state v2 separates instance registry age from receipt publication age. `runtimeRegistryGenerations[pid]` is the generation reserved when the current configuration instance takes ownership of that PID; `runtimeOwnerGenerations[pid]` changes for every receipt publication or tombstone. The two maps must contain exactly the same canonical decimal non-zero `u32` PID keys. All runtime generations are positive JavaScript-safe integers below `nextGeneration`, and each registry generation must be less than or equal to its owner generation. `globalOwnerGeneration` may be zero and must remain below `nextGeneration`. Context Room validates registry generations structurally, but only `runtimeOwnerGenerations[pid]` proves receipt freshness. A legacy v1 file remains unverified here until the compatible runtime atomically migrates it while reserving its next publication generation; Context Room never guesses the missing registry map.

Before returning an aggregate, Context Room validates one coherent batch for the exact PIDs whose receipts it will trust. It captures their initial receipt bytes, owner-generation vector, represented live-process set, and exact process identities. It then validates every snapshot, reads a strict final publication state, rereads every proved receipt, and reads the publication state and represented process set again.

Each receipt's bytes and generation must still match its proof. The relevant owner vector must match the initial vector across both final state reads, and both the PID set and every process-start identity must remain unchanged. Churn in fields and owners outside the relevant owner vector is deliberately ignored.

A batch race retries the entire batch once. A second race fails every otherwise verified member closed as unverified, so aggregation never combines stale runtime A with current runtime B.

The publication protocol requires receipt bytes to be immutable for one `publicationGeneration`. Under the runtime's artifact lock, only the current or a newer registry generation may publish. It reserves the next unique owner generation, advances `nextGeneration`, and writes publication state with that owner before writing the content-addressed snapshot and then the receipt.

A failure before receipt replacement therefore leaves the new owner as a tombstone; a failure after replacement may leave the fully written receipt verifiable. The runtime revalidates owner generation after publication, and an older registry generation cannot republish. Any later receipt publication, replacement, or tombstone must allocate a fresh owner generation for that PID.

Context Room rereads receipt bytes and catches violations that overlap its verification window. However, no sequence of filesystem reads can create a coherent batch against a writer that silently rewrites an already-read receipt without advancing its generation.

If the runtime atomically publishes a newer relevant receipt or owner generation, changes process identity, or changes the represented process set during the first attempt, the reader retries once from the latest batch. A second relevant change within the bounded retry fails closed as unverified. Missing, unreadable, insecure, malformed, ownerless, or generation-mismatched publication state also fails closed as unverified. A runtime tombstone updates the owner generation before removing a receipt, so an in-flight old receipt cannot remain verified even if its immutable snapshot still exists.

Runtime-loaded state is aggregated by target, not by global catalog, manifest, runtime revision, or collaboration-mode label. If every verified live process proves the same expected `effectiveHash`, the target is runtime loaded even when those processes use different catalog snapshots, manifests, or runtime versions. Different proved target hashes produce **Mixed runtime-loaded state** and the diagnostic **Different loaded prompt versions**. A missing, invalid, stale, or target-incomplete snapshot produces **Runtime-loaded state unavailable**. Older global catalog or manifest revisions remain visible as diagnostics but do not create a false target conflict.

A globally stale manifest is also reported separately when the selected target's exact loaded hash already matches its desired hash, so unrelated changes do not create a false per-target restart warning. The compatible Codex runtime regenerates `catalog.json`, an immutable process snapshot, and its receipt during configuration loading and startup; resolving a model can add its model-specific target. Context Room owns only safe updates to `overrides.json`. No `config.toml` switch is required.

The receipt field `activeOverrides` means that the runtime successfully resolved those concrete overrides. It must be the exact ordered set derived from the referenced immutable snapshot: every target with both a non-null source target ID and a non-null runtime effective hash, with the exact `targetId`, `sourceTargetId`, and `effectiveHash`. Missing, extra, reordered, or mismatched records invalidate the receipt. It is not a record of an active collaboration mode and is not task-level delivery evidence.

## Runtime States

Prompt Center can show:

- `Official loaded by runtime`
- `Effective loaded by runtime`
- `Runtime loaded`
- `Pending next launch`
- `Restart required`
- `Mixed runtime-loaded state`
- `Runtime-loaded state unavailable`
- `Loaded prompt differs`
- `Catalogued`
- `Target pattern`
- `Conflict`
- `Codex not running`

The restart instruction is deliberately explicit: **Quit Codex completely (`⌘Q` on macOS), reopen it, then create a new task.** Closing only a window is insufficient, and an existing task may retain previously injected context. The same guidance applies to a read-only target whose loaded prompt differs from the current runtime-published effective value: Prompt Center cannot edit that authority-owned value, but a full restart is still required to load its current form.

## API

The loopback server exposes:

```text
GET    /api/codex-prompts
GET    /api/codex-prompts/target?id=…
POST   /api/codex-prompts/validate
POST   /api/codex-prompts/override
DELETE /api/codex-prompts/override
POST   /api/codex-prompts/refresh
```

The server requires a loopback peer and the active loopback `Host`. It rejects an `Origin` or `Referer` that names another origin and rejects requests explicitly marked cross-site; headerless local clients remain supported. Every mutation must still send both the random `x-context-room-prompt-nonce` and the active `x-context-room-project` identity, which prevents a stale project tab or local client from mutating through a different Context Room process. Every Context Room page also sends a `frame-ancestors` policy limited to itself and the exact loopback ports of its known parent rooms, so isolated project and proposal reviews can open inside the secondary review area without allowing wildcard or external framing.

## Durable Contracts

The persisted JSON contracts are versioned independently from the UI:

- [`schemas/codex-prompt-catalog-v1.schema.json`](../../schemas/codex-prompt-catalog-v1.schema.json): `catalog.json` and immutable `<pid>.<hash>.catalog.json` snapshots;
- [`schemas/codex-prompt-overrides-v1.schema.json`](../../schemas/codex-prompt-overrides-v1.schema.json): `overrides.json`;
- [`schemas/codex-prompt-publication-state-v2.schema.json`](../../schemas/codex-prompt-publication-state-v2.schema.json): read-only **.publication-state.json** registry and publication generation ownership;
- [`schemas/codex-prompt-runtime-receipt-v2.schema.json`](../../schemas/codex-prompt-runtime-receipt-v2.schema.json): hash-only `<pid>.json` receipts.

All four schemas reject unknown top-level fields. The compatible Codex runtime validates its own target allowlist; Context Room only saves targets present in the current runtime catalog. Context Room additionally enforces relationships JSON Schema cannot express directly: the runtime-compatible typed catalog revision, Unicode scalar validity, UTF-8 byte and estimated-token limits, unique override IDs, JavaScript-safe publication generations and strict owner ordering, exact receipt-owner equality across two stable publication-state reads, the exact Darwin process-generation identity, the PID embedded in `catalogFile`, the raw snapshot hash, the logical catalog revision, and the exact ordered `activeOverrides` snapshot set.

## Source Map

- `src/codex_prompt_center.mjs`: catalog normalization, exact overlays, optimistic concurrency, private storage, receipts, and provider.
- `src/context_room.mjs`: injectable API routes and lazy Context Room interface.
- `schemas/codex-prompt-*.schema.json`: strict persisted catalog, manifest, publication-state, snapshot, and receipt contracts.
- `test/codex_prompt_center.test.mjs`: synthetic catalog, overlay, storage, receipt, API, and privacy tests.
- [Global Context Room](context-hub.md): global navigation and project isolation.
- [Settings](settings.md): project and preference configuration that remains separate from prompt state.
