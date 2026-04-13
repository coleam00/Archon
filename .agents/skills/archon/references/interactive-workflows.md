# Interactive Workflows For Codex

Use this guide when the workflow is interactive and the user is effectively
talking to the workflow through Codex.

Interactive workflows in this repo include:

- `archon-piv-loop-codex`
- `archon-interactive-prd`

## Core Rule

Be a transparent relay.

- show the workflow's latest question or summary directly
- do not rewrite or "improve" the workflow's wording
- pass the user's answer back as directly as possible

## Basic Loop

1. Launch the workflow and capture the run ID.
2. Monitor with `archon workflow status --json`.
3. When the run becomes `paused`, read the latest workflow output.
4. Relay that output directly to the user.
5. When the user answers, resume with `archon workflow approve` or
   `archon workflow reject`.
6. Repeat until the run reaches a terminal state.

## Commands

```bash
archon workflow status --json
archon workflow approve <run-id> "<user response>"
archon workflow reject <run-id> "<reason>"
```

## When Paused

When the workflow is paused:

- read the latest assistant output from the run log
- show it directly
- wait for the user
- pass their response through verbatim unless a safety or formatting issue
  requires intervention

Do not replace the workflow's structured questions with your own summary.

## When Still Running

Long research or implementation nodes can stay `running` for a while without
needing user input.

- keep checking status on the monitoring cadence
- do not treat "still running" by itself as a problem
- if activity stops for the stall window, flag a possible stall and say what
  evidence stopped moving

## Where To Read The Latest Output

Use the per-run JSONL when status alone is not enough:

```bash
find "${ARCHON_HOME:-$HOME/.archon}/workspaces" -name "<run-id>.jsonl" 2>/dev/null
tail -n 40 "<log-file>"
```

Read `log-debugging.md` when you need the full trace.
