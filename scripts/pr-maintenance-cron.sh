#!/usr/bin/env bash
# pr-maintenance-cron.sh — Run from cron every 15 minutes.
# Zero AI cost when nothing to do. Processes one PR per project per run.
#
# Usage:
#   ./scripts/pr-maintenance-cron.sh                    # all projects
#   ./scripts/pr-maintenance-cron.sh cosmic-match reli  # specific projects
#
# Crontab entry:
#   */15 * * * * /mnt/ext-fast/archon/scripts/pr-maintenance-cron.sh >> /tmp/pr-maintenance.log 2>&1

set -euo pipefail

# Cron runs with a minimal PATH (/usr/bin:/bin). archon, gh, bun, git
# often live in user-local bins; prepend them so the script works from
# both cron and an interactive shell.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

# --- Configuration ---
DEFAULT_PROJECTS=(cosmic-match word-coach-annie filmduel reli beads)
BASE_DIR="/mnt/ext-fast"
LOG_PREFIX="[pr-maintenance]"

# Use arguments if provided, otherwise all projects
if [ $# -gt 0 ]; then
  PROJECTS=("$@")
else
  PROJECTS=("${DEFAULT_PROJECTS[@]}")
fi

log() { echo "$(date -Is) $LOG_PREFIX $*"; }

for PROJECT in "${PROJECTS[@]}"; do
  REPO_DIR="$BASE_DIR/$PROJECT"

  if [ ! -d "$REPO_DIR/.git" ]; then
    log "$PROJECT: not a git repo, skipping"
    continue
  fi

  cd "$REPO_DIR"

  # --- Phase 1: Merge CLEAN PRs directly (bash only, zero AI cost) ---
  CLEAN_PRS=$(gh pr list --state open --json number,mergeStateStatus,isDraft \
    --jq '[.[] | select(.isDraft == false and .mergeStateStatus == "CLEAN")] | .[].number' 2>/dev/null || true)

  for PR in $CLEAN_PRS; do
    log "$PROJECT: PR #$PR is CLEAN — merging directly"
    gh pr merge "$PR" --squash --auto --delete-branch 2>/dev/null \
      || gh pr merge "$PR" --squash --delete-branch 2>/dev/null \
      || log "$PROJECT: PR #$PR — could not merge, skipping"
  done

  # --- Phase 2: Check for one PR needing AI attention ---
  ACTIONABLE=$(gh pr list --state open --json number,mergeStateStatus,isDraft \
    --jq '[.[] | select(.isDraft == false and (.mergeStateStatus == "BEHIND" or .mergeStateStatus == "DIRTY" or .mergeStateStatus == "UNSTABLE" or .mergeStateStatus == "UNKNOWN"))] | .[0].number // empty' 2>/dev/null || true)

  if [ -z "$ACTIONABLE" ]; then
    log "$PROJECT: no PRs need AI maintenance"
    continue
  fi

  log "$PROJECT: PR #$ACTIONABLE needs maintenance — launching archon"
  archon workflow run archon-pr-maintenance --cwd "$REPO_DIR" "PR #$ACTIONABLE" &

done

# Wait for any background archon runs to complete
wait
log "Done"
