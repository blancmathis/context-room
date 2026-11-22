#!/usr/bin/env bash
# Install the post-commit hook that deploys every commit on branch `perso` by itself.
# Hooks are shared by all worktrees of the repository. Remove with: rm "$(git rev-parse --git-common-dir)/hooks/post-commit"
set -euo pipefail
cd "$(dirname "$0")/.."
HOOK=$(git rev-parse --git-common-dir)/hooks/post-commit
mkdir -p "$(dirname "$HOOK")"
if [ -e "$HOOK" ] && ! grep -q perso-auto "$HOOK"; then echo "perso-hook-install: $HOOK exists and is not ours; not touching it" >&2; exit 1; fi
cat > "$HOOK" <<'H'
#!/bin/sh
# perso-auto: a commit on branch perso deploys itself (scripts/perso-auto.sh, log: $PERSO_HOME/perso.log)
[ "$(git branch --show-current)" = perso ] || exit 0
top=$(git rev-parse --show-toplevel)
[ -x "$top/scripts/perso-auto.sh" ] || exit 0
touch "${PERSO_HOME:-$HOME/.local/share/context-room}/auto.want" 2>/dev/null || mkdir -p "${PERSO_HOME:-$HOME/.local/share/context-room}"
nohup "$top/scripts/perso-auto.sh" >/dev/null 2>&1 &
exit 0
H
chmod +x "$HOOK" "$(dirname "$0")/perso-auto.sh"
echo "perso-hook-install: installed $HOOK"
