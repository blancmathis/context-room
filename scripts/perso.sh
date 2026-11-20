#!/usr/bin/env bash
# Perso channel for Context Room (class C: local tool, perso = prod).
#   perso.sh perso     build HEAD (clean + pushed) into releases/<sha>/, switch `current`, restart the Hub
#   perso.sh status    branch, sha, date of the running release
#   perso.sh rollback  switch back to `previous`
# NO_INSTALL=1: build only (perso) or print the plan (rollback). Touches nothing that runs.
# Env: PERSO_HOME (default ~/.local/share/context-room), CONTEXT_ROOM_HUB_HOME (default ~/.context-room),
#      PERSO_PORT (4319), PERSO_LABEL (app.contextroom.local), PERSO_NODE, PERSO_DEPS_FROM (runtime dir with node_modules),
#      PERSO_ACCEPT_DATA_CHANGE=1 (allow a data-format change, after reading docs).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
BASE=${PERSO_HOME:-$HOME/.local/share/context-room}
HUB=${CONTEXT_ROOM_HUB_HOME:-$HOME/.context-room}
PORT=${PERSO_PORT:-4319}
LABEL=${PERSO_LABEL:-app.contextroom.local}
LAUNCHER=$BASE/launch-installed.py
REL=$BASE/releases CUR=$BASE/current PREV=$BASE/previous
die() { echo "perso: $*" >&2; exit 1; }
field() { node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]??""))}catch{}' "$1/perso.json" "$2"; }
fmt_of() { local f; f=$(field "$1" dataFormat); [ -n "$f" ] && echo "$f" || { cat "$1/runtime/scripts/perso-data-format" 2>/dev/null || echo 1; }; }
rel_name() { [ -L "$1" ] && basename "$(readlink "$1")" || true; }
guard_data() { # $1 from release dir, $2 to release dir
  local a b; a=$(fmt_of "$1"); b=$(fmt_of "$2")
  if [ "$a" != "$b" ]; then
    echo "perso: data format changes ($a -> $b): this needs a schema migration of the data in $HUB." >&2
    [ "${PERSO_ACCEPT_DATA_CHANGE:-}" = 1 ] || die "refused. Do not switch; plan the migration first (PERSO_ACCEPT_DATA_CHANGE=1 overrides)."
  fi
}
node_bin() {
  [ -n "${PERSO_NODE:-}" ] && { echo "$PERSO_NODE"; return; }
  local n; n=$(sed -n "s/^NODE = '\(.*\)'/\1/p" "$LAUNCHER" 2>/dev/null | head -1)
  [ -x "${n:-}" ] && echo "$n" || command -v node
}
health() { for _ in $(seq 1 60); do [ "$(curl -sL -o /dev/null -w %{http_code} "http://127.0.0.1:$PORT/" || true)" = 200 ] && return 0; sleep 2; done; return 1; }
restart() {
  local old; old=$(pgrep -f "context-room.mjs hub.*--port $PORT" || true)
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  sleep 5; for p in $old; do kill "$p" 2>/dev/null && { sleep 15; kill -9 "$p" 2>/dev/null || true; echo "stopped stale $p"; }; done
  health
}
point() { ln -sfn "$1" "$2"; ln -sfn "$CUR/runtime/bin/context-room.mjs" "$HOME/.local/bin/context-room" 2>/dev/null || true; }

build() {
  cd "$REPO"
  [ -z "$(git status --porcelain)" ] || die "working tree not clean. Commit first."
  git fetch -q origin || die "git fetch failed"
  local full sha; full=$(git rev-parse HEAD); sha=$(git rev-parse --short=7 HEAD)
  [ -n "$(git branch -r --contains "$full")" ] || die "$sha is not pushed. Push the branch first."
  DEST=$REL/$sha
  if [ -f "$DEST/perso.json" ]; then echo "perso: release $sha already built"; return; fi
  mkdir -p "$REL"; local stage="$REL/.build-$sha" src; rm -rf "$stage" "$stage.src"; mkdir "$stage.src"
  git archive "$full" | tar -x -C "$stage.src"
  local nodep wh md A; nodep=$(node_bin)
  wh=/opt/homebrew/bin/whisper-cli; md=$HOME/.context-room/assistant/models/ggml-large-v3-turbo-q5_0.bin
  A=(--source "$stage.src" --output "$stage" --node "$nodep" --port "$PORT"); [ -x "$wh" ] && A+=(--whisper "$wh"); [ -f "$md" ] && A+=(--model "$md")
  local rev; rev=$(node scripts/prepare-mac-install.mjs "${A[@]}" | sed -n 's/.*"revision": "\(.*\)".*/\1/p' | head -1)
  node scripts/prepare-mac-install.mjs "${A[@]}" --apply --revision "$rev" | grep -q '"prepared": true' || die "prepare failed"
  # dependencies: reuse a release with the identical lock file, else npm ci
  local d got=""
  for d in ${PERSO_DEPS_FROM:+"$PERSO_DEPS_FROM"} "$CUR/runtime" "$REL"/*/runtime; do
    [ -d "$d/node_modules" ] && cmp -s "$stage.src/package-lock.json" "$d/package-lock.json" && { cp -R "$d/node_modules" "$stage/runtime/"; got=$d; break; }
  done
  [ -n "$got" ] || (cd "$stage/runtime" && "$(dirname "$nodep")/npm" ci --omit=dev --no-audit --no-fund >/dev/null) || die "dependencies missing and npm ci failed"
  printf '{"sha":"%s","fullSha":"%s","branch":"%s","builtAt":"%s","packageVersion":"%s","dataFormat":"%s","port":%s}\n' \
    "$sha" "$full" "$(git branch --show-current)" "$(date -u +%FT%TZ)" "$(node -p 'require("./package.json").version')" "$(cat scripts/perso-data-format)" "$PORT" > "$stage/perso.json"
  rm -rf "$stage.src"; mv "$stage" "$DEST"
  echo "perso: built $sha into $DEST"
}

install_release() {
  local name=$1 backup_dir=$BASE/state-backups
  [ "$(rel_name "$CUR")" = "$name" ] && { echo "perso: $name is already current"; return; }
  # first install: adopt the release the launcher uses today as `current`, and make the launcher follow `current`
  if [ ! -L "$CUR" ]; then
    local live; live=$(grep -m1 -o 'releases/[^/]*/runtime' "$LAUNCHER" 2>/dev/null | cut -d/ -f2 || true)
    [ -n "$live" ] && [ -d "$REL/$live" ] || die "cannot find the release your launcher runs. See README, Perso channel."
    ln -sfn "releases/$live" "$CUR"
  fi
  [ -d "$CUR" ] || die "current points nowhere"
  guard_data "$CUR" "$REL/$name"
  mkdir -p "$backup_dir"
  if grep -q "^RUNTIME = BASE / 'current/runtime'" "$LAUNCHER"; then :; else
    cp "$LAUNCHER" "$BASE/launch-installed.before-perso.py"
    perl -pi -e "s#^RUNTIME = .*#RUNTIME = BASE / 'current/runtime'#" "$LAUNCHER"
  fi
  [ -d "$HUB/hub" ] && tar czf "$backup_dir/hub-before-$name-$(date +%Y%m%d%H%M%S).tgz" -C "$HUB" hub
  local was; was=$(readlink "$CUR")
  ln -sfn "$was" "$PREV"; point "releases/$name" "$CUR"
  if restart; then echo "perso: now running $name (was ${was#releases/}); hub $(curl -sL -o /dev/null -w %{http_code} "http://127.0.0.1:$PORT/")"
  else
    echo "perso: hub did not come back on $name; switching back" >&2
    point "$was" "$CUR"; ln -sfn "releases/$name" "$PREV"; restart || true; exit 1
  fi
}

case ${1:-} in
  perso) build; [ -n "${NO_INSTALL:-}" ] && { echo "perso: NO_INSTALL set, nothing switched. data-format check would say: $(fmt_of "$CUR" 2>/dev/null) -> $(fmt_of "$DEST")"; exit 0; }
         install_release "$(basename "$DEST")" ;;
  status) c=$(rel_name "$CUR"); [ -n "$c" ] || die "not installed (no current release)"
    echo "current:  $c  branch=$(field "$CUR" branch)  built=$(field "$CUR" builtAt)  version=$(field "$CUR" packageVersion)"
    echo "previous: $(rel_name "$PREV")"
    echo "launcher follows current: $(grep -q "current/runtime" "$LAUNCHER" 2>/dev/null && echo yes || echo no)"
    echo "hub http: $(curl -sL -o /dev/null -w %{http_code} "http://127.0.0.1:$PORT/" || true) (port $PORT)" ;;
  rollback) [ -L "$PREV" ] || die "no previous release"
    a=$(rel_name "$CUR"); b=$(rel_name "$PREV"); guard_data "$CUR" "$PREV"
    [ -n "${NO_INSTALL:-}" ] && { echo "perso: dry run. would switch current $a -> $b, previous $b -> $a, restart $LABEL"; exit 0; }
    ln -sfn "releases/$a" "$PREV"; point "releases/$b" "$CUR"
    restart && echo "perso: rolled back to $b" || { echo "perso: hub down after rollback to $b" >&2; exit 1; } ;;
  *) die "usage: perso.sh perso|status|rollback" ;;
esac
