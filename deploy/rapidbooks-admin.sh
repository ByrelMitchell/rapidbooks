#!/usr/bin/env bash
# rapidbooks-admin: run RapidBooks' command-line tools as the rapidbooks user with the
# settings from /etc/rapidbooks.env. Installed by install.sh as /usr/local/bin/rapidbooks-admin.
#
#   sudo rapidbooks-admin set-password          set or change the password
#   sudo rapidbooks-admin backup                make a backup now
#   sudo rapidbooks-admin restore <file>        restore a backup (stop the service first)
#   sudo rapidbooks-admin health                ask the running server if it is well
set -euo pipefail

APP_DIR=/opt/rapidbooks
ENV_FILE=/etc/rapidbooks.env
SVC_USER=rapidbooks

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo rapidbooks-admin $*" >&2; exit 1; }
cmd="${1:-}"
[ $# -gt 0 ] && shift

run_tool() {
  # The tool runs as the service user so the files it writes belong to it.
  runuser -u "$SVC_USER" -- env HOME=/tmp bash -c 'set -a; . "$0"; set +a; cd "$1"; shift; exec node --import tsx "$@"' \
    "$ENV_FILE" "$APP_DIR" "$@"
}

case "$cmd" in
  set-password)
    run_tool packages/server/src/auth/set-password.ts "$@"
    ;;
  backup)
    run_tool packages/server/src/backup/backup-now.ts "$@"
    ;;
  restore)
    [ $# -ge 1 ] || { echo "Usage: sudo rapidbooks-admin restore <backup-file>" >&2; exit 2; }
    file="$(readlink -f "$1")"; shift
    if systemctl is-active --quiet rapidbooks; then
      echo "RapidBooks is running. Stop it first:  sudo systemctl stop rapidbooks" >&2
      exit 1
    fi
    run_tool packages/server/src/backup/restore.ts "$file" "$@"
    ;;
  health)
    port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"
    if grep -q '^RAPIDBOOKS_TLS_CERT=' "$ENV_FILE"; then proto=https; else proto=http; fi
    curl -fsSk "$proto://127.0.0.1:${port:-3001}/api/health" && echo
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
