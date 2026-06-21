#!/usr/bin/env bash
# sync-passes-to-tasks.sh — flip [ ] T<NNN> → [X] T<NNN> for prd.json
# userStories with passes:true; archive prd.json + progress.txt.
#
# Usage: sync-passes-to-tasks.sh <feature-dir-or-prefix>
#
# Exits:
#   0  success (incl. idempotent no-op when prd.json absent)
#   2  guard failure (ambiguous feature dir, missing tasks.md)

set -euo pipefail

FEATURE="${1:?feature dir required (e.g. 004 or 004-sessions-memory-auth)}"

# --- resolve feature directory (single-match required) -------------------
matches=()
while IFS= read -r d; do
  matches+=("$d")
done < <(find specs -maxdepth 1 -mindepth 1 -type d -name "${FEATURE}*" 2>/dev/null | sort)

case "${#matches[@]}" in
  0) echo "[error] no spec dir matches 'specs/${FEATURE}*'" >&2; exit 2 ;;
  1) SPEC_DIR="${matches[0]}" ;;
  *)
    {
      echo "[error] feature prefix '$FEATURE' is ambiguous — matches:"
      printf '  %s\n' "${matches[@]}"
    } >&2
    exit 2
    ;;
esac

PRD="$SPEC_DIR/prd.json"
PROGRESS="$SPEC_DIR/progress.txt"
TASKS="$SPEC_DIR/tasks.md"

# --- idempotency guard: missing prd.json → exit 0 -------------------------
if [ ! -f "$PRD" ]; then
  echo "[info] no prd.json at $PRD — already synced or never started"
  exit 0
fi
[ -f "$TASKS" ] || { echo "[error] tasks.md missing at $TASKS" >&2; exit 2; }

# --- extract passed IDs (v3 nested schema) -------------------------------
# Tasks live one level deeper now: userStories[].tasks[].
PASSED_IDS=$(jq -r '.userStories[].tasks[]? | select(.passes==true) | .id' "$PRD")
if [ -z "$PASSED_IDS" ]; then
  echo "[info] no tasks with passes:true; archiving artifacts only"
fi

# --- single-pass POSIX awk flip ------------------------------------------
# Build a one-per-line ID file the awk script can read into an associative
# array. Empty file is fine (zero flips).
IDS_FILE="$SPEC_DIR/.passed-ids.$$.txt"
printf '%s\n' "$PASSED_IDS" > "$IDS_FILE"

awk -v ids="$IDS_FILE" '
  BEGIN {
    while ((getline id < ids) > 0) if (id != "") set[id] = 1
    close(ids)
    flipped = 0
  }
  {
    line = $0
    if (line ~ /^[[:space:]]*-[[:space:]]+\[ \][[:space:]]+T[0-9][0-9][0-9]/) {
      n = split(line, f, /[[:space:]]+/)
      id = ""
      for (i = 1; i <= n; i++) if (f[i] ~ /^T[0-9][0-9][0-9]$/) { id = f[i]; break }
      if (id != "" && (id in set)) {
        sub(/\[ \]/, "[X]", line)
        flipped++
        print "[flip] " id > "/dev/stderr"
      }
    }
    print line
  }
  END {
    print "[summary] flipped " (flipped + 0) " task(s)" > "/dev/stderr"
  }
' "$TASKS" > "$TASKS.new"

mv "$TASKS.new" "$TASKS"
rm -f "$IDS_FILE"

# --- warn on unmatched IDs (passed but not present in tasks.md) -----------
if [ -n "$PASSED_IDS" ]; then
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! grep -qE "(^|[[:space:]])${id}([[:space:]]|$)" "$TASKS"; then
      echo "[warn] passed ID '$id' not found in tasks.md" >&2
    fi
  done <<EOF
$PASSED_IDS
EOF
fi

# --- archive prd.json + progress.txt --------------------------------------
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_DIR="$SPEC_DIR/archive/$STAMP"
# Append a short suffix if the dir somehow already exists (sub-second double-run).
if [ -d "$ARCHIVE_DIR" ]; then
  ARCHIVE_DIR="${ARCHIVE_DIR}-$$"
fi
mkdir -p "$ARCHIVE_DIR"

mv "$PRD" "$ARCHIVE_DIR/prd.json"
[ -f "$PROGRESS" ] && mv "$PROGRESS" "$ARCHIVE_DIR/progress.txt"
echo "[archive] $ARCHIVE_DIR"

echo "[done] sync-back complete for $SPEC_DIR"
