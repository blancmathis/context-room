---
context_room:
  id: projection.repository-entry
  depends_on:
    - strategy.context-room
    - product.model
    - projection.documentation.map
---

# Context Room

Context Room is a local-first control room for documentation used by humans and AI agents. It keeps accepted context, pending changes, and human review authority visibly separate.

## Documentation

- [Documentation map](docs/index.md)
- [Product strategy](PRODUCT.md)
- [Product model](docs/product-overview.md)
- [System architecture](docs/system/architecture.md)
- [Shared Context](docs/features/shared-context.md)
- [Human review authority](docs/features/review-authority.md)

The active refactor and its measured results are recorded in the [implementation dossier](docs/lifecycle/changes/active/refactor/index.md). Historical release records do not describe this working branch.

## Agent workflow

Any agent harness can use the CLI. Normal search and reading return accepted content. To change documentation, create an isolated proposal, edit its returned directory, then submit it to the human Review Queue:

```bash
context-room docs search "authentication" --root /path/to/project --format json
context-room changes begin --task "Clarify authentication" --root /path/to/project --format json
context-room changes status --change CHANGE_ID --format json
context-room changes submit --change CHANGE_ID --format json
```

Use `--scope shared` when creating a Shared change. Keep the reader token returned by document commands and supply `--reader` on subsequent reads. The [document workflow](docs/features/document-workflow.md) describes accepted versions, formats, migration and the optional tablet bridge.

## Development

Requires Node.js 20 or later.

```bash
npm ci
npm test
node bin/context-room.mjs doctor --root .
```

The CLI entry point is `bin/context-room.mjs`; the main implementation is `src/context_room.mjs`.

## Perso channel (your own build, daily)

Run your own pushed commit without waiting for CI. Agents just commit on the long-lived branch `perso`: a post-commit hook pushes and deploys it by itself, and an open Hub page reloads itself (no PR per change, no manual step). Install the hook once per clone: `make perso-hook` (`scripts/perso-hook-install.sh`). It runs `scripts/perso-auto.sh` in the background, one run at a time, latest commit wins; the log is `$PERSO_HOME/perso.log` (`live in N s` or `FAILED`). `make perso` stays as the manual fallback. Publishing to others stays PR `perso` → `main`, CI, merge, only when Mathis asks.

```bash
make perso            # HEAD must be clean and pushed: build releases/<sha>/, switch `current`, restart the Hub
make perso-status     # branch, sha, date, previous release, Hub HTTP code
make perso-rollback   # back to `previous`
make perso-hook       # install the post-commit auto-deploy hook (once)
make perso NO_INSTALL=1   # build only into releases/; switches and restarts nothing (dry run / build check)
```

Releases live in `~/.local/share/context-room/releases/<sha>/` (`PERSO_HOME` overrides). `node_modules` is cloned (APFS `cp -c`), so a release costs little disk. After each switch, `perso.sh prune` keeps `current`, `previous` and the 3 newest other releases, and the 10 newest Hub backups. The Hub reports its release in `/api/health` (`release`); an open page checks it every 5 s while visible and reloads when it changes, unless a text field is being edited. Data stays in `~/.context-room`; it is backed up (`state-backups/`) before each switch. The first `make perso` makes the launchd launcher follow `current` (backup: `launch-installed.before-perso.py`) and adopts the release it runs today as `previous`. If the Hub does not answer after a switch, the old release comes back. A change of stored data format needs a migration: bump `scripts/perso-data-format` in that PR; `make perso` and `perso-rollback` then refuse until you plan it (`PERSO_ACCEPT_DATA_CHANGE=1` overrides; Mathis only, agents never set it).
