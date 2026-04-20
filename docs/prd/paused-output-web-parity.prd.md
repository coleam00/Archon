---
title: Paused Output Web Parity
status: handoff_candidate
workflow_handoff_status: handoff_candidate
created: 2026-04-20
updated: 2026-04-20
source_plan: docs/plans/archon-paused-output-ux-parity_plan.md
slice: 1
---

# PRD: Paused Output Web Parity

## 1. Problem Statement

When an Archon workflow pauses for human approval, the Web chat and dashboard
surfaces show the short approval prompt but do not show the latest workflow
output that Archon already persisted in `metadata.approval.lastOutput`.

This makes the Web operator experience weaker than the CLI experience. The CLI
can display `Latest output`; Web operators must inspect logs or rely on a
separate relay to understand what the workflow just concluded before asking for
approval.

This slice fixes only the Web display parity gap. It does not change workflow
runtime metadata, output extraction semantics, or non-Web adapters.

## 2. Source Context

Umbrella plan:

- `docs/plans/archon-paused-output-ux-parity_plan.md`

This PRD covers only Slice 1 from that plan: Web Paused Output Parity.

## 3. Users And Context

Primary user: Mase as an Archon workflow operator using the Web chat or
dashboard to monitor and resume paused Codex PIV workflows.

Job to be done:

> When a workflow pauses for approval in Web, I need to see both the short gate
> prompt and the latest persisted workflow output, so I can make the approval
> decision without manually digging through run logs.

## 4. Scope

Update:

- `packages/web/src/components/chat/WorkflowProgressCard.tsx`
- `packages/web/src/components/dashboard/WorkflowRunCard.tsx`

Required behavior:

- Keep `approval.message` as the short gate prompt.
- Render `approval.lastOutput` below it as `Latest output`.
- Gate all new latest-output rendering on `status === "paused"`.
- Do not render stale approval output for `running`, `completed`, `failed`, or
  `cancelled` runs.
- If the output ends with `[truncated]`, show a visible clipped-output notice.
- Keep output visually bounded with stable layout, such as a max-height
  scrollable `pre-wrap` text block.

## 5. Non-Goals

Do not include:

- new metadata fields
- `lastOutputTruncated`
- `finalAssistantOutput`
- stale approval metadata cleanup on resume
- full-output endpoint
- run-log reading
- Slack, Telegram, GitHub, Discord, or other non-Web adapter changes
- broad styling refactors

## 6. Acceptance Criteria

- A paused workflow in the Web chat progress card shows the approval prompt.
- A paused workflow in the Web chat progress card shows `Latest output` when
  `approval.lastOutput` exists.
- A paused workflow in the dashboard workflow run card shows the approval
  prompt.
- A paused workflow in the dashboard workflow run card shows `Latest output`
  when `run.metadata.approval.lastOutput` exists.
- All new latest-output rendering is gated on `status === "paused"`.
- An output ending with `[truncated]` shows a clear clipped-output notice.
- No backend schema, executor, database, or workflow persistence change is made
  in this slice.

## 7. Validation

Run the narrow useful checks first:

```bash
bun run type-check
bun run lint
```

If a suitable Web component or helper test home exists, add the smallest
practical regression test. If no practical component-level harness exists for
these cards, document the remaining UI test gap in the implementation summary.

Before merge or PR:

```bash
bun run validate
```

## 8. Operator Handoff Prompt

Use this PRD as the complete implementation scope for the Archon Codex PIV loop.
Implement only Slice 1: Web Paused Output Parity. Treat every item under
Non-Goals as out of scope, even if related code is nearby. Preserve unrelated
dirty worktree changes and avoid broad refactors.
