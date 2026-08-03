# Context Room

**A local-first workbench for keeping the context humans and AI agents use accurate, visible, and reviewable.**

Context Room brings project documentation, agent instructions, skills, hooks, reviews, and shared knowledge into one global app. Agents work through the CLI. People keep the final say in the webapp.

![Context Room Home with the Explorer, local document reviews, and a shared proposal](https://raw.githubusercontent.com/Swarek/context-room/main/docs/assets/readme/home-review-queue.png)

*The Home workspace puts the review queue first while the Explorer keeps projects, worktrees, and files close at hand.*

| Accepted context | Human-owned review | Multi-project by design |
| --- | --- | --- |
| Agents receive the latest verified local documents and accepted shared revision. | Every document version stays pending until a person accepts or rejects it. | One global Context Room can organize many projects, shared contexts, and registered worktrees. |

## Quick start

Context Room requires Node.js 20 or newer.

```bash
npm install -D context-room
npx context-room setup --title "My Project"
```

Setup maps the current project, registers it in the global Context Room, and opens the app. Use the Explorer to confirm the selected project and worktree before editing.

There is only one Context Room application. **Local** and **Shared** describe where documentation is stored and how it is reviewed; they are not separate app modes.

### Optional authenticated remote mode

The opt-in multi-user server entrypoint does not change the local default:

```bash
context-room-remote
```

The entrypoint refuses to start unless `CONTEXT_ROOM_REMOTE=1` and all signed-identity, shared-repository, project, and persistent-data settings are present. Browser requests require a short-lived signed administrator identity. Agent requests require a separate user-, project-, and session-scoped token and expose only accepted `main`, proposal work, and ephemeral Workspace navigation; agents cannot review, reject, or accept. The service is intended to stay on a private network behind an authenticated Portal, with `/data` on a persistent encrypted volume. QM is one supported adapter, not a dependency of the protocol. See [Remote QM deployment](docs/remote-qm.md).

Version 0.5.0 lets the same public CLI control one exact local or remote Context Room tab through the server:

```bash
context-room ui list --all --format json
context-room ui open --workspace <workspace-id> --view file --project atlas --file docs/PRODUCT.md
```

Use `CONTEXT_ROOM_REMOTE_URL` and `CONTEXT_ROOM_REMOTE_TOKEN` for a generic remote installation. A missing compatible tab returns `open_required` and a five-minute one-use pairing URL; the CLI never chooses or launches a browser. Exact Workspace and session targeting win, `--recent` is explicit, and unresolved multiple matches return `workspace_ambiguous` without moving any page. Installations whose private proxy host differs from their public page set `CONTEXT_ROOM_BROWSER_HOST` for those pairing URLs.

## How it works

1. **Register the places that matter.** Add projects, explicit worktrees, and any shared documentation repositories you use.
2. **Give agents accepted context.** Agents can search verified documentation, inspect active instructions and skills, and prepare documentation changes without taking review decisions.
3. **Review every changed file.** Local files enter the review queue individually. Shared changes are grouped in a Git-backed proposal. A person accepts or rejects each file in the webapp. If an agent is operating the review surface, it must ask first, restate the exact action and effects after the first yes, ask again, and make no decision without a second separate, unambiguous yes.

## Product tour

### One Home for every project

Home starts with a unified review queue. Local files and shared proposals stay visually distinct, while project filters, project priority, and snooze keep a large catalog manageable. Each browser tab is an independent Workspace, so different projects, worktrees, files, or proposals can remain open side by side.

The Explorer stays available across Home, Settings, files, and proposals. It supports project and Computer views, registered worktrees, watched states, search, file operations, and project-aware context menus.

Graph turns explicit documentation links into a progressive visual map: start with all registered projects, open one project's managed documents, then focus on the proven neighbors of a single file. Accepted context is shown by default; unverified, target, unresolved, and proposal layers remain optional and visibly separate.

### Read, edit, compare, and review

![A watched AGENTS.md file open beside its Git diff in Context Room](https://raw.githubusercontent.com/Swarek/context-room/main/docs/assets/readme/document-review.png)

*A calm document canvas keeps the source, Git diff, edit boundary, and current review state together.*

Context Room reads Markdown, HTML documents, images, and common diagram formats. Watched documents remain in review until the exact current content hash is verified. Git supplies a diff when one exists; it never decides that a file has already been reviewed.

### Review shared proposals without mixing them into current context

![A six-file shared proposal with its description, review progress, and Context Impact entry](https://raw.githubusercontent.com/Swarek/context-room/main/docs/assets/readme/proposal-review.png)

*A proposal keeps its purpose, changed files, progress, and impact visible without exposing pull-request mechanics as the main workflow.*

Shared documentation is changed on a proposal branch. Context Room shows every changed file as a human review item, rebases against the accepted default branch, and finalizes the proposal only after the file decisions are complete. Context Impact shows which documents, instructions, skills, projects, and registered worktrees the exact proposal revision can affect.

### See what can shape an agent before work starts

![Startup settings showing AGENTS.md and CLAUDE.md discovery, local skills, and executable hook sources](https://raw.githubusercontent.com/Swarek/context-room/main/docs/assets/readme/startup-environment.png)

*Startup settings make instruction discovery, local skill folders, and executable hook sources explicit for the selected project.*

Startup environment separates every discovered instruction, skill, and hook, with its source and state. Context Health reports broken paths, unsafe or uncertain configuration, stale managed links, provider problems, and review-safety issues without silently changing the project.

### Share reviewed skills and instructions

![Shared resource settings with a skill collection, local destinations, and a shared instruction collection](https://raw.githubusercontent.com/Swarek/context-room/main/docs/assets/readme/shared-resources.png)

*Shared resources keep accepted skills and instruction files canonical while exposing them through explicit, managed destinations.*

Shared Skills can target Codex, Claude Code, OpenCode, or a custom folder. Codex uses its official `~/.agents/skills` device destination and `.agents/skills` project destination. Shared Instructions can contain reviewed `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, or another chosen Markdown instruction file. Logical assignments live in the shared repository; provider activation, physical destinations, and local overrides remain device configuration.

Context Room never replaces an unmanaged local file or link. Executable hooks remain local and are not presented as shareable resources.

## Everything Context Room manages

| Area | What you can manage |
| --- | --- |
| Reviews | A unified queue, exact-hash verification, project priority, snooze, annotations, and owner-controlled Git gates. |
| Documents | Markdown, visual HTML, images, diagrams, diffs, editing, read-only paths, and explicit edit boundaries. |
| Document Graph | Global, project, and local maps of explicit references, applicable instructions and skills, shared origins, backlinks, and cited sources. |
| Projects | Local projects, multiple shared contexts, registered worktrees, project search, and independent browser Workspaces. |
| Agent startup | `AGENTS.md`, `CLAUDE.md`, provider-specific instructions, local skills, and local executable hooks. |
| Shared resources | Reviewed skill and instruction collections, scoped assignments, provider destinations, exclusions, overrides, and collision safety. |
| Context Engine | Effective context, application trace, resource impact, accepted snapshots, snapshot diffs, and proposal impact. |
| Research | A documentation-only Research Agent through `ask`, technically restricted to accepted local documents and accepted shared main. |
| Personalization | Searchable Settings, six themes, system light/dark mode, interface sounds, keyboard shortcuts, Hub sections, and Codex Prompt Center. |
| Diagnostics | Doctor, Context Health, configuration checks, shared freshness, managed-link checks, and Git review gates. |

## Local vs Shared documentation

| Local | Shared |
| --- | --- |
| Documents live with the project or in another explicitly allowed local path. | Documents live in a dedicated Git repository used by one or more projects or teams. |
| Each watched file version is reviewed individually. | Changes are grouped in a proposal branch and each changed file receives a decision. |
| A verified content hash becomes the accepted local version. | The accepted default branch is the canonical shared version everywhere. |
| A changed but unverified document is blocked from effective agent context. | Proposal content stays outside effective context until the proposal is finalized into the accepted branch. |

This separation lets teams share one reviewed body of knowledge without giving an agent a direct write path to canonical documentation.

## Agent-first CLI

The webapp is the human interface. The CLI is the machine interface for coding agents and voice agents. Its root surface has only three commands.

```bash
context-room ask "We are changing production rollback for the Atlas deployment service. Find the accepted documents that define the current workflow and ownership, explain the exact sequence and constraints the implementation must preserve, identify contradictions or missing decisions, and return the useful passages in the answer."
context-room edit create "Update the accepted deployment documentation to explain the production rollback sequence, ownership boundaries, failure handling, and verification steps." --project atlas
context-room capabilities
```

- `ask` sends a complete task-specific research brief to a read-only documentation researcher. Include the work context, what must be learned or verified, constraints, and the expected answer; it is not a keyword search.
- `edit create` creates a proposal from a complete human-readable description. `edit list` uses the project containing the current directory, and `edit open <exact-branch>` finds and restores the proposal without another project selector. None of them accepts documentation.
- `capabilities` returns six compact sections. An agent opens only the relevant section, then asks for one exact command contract if needed.

```bash
context-room capabilities
context-room capabilities --include shared
context-room capabilities "shared skills assign"
```

The exhaustive inventory remains available through `capabilities --expand`, but is never loaded by default.

Advanced and compatibility commands stay out of root help. There is no agent-facing `publish` step and no CLI command that accepts or rejects a file review.

The complete machine contract, output formats, targeting rules, and safety boundaries live in the [Agent CLI guide](docs/features/agent-cli.md).

## Trust model

- **Review decisions and scope reductions are human-only.** The agent-facing CLI cannot accept, reject, verify, narrow, or remove owner-authorized review coverage. Before attempting any review decision through another surface, an agent must obtain two separate explicit confirmations: after the first yes it restates the exact action, scope, and effects, then waits for a second unambiguous yes.
- **Authority failures stay visible.** Direct config narrowing fails closed, and a disappeared shared proposal remains a critical queue item instead of silently looking rejected.
- **Local controls are defense in depth.** UI nonces and signed owner state do not prove physical human presence against an unrestricted process under the same OS account; provider-side rules or a separate authenticated reviewer provide the stronger boundary.
- **Verification belongs to an exact content hash.** Any content change creates a new review state, including a change that was already committed.
- **`allowedPaths` is the editing boundary.** Context Room does not broaden it implicitly.
- **Unmanaged files and links are preserved.** Managed Shared Skills and Shared Instructions stop at a collision instead of overwriting another source.
- **Proposal content is never canonical early.** Only the accepted shared default branch enters effective context.
- **Projects and worktrees are explicit.** Context Room does not scan the computer to discover new ones.
- **Hooks are treated as executable code.** They are local, visible, and read-only by default unless the project owner enables editing.

## Documentation

- [Product overview](docs/product-overview.md) — the product model and source map.
- [Feature documentation](docs/features/index.md) — every user-facing capability.
- [Agent configuration](docs/agent-configuration.md) — project settings, paths, review scope, and startup discovery.
- [Shared context](docs/features/shared-context.md) — repositories, proposals, reviews, Shared Skills, and Shared Instructions.
- [Context Engine](docs/features/context-engine.md) — effective context, graph, trace, impact, snapshots, and diffs.
- [Document Graph](docs/features/document-graph.md) — human navigation across proven document relations.
- [Agent CLI](docs/features/agent-cli.md) — the complete agent-facing machine contract.
- [Review authority](docs/features/review-authority.md) — threat model, controls, Git protections, recovery, and same-user limits.

## Development

```bash
npm test
npm run test:ux-smoke
npm run test:perf
node bin/context-room.mjs doctor --root .
npm run package:privacy
npm pack --dry-run
```

`npm run test:ux-smoke` runs the permanent desktop and mobile browser regression suite in an isolated Context Room. `npm run test:perf` measures hot boot, first paint, long tasks, transfer sizes, and idle network activity after two warmups. Before a release or after a substantial shell change, run `npm run test:ux-soak`; it runs for 15 minutes by default and repeats the same workflows across accelerated days while checking browser memory, DOM growth, requests, Workspace cleanup, and navigation persistence. For a bounded local diagnosis, set `CONTEXT_ROOM_UX_SOAK_CYCLES=4`.

`package:privacy` inspects the exact npm file list and rejects absolute user-home paths or email addresses before publication.
