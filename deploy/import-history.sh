#!/usr/bin/env bash
# Import the QuickBooks exports into a new RapidBooks company file and print the
# reconciliation with QuickBooks (see docs/IMPORT.md).
#
#   ./deploy/import-history.sh                        exports in data/qb-exports, makes data/trial.db
#   ./deploy/import-history.sh path/to/qb-export      exports somewhere else
#   ./deploy/import-history.sh path/to/qb-export data/other.db
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

EXPORTS="${1:-data/qb-exports}"
OUT="${2:-data/trial.db}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }
[ -d "$EXPORTS" ] || die "No export folder $EXPORTS. Give it as the first argument."
EXPORTS="$(cd "$EXPORTS" && pwd)"
mkdir -p "$(dirname "$OUT")"
OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT_NAME="$(basename "$OUT")"
REPORT_NAME="${OUT_NAME%.db}-reconciliation.txt"

# Files of the export folder whose lower-case name matches a pattern, sorted.
find_files() {
  local pattern="$1" f
  shopt -s nullglob nocaseglob
  for f in "$EXPORTS"/$pattern; do [ -f "$f" ] && basename "$f"; done | LC_ALL=C sort
  shopt -u nullglob nocaseglob
}
one_file() { find_files "$1" | head -n 1; }

IIF="$(one_file 'lists.iif')"
[ -n "$IIF" ] || die "No lists.iif in $EXPORTS."
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
  # Files made inside belong to whoever runs this (the sudo caller, under sudo).
  uid="${SUDO_UID:-$(id -u)}"
  gid="${SUDO_GID:-$(id -g)}"
  mapfile -t A < <(args /exports /out)
  docker run --rm --user "$uid:$gid" -e HOME=/tmp \
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
[ "$status" -eq 0 ] && echo "OVERALL: PASS. Company file: $OUT_DIR/$OUT_NAME" \
  || echo "Something differs or went wrong (exit $status). The reconciliation: $OUT_DIR/$REPORT_NAME"
exit "$status"
