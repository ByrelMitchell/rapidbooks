#!/bin/sh
# RapidBooks launcher for the client desktops: opens Chromium in app mode, full screen,
# at the server. Install as /usr/local/bin/rapidbooks-launch (see docs/DEPLOY.md);
# rapidbooks.desktop runs it.
#
# Set the server address here, or in /etc/rapidbooks-client.conf as RAPIDBOOKS_URL=...
RAPIDBOOKS_URL="https://rapidbooks.lan:3001/"
# Only if the server runs plain HTTP (no certificate): set to 1 to have Chromium treat
# this one address as secure anyway, so Ctrl+W / Ctrl+N / Ctrl+T work in full screen.
TREAT_AS_SECURE=0

[ -r /etc/rapidbooks-client.conf ] && . /etc/rapidbooks-client.conf

for b in chromium chromium-browser google-chrome-stable google-chrome; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
if [ -z "${BROWSER:-}" ]; then
  echo "Chromium is not installed." >&2
  exit 1
fi

# A separate browser profile just for RapidBooks (its own zoom, its own login cookie).
PROFILE="${HOME}/.config/rapidbooks-browser"
set -- --app="$RAPIDBOOKS_URL" --start-fullscreen --user-data-dir="$PROFILE" \
  --class=RapidBooks --no-first-run --no-default-browser-check
if [ "$TREAT_AS_SECURE" = 1 ]; then
  ORIGIN="$(printf '%s' "$RAPIDBOOKS_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  set -- "$@" --unsafely-treat-insecure-origin-as-secure="$ORIGIN"
fi
exec "$BROWSER" "$@"
