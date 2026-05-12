---
title: Approval Nodes
description: Pause workflow execution for human review with approve/reject gates and optional AI rework on rejection.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 4
---

DAG workflow nodes support an `approval` field that pauses workflow execution
until a human approves or rejects the gate. Use approval nodes to insert human
review steps between AI-driven nodes — for example, reviewing a generated plan
before committing to expensive implementation work.

## Quick Start

> **Web UI users:** Add `interactive: true` at the workflow level. Without it, the
> workflow dispatches to a background worker and approval gate messages won't appear
> in your chat window. See [Web Execution Mode](/guides/authoring-workflows/#web-execution-mode).

```yaml
name: plan-approve-implement
description: Plan, get approval, then implement
interactive: true   # Required for Web UI: ensures approval gates appear in chat

nodes:
  - id: plan
    prompt: |
      Analyze the codebase and create a detailed implementation plan.
      $USER_MESSAGE

  - id: review-gate
    approval:
      message: "Review the plan above before proceeding with implementation."
    depends_on: [plan]

  - id: implement
    command: implement
    depends_on: [review-gate]
```

When execution reaches `review-gate`, the workflow pauses and sends a message
to the user on whatever platform they're using (CLI, Slack, GitHub, etc.). On the
**Web UI**, `interactive: true` is required for the message to appear in your chat.

## How It Works

1. **Pause**: The executor sets the workflow run status to `paused` and stores
   the approval context (node ID and message) in the run's metadata.
2. **Notify**: A message is sent to the user with the approval prompt and
   instructions for approving or rejecting.
3. **Wait**: The workflow stays paused until the user takes action. Paused runs
   block the worktree path guard (no other workflow can start on the same path).
4. **Approve**: The user approves, which writes a `node_completed` event for
   the approval node and transitions the run to resumable. Natural-language
   messages, the CLI, and the Web UI approve button all auto-resume the
   workflow from the paused gate. (The explicit `/workflow approve <run-id>`
   slash command also auto-resumes when issued in the originating conversation.)
5. **Reject**: The user rejects.
   - **Without `on_reject`**: The workflow is cancelled immediately.
   - **With `on_reject`**: The executor runs the `on_reject.prompt` via AI (with
     `$REJECTION_REASON` substituted), then re-pauses at the same gate. This
     repeats until the user approves or `on_reject.max_attempts` is reached, at
     which point the workflow is cancelled.

## YAML Schema

```yaml
- id: gate-name
  approval:
    message: "Human-readable prompt shown to the user"
    capture_response: true    # optional: store comment as $gate-name.output
    on_reject:                # optional: AI rework on rejection instead of cancel
      prompt: "Fix based on feedback: $REJECTION_REASON"
      max_attempts: 3         # optional: default 3, range 1–10
  depends_on: [upstream-node]  # optional
  when: "$plan.output != ''"   # optional condition
  trigger_rule: all_success    # optional (default: all_success)
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `approval.message` | string | Yes | The message shown to the user when the workflow pauses |
| `approval.capture_response` | boolean | No | When `true`, the user's approval comment is stored as `$<node-id>.output` for downstream nodes. Default: `false` |
| `approval.on_reject.prompt` | string | No | Prompt template run via AI when the user rejects. `$REJECTION_REASON` is substituted with the reject reason. After running, the workflow re-pauses at the same gate |
| `approval.on_reject.max_attempts` | integer | No | Max times the on_reject prompt runs before the workflow is cancelled. Range: 1–10. Default: 3 |

Approval nodes do not support AI-specific fields (`model`, `provider`, `context`,
`output_format`, `allowed_tools`, `denied_tools`, `hooks`, `mcp`, `skills`,
`idle_timeout`) since they don't invoke an AI agent. (The `on_reject.prompt` runs
as a separate AI node using the workflow's default provider.)

Standard DAG fields (`id`, `depends_on`, `when`, `trigger_rule`, `retry`) work
as expected.

## Approving and Rejecting

### Natural Language (recommended)

Just type your answer in the same conversation. The system detects the paused
workflow and treats your message as the approval response:

```
User: "Looks good, but add error handling for the edge cases"
→ System auto-approves, resumes workflow with your message as $gate.output
  (only if capture_response: true is set)
```

This works on all platforms (Web, Slack, Telegram, Discord, GitHub).

To reject instead, use `/workflow reject <run-id>`.

### CLI

The CLI is non-interactive — use explicit commands:

```bash
# Approve (resumes the workflow immediately)
bun run cli workflow approve <run-id>
bun run cli workflow approve <run-id> --comment "Looks good, proceed"

# Reject
# Without on_reject: cancels the workflow
# With on_reject: records feedback, triggers AI rework, re-pauses
bun run cli workflow reject <run-id>
bun run cli workflow reject <run-id> --reason "Plan needs more test coverage"
```

### Explicit Commands (all platforms)

```
/workflow approve <run-id> looks good
/workflow reject <run-id> needs changes
```

### Web UI

Paused workflows show an amber pulsing badge on the dashboard. Click **Approve**
or **Reject** directly on the workflow card. Both actions auto-resume the
workflow from the paused gate — no follow-up message required.

**Reject with reason**: the Reject dialog includes an optional free-text
reason field. The trimmed value (empty after trim → omitted) is passed to
the workflow as `$REJECTION_REASON`, available in the `on_reject.prompt`.
Rejects on web and chat cards use the same confirmation dialog.

**Cross-platform caveat**: auto-resume via the Web UI only applies when the
run was originally dispatched from the Web UI (parent conversation is a web
conversation). If you approve a Slack / Telegram / GitHub-dispatched run
from the dashboard, the decision is recorded, but the resume flow has to
happen in the originating platform (re-run the workflow there).

### REST API

```bash
# Approve
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Approved"}'

# Reject
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Needs revision"}'
```

## Downstream Output

By default, the user's approval comment is **not** available downstream —
`$<node-id>.output` will be an empty string. To capture the comment as node
output, set `capture_response: true`:

```yaml
nodes:
  - id: gate
    approval:
      message: "Any special instructions for implementation?"
      capture_response: true   # Makes the user's comment available as $gate.output
    depends_on: [plan]

  - id: implement
    prompt: |
      Implement the plan. User instructions: $gate.output
    depends_on: [gate]
```

Without `capture_response: true`, downstream nodes should not reference
`$gate.output` — it will be an empty string.

## Rejection with AI Rework (`on_reject`)

When `on_reject` is configured, a rejection does not cancel the workflow —
instead, the executor runs an AI prompt with the rejection reason and re-pauses
at the same gate.

```yaml
- id: review-gate
  approval:
    message: "Review the implementation plan."
    capture_response: true
    on_reject:
      prompt: |
        The reviewer rejected the plan with this feedback: $REJECTION_REASON

        Revise the plan to address the feedback, then summarize the changes.
      max_attempts: 3   # After 3 rejections, the workflow is cancelled. Default: 3.
  depends_on: [plan]
```

The `$REJECTION_REASON` variable is substituted with the `--reason` text provided
by the rejecting user. After the AI rework, the workflow re-pauses so the reviewer
can approve or reject again.

### Lifecycle with on_reject

1. Workflow pauses at approval gate
2. Reviewer rejects: `rejection_count` incremented, `rejection_reason` stored
3. If `rejection_count < max_attempts`: `on_reject.prompt` runs via AI, workflow re-pauses
4. If `rejection_count >= max_attempts`: workflow cancelled

## Edge Cases

- **Multiple approval nodes**: Supported. Each pauses the workflow independently.
- **Approval in parallel layer**: Other nodes in the same layer complete normally;
  the workflow pauses at the layer boundary.
- **Server restart while paused**: The run persists in the database. The user can
  still approve or reject after restart.
- **Abandoning a paused run**: Use `/workflow abandon <id>` or the Abandon button
  on the dashboard.

## Design Notes

Approval nodes reuse the existing resume infrastructure. When approved, the run
transitions through `failed` status briefly so the orchestrator's explicit
resume path (via `hydrateResumableRun`) picks it up — this avoids duplicating
resume logic. The `metadata.approval_response` field distinguishes
approved-then-resumed from genuinely-failed runs.
