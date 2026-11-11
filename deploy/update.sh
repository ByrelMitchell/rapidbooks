#!/usr/bin/env bash
# Update RapidBooks to a new version. Run on the server:
#
#   sudo /opt/rapidbooks/deploy/update.sh /path/to/new/rapidbooks   (copy from a folder)
#   sudo /opt/rapidbooks/deploy/update.sh                            (git pull, if /opt/rapidbooks is a git checkout)
#
# Stops the service, makes a backup, brings in the new version, npm ci, builds,
# starts the service and checks that it answers.
set -euo pipefail

APP_DIR=/opt/rapidbooks
ENV_FILE=/etc/rapidbooks.env
SRC="${1:-}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -d "$APP_DIR" ] || die "$APP_DIR does not exist. Use deploy/install.sh for a first install."

say "Stopping RapidBooks"
systemctl stop rapidbooks.service

say "Backing up before the update"
if ! /usr/local/bin/rapidbooks-admin backup; then
  echo "The backup failed. RapidBooks has been left stopped and NOT updated." >&2
  echo "Fix the backup (see the message above), or start it again with: sudo systemctl start rapidbooks" >&2
  exit 1
fi

say "Bringing in the new version"
if [ -n "$SRC" ]; then
  SRC="$(cd "$SRC" && pwd)"
  [ -f "$SRC/package.json" ] || die "$SRC does not look like a RapidBooks folder (no package.json)."
  rsync -a --delete \
    --exclude node_modules --exclude 'packages/*/node_modules' --exclude 'packages/web/dist' \
    --exclude data --exclude config --exclude .git --exclude reference \
    "$SRC/" "$APP_DIR/"
elif [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  die "Give the folder with the new version: sudo $0 /path/to/rapidbooks"
fi

say "Installing packages and building"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
install -m 0644 "$APP_DIR/deploy/rapidbooks.service" /etc/systemd/system/rapidbooks.service
install -m 0755 "$APP_DIR/deploy/rapidbooks-admin.sh" /usr/local/bin/rapidbooks-admin
systemctl daemon-reload

say "Starting RapidBooks"
systemctl start rapidbooks.service
for _ in $(seq 1 20); do
  if /usr/local/bin/rapidbooks-admin health >/dev/null 2>&1; then
    /usr/local/bin/rapidbooks-admin health
    echo "Update complete."
    exit 0
  fi
  sleep 1
done
echo "RapidBooks did not answer after the update. Look at the log: journalctl -u rapidbooks -n 50" >&2
exit 1
