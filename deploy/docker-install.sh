#!/usr/bin/env bash
# Install or update RapidBooks as a Docker container, for Linux machines whose own
# Node.js is too old (e.g. Linux Mint 19 / Ubuntu 18.04). Safe to run again: it
# rebuilds the image from this folder and replaces the container; the data is kept.
#
#   sudo ./deploy/docker-install.sh            this computer only, no password
#   sudo ./deploy/docker-install.sh --lan      also other computers on the network (asks for a password)
#   sudo ./deploy/docker-install.sh --empty    first install with an empty company instead of the demo
#
# Data folder: /var/lib/rapidbooks (database, backups, auth.json, smtp.json).
# The container restarts by itself after a reboot. See docs/DOCKER.md.
set -euo pipefail

NAME=rapidbooks
IMAGE=rapidbooks:latest
DATA_DIR=/var/lib/rapidbooks
PORT=3001
CONTAINER_UID=1000   # the "node" user inside the image
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LAN=0
EMPTY=0
for a in "$@"; do
  case "$a" in
    --lan) LAN=1 ;;
    --empty) EMPTY=1 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo $0 $*"
command -v docker >/dev/null || die "Docker is not installed. Install it with: sudo apt install docker.io"
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker is installed but not running (sudo systemctl start docker)."

TZ_NAME="$(cat /etc/timezone 2>/dev/null || true)"
TZ_NAME="${TZ_NAME:-$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}"
run_tool() { docker run --rm -e TZ="$TZ_NAME" -v "$DATA_DIR:/data" "$@"; }

# The web app is built by GitHub for every commit (.github/workflows/web-dist.yml):
# some older CPUs cannot run Vite's bundler ("Illegal instruction"). Use that build when
# there is one for this exact commit; otherwise build it in the image.
REPO="${RAPIDBOOKS_REPO:-ByrelMitchell/rapidbooks}"
DIST="$SRC_DIR/packages/web/dist"
rm -rf "$DIST"
# Ask git as the folder's owner: run as root, git refuses another user's repository.
SHA=""
if [ -d "$SRC_DIR/.git" ]; then
  OWNER="$(stat -c %U "$SRC_DIR")"
  SHA="$(sudo -u "$OWNER" git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$SHA" ] || SHA="$(git -c safe.directory='*' -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
fi
if [ -z "$SHA" ]; then
  say "Could not tell which commit this folder is, so the web app will be built here."
  echo "If that fails with \"Illegal instruction\", use a git clone of the repository."
else
  say "Downloading the web app built for commit ${SHA:0:7}"
  URL="https://github.com/$REPO/releases/download/web-dist/web-dist-$SHA.tar.gz"
  if curl -fsSL "$URL" -o /tmp/rapidbooks-web-dist.tgz; then
    mkdir -p "$DIST" && tar -xzf /tmp/rapidbooks-web-dist.tgz -C "$SRC_DIR/packages/web"
    rm -f /tmp/rapidbooks-web-dist.tgz
    echo "Got it."
  else
    echo "Not there (GitHub may still be building it, a few minutes after a push)."
    echo "Building it here instead. If that fails with \"Illegal instruction\", wait a few"
    echo "minutes and run this script again."
  fi
fi

say "Building the RapidBooks image (a few minutes)"
OLD_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
# Leftovers of earlier builds first, so a nearly full disk still has room for this one
# (the image the running container uses is kept: it is not dangling).
docker image prune -f --filter label=app=rapidbooks >/dev/null 2>&1 || true
docker build -t "$IMAGE" "$SRC_DIR"

say "Data folder $DATA_DIR"
install -d -m 0750 -o "$CONTAINER_UID" -g "$CONTAINER_UID" "$DATA_DIR"

if docker container inspect "$NAME" >/dev/null 2>&1; then
  say "Stopping the running RapidBooks"
  docker stop -t 60 "$NAME" >/dev/null || true
  docker rm "$NAME" >/dev/null
  if [ -f "$DATA_DIR/rapidbooks.db" ]; then
    install -d -m 0750 -o "$CONTAINER_UID" -g "$CONTAINER_UID" "$DATA_DIR/backups"
    COPY="$DATA_DIR/backups/before-update-$(date +%Y%m%d-%H%M%S).db"
    cp -p "$DATA_DIR/rapidbooks.db" "$COPY"
    echo "Copied the database to $COPY"
  fi
fi

if [ ! -f "$DATA_DIR/rapidbooks.db" ] && [ "$EMPTY" -eq 0 ]; then
  say "Creating the demo company"
  run_tool "$IMAGE" node --import tsx packages/server/src/demo/cli.ts --out /data/rapidbooks.db
fi

if [ "$LAN" -eq 1 ]; then
  if [ ! -f "$DATA_DIR/auth.json" ]; then
    say "Set the RapidBooks password (needed when other computers can reach it)"
    run_tool -it "$IMAGE" node --import tsx packages/server/src/auth/set-password.ts
  fi
  PUBLISH=(-p "$PORT:3001")
  AUTH=()
else
  # Published on 127.0.0.1 only, so nothing else on the network can reach it.
  PUBLISH=(-p "127.0.0.1:$PORT:3001")
  AUTH=(-e RAPIDBOOKS_NO_AUTH=1)
fi

say "Starting RapidBooks"
docker run -d --name "$NAME" --init --restart unless-stopped \
  -e TZ="$TZ_NAME" "${AUTH[@]}" "${PUBLISH[@]}" \
  -v "$DATA_DIR:/data" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then echo; break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || {
  docker logs --tail 30 "$NAME" >&2 || true
  die "RapidBooks did not answer on port $PORT. The log is above (more: sudo docker logs $NAME)."
}

# Every build leaves the previous image and its build stage behind, hundreds of MB
# each, until the disk fills. Remove them now that the new image is the one running.
say "Removing old RapidBooks images"
docker image prune -f --filter label=app=rapidbooks | tail -n 1 || true
# The image of the previous install, if it was built before the label existed.
NEW_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE")"
if [ -n "$OLD_IMAGE_ID" ] && [ "$OLD_IMAGE_ID" != "$NEW_IMAGE_ID" ]; then
  docker rmi "$OLD_IMAGE_ID" >/dev/null 2>&1 || true
fi
# BuildKit's cache (newer Docker), only a cache: the next build just takes longer.
docker builder prune -f >/dev/null 2>&1 || true

say "Installing the RapidBooks menu entry"
install -m 0755 "$SRC_DIR/deploy/rapidbooks-launch.sh" /usr/local/bin/rapidbooks-launch
install -m 0644 "$SRC_DIR/deploy/rapidbooks.desktop" /usr/share/applications/rapidbooks.desktop
install -D -m 0644 "$SRC_DIR/deploy/rapidbooks.png" /usr/share/icons/hicolor/256x256/apps/rapidbooks.png
if [ ! -f /etc/rapidbooks-client.conf ]; then
  printf 'RAPIDBOOKS_URL=http://localhost:%s/\nTREAT_AS_SECURE=0\n' "$PORT" > /etc/rapidbooks-client.conf
fi
command -v chromium >/dev/null || command -v chromium-browser >/dev/null || command -v google-chrome-stable >/dev/null \
  || echo "Note: the menu entry needs Chromium or Chrome: sudo apt install chromium-browser"

echo
echo "Done. RapidBooks is at http://localhost:$PORT/ (or Menu > RapidBooks)."
[ "$LAN" -eq 1 ] && echo "Other computers: http://$(hostname -I | awk '{print $1}'):$PORT/"
echo "Log: sudo docker logs -f $NAME    Update: git pull, then run this script again."
