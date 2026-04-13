# Archon Log Debugging For Codex

Use this guide when the main job is understanding what Archon just did, why a
run paused, why it failed, or whether it is stalled.

## Three Evidence Layers

### 1. Status and run details

Use first when you need the current high-level state.

- `archon workflow status --json`
- `archon workflow status --verbose`
- web or API run details when available

This is the fastest way to confirm:

- run ID
- current status
- `last_activity_at`
- working path
- approval context

### 2. Per-run workflow JSONL

Use when status is ambiguous or you need the actual workflow trace.

Default location:

```text
${ARCHON_HOME:-$HOME/.archon}/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

Best for:

- assistant output
- tool calls
- node boundaries
- workflow pause or failure context

Representative commands:

```bash
find "${ARCHON_HOME:-$HOME/.archon}/workspaces" -name "<run-id>.jsonl" 2>/dev/null
tail -n 40 "$LOG_FILE"
rg '"type":"workflow_error"|"type":"node_error"' "$LOG_FILE"
rg '"type":"assistant"' "$LOG_FILE" | tail -n 5
```

### 3. Runtime process logs

Use only when the issue looks like Archon runtime behavior rather than workflow
logic.

Examples:

```bash
LOG_LEVEL=debug archon workflow status --json
LOG_LEVEL=debug archon workflow run <workflow-name> "<message>"
```

Best for:

- database errors
- config loading failures
- adapter or API problems
- unexpected process behavior

## Triage Order

1. `archon workflow status --json`
2. `archon workflow status --verbose` or the web/API run details
3. per-run JSONL
4. runtime logs with `LOG_LEVEL=debug`

## Important Note

Status and UI/API events are intentionally lean. They are good for current
state, but not a replacement for the JSONL trace when you need the workflow's
actual assistant or tool history.
