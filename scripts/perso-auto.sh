#!/usr/bin/env bash
# Auto-deploy of the perso branch (started in the background by the post-commit hook).
# Push `perso`, then build + switch with perso.sh. One run at a time; the latest commit wins:
# a commit made during a run sets auto.want, and the run goes again on the new HEAD. Log: $PERSO_HOME/perso.log
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
BASE=${PERSO_HOME:-$HOME/.local/share/context-room}
LOG=$BASE/perso.log LOCK=$BASE/auto.lock WANT=$BASE/auto.want
mkdir -p "$BASE"; touch "$WANT"
[ "$(git -C "$REPO" branch --show-current)" = perso ] || exit 0
if ! mkdir "$LOCK" 2>/dev/null; then
  kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null && exit 0   # a run is live: it will see the new HEAD
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT
cd "$REPO"
while [ -e "$WANT" ]; do
  rm -f "$WANT"
  sha=$(git rev-parse --short=7 HEAD); t0=$(date +%s)
  echo "[$(date -u +%FT%TZ)] perso-auto: commit $sha" >> "$LOG"
  if git push -q origin perso >> "$LOG" 2>&1 && PERSO_AUTO=1 scripts/perso.sh perso >> "$LOG" 2>&1; then
    echo "[$(date -u +%FT%TZ)] perso-auto: $sha live in $(( $(date +%s) - t0 )) s" >> "$LOG"
  else
    echo "[$(date -u +%FT%TZ)] perso-auto: $sha FAILED (see lines above); fix, then commit again or run make perso" >> "$LOG"
  fi
done
trap - EXIT; rm -rf "$LOCK"
[ -e "$WANT" ] && exec "$0"   # a commit arrived while the lock was being released
exit 0
