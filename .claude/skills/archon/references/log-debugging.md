# Archon Log Debugging For Codex

Use this guide when the main job is understanding what Archon just did during a
workflow run, why it failed, why it paused, or where the useful evidence lives.

## Three Evidence Layers

Archon exposes overlapping but non-interchangeable evidence surfaces.

### 1. Status and run details

Use this first for the current high-level truth.

- `archon workflow status --json`
- `archon workflow status --verbose`
- web or API run details when available

Best for:

- run ID
- current status
- `last_activity_at`
- working path
- approval context

### 2. Per-run workflow JSONL

Use this when status is ambiguous or when you need the full workflow trace.

Default location:

```text
${ARCHON_HOME:-$HOME/.archon}/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

Best for:

- assistant output
- tool calls
- node boundaries
- validation events
- workflow pause or failure context

### 3. Runtime process logs

Use this when the issue looks like Archon runtime behavior rather than workflow
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

## Finding The Run

For active runs:

```bash
archon workflow status
archon workflow status --verbose
archon workflow status --json
```

If you already know the run ID:

```bash
find "${ARCHON_HOME:-$HOME/.archon}/workspaces" -name "<run-id>.jsonl" 2>/dev/null
```

## Reading The JSONL

Set a shell variable first:

```bash
LOG_FILE="${ARCHON_HOME:-$HOME/.archon}/workspaces/<owner>/<repo>/logs/<run-id>.jsonl"
```

Common reads:

```bash
tail -n 40 "$LOG_FILE"
rg '"type":"workflow_error"|"type":"node_error"' "$LOG_FILE"
rg '"type":"assistant"' "$LOG_FILE" | tail -n 5
rg '"type":"validation"' "$LOG_FILE"
```

## Common Event Families

Representative JSONL event types include:

- `workflow_start`
- `workflow_complete`
- `workflow_error`
- `assistant`
- `tool`
- `validation`
- `node_start`
- `node_complete`
- `node_skipped`
- `node_error`

Use them as breadcrumbs rather than assuming the UI event names will match
exactly.

## Filtering Patterns

Assistant messages:

```bash
rg '"type":"assistant"' "$LOG_FILE"
```

Tool calls:

```bash
rg '"type":"tool"' "$LOG_FILE"
```

Skipped nodes:

```bash
rg '"type":"node_skipped"' "$LOG_FILE"
```

If `jq` is available:

```bash
jq -r 'select(.type=="assistant") | .content' "$LOG_FILE" | tail -n 1
jq -c 'select(.type=="node_error") | {ts, step, error}' "$LOG_FILE"
```

## Interpretation Rules

- status and UI/API surfaces are intentionally lean
- the JSONL trace is the authoritative assistant and tool history for one run
- current pause state should still come from `archon workflow status --json`
- use runtime logs only when the issue looks like Archon itself rather than a
  workflow node decision
