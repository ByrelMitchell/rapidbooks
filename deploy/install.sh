#!/usr/bin/env bash
# Install (or re-install) RapidBooks on this Linux machine. Safe to run again.
#
#   sudo ./deploy/install.sh            (run from the unpacked RapidBooks folder)
#
# Does: checks Node >= 22, creates the rapidbooks user and its folders, copies the
# app to /opt/rapidbooks, npm ci, builds the web app, installs /etc/rapidbooks.env
# (if missing), the systemd unit and the rapidbooks-admin helper, and enables the
# service. Does NOT set the password: it tells you how.
set -euo pipefail

APP_DIR=/opt/rapidbooks
DATA_DIR=/var/lib/rapidbooks
ENV_FILE=/etc/rapidbooks.env
UNIT=/etc/systemd/system/rapidbooks.service
DROPIN_DIR=/etc/systemd/system/rapidbooks.service.d
SVC_USER=rapidbooks
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo $0"

say "Checking Node.js"
command -v node >/dev/null || die "Node.js is not installed. Install Node 22 or newer (e.g. from https://nodejs.org or NodeSource) and run this again."
command -v npm >/dev/null || die "npm is not installed (it normally comes with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js $(node -v) is too old; RapidBooks needs Node 22 or newer."
[ -x /usr/bin/node ] || echo "Note: node is at $(command -v node), not /usr/bin/node; the service finds it through /usr/bin/env."
echo "Node $(node -v), npm $(npm -v)"

say "Creating the $SVC_USER user and folders"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 0755 "$APP_DIR"

say "Copying the app to $APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  if command -v rsync >/dev/null; then
    rsync -a --delete \
      --exclude node_modules --exclude 'packages/*/node_modules' --exclude 'packages/web/dist' \
      --exclude data --exclude config --exclude .git --exclude reference \
      "$SRC_DIR/" "$APP_DIR/"
  else
    (cd "$SRC_DIR" && tar --exclude=node_modules --exclude=packages/web/dist --exclude=./data \
      --exclude=./config --exclude=.git --exclude=./reference -cf - .) | (cd "$APP_DIR" && tar -xf -)
  fi
fi

say "Installing packages (npm ci) and building the web app"
cd "$APP_DIR"
# Dev dependencies are needed too (tsx runs the server, vite builds the app): no --omit=dev.
npm ci --no-audit --no-fund
npm run build

say "Settings file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  install -m 0640 -o root -g "$SVC_USER" "$APP_DIR/deploy/rapidbooks.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE from the example. Review it (especially RAPIDBOOKS_BACKUP_DIR)."
else
  echo "$ENV_FILE already exists; left as it is."
fi

say "Installing the systemd service"
install -m 0644 "$APP_DIR/deploy/rapidbooks.service" "$UNIT"
# Let the service write to the configured backup folder (ProtectSystem=strict hides it otherwise).
BACKUP_DIR="$(sed -n 's/^[[:space:]]*RAPIDBOOKS_BACKUP_DIR=//p' "$ENV_FILE" | tail -n 1)"
install -d -m 0755 "$DROPIN_DIR"
if [ -n "$BACKUP_DIR" ]; then
  printf '[Service]\n# Written by install.sh from RAPIDBOOKS_BACKUP_DIR in %s\nReadWritePaths=-%s\n' "$ENV_FILE" "$BACKUP_DIR" > "$DROPIN_DIR/backup-dir.conf"
  echo "Backup folder: $BACKUP_DIR"
  [ -d "$BACKUP_DIR" ] || echo "WARNING: $BACKUP_DIR does not exist yet. Mount it (see docs/DEPLOY.md) before the first backup."
else
  rm -f "$DROPIN_DIR/backup-dir.conf"
  echo "Backup folder: $DATA_DIR/backups (same disk as the database -- set RAPIDBOOKS_BACKUP_DIR to another machine's mount)."
fi
install -m 0755 "$APP_DIR/deploy/rapidbooks-admin.sh" /usr/local/bin/rapidbooks-admin
systemctl daemon-reload
systemctl enable rapidbooks.service >/dev/null

AUTH_FILE="$(sed -n 's/^[[:space:]]*RAPIDBOOKS_AUTH_FILE=//p' "$ENV_FILE" | tail -n 1)"
AUTH_FILE="${AUTH_FILE:-$DATA_DIR/auth.json}"
if [ -f "$AUTH_FILE" ]; then
  say "Starting RapidBooks"
  systemctl restart rapidbooks.service
  sleep 2
  systemctl --no-pager --lines=5 status rapidbooks.service || true
else
  say "Almost done: set the password"
  cat <<EOF
No password has been set yet, so RapidBooks will not start on the network.
Set one, then start the service:

    sudo rapidbooks-admin set-password
    sudo systemctl start rapidbooks

Then check:  curl http://localhost:$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)/api/health
EOF
fi
echo
echo "Done. See $APP_DIR/docs/DEPLOY.md for the firewall, HTTPS, client launchers and backups."
