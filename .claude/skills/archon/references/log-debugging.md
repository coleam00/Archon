# Archon Log Debugging Reference

Use this guide when the main job is understanding what Archon just did during a
workflow run, why it failed, why it paused, or where the useful evidence lives.

## Three Log Layers

Archon exposes three different evidence surfaces. They overlap, but they are
not interchangeable.

### 1. Runtime process logs

Use these when you need to debug Archon itself: startup, config loading,
database errors, adapter issues, API route failures, or unexpected process
behavior.

- Output goes to the current terminal or process log sink
- Verbosity is controlled by `LOG_LEVEL`
- `archon --verbose ...` sets the CLI logger to `debug`

Examples:

```bash
LOG_LEVEL=debug archon workflow list
LOG_LEVEL=debug archon workflow run archon-assist "help me debug this run"
LOG_LEVEL=debug bun run dev
```

### 2. Per-run workflow JSONL logs

Use these when you need the raw workflow trace for one run: assistant messages,
tool calls, node boundaries, validation events, and workflow-level failures.

Default location:

```text
~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

If `ARCHON_HOME` is set, replace `~/.archon` with that directory.

### 3. Web UI and API run details

Use these when you want a quick run summary, node progress, artifacts, and the
conversation view without opening the raw JSONL file.

- Web UI run details show node state, logs, and artifacts
- `GET /api/workflows/runs/:runId` returns the run plus lean DB events
- `archon workflow status --verbose` gives a CLI summary of active runs

Important: the UI/API event stream is intentionally lean. It does not replace
the raw JSONL file when you need the full assistant or tool trace.

## What Each Layer Contains

### Runtime process logs

Best for:

- startup and shutdown failures
- SQLite or PostgreSQL connection errors
- API route errors
- adapter or orchestration errors
- configuration problems

### Workflow JSONL logs

Best for:

- a single run's assistant output
- tool inputs for that run
- node-by-node flow
- validation pass/fail details
- interactive workflow pause output

The raw JSONL logger writes these event types:

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

### UI/API events

Best for:

- current node status
- elapsed time and progress
- artifacts
- recent workflow state in the app

Expect the naming to differ slightly from the JSONL file. The UI/API layer is
built from `remote_agent_workflow_events` and persisted messages, so event names
such as `node_started` or `tool_called` may appear there instead of the raw
JSONL names.

## Quick Triage Order

Use this sequence unless you already know the failing layer:

1. Get the run ID and current status.
2. Look at the UI run details or `archon workflow status --verbose`.
3. Open the per-run JSONL file for the full trace.
4. Turn on `LOG_LEVEL=debug` or `--verbose` only if the current evidence is too
   thin.
5. Return to process logs if the failure looks like Archon runtime behavior
   rather than workflow logic.

## Finding the Run

For active runs:

```bash
archon workflow status
archon workflow status --verbose
archon workflow status --json
archon workflow status --json --verbose
```

If you already have the run ID, locate the file directly:

```bash
find "${ARCHON_HOME:-$HOME/.archon}/workspaces" -name "<run-id>.jsonl" 2>/dev/null
```

## Reading the JSONL File

Set a shell variable first:

```bash
LOG_FILE="${ARCHON_HOME:-$HOME/.archon}/workspaces/<owner>/<repo>/logs/<run-id>.jsonl"
```

Show the last lines:

```bash
tail -n 40 "$LOG_FILE"
```

Search for failures:

```bash
rg '"type":"workflow_error"|"type":"node_error"' "$LOG_FILE"
```

Search for one node:

```bash
rg '"step":"implement"' "$LOG_FILE"
```

Search for validations:

```bash
rg '"type":"validation"' "$LOG_FILE"
```

## Filtering Patterns

### With `rg`

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

### With `jq` if installed

Latest assistant message:

```bash
jq -r 'select(.type=="assistant") | .content' "$LOG_FILE" | tail -n 1
```

Node errors with timestamps:

```bash
jq -c 'select(.type=="node_error") | {ts, step, error}' "$LOG_FILE"
```

Validation results:

```bash
jq -c 'select(.type=="validation") | {ts, step, check, result, error}' "$LOG_FILE"
```

## How To Interpret Common Events

### `workflow_start`

The run was created and the workflow began. This is the anchor for the rest of
the file.

### `node_start` and `node_complete`

The workflow crossed a node boundary. These tell you which step ran, in what
order, and where time was spent.

### `node_skipped`

This usually means a `when:` condition or trigger rule prevented the node from
running. It is not necessarily a failure.

### `node_error`

The node failed. Start here for step-local failures.

### `validation`

A named check ran and produced `pass`, `fail`, `warn`, or `unknown`.

### `assistant`

This is the workflow agent's textual output for the run. In interactive
workflows, this is the content you relay back to the user.

### `tool`

A raw tool invocation was recorded in the JSONL trace. Use this when you need
to see what the workflow attempted, not just the summarized UI status.

## Interactive Workflow Note

For interactive workflows, the important readback pattern is:

1. get the run ID
2. open the JSONL file
3. extract the last `assistant` event
4. relay its `content` directly

That is the canonical way to surface pause output from the raw log.

## UI Versus Raw File

Use the UI or API when:

- you need quick node status
- you want artifacts and high-level progress
- you are navigating several runs quickly

Use the raw JSONL file when:

- you need the exact assistant text
- you need the raw tool trace
- UI summaries feel incomplete
- you are investigating a single run deeply

## Common Failure Patterns

`workflow appears active but progress is unclear`:
Open the JSONL file and check the most recent `assistant`, `tool`, and
`node_*` events.

`UI shows state but not enough context`:
Use the raw JSONL for the detailed trace.

`run failed but nothing obvious appears in JSONL`:
Check Archon runtime logs with `LOG_LEVEL=debug`; the problem may be outside the
workflow trace itself.

`interactive workflow is paused and you need the exact wording`:
Extract the last `assistant` event from the JSONL file.

## Minimal Operator Checklist

When debugging a run for someone else, report:

1. run ID
2. workflow name
3. current status
4. failing node or last completed node
5. most recent assistant output
6. most relevant error or validation event
7. whether the problem looks like workflow logic or Archon runtime behavior
