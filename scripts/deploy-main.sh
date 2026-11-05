#!/usr/bin/env bash
set -euo pipefail
umask 077

# The Actions runner sends its short-lived repository token over SSH stdin.
IFS= read -r token
[[ -n "$token" ]] || { echo "Missing GitHub token" >&2; exit 1; }
cd "${CRAMAMELEON_ROOT:-$HOME/cramameleon}"
exec 9>var/run/deploy-main.lock
flock -w 60 9

releases=var/pm2-releases
live=var/pm2-current
health=http://127.0.0.1:18085
previous=$(readlink "$live")
stage=$(mktemp -d "$releases/.deploy.XXXXXXXX")
release=
switched=0
restart_backend=0

switch_to() {
  ln -sfn "$1" "$stage/current"
  mv -Tf "$stage/current" "$live"
}

wait_for_release() {
  local expected=$1 attempt
  for ((attempt = 0; attempt < 15; attempt++)); do
    if curl -fsS --max-time 2 "$health/api/health" >/dev/null 2>&1 &&
       curl -fsS --max-time 2 "$health/" 2>/dev/null | cmp -s "$expected/dist/index.html" -; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  local status=$?
  if (( switched )); then
    echo "Deploy failed. Restoring $previous" >&2
    if switch_to "$previous"; then
      if (( restart_backend )); then
        pm2 restart cramameleon || echo "PM2 rollback restart failed" >&2
      fi
      wait_for_release "var/$previous" || echo "Rollback health check failed" >&2
    else
      echo "Could not restore the previous release symlink" >&2
    fi
    status=1
  fi
  if [[ -n "$release" && -d "var/$release" && "$(readlink "$live")" != "$release" ]]; then
    rm -r -- "var/$release"
  fi
  rm -r -- "$stage"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cat > "$stage/askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' x-access-token ;;
  Password*) printf '%s\n' "$CRAMAMELEON_FETCH_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 "$stage/askpass"
LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$PWD/$stage/askpass" CRAMAMELEON_FETCH_TOKEN="$token" \
  timeout 120 git -c credential.helper= -c http.proxy="${CRAMAMELEON_GIT_PROXY:-}" fetch --no-tags \
    https://github.com/dormitory604/cramameleon.git refs/heads/main:refs/remotes/origin/main
unset token

target=$(git rev-parse refs/remotes/origin/main)
if [[ ! "$previous" =~ ^pm2-releases/(auto-)?([0-9a-f]{40})$ ]]; then
  echo "Unexpected active release path: $previous" >&2
  exit 1
fi
current=${BASH_REMATCH[2]}
if [[ "$target" == "$current" ]]; then
  echo "Already deployed $target"
  exit 0
fi
git merge-base --is-ancestor "$current" "$target" || {
  echo "main does not contain the currently deployed commit $current" >&2
  exit 1
}

echo "Building main at $target"
mkdir "$stage/source" "$stage/release"
git archive "$target" | tar -xf - -C "$stage/source"
(
  cd "$stage/source"
  npm ci --prefer-offline --no-audit --no-fund
  npm run build
)
mv "$stage/source/dist" "$stage/release/dist"
mv "$stage/source/material-parser" "$stage/release/material-parser"
if git diff --quiet "$current" "$target" -- server; then
  cp -p "var/$previous/cramameleon" "$stage/release/cramameleon"
else
  restart_backend=1
  (
    cd "$stage/source/server"
    GOMAXPROCS=1 GOMEMLIMIT=256MiB go build -p 1 -trimpath -o "../../release/cramameleon" .
  )
fi

destination="pm2-releases/auto-$target"
mv -T "$stage/release" "var/$destination"
release=$destination
switched=1
switch_to "$release"
if (( restart_backend )); then
  pm2 restart cramameleon
fi
wait_for_release "var/$release"
switched=0
echo "Deployed main at $target"

# Keep the active release and its immediate predecessor for rollback.
for old in "$releases"/auto-*; do
  [[ "$old" =~ ^var/pm2-releases/auto-[0-9a-f]{40}$ ]] || continue
  [[ "$old" == "var/$release" || "$old" == "var/$previous" ]] && continue
  rm -r -- "$old"
done
