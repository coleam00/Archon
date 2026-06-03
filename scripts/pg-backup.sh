#!/usr/bin/env bash
#
# Archon Postgres nightly backup.
#
# - Custom-format dump (`pg_dump -Fc`) for fast restore + parallel restore
#   support via `pg_restore -j`.
# - Z9 max compression.
# - 14-day retention (enforced by `find -mtime +14 -delete`).
# - Output: ~/.archon/backups/archon-pg-YYYY-MM-DDTHH-MM-SSZ.dump
#
# Usage:
#   bash scripts/pg-backup.sh                  # one-shot, uses $DATABASE_URL from ~/.archon/.env
#
# Exit codes:
#   0  backup produced (or already-existed dump preserved; never overwrites)
#   1  misconfiguration: DATABASE_URL unset, pg_dump missing, etc.
#   2  pg_dump failed
#
# Sourced from: docs/runbooks/archon-postgres-backup-restore.md
# Deployed by:  systemd user timer (Task 9) and on-demand from the runbook
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve Archon home (matches packages/paths/src/archon-paths.ts:ARCHON_HOME)
# ---------------------------------------------------------------------------
ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
ENV_FILE="$ARCHON_HOME/.env"
BACKUP_DIR="$ARCHON_HOME/backups"

# ---------------------------------------------------------------------------
# Pre-flight: pg_dump on PATH, DATABASE_URL from .env
# ---------------------------------------------------------------------------
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "Error: pg_dump is not on PATH. Install postgresql-client (e.g. apt install postgresql-client, brew install libpq)." >&2
  exit 1
fi

# Source .env if it exists and DATABASE_URL isn't already in the environment.
# `set -a` auto-exports all variables from the sourced file; we re-`set +a`
# immediately after to keep subsequent commands local.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL is not set. Either export it, or add it to $ENV_FILE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Run pg_dump
# ---------------------------------------------------------------------------
# We invoke pg_dump inside the `archon-postgres-1` container rather than
# the host's pg_dump because the system Postgres client (16.x) refuses
# to dump a 17.x server ("aborting because of server version mismatch").
# `docker exec` is the only path that has matching major versions here
# without requiring apt-get root.
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT_FILE="$BACKUP_DIR/archon-pg-$TIMESTAMP.dump"
ERR_FILE="$BACKUP_DIR/archon-pg-$TIMESTAMP.err"
START_EPOCH="$(date +%s)"
if ! docker exec archon-postgres-1 \
     pg_dump -U postgres -Fc -Z 9 remote_coding_agent \
     >"$OUT_FILE" 2>"$ERR_FILE"; then
  echo "Error: docker exec pg_dump failed:" >&2
  cat "$ERR_FILE" >&2
  rm -f "$OUT_FILE" "$ERR_FILE"
  exit 2
fi
rm -f "$ERR_FILE"
END_EPOCH="$(date +%s)"
DURATION=$((END_EPOCH - START_EPOCH))

# Human-readable size
if command -v du >/dev/null 2>&1; then
  SIZE_HUMAN="$(du -h "$OUT_FILE" | cut -f1)"
else
  SIZE_HUMAN="$(stat -c '%s' "$OUT_FILE" 2>/dev/null || stat -f '%z' "$OUT_FILE") bytes"
fi

echo "Backup complete: $OUT_FILE ($SIZE_HUMAN, ${DURATION}s)"

# ---------------------------------------------------------------------------
# Prune backups older than 14 days
# ---------------------------------------------------------------------------
# -mtime +14 matches files modified more than 14 days ago. -name guards
# against the user putting other files in the backups dir.
find "$BACKUP_DIR" -name 'archon-pg-*.dump' -mtime +14 -delete -print | while read -r pruned; do
  echo "Pruned old backup: $pruned"
done
