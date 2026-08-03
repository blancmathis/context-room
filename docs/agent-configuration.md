---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent configuration
  last_verified: 2026-08-03
  sources: [bin/context-room.mjs, src/context_room.mjs, src/context_settings.mjs, src/review_authority.mjs, src/codex_prompt_center.mjs, src/shared_context.mjs, src/provider_profiles.mjs, schemas/config.schema.json, schemas/shared-repository.schema.json, schemas/shared-skill-locations.schema.json, schemas/shared-skill-local-state.schema.json, schemas/shared-resource-local-state.schema.json, schemas/shared-instruction-locations.schema.json, schemas/codex-prompt-catalog-v1.schema.json, schemas/codex-prompt-overrides-v1.schema.json, schemas/codex-prompt-publication-state-v2.schema.json, schemas/codex-prompt-runtime-receipt-v2.schema.json]
---

# Agent configuration guide

Project behavior is configured with one JSON file:

```text
.context-room/config.json
```

That file is the portable project contract between the owner, the UI, and AI agents. Fresh setup derives it from the documentation that actually exists in the project. Effective review coverage also includes the last owner-authorized scope stored outside the project; a direct config edit cannot silently narrow that scope. If an agent later needs to curate a card or safe editable surface, it should use the typed Settings CLI and then run `context-room doctor`. For folder watch rules, `context-room watch set` may add or widen coverage while capturing snapshots consistently; only the owner Settings interface may narrow or remove coverage.

Interface preferences are shared across every Context Room on the computer and stored separately:

```text
~/.context-room/preferences.json
```

Use the Settings screen to change the app theme, hidden-file visibility, `Auto-open Git diff`, interface sounds, their volume, or keyboard shortcuts. Project paths, review rules, scanners, templates, and hub cards remain local to `.context-room/config.json`.

Codex prompt overrides are also computer-wide, but they are not preferences and never belong in project configuration:

```text
$CODEX_HOME/prompt-overrides/
```

Use **Settings → Advanced extensions → Codex prompts → Open prompt editor** to inspect the runtime-published catalog and edit only targets marked `securityClass: local_user_editable`. Context Room writes the strict private `overrides.json` contract; a compatible Codex runtime regenerates the catalog and per-process runtime receipts. After a change, quit Codex completely (`⌘Q` on macOS), reopen it, then create a new task. See [Codex Prompt Center](features/codex-prompt-center.md).

The human-owned review gate is also stored separately:

```text
.context-room/review-gate.json
```

Use the Review tab in Settings to choose any combination of `commit`, `push`, `pull request`, and `merge`. This policy is local to the worktree, excluded from Git, omitted from project configuration, and not writable through the Context Room agent CLI. The last owner-authorized review scope and exact shared-proposal rejection receipts also live in private owner-local authority state, normally under `~/.context-room/hub/review-authority/` and `~/.context-room/shared/review-authority/`.

Context Room signs that authority state and requires a current UI nonce for protected local mutations. These controls block normal CLI, config, and raw-HTTP bypasses, but they are not proof of physical human presence against a process with unrestricted access to the same OS account. Use provider-side rules and a separate authenticated reviewer, hardware-backed user presence, or OS isolation for that stronger boundary. The canonical security contract is `docs/features/review-authority.md`.

## Fresh project setup

Use one command to initialize the project-aware configuration, register the
project, and start or reuse the global Context Room:

```bash
context-room setup --root . --title "My Project"
```

For a fresh project, `setup` and `init` inspect the existing repository before writing configuration. They:

- discover project-owned documentation, indexes, agent instructions, skills, runbooks, decisions, and records;
- add safe documentation surfaces to `allowedPaths` and `watchAllow`;
- organize discovered docs into the nonempty sections Start here, Current documentation, Target documentation, Decisions, research, and incidents, Documentation to classify, and Agent guidance;
- keep startup context, skills, and hooks project-only by default; and
- leave existing `AGENTS.md`, CLAUDE.md, documentation, and owner-controlled review policy unchanged.

`init` remains write-only. `setup` continues into the local server. Re-running either command preserves an existing `.context-room/config.json`, including intentionally empty or curated lists, instead of rebuilding it from inference. Explicit `--title`, `--allow`, or `--watch` options amend only their matching fields and preserve extension fields permitted by the schema. Invalid JSON stops setup without overwriting the file.

When no port is supplied, `setup` and `start` select the first free port within the 200-port range starting at `4317`. They never stop another Context Room. An explicitly requested occupied port fails with a clear error.

After startup, open the printed `/api/health` URL and confirm that `root` is the intended absolute project path. A current tab also binds itself to that root. If the same port later serves another project, the server rejects requests carrying the stale identity and the current tab reloads before old project state can be written into the new room. During an upgrade, browser-originated mutations from an older tab that sends no project identity are rejected with `409`; reload that tab once before editing. Headerless non-browser API and CLI requests remain compatible.

Run the deterministic configuration check as well:

```bash
context-room doctor --root .
```

Setup is complete when the health endpoint reports the intended root, watched and hub paths resolve inside `allowedPaths`, the hub exposes the discovered documentation clearly, and `doctor` has no unresolved high- or critical-severity setup issue.

## Configuration intent checklist

Use this checklist to make the intended setup clear before checking field details. The schema and `context-room doctor` validate JSON syntax.

Check intent:

- `allowedPaths` exposes only safe text. A `~/...` entry is an explicit external authorization, so keep it as narrow as a project-relative entry.
- `readOnlyPaths` contains the allowed paths that Context Room may display but must not create, edit, or delete. It does not widen `allowedPaths`.
- Top-level `projectOnly` controls physical containment for ordinary project paths. Fresh setup writes `true`. Setting it to `false`, or omitting it in a legacy config, can make configured symlink targets outside the project readable and editable; retain that compatibility only for trusted, established hubs.
- `watchAllow` contains simple file watches and legacy/default recursive live folder watches.
- `watchRules` contains folder watches that need an explicit recursive/direct and live/current-files mode.
- Every document covered by `watchAllow` or `watchRules` requires human verification for its current content hash. Git only provides a diff when one exists.
- `hubSections` separates current truth, target truth, and records when the project makes those distinctions.
- Fresh `startupContext`, `startupSkills`, and `startupHooks` settings expose project-local surfaces only unless the owner opts into broader scanning.
- Hook editing stays off unless the project owner explicitly wants Context Room to edit executable files.

If those boundaries are right, the exact JSON shape is a mechanical concern.

## Configuration fields

### Global interface preferences

`fileTheme`, `colorMode`, `showHiddenFiles`, `autoOpenGitDiff`, `shortcuts`, and
`sounds` apply to every Context Room on the computer. The Settings screen writes
them to `~/.context-room/preferences.json`; they do not belong in project
configuration. `colorMode` accepts `system`, `light`, or `dark` and affects the
adaptive Context Room theme. Explicit editor themes retain their own palette.

`sounds` contains the computer-wide `enabled` switch and a normalized `volume` from `0` to `1`. Sounds are enabled by default at `0.35`. Enabled buttons use a short, dry, warm low-mid interaction click that remains audible on laptop speakers at restrained volume. Longer low-register cues identify completed review milestones, accepted shared proposals, and newly detected file conflicts. Typing, field focus, sliders, disabled buttons, and background refreshes stay silent. All five previews in Settings remain available while interface sounds are muted.

### `allowedPaths`

Safety boundary.

Context Room only exposes supported text files inside these files or folders. It may write them unless they also match `readOnlyPaths`. Project-relative entries stay inside the room's normal project boundary. An entry beginning with `~/` explicitly authorizes that home file or folder even though Git in the project does not own it. Keep both forms narrow and documentation-focused.

Set top-level `projectOnly: true` to require every ordinary allowed, watched, and hub path to remain physically inside the project root after symbolic links are resolved. Fresh setup writes this flag. Setting it to `false`, or omitting it in an existing configuration, preserves established symlink documentation hubs but can make their configured targets outside the project both readable and editable. Use that mode only for trusted, established hubs. This flag does not govern explicit `~/...` integrations.

The three nested startup scanner flags have a separate purpose: they control whether instruction, skill, and hook discovery stays inside the project or includes compatible ancestor/global sources.

Good examples:

```json
"allowedPaths": ["docs/", "skills/", "README.md", "AGENTS.md", "~/shared-project-docs/"]
```

Do not use `~/` as a broad filesystem browser. Avoid secrets, dependency folders, build outputs, generated files, private exports, and binary assets. External entries remain subject to the same supported-text and blocked-path checks as project entries.

### `readOnlyPaths`

Display-only boundary.

Every entry uses the same project-relative or explicit `~/...` path syntax as `allowedPaths`. A matching file can appear in the hub, explorer, and reader, but the server rejects create, edit, and delete operations. Add the path to `allowedPaths` as well; `readOnlyPaths` never grants access by itself.

Shared-context sync adds the accepted project docs, project skills, and global skills to both arrays. Those entries point through `~/.context-room/shared/` to an accepted immutable Git snapshot. Change them through the shared proposal workflow, not by removing their read-only protection.

Generic shared skill collections and assignments use `skill-locations.json` in the shared repository, not fields in `.context-room/config.json`. Logical assignment changes require a `skills` proposal. Device provider preferences, project provider overrides, physical destinations, custom mounts, local exclusions, Skills and Instructions pending imports, archives, and managed-link ownership use the version 3 Shared Resources local-state contract under `~/.context-room/shared/`. Version 2 Skills state remains readable and migrates locally on the first mutation. See [Shared Context](features/shared-context.md#shared-skill-locations).

Shared instruction collections use `instruction-locations.json`, also outside
project configuration. Each assignment declares exact Markdown source and
target paths, providers, and a `project`, `shared`, or `device` scope. Logical
changes require an `instructions` proposal. Accepted-main files are exposed
through managed links; an unmanaged file at the destination is preserved and
reported as a conflict. The common provider preference applies to Skills and
Instructions. Installation and provider activation remain separate: an
arbitrary target is not effective until the provider natively discovers it or
its local configuration explicitly names it. Shared hooks are not supported. See
[Shared Context](features/shared-context.md#shared-instruction-locations).

```json
{
  "allowedPaths": ["docs/", "imported-reference/"],
  "readOnlyPaths": ["imported-reference/"]
}
```

### `watchAllow`

Review boundary.

Files here require human verification for every current content version. A verified content hash leaves the queue; any meaningful content change creates a new hash and reopens review, including after that change has already been committed. Folder entries use `recursive-live`: current and future eligible files at any depth use the same rule.

For project files, Git supplies an inline diff when one exists. A Git-clean file with an unverified current hash still appears and can be verified as a whole. Files under an explicit `~/...` `allowedPaths` boundary use Context Room's local review baseline because project Git does not own them.

Good examples:

```json
"watchAllow": ["docs/", "skills/", "AGENTS.md", "docs/decisions/"]
```

### `watchRules`

Explicit folder review boundary.

Use `watchRules` when a folder needs a mode other than the default recursive live behavior. Each rule stores an allowed folder path—normally project-relative, or an explicit `~/...` path already present in `allowedPaths`—and one of four modes:

Here, an eligible file is an allowed, supported text file that passes Context Room's secret, dependency, build-output, binary, and containment exclusions.

| Mode | Existing files | Future files | Subfolder files |
| --- | --- | --- | --- |
| `recursive-live` | Included | Included | Included at any depth |
| `recursive-current` | Included in a saved snapshot | Excluded | Included in the snapshot at any depth |
| `direct-current` | Included in a saved snapshot | Excluded | Excluded |
| `direct-live` | Included | Included | Excluded |

`recursive-live` is the default when the Explorer or agent CLI does not specify a mode. A live rule stays active after it is created. For example, `recursive-live` includes a file later created inside a new nested folder, while `direct-live` includes only future files whose immediate parent is the watched folder.

The two `current` modes persist the eligible file paths in `files` when the rule is created. They do not expand when later files or folders appear. Context Room reviews files, not empty directory objects: saying that a folder is watched means a live rule is retained so eligible files created under it can enter the queue.

```json
"watchRules": [
  {
    "path": "docs/",
    "mode": "recursive-current",
    "files": ["docs/index.md", "docs/guides/setup.md"]
  },
  {
    "path": "decisions/",
    "mode": "direct-live"
  }
]
```

Keep snapshot `files` inside their rule path. `recursive-current` may list descendants at any depth; `direct-current` lists only immediate file children. When rules overlap, the most specific matching path controls a file. An explicit structured rule wins a tie with a `watchAllow` folder entry at the same path.

The Explorer and agent CLI require an existing folder covered by `allowedPaths`; adding a watch rule never widens the edit boundary. They remove that same folder from `watchAllow` when they upsert a structured rule, leaving one owner for the scope. Use those surfaces to create snapshot rules so Context Room records the eligible files correctly. An agent may upsert only when the result preserves or widens the owner-authorized scope. Removing an exact folder rule, or replacing it with a narrower mode, requires the owner Settings interface. Removal does not create an exclusion; a broader ancestor rule may still watch files below it.

External watched files are not assigned invented Git history. Their first appearance is a new-file first review. Accepting it records a local baseline; later edits and deletions are reviewed against that baseline. A live external rule also admits later eligible files according to its recursive or direct-child scope. The shared ledger still keys trust by canonical absolute path, so another room watching the same external file can reuse a matching verified content hash.

### Deprecated `reviewPaths` and `reviewAgentInstructions`

Context Room still reads these legacy fields for compatibility but no longer generates or exposes them. Allowed `reviewPaths` are merged into the unified watched-document scope in memory. Their former array order has no effect; the queue uses its normal risk, authority, and path ordering.

On the next human Settings save, Context Room records the unified `watchAllow` and `watchRules` scope and removes both deprecated fields. It never widens `allowedPaths`: an inaccessible legacy path remains unconfigured and appears in Context Health with a migration action.

Every project `AGENTS.md` is implicitly editable and watched. It follows exactly the same content-hash review rule as every other watched document; `reviewAgentInstructions: false` no longer exempts it.

### Shared review ledger

Verified content is recorded in the local Context Room state and in a shared repo ledger:

```text
.context-room/review-ledger.json
```

The shared key is the canonical absolute file path. Trust is decided by the exact content hash, whether the resource was present or absent when reviewed, and the last Git change for an absent path. A secondary review hash may simplify diffs by ignoring only `context_room.last_verified`, but it never grants trust. When Context Room observes a restored path, it clears that deletion trust so a later deletion at the same path requires review again. If two Context Rooms watch the same present file, one verification is enough until any content changes.

When two or more watched files are deleted without being recognized as renames, the webapp groups them into an expandable deletion set. The path list is loaded only when opened, up to 5,000 pending paths at a time. Routine paths start selected; protected or uncertain-history paths start unselected and require an extra acknowledgement when included. A human can narrow the selection and confirm the removals once; the server rejects a stale batch key and revalidates every path before recording its absent state. This action acknowledges files that are already missing and never deletes them.

### `hubSections`

Navigation model.

Use hub sections for the paths that should be opened first. A card can point to one file or folder:

```json
{
  "id": "docs",
  "title": "Docs",
  "path": "docs/",
  "autoChildren": true
}
```

Fresh setup builds sections from discovered documentation rather than retaining generic cards for paths that do not exist.

Explicit `_target`, `target`, `plans`, `proposals`, and `roadmap` paths go under Target documentation. A generic `draft` status alone does not prove target ownership and remains under Documentation to classify. Decisions, research, history, and incidents get their own records section.

Entry points and indexes go under Start here unless their path makes them target or record material. Documentation explicitly marked `current` goes under Current documentation. Missing or invalid status metadata remains under Documentation to classify unless an explicit target or record path supplies its truth state; it is never presented as current truth. Project instructions plus safe skill documentation appear under Agent guidance.

Every configured section remains visible even when it has no cards, so it may serve as a deliberate separator. Remove the section in **Settings → Project → Home sections and cards** when it should disappear entirely; `Main` has no special protection.

### `startupContext`

Startup context scanner.

When enabled, Context Room lists matching instruction files. Fresh setup writes `projectOnly: true` and enables this scanner only when the project contains a matching local instruction file. In that mode, it does not traverse ancestor folders or load global instruction paths. Owners can set `projectOnly: false` and configure `globalPaths` when they intentionally want broader startup context.

Existing configs without `projectOnly` keep the previous ancestor-scanning behavior for compatibility.

Project-local instruction files can also appear in the normal explorer, where project `AGENTS.md` files are automatically editable and watched. Ancestor and global startup-context files stay outside the project explorer.

Startup context files outside the Context Room root are not Git-reviewable from the project. Context Room requires an initial review of each one and stores an untrusted observation baseline immediately at discovery. An edit made before the first human decision therefore appears as a real inline diff. Accepting or rejecting visible changes updates the local baseline for future reviews. Content that changed before the first observation still requires Git history, a backup, or another recovered snapshot.

### Generated agent context

Context Room writes its installed setup and HTML visual guidance to `.context-room/`. The stable entry point is `.context-room/README.md`; it routes an agent through project setup and links to the full visual usage contract, pattern reference, and catalogs in `.context-room/agent-context/`. `context-room init`, `setup`, and `start` refresh these generated files, so agents can use one project-local path without depending on the npm installation location. The generated files are local runtime material and excluded from Git.

The explorer shows safe hidden files, including this generated folder, by default. `Show hidden files` is a computer-wide Appearance preference; disabling it hides dotfiles and dotfolders without changing project configuration or deleting anything.

### `startupSkills`

Startup skill scanner.

Context Room enables startup skill discovery by default and lists configured
skill folders such as `.agents/skills` or `skills` whenever they exist. Fresh
setup writes `projectOnly: true`, preventing discovery in ancestor folders.
Keeping the scanner active means a skill folder added after setup is discovered
automatically. Existing configs without `projectOnly` keep ancestor discovery
for compatibility. Legacy `.codex/skills` locations remain visible when they
exist, but fresh Codex destinations follow the provider profile and use
`.agents/skills`.

Startup skills can be opened in the explorer without making the whole project editable.

Every discovered skill entrypoint requires an initial review, including skills outside the repo. Context Room captures the first observed content immediately without treating it as verified. If it remains unchanged, the UI offers whole-document acceptance or a non-destructive request-changes decision; if it changes first, the UI shows the line-level diff against that observation baseline. Once verified, its content hash is trusted until the skill changes. If a repo skill already appears through the normal Git queue, Context Room keeps only that richer Git-backed item instead of showing a duplicate.

### `startupHooks`

Startup hook scanner.

When enabled, Context Room lists hook files that can affect agent work, commits, or validation. Fresh setup keeps hooks enabled with `projectOnly: true`: it scans project-local AI-agent and hook-manager paths plus the current repository's effective Git hooks, without walking unrelated ancestor projects. Existing configs without `projectOnly` retain their broader discovery behavior.

Each `agentHookSources` entry names one agent system and the config/plugin paths to scan. This keeps Context Room usable with Codex, Claude Code, OpenCode, or any other coding agent without hard-coding one vendor as the default mental model.

For JSON agent hook configs, Context Room lists both the hook config file and referenced local hook scripts so users can review the exact commands that may run around agent tool use, prompt submission, session start, stop, or other lifecycle events.

Hook cards include a readable name, provider/source, a short description extracted from docstrings or comments, the file path, the event/source, tracking state, and a compact command summary when a command is known.

Hooks are read-only by default because they execute code. Enable `startupHooks.editable` only when the project owner intentionally wants Context Room to edit hook files.

### `sharedContext`

Generated connection summary.

`context-room shared setup` writes the active repository URL and project ID here after it adds the accepted shared paths and hub section. This field is only a display summary; it does not authorize fetching a remote. The approved connection, source-repository mapping, accepted snapshots, and skill-link registry live under `~/.context-room/shared/`. Use the shared CLI instead of editing this summary directly.

```json
"sharedContext": {
  "enabled": true,
  "repository": "git@github.com:example/company-shared-context.git",
  "projectId": "my-project"
}
```

See [Shared context](features/shared-context.md) for repository setup, refresh, proposals, exact-hash review, partial acceptance, skills, and the required Git-host permission boundary.

`sharedContext` does not select a proposal as effective context. The configured
shared default branch remains canonical. `context-room context effective`
verifies that accepted shared revision before reporting current effective
context; `--allow-stale` is reserved for an explicitly stale read-only
diagnostic. Proposal
metadata can remain visible, but proposal content does not enter effective
documents, instructions, or skills before integration.

## Documentation metadata

Structured Markdown docs should include frontmatter:

```md
---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: [src/billing.ts, docs/pricing.md]
---
```

Kinds:

- `agents`: instructions that shape agent behavior.
- `index`: navigation and source-of-truth map.
- `canonical`: current truth for a feature, system, or workflow.
- `procedure`: runbook, workflow, checklist, deploy or testing procedure.
- `decision`: decision record.

Statuses:

- `current`: can be trusted as current context.
- `draft`: still being prepared.
- `historical`: useful history, not current truth.
- `superseded`: replaced by another document.

Keep metadata small. The goal is not bureaucracy; it lets Context Room find stale docs, duplicate canonical truth, broken references, and missing source links.

## Rules for agents

1. Treat `.context-room/config.json` as the portable project intent. Effective review coverage is the union with the last owner-authorized local scope; do not try to reduce it outside the owner Settings interface.
2. Start with `context-room setup`; edit the JSON directly only when the inferred project map needs deliberate curation.
3. Keep `allowedPaths` conservative: documentation, skills, runbooks, agent instructions, and safe text files.
4. Treat `readOnlyPaths` as context, not an edit surface. For shared accepted paths, create a shared proposal instead of removing the boundary.
5. Put the truly important docs in `watchAllow` or an explicit `watchRules` mode, not every file in the repo. Use `context-room watch set <path> --mode <mode>` to add or widen folder coverage and create snapshots. Never use an agent path to narrow or remove review coverage.
6. Use stable lowercase IDs with dashes, for example `agent-context`, `architecture`, `release-runbooks`.
7. Preserve the `$schema` field so editors and agents can validate the file shape.
8. After editing config, run:

```bash
context-room doctor
```

Use the typed context Settings CLI when an agent needs to inspect or change a
supported context setting. It validates values, previews the exact revision,
and refuses stale apply operations:

```bash
context-room settings get allowedPaths --detail standard --format json
context-room settings set --set 'allowedPaths=["docs/","runbooks/"]' --format json
context-room settings set --apply <plan-id> --format json
```

This surface intentionally excludes appearance, owner-controlled Git gates,
review decisions, review-scope reductions, document or hook content, and shared
collection or assignment intent. A reduction returns
`human-authority-required`. Root help exposes only `ask`, `edit`, and
`capabilities`.
`context-room capabilities` returns a compact static index of the primary
actions and capability sections. Exact command contracts are loaded only on
request; the command does not interpret an objective or choose an operation.

9. For stronger validation, run:

```bash
context-room doctor --strict
```

Use strict mode only when the project is ready to enforce metadata and graph health.

10. For accepted documentation, use the worker entry point:

```bash
context-room ask "We are changing billing onboarding. Find the accepted documents that govern the current flow, ownership, validation rules, failure handling, and provider constraints. Identify contradictions or missing decisions and return the implementation rules and useful passages the working agent must preserve."
```

An administrative or diagnostic agent can request the expert profile and use
`context-room context bundle --task "change billing onboarding"` when it needs
the complete deterministic environment rather than a documentation answer.

11. If available, start the UI and smoke-test the hub and review queue:

```bash
context-room start --root .
```

Without `--port`, Context Room selects a free port and prints the URL. Do not stop or reuse an unrelated room to obtain a preferred port.

12. To install or refresh the local Git hooks selected by the owner review gate, run:

```bash
context-room hooks sync --root .
context-room hooks sync --root . --apply <plan-id>
```

`hooks sync` returns an exact protected plan before changing local hooks. Context Room manages `pre-commit`, `pre-push`, and `pre-merge-commit` only when their matching operation is selected and refuses to overwrite a custom hook. A managed dispatcher can remain installed after an operation is deselected; it reads the active worktree's owner policy and exits silently. Git hooks are local and are not committed to the repository. The legacy `install-hooks` command remains executable during migration but is not part of the canonical agent profile surface.

There is no local Git hook for creating a pull request, and a merge performed by GitHub, GitLab, or another host does not run the clone's hooks. For those selections, connect the corresponding command to a hosted check and make that check required:

```bash
context-room guard --operation pull-request --profile strict
context-room guard --operation merge --profile strict
```

The pull-request check runs after the PR exists; repository rules can use its result to prevent merge. Provider wiring is intentionally separate because Context Room is provider-agnostic.

To check what the hook will enforce without committing, run:

```bash
context-room guard
```

`guard` is advisory by default and exits with status `0` even when review is pending. `review-only` also reports without blocking. An explicit `--profile strict` invocation can fail regardless of owner policy. A selected `--operation` fails only for pending review; it does not add strict documentation-health failures to the Git gate.

## Agent setup prompt

```text
Configure Context Room for this repository with `context-room setup --root .`.

Goal: make the documentation and agent skills easy to navigate, maintain, and verify.

1. Read the root README, every applicable project `AGENTS.md` or CLAUDE.md, and existing documentation indexes. Do not create, replace, or append agent instructions merely to configure Context Room.
2. Confirm that the discovered docs, skills, runbooks, decisions, and records are project-owned safe text surfaces.
3. Check that important docs are in `watchAllow` or an appropriate `watchRules` mode, not only `allowedPaths`. Use `context-room watch set` for explicit folder modes so current-file snapshots are captured consistently.
4. Check that `hubSections` separates Start here, Current documentation, Target documentation, records, unclassified docs, and Agent guidance where those groups exist.
5. Preserve existing config values and leave `.context-room/review-gate.json` to the project owner.
6. Keep startup scanners project-only unless the owner explicitly requests ancestor or global context.
7. Run `context-room doctor --root .` and resolve high- or critical-severity setup issues.
8. Open the printed `/api/health` URL and confirm that `root` matches this repository.
9. Run `context-room guard` to inspect the watched-doc queue without blocking work.
10. Do not include secrets, `.env` files, private data, build outputs, dependencies, exports, or generated artifacts.
```
