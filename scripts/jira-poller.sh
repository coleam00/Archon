#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# jira-poller.sh — Archon Jira polling daemon
#
# Scans Jira every 15 minutes for tickets tagged with the "Archon" label.
# For each new ticket, triggers the manhattan-orchestrator workflow in Archon,
# then replaces the "Archon" label with "Archon-In-Progress" to prevent
# duplicate runs. The workflow itself removes "Archon-In-Progress" and
# transitions the ticket to Done when complete.
#
# Usage:
#   ./jira-poller.sh                  # run once (for cron)
#   ./jira-poller.sh --watch          # loop forever (for foreground/systemd)
#
# Required env vars (set in /home/jbain/apps/archon/.env or export before running):
#   JIRA_BASE_URL      e.g. https://yourorg.atlassian.net
#   JIRA_EMAIL         e.g. dev@yourorg.com
#   JIRA_API_TOKEN     Jira API token
#   JIRA_PROJECT_KEY   e.g. PROJ
#   JIRA_ARCHON_LABEL  default: Archon
#   ARCHON_URL         default: http://localhost:3090
#   ARCHON_CODEBASE    cwd registered with Archon, default: /app
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Load .env from the archon directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

ARCHON_URL="${ARCHON_URL:-http://localhost:3090}"
ARCHON_CODEBASE="${ARCHON_CODEBASE:-/app}"
JIRA_ARCHON_LABEL="${JIRA_ARCHON_LABEL:-Archon}"
POLL_INTERVAL="${POLL_INTERVAL:-900}"  # 15 minutes in seconds
LOG_FILE="${LOG_FILE:-$SCRIPT_DIR/../logs/jira-poller.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

check_deps() {
  for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      log "ERROR: required command '$cmd' not found"
      exit 1
    fi
  done
}

# Query Jira for tickets with the Archon label in the configured project
fetch_archon_tickets() {
  local jql="project = ${JIRA_PROJECT_KEY} AND labels = \"${JIRA_ARCHON_LABEL}\" AND statusCategory != Done ORDER BY created ASC"
  local encoded_jql
  encoded_jql=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$jql" 2>/dev/null \
    || echo "$jql" | sed 's/ /%20/g; s/"/%22/g; s/=/%3D/g; s/!=/%21%3D/g')

  curl -s \
    -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${JIRA_BASE_URL}/rest/api/3/search?jql=${encoded_jql}&fields=summary,labels,status&maxResults=50"
}

# Mark ticket as in-progress by swapping label Archon → Archon-In-Progress
mark_in_progress() {
  local ticket_key="$1"
  log "  Marking $ticket_key as Archon-In-Progress"
  curl -s -X PUT \
    -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${JIRA_BASE_URL}/rest/api/3/issue/${ticket_key}" \
    -d '{"update":{"labels":[{"remove":"'"${JIRA_ARCHON_LABEL}"'"},{"add":"Archon-In-Progress"}]}}' \
    > /dev/null
}

# Post a "Archon picking up this ticket" comment
post_pickup_comment() {
  local ticket_key="$1"
  local body
  body=$(jq -n \
    --arg text "🤖 *Archon* — Picking up this ticket. Running manhattan-orchestrator workflow now. Progress updates will follow at each gate." \
    '{body:{type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:$text}]}]}}')
  curl -s -X POST \
    -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${JIRA_BASE_URL}/rest/api/3/issue/${ticket_key}/comment" \
    -d "$body" \
    > /dev/null
}

# Trigger the Archon workflow
trigger_workflow() {
  local ticket_key="$1"
  log "  Triggering manhattan-orchestrator for $ticket_key"

  local response
  response=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    "${ARCHON_URL}/api/workflows/manhattan-orchestrator/run" \
    -d "{\"arguments\": \"${ticket_key}\", \"cwd\": \"${ARCHON_CODEBASE}\"}")

  local run_id
  run_id=$(echo "$response" | jq -r '.runId // .id // "unknown"' 2>/dev/null || echo "unknown")
  log "  Workflow triggered — run ID: $run_id"
  echo "$run_id"
}

poll_once() {
  log "Polling Jira for tickets with label: ${JIRA_ARCHON_LABEL}"

  local result
  result=$(fetch_archon_tickets)

  local count
  count=$(echo "$result" | jq '.issues | length' 2>/dev/null || echo 0)
  log "Found $count ticket(s)"

  if [ "$count" -eq 0 ]; then
    return 0
  fi

  echo "$result" | jq -r '.issues[].key' | while read -r ticket_key; do
    log "Processing ticket: $ticket_key"
    mark_in_progress "$ticket_key"
    post_pickup_comment "$ticket_key"
    trigger_workflow "$ticket_key"
    log "  Done dispatching $ticket_key"
  done
}

# ─── Main ────────────────────────────────────────────────────────────────────
check_deps

if [ "${1:-}" = "--watch" ]; then
  log "Starting Jira poller in watch mode (interval: ${POLL_INTERVAL}s)"
  while true; do
    poll_once
    log "Sleeping ${POLL_INTERVAL}s until next poll..."
    sleep "$POLL_INTERVAL"
  done
else
  # Single run (cron mode)
  poll_once
fi
