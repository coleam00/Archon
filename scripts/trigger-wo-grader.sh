#!/usr/bin/env bash
# Poll Notion for Work Orders at REVIEW and fire the bdc-wo-grader workflow.
#
# Intended systemd timer:
#   */5 minutes: /opt/bdc/archon/scripts/trigger-wo-grader.sh
#
# Required env:
#   NOTION_API_KEY
#
# Optional env:
#   NOTION_DB_ID                    default a6df831c-0b52-449f-8ca4-d77be6b70d0a
#   ARCHON_DIR                      default /opt/bdc/archon
#   ARCHON_DB                       default /opt/bdc/archon-data/archon.db
#   MAX_WOS                         default 6
#   MIN_REVIEW_AGE_MINUTES          default 5
#   REQUIRE_BDC_HARNESS_CODEBASE    default true
#   DRY_RUN                         default false

set -euo pipefail

NOTION_DB_ID="${NOTION_DB_ID:-a6df831c-0b52-449f-8ca4-d77be6b70d0a}"
ARCHON_DIR="${ARCHON_DIR:-/opt/bdc/archon}"
ARCHON_DB="${ARCHON_DB:-/opt/bdc/archon-data/archon.db}"
MAX_WOS="${MAX_WOS:-6}"
MIN_REVIEW_AGE_MINUTES="${MIN_REVIEW_AGE_MINUTES:-5}"
REQUIRE_BDC_HARNESS_CODEBASE="${REQUIRE_BDC_HARNESS_CODEBASE:-true}"
DRY_RUN="${DRY_RUN:-false}"

if [ -z "${NOTION_API_KEY:-}" ]; then
  echo "ERROR: NOTION_API_KEY is required" >&2
  exit 1
fi

if [ ! -d "$ARCHON_DIR" ]; then
  echo "ERROR: ARCHON_DIR not found: $ARCHON_DIR" >&2
  exit 1
fi

if [ "$REQUIRE_BDC_HARNESS_CODEBASE" = "true" ] && [ -f "$ARCHON_DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "$ARCHON_DB" "SELECT name FROM remote_agent_codebases WHERE name='bluedevilcollectibles/bdc-harness'" | grep -qx 'bluedevilcollectibles/bdc-harness'; then
    echo "ERROR: bluedevilcollectibles/bdc-harness is not registered in remote_agent_codebases" >&2
    echo "Run WO-HARNESS-SELF-REGISTRATION-01 before enabling the grader timer." >&2
    exit 1
  fi
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

python3 - "$NOTION_DB_ID" "$MIN_REVIEW_AGE_MINUTES" "$MAX_WOS" > "$TMP_DIR/review-wos.tsv" <<'PY'
import datetime as dt
import json
import os
import sys
import urllib.request

db_id, min_age_raw, max_wos_raw = sys.argv[1:4]
min_age = int(min_age_raw)
max_wos = int(max_wos_raw)
token = os.environ["NOTION_API_KEY"]

headers = {
    "Authorization": f"Bearer {token}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

payload = {
    "page_size": 100,
    "filter": {
        "and": [
            {"property": "Claude Status", "select": {"equals": "REVIEW"}},
            {"property": "Execution State", "select": {"does_not_equal": "HOLD"}},
        ]
    },
    "sorts": [{"timestamp": "last_edited_time", "direction": "ascending"}],
}

req = urllib.request.Request(
    f"https://api.notion.com/v1/databases/{db_id}/query",
    data=json.dumps(payload).encode(),
    headers=headers,
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as resp:
    data = json.loads(resp.read().decode())

now = dt.datetime.now(dt.timezone.utc)
emitted = 0

for page in data.get("results", []):
    edited = dt.datetime.fromisoformat(page["last_edited_time"].replace("Z", "+00:00"))
    if (now - edited).total_seconds() < min_age * 60:
        continue

    props = page.get("properties", {})
    wo_prop = props.get("WO ID", {})
    chunks = wo_prop.get("rich_text", [])
    wo_id = "".join(c.get("plain_text", "") for c in chunks).strip()
    if not wo_id:
        title_prop = props.get("Task", {})
        wo_id = "".join(c.get("plain_text", "") for c in title_prop.get("title", [])).strip()
    if not wo_id:
        continue

    print(f"{page['id']}\t{wo_id}")
    emitted += 1
    if emitted >= max_wos:
        break
PY

if [ ! -s "$TMP_DIR/review-wos.tsv" ]; then
  echo "No REVIEW WOs older than ${MIN_REVIEW_AGE_MINUTES} minute(s)."
  exit 0
fi

echo "Found REVIEW WOs:"
cat "$TMP_DIR/review-wos.tsv"

while IFS=$'\t' read -r page_id wo_id; do
  [ -z "$page_id" ] && continue
  page_id="${page_id%$'\r'}"
  wo_id="${wo_id%$'\r'}"
  echo "Firing bdc-wo-grader for ${wo_id} (${page_id})"
  if [ "$DRY_RUN" = "true" ]; then
    continue
  fi
  (
    cd "$ARCHON_DIR"
    WO_PAGE_ID="$page_id" \
    WO_ID="$wo_id" \
    NOTION_DB_ID="$NOTION_DB_ID" \
    bun run cli workflow run bdc-wo-grader --no-worktree "Grade ${wo_id} at REVIEW"
  )
done < "$TMP_DIR/review-wos.tsv"
