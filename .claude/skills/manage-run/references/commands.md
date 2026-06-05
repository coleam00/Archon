# Manage-Run Command Reference

Every command runs through the `archon` CLI and is scoped to the current project by
the working directory. Add `--json` for a single clean JSON object on stdout (logs
are suppressed in `--json` mode); omit it for human-readable text. Diagnostics go to
stderr either way.

---

## Read

### `archon workflow runs [--all] [--status <s>] [--limit <n>] [--json]`
Recent runs of **all statuses** for this project (complements `status`, which is
active-only).

- `--all` — drop the project scope; list runs across every project.
- `--status <s>` — filter to one status: `pending | running | completed | failed | cancelled | paused`.
- `--limit <n>` — max rows (default 20).
- Unregistered cwd (or a codebase lookup failure): falls back to a global list and prints a `(not a registered project — showing all runs)` note (never a silent wrong scope). In `--json` this is the `scopeFallback` field — `true` means the result is global, not the project scope you asked for.

`--json` shape — the dashboard result:
```json
{
  "runs": [
    { "id": "…", "workflow_name": "archon-assist", "status": "completed",
      "current_step_name": "review", "total_steps": 4, "started_at": "…",
      "codebase_name": "…", "working_path": "…" }
  ],
  "total": 87,
  "counts": { "all": 87, "running": 1, "completed": 70, "failed": 12,
              "cancelled": 3, "pending": 0, "paused": 1 },
  "scopeFallback": false
}
```

### `archon workflow get <run-id> [--verbose] [--json]`
Detail for **one run, any status**.

- `--verbose` — also derive a per-node summary from the event log (and, in `--json`, attach the raw `events` array).
- `--json` emits the raw run object on success; on failure (not found, DB error) it emits one `{ "ok": false, "runId": "…", "error": "…" }` line and never throws (`error` is `"not_found"` for a missing run).
- Exit code is non-zero when the run is not found (so `archon workflow get <id> && …` and CI checks react to a missing run); `0` on success.

```json
{ "id": "…", "workflow_name": "archon-assist", "status": "failed",
  "working_path": "…", "started_at": "…", "completed_at": "…",
  "metadata": { "error": "Step failed: review" } }
```
With `--verbose --json`: `{ …run, "events": [ … ] }`.

### `archon workflow status [--verbose] [--json]`
**Active** runs only (running + paused). `--json` → `{ "runs": [ … ] }`.

---

## Start

### `archon workflow run <workflow> "<message>" --detach [--json]`
Run a workflow in a **detached background child**; returns immediately.

- The parent pins a generated branch + conversation id on the child so exactly one
  worktree/conversation is created. It **cannot** report the new run id (created in the
  child) — find it via `archon workflow runs`.
- Combine with the normal `run` flags (`--branch`, `--no-worktree`, `--from`, `--resume`).
- Child stdout/stderr are written to a per-conversation log file under
  `~/.archon/logs/`; the path is printed (and is the `logPath` field in `--json`).

`--detach --json` shape:
```json
{ "ok": true, "action": "run", "detached": true, "workflow": "archon-assist",
  "branch": "archon-assist-1780000000000", "conversationId": "cli-…",
  "logPath": "/Users/you/.archon/logs/detached-run-cli-….log" }
```

---

## Control

These four accept `--json`. **In `--json` mode they record/validate the decision and
return — they do NOT execute the workflow inline** (execution streams output that would
corrupt the JSON). The error path always returns `{ "ok": false, "runId": …, "error": … }`
instead of throwing, so a parser always gets one JSON line.

### `archon workflow approve <run-id> [comment] [--json]`
Approve a paused gate (approval node or interactive loop).
```json
{ "ok": true, "runId": "…", "action": "approve",
  "type": "approval_gate", "workflowName": "…", "resumable": true }
```
Non-`--json`: records the approval **and auto-resumes** (blocking — run as a background task).

### `archon workflow reject <run-id> [reason] [--json]`
Reject a paused gate. `cancelled: false` means an `on_reject` rework pass is queued
(run is resumable); `cancelled: true` ends the run.
```json
{ "ok": true, "runId": "…", "action": "reject", "cancelled": false,
  "maxAttemptsReached": false, "workflowName": "…", "resumable": true }
```

### `archon workflow abandon <run-id> [--json]`
Cancel a non-terminal run. (There is no separate `cancel` verb.)
```json
{ "ok": true, "runId": "…", "action": "abandon", "status": "cancelled", "workflowName": "…" }
```

### `archon workflow resume <run-id> [--json]`
Re-run a failed/paused run, skipping completed nodes.

- **Without `--json`**: executes (blocking — run as a background task), then poll with `get`.
- **With `--json`**: validates the run is resumable and returns `executed: false` **without
  running** — to actually execute, use the blocking form (background) or `run <name> --resume --detach`.
```json
{ "ok": true, "runId": "…", "action": "resume", "executed": false,
  "status": "failed", "workflowName": "…", "workingPath": "…" }
```

---

## Continuation model (paused → done)

```bash
archon workflow approve <run-id> "ship it" --json   # 1. record decision (fast, parseable)
archon workflow resume  <run-id>                    # 2. execute — run as a BACKGROUND task
archon workflow get     <run-id> --json             # 3. poll until completed/failed/cancelled
```
Or, to approve and continue in one (blocking) call, drop `--json` from step 1 — it
auto-resumes. A run is finished when `status` is `completed`, `failed`, or `cancelled`.
