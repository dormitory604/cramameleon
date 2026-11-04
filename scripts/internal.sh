#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
set -a
. "${CRAM_ENV_FILE:-./.env.internal}"
set +a
mkdir -p var/run var/log
pidfile=var/run/internal.pid
binary=$(realpath "${APP_BINARY:-server/bin/cramameleon}")
running() {
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile")
  case "$pid" in ''|*[!0-9]*) return 1;; esac
  [ "$(readlink "/proc/$pid/exe" 2>/dev/null || true)" = "$binary" ]
}
case "${1:-start}" in
 start)
  if running; then echo "Internal service already running"; exit 0; fi
  [ -x "$binary" ] || { echo "Build the server binary first"; exit 1; }
  nohup "$binary" >>var/log/internal.log 2>&1 </dev/null &
  echo "$!" >"$pidfile"
  sleep 1
  if ! running; then echo "Startup failed; inspect var/log/internal.log"; exit 1; fi
  echo "Internal service started"
 ;;
 stop)
  if running; then
    kill -TERM "$pid"
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if ! running; then echo "Internal service stopped"; exit 0; fi
      sleep 1
    done
    echo "Service is still stopping; inspect before retrying"; exit 1
  fi
  echo "Internal service is not running"
 ;;
 status) if running; then echo "Internal service running"; else echo "Internal service stopped"; exit 1; fi ;;
 *) echo "Usage: sh scripts/internal.sh start|stop|status"; exit 1 ;;
esac
