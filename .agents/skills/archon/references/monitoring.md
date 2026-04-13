# Monitoring Archon Workflows From Codex

Use this guide when the user wants ongoing updates about a live Archon workflow.

## First Check

Start with:

```bash
archon workflow status --json
```

This command currently includes `last_activity_at`, which makes it usable as the
first stall-detection surface.

## Default Cadence

Use this cadence during active live monitoring:

- first check shortly after launch
- then about every 30 seconds while the user is actively waiting

Why not every 15 seconds?

- the web app already has a 15 second client-side fallback poll
- CLI monitoring is heavier because each check is a full Archon CLI invocation
  with database access

If the user is not actively waiting, reduce noise and check less often.

## Evidence Order

1. `archon workflow status --json`
2. web or API run details if available
3. per-run JSONL when status is ambiguous, paused, failed, or possibly stalled
4. runtime logs only when the problem looks like Archon itself

## Progress States

### Healthy running

Report only meaningful changes such as:

- current workflow changed
- status changed
- a new approval gate appeared
- artifacts appeared
- the run clearly moved to a new phase or node family

Do not spam the user with identical "still running" updates.

### Paused

Treat `paused` as action-required.

- open the latest workflow output
- relay it directly
- wait for the user response

### Possible stall

Default heuristic:

- run status is still `running`
- `last_activity_at` has not advanced for at least 5 minutes
- the JSONL tail shows no new assistant, tool, or node activity in the same
  5 minute window

Report this as a possible stall, not a confirmed failure.

### Terminal

When the run becomes `completed`, `failed`, or `cancelled`:

- report the terminal status
- include the most relevant evidence
- stop polling

## Optional Heartbeat Automation

If the user explicitly wants unattended follow-up and the current Codex surface
supports thread heartbeat automations, prefer a thread-attached heartbeat that:

- watches a specific run ID
- posts only on meaningful change
- flags a possible stall using the heuristic above
- stops once the run reaches a terminal state

Suggested reporting triggers:

- status transition
- approval gate reached
- terminal result
- possible stall

If heartbeat automation is unavailable on the current Codex surface, keep the
monitoring in-session instead of pretending the automation exists.
