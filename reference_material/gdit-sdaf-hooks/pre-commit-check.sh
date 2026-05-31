#!/usr/bin/env bash
# Hook: PreToolUse(Bash) — block git commit if security scans are stale
# Exit: 2 = BLOCK (stale scans), 0 = proceed

# Read tool input from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)

# Only check git commit commands
if [[ "$COMMAND" != *"git commit"* ]]; then
    exit 0
fi

# Check scan manifest recency
MANIFEST=".scan-manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
    echo "BLOCKED: No .scan-manifest.json found. Run security scans before committing." >&2
    exit 2
fi

# Check if manifest is within staleness threshold (default 1800 seconds)
MAX_STALE=${GDIT_SDAF_SCAN_RECENCY:-1800}
MANIFEST_TIME=$(python3 -c "
import json, datetime, sys
try:
    with open('$MANIFEST') as f:
        d = json.load(f)
    ts = datetime.datetime.fromisoformat(d['timestamp'])
    age = (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds()
    print(int(age))
except Exception:
    print(99999)
" 2>/dev/null)

if [[ "$MANIFEST_TIME" -gt "$MAX_STALE" ]]; then
    echo "BLOCKED: Scan manifest is ${MANIFEST_TIME}s old (max: ${MAX_STALE}s). Re-run security scans." >&2
    exit 2
fi

exit 0
