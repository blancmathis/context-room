---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: settings
  last_verified: 2026-08-03
  sources: [src/context_room.mjs, src/review_authority.mjs, src/context_settings.mjs, src/shared_context.mjs, src/codex_prompt_center.mjs, schemas/config.schema.json, schemas/shared-skill-locations.schema.json, schemas/shared-instruction-locations.schema.json, docs/agent-configuration.md, docs/features/codex-prompt-center.md]
---

# Settings

## Purpose

Settings separates project setup from computer-wide preferences without exposing every option at once. It is also the only primary route to advanced global tools that should not compete with daily review work.

## Categories

- `Project`: Shared Context repository registration and the selected local project's connection, followed by project templates and Hub organization.
- `Review`: one Documents to review scope plus advanced Git-action protection.
- `Startup`: agent instructions, local skill discovery, and hooks or automation that can affect work before an agent starts.
- `Shared resources`: Shared Skills plus reviewed instruction collections such as **AGENTS.md** and **CLAUDE.md**, their accepted assignments, exact provider targets, managed links, and conflicts.
- `Appearance`: theme and reading, Explorer and file behavior, interface sounds, and keyboard shortcuts.
- `Templates`: Markdown document templates.
- `Hub`: device-wide project priority plus project-owned Home sections, cards, and routing.
- `Codex prompts`: entry to the global [Codex Prompt Center](codex-prompt-center.md). The dedicated editor keeps its versioned runtime catalog, conflict handling, and private storage separate from project configuration and review.

## Rules

- Show one category at a time and keep all categories reachable from the tab bar.
- Render the categories as one flat native tab strip. Setting groups use
  hairline-separated rows and disclosures rather than nested floating cards.
- Put a live Settings search beside the title. Search setting names, plain-language aliases, technical terms, category, and scope; selecting a result opens only its category and disclosure, scrolls to the control, focuses it, and briefly highlights it.
- Support Arrow Up, Arrow Down, Enter, and Escape in search, and announce result counts without moving focus away from the field.
- Organize each category as native disclosure cards. Each summary states the purpose, current status or configured count, and scope when relevant.
- Keep frequent groups open by default and advanced owner controls closed. Remember every explicit disclosure state locally; unrelated navigation must not expand or collapse a group.
- Keep unsaved field values when switching categories, then save everything once.
- Keep one sticky manual Save bar. It reports `Unsaved changes` and the number of changed groups; hidden controls remain part of the same save payload.
- Label each category as project-scoped or global.
- In a global Context Room, never present the Hub host's private configuration as project configuration. The Review category shows the real aggregate counts for local review files and shared proposals, then explains that watched documents, Git gates, Startup scanners, templates, and Home sections belong to individual projects.
- Keep **Review → Agent CLI guide** available before any project is selected. It leads with the three root commands: `ask`, `edit`, and `capabilities`. The guide explains the one human-owned responsibility—accepting or rejecting each file awaiting review—and the mandatory two-confirmation agent rule: ask once, restate the exact action, scope, and effects after the first yes, ask again, and do nothing without a second separate, unambiguous yes. It states that `edit` creates the shared proposal worktree directly and provides a paste-ready instruction for a coding agent.
- To edit a project-owned category from a global room, select a local project or worktree in Explorer. Its Review, Startup, Templates, and Hub settings load directly in the current Settings page and save only to that selected project. Shared-only projects have no local project settings.
- Keep **Project → Shared repositories** available without a project selection. It registers or removes independent Shared Context Git repositories on this device. Removal is blocked while a local project remains connected and never deletes the remote repository or its documents.
- Keep **Project → Selected project connection** bound to the local project and worktree selected in Explorer. A local project connects to one Shared Context repository at a time; switching repositories requires an explicit disconnect first. Disconnect removes only managed local links and connection state, preserving unmanaged files, shared Git history, and proposals.
- Keep **Hub → Project priority** available independently of project Settings validation. It stores one private device-wide logical-project order and updates immediately; it is not part of the manual project Save payload. Search, drag, or use the directional controls to reorder projects, and reset to restore automatic current/attention/recent ordering. Blocking conflicts remain first.
- A project selection appears immediately. Context Room then requests only that worktree's compact Settings payload and Explorer root. Cached Settings may appear at once, but project-owned controls and Save remain disabled until the server validates their revision.
- Every project Settings save includes the revision that was loaded. A concurrent project change returns `409` instead of overwriting newer configuration. The compact endpoint supports `ETag` and `If-None-Match` and does not duplicate materialized Hub cards or sections.
- Load Shared resources only when its category opens. Load Startup environment and Context Health only when their disclosure opens; a failure in one of these secondary surfaces must not block Settings or Explorer.
- In a global Context Room, bind Shared Skills and Shared Instructions to the project or worktree currently selected in Explorer. Do not merge collections from unrelated projects into one implicit destination.
- Keep the shared repository canonical and local paths private. **Use these skills in…** publishes assignment changes through a `skills` proposal; **Local destination…** changes only the local mount for an accepted assignment.
- Offer `project`, `shared`, and `device` scopes. Project scope uses a searchable multi-project selector; shared scope reaches only registered local locations in the selected shared.
- Enable Codex, Claude Code, and OpenCode on the device by default. A project override can inherit, enable, or disable each provider. Show `provider-disabled` without treating it as a broken shared snapshot.
- Apply that provider state to both Shared Skills and Shared Instructions. Disabling one provider removes only links recorded as managed on this device; it never removes unmanaged content.
- Derive provider destinations from the common provider profile. Codex uses
  `~/.agents/skills` device-wide and `.agents/skills` per project; managed
  legacy links migrate only after the preview is conflict-free, while
  unmanaged legacy content is preserved.
- Preview the exact projects, providers, destinations, skills, and collisions before the final action.
- For Shared Instructions, require an explicit Markdown source, target path,
  provider set, and project/shared/device scope. Logical changes use an
  `instructions` proposal; accepted main alone is projected into projects.
  Let an existing collection be assigned through **Use these instructions
  in…** without reimporting it. Preview both link installation and actual
  provider discovery. Never replace unmanaged instruction files. Hooks are not
  shared.
- Show safe hidden files by default. The global `Show hidden files` preference may hide dotfiles and dotfolders in every explorer.
- Keep the same component geometry across every theme. `Context Room` supports
  `system`, `light`, and `dark` appearance modes; the other named themes retain
  their explicit light or dark palettes.
- Enable interface sounds by default at 35%, with one global mute switch and volume control. Keep previews available while muted.
- Give enabled buttons a very short, dry interaction click with warm low-mid energy so it remains audible on laptop speakers at restrained volume without sounding sharp. Do not sound typing, field focus, slider movement, disabled buttons, or background refreshes.
- Reserve the longer cues for four outcomes: a completed file review, an emptied review queue, an accepted shared proposal, or a newly detected file conflict.
- Keep the palette quiet and repeatable: a softly damped, reverb-free click for frequent actions, with deeper tones and light reverb reserved for important outcomes instead of bright notification chimes.
- Generate the sound palette locally with Web Audio. Create or resume the audio context only after user interaction and fail silently when audio is unsupported.
- Store the Reference in Codex shortcut as a computer-wide preference. The default is `Mod+Shift+L`; clearing it disables keyboard activation without removing the floating action.
- Restore the active category after browser refresh.
- Persist disclosure and workbench pane state in local navigation state version
  3. Continue accepting versions 1 and 2 with default pane values; this
  migration never writes project configuration.
- Keep nested template and hub editors collapsed until selected.
- Preserve structured `watchRules` when other settings are saved. Show each folder rule with its mode and snapshot size when applicable. Removing or narrowing a rule is an owner-authority decision available in the current Settings interface, never through the agent CLI; it changes configuration, not project files or past human review decisions.
- Create folder rules from the Explorer or agent CLI. See [Agent configuration](../agent-configuration.md#watchrules) for the canonical four-mode contract.

## Context Settings CLI

The typed CLI exposes only settings that change context resolution or Context
Room organization:

```bash
context-room settings get [key] --project <id> --format json
context-room settings set --set 'allowedPaths=["docs/","runbooks/"]' --project <id> --format json
context-room settings set --apply <plan-id> --project <id> --format json
```

Manageable keys cover `allowedPaths`, `watchAllow`, `watchRules`, Startup
context, skill, and hook discovery, Shared Skills provider and assignment
overrides, and Hub sections or card state. Values are validated by a typed
registry; there is no arbitrary JSON mutation. For owner-review fields, the
agent path is monotonic: it may add or widen coverage, but a plan that removes
an allowed review path, narrows a folder mode, disables Startup context or
Startup skills, or otherwise reduces the current review boundary fails with
`human-authority-required`.

Appearance, sounds, shortcuts, Codex prompts, templates, document or hook
content, owner-controlled Git gates, and human review decisions are not exposed
through this CLI. Shared Skill collections and assignments are shared intent
and continue to change through a `shared skills` proposal.

Plan captures the exact project or local-state revision. Apply rejects a stale
plan instead of overwriting concurrent changes and emits only
`settings.changed` in the existing event journal.

Human Settings saves authorize the resulting normalized review scope for that
device. Context Room stores this authority state outside the project config;
later direct config narrowing stays ineffective and produces a critical health
issue until the owner saves the intended scope. Protected local Settings and
review requests also require the current UI session nonce. See
[Review authority](review-authority.md) for the exact boundary and same-user
limitations.

## Source Map

- `renderSettingsPanel` builds the category content.
- `renderSharedContextManagementSettings` explains accepted Git discovery, then manages device repositories and the selected project's connection through dedicated Context Hub APIs.
- `removeWatchRuleFromSettings` removes one exact structured folder rule through `/api/watch-rule`.
- `renderSettingsTabs`, `activateSettingsSection`, `renderSettingsDisclosure`, and the Settings search helpers control navigation and progressive disclosure.
- `refreshSharedSkillLocationsSettingsPanel` refreshes Shared Skills and Shared Instructions without rebuilding unrelated unsaved settings.
- `/api/settings` separates project configuration from global appearance, sound, and shortcut preferences.
- `/api/context-hub/project-settings` returns one project's compact revisioned settings and rejects stale saves.
- `src/context_settings.mjs` owns the typed CLI registry, plan IDs, stale checks, and receipts.
- `src/review_authority.mjs` owns the last owner-authorized review scope and tamper detection.
