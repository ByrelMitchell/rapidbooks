#!/usr/bin/env bash
# Import the QuickBooks exports into a new RapidBooks company file and print the
# reconciliation with QuickBooks (see docs/IMPORT.md).
#
#   ./deploy/import-history.sh                        exports in data/qb-exports, makes data/trial.db
#   ./deploy/import-history.sh path/to/qb-export      exports somewhere else
#   ./deploy/import-history.sh path/to/qb-export data/other.db
#   sudo ./deploy/import-history.sh --install [path/to/qb-export]
#
# --install makes the imported books the ones RapidBooks serves. Fine to do before
# cutover, to try RapidBooks on her real books; then run it again at cutover with fresh
# exports (docs/IMPORT.md sections 6 and 7): anything entered in the meantime is set
# aside with the old file, not carried over. It imports into a new file next to the served database while RapidBooks
# keeps running; only if the reconciliation says PASS does it stop RapidBooks (the Docker
# container, or the rapidbooks service of deploy/install.sh), rename the old database
# with a date and time, put the new one in its place and start RapidBooks again. If
# anything differs, nothing is changed and the new file is left for a look.
#
# Paths are relative to the RapidBooks folder (the one with packages/ and data/), wherever
# this is run from. An existing company file at the output path is renamed with a date
# and time, never deleted. The reconciliation is also saved next to it as
# <name>-reconciliation.txt. Exit status: 0 = everything agrees with QuickBooks (PASS),
# 1 = something differs or an error, 2 = usage.
#
# Files are found in the export folder by name, in any letter case:
#   lists.iif                     the lists (required)
#   journal01.csv, journal02.csv  the Journal, one file per date range (or one journal.csv);
#                                 when numbered files exist, a plain journal.csv is ignored
#   tb.csv                        Trial Balance; the as-of date is read from its heading
#   open-invoices.csv, unpaid-bills.csv
#   pl*.csv                       Profit & Loss exports (pl-monthly.csv, pl-2025.csv, ...)
# .txt (tab-delimited) works in place of .csv.
#
# Runs with this computer's Node.js when it has a usable one and the packages are
# installed (npm ci); otherwise inside the RapidBooks Docker image (deploy/docker-install.sh),
# with this folder's importer code, so a git pull is enough to use a newer importer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

INSTALL=0
POS=()
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    -*) die "Unknown option: $a" ;;
    *) POS+=("$a") ;;
  esac
done
EXPORTS="${POS[0]:-data/qb-exports}"
OUT="${POS[1]:-data/trial.db}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# --install: where the served database is, and how RapidBooks runs here.
if [ "$INSTALL" -eq 1 ]; then
  [ "${#POS[@]}" -le 1 ] || die "--install takes only the export folder; it writes the served database."
  [ "$(id -u)" -eq 0 ] || die "--install needs sudo: sudo $0 $*"
  if command -v docker >/dev/null 2>&1 && docker container inspect rapidbooks >/dev/null 2>&1; then
    MODE=docker
    LIVE=/var/lib/rapidbooks/rapidbooks.db
    LIVE_OWNER=1000:1000 # the "node" user of the image (deploy/docker-install.sh)
  elif systemctl cat rapidbooks.service >/dev/null 2>&1; then
    MODE=service
    LIVE="$(sed -n 's/^RAPIDBOOKS_DB=//p' /etc/rapidbooks.env 2>/dev/null | tail -n 1)"
    LIVE="${LIVE:-/var/lib/rapidbooks/rapidbooks.db}"
    LIVE_OWNER=rapidbooks:rapidbooks
  else
    die "RapidBooks is not installed here (no rapidbooks Docker container or service). Install it first: sudo ./deploy/docker-install.sh"
  fi
  OUT="$(dirname "$LIVE")/rapidbooks.import-$STAMP.db"
fi
[ -d "$EXPORTS" ] || die "No export folder $EXPORTS. Give it as the first argument."
EXPORTS="$(cd "$EXPORTS" && pwd)"
mkdir -p "$(dirname "$OUT")"
OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT_NAME="$(basename "$OUT")"
REPORT_NAME="${OUT_NAME%.db}-reconciliation.txt"

# Files of the export folder whose name, in lower case, matches a pattern (also in lower
# case), sorted. Compared name by name: a glob without wildcards ("lists.iif") is never
# matched against the folder, so nocaseglob would not help, and Linux names are
# case-sensitive (QuickBooks writes lists.IIF, tb.CSV).
find_files() {
  local pattern="$1" f name
  for f in "$EXPORTS"/*; do
    [ -f "$f" ] || continue
    name="${f##*/}"
    # shellcheck disable=SC2053 # $pattern is a glob on purpose
    if [[ "${name,,}" == $pattern ]]; then printf '%s\n' "$name"; fi
  done | LC_ALL=C sort
  return 0
}
one_file() { find_files "$1" | head -n 1; }

# The lists: lists.iif (any case; lists.iff too), else the folder's only .iif file.
IIF="$(one_file 'lists.iif')"; [ -n "$IIF" ] || IIF="$(one_file 'lists.iff')"
if [ -z "$IIF" ]; then
  mapfile -t IIFS < <(find_files '*.iif')
  [ "${#IIFS[@]}" -eq 1 ] && IIF="${IIFS[0]}"
fi
[ -n "$IIF" ] || die "No lists.iif in $EXPORTS (the list export, any letter case)."
mapfile -t JOURNALS < <(find_files 'journal[0-9]*.csv'; find_files 'journal[0-9]*.txt')
[ "${#JOURNALS[@]}" -gt 0 ] || mapfile -t JOURNALS < <(find_files 'journal.csv'; find_files 'journal.txt')
[ "${#JOURNALS[@]}" -gt 0 ] || die "No journal*.csv in $EXPORTS."
TB="$(one_file 'tb.csv')"; [ -n "$TB" ] || TB="$(one_file 'tb.txt')"
OI="$(one_file 'open-invoices.csv')"; [ -n "$OI" ] || OI="$(one_file 'open-invoices.txt')"
UB="$(one_file 'unpaid-bills.csv')"; [ -n "$UB" ] || UB="$(one_file 'unpaid-bills.txt')"
mapfile -t PLS < <(find_files 'pl*.csv'; find_files 'pl*.txt')

# The as-of date: AS_OF=YYYY-MM-DD, else the Trial Balance's heading ("Nov 23, 26").
AS_OF="${AS_OF:-}"
if [ -z "$AS_OF" ] && [ -n "$TB" ]; then
  heading="$(head -n 3 "$EXPORTS/$TB" | tr -d '"\r' | grep -oiE '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* +[0-9]{1,2}, *[0-9]{2,4}' | head -n 1 || true)"
  if [ -n "$heading" ]; then
    read -r mon day year <<<"$(echo "$heading" | tr -d ',')"
    m=$(( $(echo "jan feb mar apr may jun jul aug sep oct nov dec" | tr ' ' '\n' | grep -n -i "^${mon:0:3}$" | cut -d: -f1) ))
    if [ "${#year}" -eq 2 ]; then year=$(( 10#$year < 70 ? 2000 + 10#$year : 1900 + 10#$year )); fi
    AS_OF="$(printf '%04d-%02d-%02d' "$year" "$m" "$((10#$day))")"
  fi
fi
if [ -n "$TB" ] && [ -z "$AS_OF" ]; then
  die "Could not read the date of $TB. Give it: AS_OF=2026-11-23 $0 $*"
fi

# The importer's arguments; $1 is where the export folder is seen, $2 the output folder.
args() {
  local in="$1" out="$2" f
  printf '%s\n' --iif "$in/$IIF"
  for f in "${JOURNALS[@]}"; do printf '%s\n' --journal "$in/$f"; done
  if [ -n "$TB" ]; then printf '%s\n' --trial-balance "$in/$TB" --as-of "$AS_OF"; fi
  if [ -n "$OI" ]; then printf '%s\n' --open-invoices "$in/$OI"; fi
  if [ -n "$UB" ]; then printf '%s\n' --unpaid-bills "$in/$UB"; fi
  for f in "${PLS[@]}"; do printf '%s\n' --profit-loss "$in/$f"; done
  printf '%s\n' --out "$out/$OUT_NAME" --force --report "$out/$REPORT_NAME"
}

echo "Exports:  $EXPORTS"
echo "          $IIF, ${JOURNALS[*]}${TB:+, $TB (as of $AS_OF)}${OI:+, $OI}${UB:+, $UB}${PLS:+, ${PLS[*]}}"
echo "Output:   $OUT_DIR/$OUT_NAME"
echo

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ -x node_modules/.bin/tsx ] || [ -f node_modules/.bin/tsx.cmd ] || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ]
}

set +e
if node_ok; then
  mapfile -t A < <(args "$EXPORTS" "$OUT_DIR")
  npx tsx packages/server/src/import/cli.ts "${A[@]}"
  status=$?
elif command -v docker >/dev/null 2>&1 && docker image inspect rapidbooks:latest >/dev/null 2>&1; then
  echo "(running in the RapidBooks Docker image)"
  # Run as the owner of the output folder, so the files made there are its own.
  owner="$(stat -c '%u:%g' "$OUT_DIR")"
  [ "$owner" != "0:0" ] || owner="${SUDO_UID:-$(id -u)}:${SUDO_GID:-$(id -g)}"
  mapfile -t A < <(args /exports /out)
  docker run --rm --user "$owner" -e HOME=/tmp \
    -v "$EXPORTS:/exports:ro" -v "$OUT_DIR:/out" \
    -v "$ROOT/packages/server/src:/app/packages/server/src:ro" \
    -v "$ROOT/packages/shared/src:/app/packages/shared/src:ro" \
    rapidbooks:latest node --import tsx packages/server/src/import/cli.ts "${A[@]}"
  status=$?
else
  echo "ERROR: no usable Node.js here (20 or newer, with npm ci done) and no RapidBooks" >&2
  echo "Docker image (sudo ./deploy/docker-install.sh). If Docker needs it: sudo $0 $*" >&2
  exit 2
fi
set -e
echo
if [ "$status" -ne 0 ]; then
  echo "Something differs or went wrong (exit $status). The reconciliation: $OUT_DIR/$REPORT_NAME"
  [ "$INSTALL" -eq 1 ] && echo "Nothing was installed: RapidBooks still serves $LIVE as before. The new file is $OUT_DIR/$OUT_NAME."
  exit "$status"
fi
if [ "$INSTALL" -eq 0 ]; then
  echo "OVERALL: PASS. Company file: $OUT_DIR/$OUT_NAME"
  exit 0
fi

# --- Install: swap the new books in for the served ones.
NEW="$OUT_DIR/$OUT_NAME"
OLD="$LIVE.before-import-$STAMP"
move_db() { # move a database with its -wal and -shm files
  mv "$1" "$2"
  for s in -wal -shm; do if [ -e "$1$s" ]; then mv "$1$s" "$2$s"; fi; done
}
echo "OVERALL: PASS. Installing the imported books as $LIVE"
echo "Stopping RapidBooks"
if [ "$MODE" = docker ]; then docker stop -t 60 rapidbooks >/dev/null; else systemctl stop rapidbooks.service; fi
if [ -e "$LIVE" ]; then
  move_db "$LIVE" "$OLD"
  echo "The previous books were renamed to $OLD"
fi
move_db "$NEW" "$LIVE"
chown "$LIVE_OWNER" "$LIVE"
chmod 0640 "$LIVE"
mv "$OUT_DIR/$REPORT_NAME" "$OUT_DIR/import-$STAMP-reconciliation.txt"
echo "Starting RapidBooks"
if [ "$MODE" = docker ]; then docker start rapidbooks >/dev/null; else systemctl start rapidbooks.service; fi

healthy() {
  if [ "$MODE" = docker ]; then
    curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1
  else
    /usr/local/bin/rapidbooks-admin health >/dev/null 2>&1
  fi
}
for _ in $(seq 1 60); do healthy && break; sleep 1; done
if healthy; then
  echo
  echo "Done. RapidBooks now serves the imported books. The reconciliation is"
  echo "$OUT_DIR/import-$STAMP-reconciliation.txt; keep it with the QuickBooks backup."
  echo "To go back: stop RapidBooks, then move $OLD back to $LIVE."
  exit 0
fi
echo "ERROR: RapidBooks did not answer after the swap." >&2
if [ "$MODE" = docker ]; then echo "Its log: sudo docker logs --tail 50 rapidbooks" >&2; else echo "Its log: journalctl -u rapidbooks -n 50" >&2; fi
echo "To go back: stop RapidBooks, then move $OLD back to $LIVE (and its -wal/-shm files, if any)." >&2
exit 1
