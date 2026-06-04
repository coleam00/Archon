---
name: manage-run
description: |
  Use when: User wants to INSPECT, MONITOR, START, APPROVE, or CONTROL Archon
  workflow RUNS in the current project — driven through the `archon` CLI over bash.
  Triggers (inspect): "what's running", "list runs", "show recent runs", "run status",
            "did the review pass", "check run <id>", "show me run <id>", "what happened in that run".
  Triggers (control): "approve the plan", "approve run <id>", "reject that run", "cancel that run",
            "abandon run <id>", "resume run <id>", "continue that run".
  Triggers (start): "start <workflow> in the background", "kick off <workflow> detached".
  Capability: Drives `archon workflow runs/get/status/run --detach/approve/reject/abandon/resume`
            with machine-readable `--json` output, scoped to the current project by cwd.
  NOT for: Authoring workflows/commands, or Archon setup/config — use the broader `archon` skill.
argument-hint: "[run-id or workflow] [comment]"
---

# Manage Archon Runs

A focused skill for **managing workflow runs** through the `archon` CLI. It assumes
Archon is already installed and you are working **inside the project repo** — the
current directory scopes every command to that project automatically. For authoring
workflows, setup, or config, use the broader **`archon`** skill instead.

## Recent runs (live)

!`archon workflow runs --limit 10 2>&1 || echo "Archon CLI not installed. (This skill needs the archon CLI on PATH.)"`

## How output works

- Add `--json` to any command for a **single clean JSON object on stdout** (logs are
  suppressed automatically in `--json` mode). Prefer `--json` when you will parse the result.
- Without `--json` you get human-readable text. Diagnostics/warnings always go to stderr.
- The current directory (cwd) determines which project's runs you see. Run from the repo.

## Verbs

| Goal | Command |
|------|---------|
| **List recent runs** (all statuses, this project) | `archon workflow runs --json` |
| List across **all** projects | `archon workflow runs --all --json` |
| Filter by status / cap rows | `archon workflow runs --status running --limit 50 --json` |
| **Show one run** (status, error) | `archon workflow get <run-id> --json` |
| One run **with per-node detail** | `archon workflow get <run-id> --verbose --json` |
| **Active** runs only (running/paused) | `archon workflow status --json` |
| **Start** a run, non-blocking | `archon workflow run <workflow> "<message>" --detach` |
| **Approve** a paused gate | `archon workflow approve <run-id> "looks good" --json` |
| **Reject** a paused gate | `archon workflow reject <run-id> "fix X first" --json` |
| **Cancel** a non-terminal run | `archon workflow abandon <run-id> --json` |

> There is no separate `cancel` verb — `abandon` cancels a non-terminal run by id.

## Patterns

### Monitor a run to completion
```bash
archon workflow runs --json                 # find the run id
archon workflow get <run-id> --json         # poll status: running | completed | failed | paused
```
A run is finished when `status` is `completed`, `failed`, or `cancelled`.

### Start work without blocking
```bash
archon workflow run archon-assist "Investigate the flaky test" --detach
# returns immediately; the run then appears in `archon workflow runs`
```
`--detach` runs the workflow in a background child. The parent can't print the new
run id (it's created in the child) — find it with `archon workflow runs`. If the run
never appears, check the child log path printed by the command (or the `logPath`
field in `--detach --json`).

> **Console UI note:** a detached run *does* appear in the web console's Workflow dock
> (the dock lists runs by project), but its progress may **not update live** — detached
> runs execute in a separate process and don't stream to the console's live event feed,
> so the dock catches up on its next refetch rather than in real time. Tell the user to
> refresh if they want the latest state. (Re-running progress live for CLI-started runs
> is a tracked follow-up.)

### Approve or reject a paused run (two steps)
`--json` approve/reject/resume **record the decision** (the run becomes resumable) but
do **not** execute the workflow — execution streams output that would corrupt the JSON.
So:
```bash
archon workflow approve <run-id> "ship it" --json   # records the approval (resumable: true)
archon workflow resume <run-id>                      # execute it — run this as a BACKGROUND task
archon workflow get <run-id> --json                  # poll until completed/failed
```
If you only need to record the decision (e.g. cancel via reject) and don't need to
drive the run forward, the `--json` step alone is enough. To approve **and** continue
in one blocking call, drop `--json`: `archon workflow approve <run-id> "ship it"`
auto-resumes (run it as a background task).

## Reference

For the full flag list and JSON shapes of each verb: read `references/commands.md`.
