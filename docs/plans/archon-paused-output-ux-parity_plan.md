---
title: Archon Paused Output UX Parity Plan
kind: plan
status: active
created: 2026-04-20
updated: 2026-04-20
origin: user request to improve Archon Codex paused-output visibility after status snapshot truncation
version: 1
---

# ELI5 Summary (Read This First)

Archon can pause a workflow and store what the agent just said. The CLI can show
that stored text as `Latest output`, but the Web chat and dashboard surfaces show
mostly the short approval prompt.

Simple version:

- Archon already has a bounded paused-output snapshot.
- The Web UI should show that snapshot when a run is actually paused.
- If the snapshot is clipped, Web should say so instead of pretending it is full.
- Deeper fixes belong in later slices because they change runtime contracts,
  metadata semantics, or log retrieval.

Only Slice 1 is implementation-ready in this plan. Later slices are intentionally
retained as roadmap scope but require separate review before coding.

# Orchestration Model

This plan is the umbrella. Implementation proceeds one slice at a time through a
slice-specific PRD or brief, then a scoped Archon Codex PIV run.

Current operating rule:

- Do not feed this whole umbrella plan into implementation.
- Create or identify the slice artifact first.
- Run `archon-piv-loop-codex` on exactly one slice.
- Update this umbrella plan after each meaningful workflow transition.

## Single Persistent Slice Lane

Operator decision on 2026-04-20:

- Keep all accepted umbrella slices on one persistent Git branch and one
  persistent Archon worktree so review and merge happen through a single PR.
- The active persistent lane is:
  - branch: `archon/task-piv-paused-output-web-parity-v2`
  - worktree:
    `/Users/mase/.archon/worktrees/Personal-Projects/Archon/archon/task-piv-paused-output-web-parity-v2`
- For Slice 2 and later, do not use Archon's default auto-generated branch.
  Launch with the explicit branch above so Archon reuses the healthy existing
  worktree when possible.
- Do not reuse the older superseded Slice 1 lane
  `archon/task-piv-paused-output-web-parity`.
- Do not run umbrella-slice implementation directly in the dirty root `dev`
  checkout.

# Slice Progress

| Slice | Artifact | PIV Branch | State | Notes |
| --- | --- | --- | --- | --- |
| Slice 1: Web Paused Output Parity | `docs/prd/paused-output-web-parity.prd.md` | `archon/task-piv-paused-output-web-parity-v2` | Implemented; Archon finalize failed | The restarted run advanced cleanly through `explore`, `create-plan`, implementation, code review, and approved `fix-feedback`. Slice 1 shipped in the worktree branch and was manually verified in the branch UI, but the workflow ended `failed` in `finalize` because `.archon/scripts/github-pr.ts` was invoked without `ARCHON_ARTIFACTS_DIR`. |
| Slice 2: Paused Snapshot Contract Design | TBD | `archon/task-piv-paused-output-web-parity-v2` | Deferred | Requires `finalAssistantOutput` design decision before implementation; next Archon run should reuse the persistent Slice lane. |
| Slice 3: Runtime Metadata Hygiene | TBD | `archon/task-piv-paused-output-web-parity-v2` | Deferred | Requires workflow-state semantics review; keep on the same persistent Slice lane. |
| Slice 4: Full Output Fallback | TBD | `archon/task-piv-paused-output-web-parity-v2` | Deferred | Requires API/log-access design; keep on the same persistent Slice lane. |
| Slice 5: Non-Web Adapter Review | TBD | `archon/task-piv-paused-output-web-parity-v2` | Deferred | Requires adapter-specific review; keep on the same persistent Slice lane. |

# Current Orchestration Ledger

- Active slice: Slice 1
- Slice artifact: `docs/prd/paused-output-web-parity.prd.md`
- Workflow: `archon-piv-loop-codex`
- Branch: `archon/task-piv-paused-output-web-parity-v2`
- Run ID: `0fcda4d1b1b047ea74b1d59028f8e595`
- Worktree: `/Users/mase/.archon/worktrees/Personal-Projects/Archon/archon/task-piv-paused-output-web-parity-v2`
- Persistent umbrella branch/worktree policy: reuse this same branch/worktree
  for Slice 2+ Archon runs
- Plan artifact: `.claude/archon/plans/paused-output-web-parity.plan.md`
- Last observed status: failed
- Last observed phase: `finalize`
- Last approval response: `approved` completed the `fix-feedback` gate and advanced through `compose-finalize`
- Last updated: 2026-04-20 Slice 1 implementation completed, branch UI verified on dashboard + chat, PR artifacts written, then `finalize` failed because `ARCHON_ARTIFACTS_DIR` was missing

## Latest Slice 1 Execution Result

Verified outcome for run `0fcda4d1b1b047ea74b1d59028f8e595`:

- `ready` advanced the restarted run out of `explore` and into normal plan
  creation.
- `approved` advanced the run out of `fix-feedback` and into finalization
  without requiring another model-emitted control token.
- Slice 1 implementation landed in branch
  `archon/task-piv-paused-output-web-parity-v2`, pushed to
  `origin/archon/task-piv-paused-output-web-parity-v2`, and remained clean at
  the end of implementation.
- Branch-scoped validation passed:
  `bun --filter @archon/web type-check`,
  `bun x eslint ... --max-warnings 0`,
  `bun x prettier --check ...`,
  `bun --filter @archon/web test`,
  `bun test packages/web/src/stores/workflow-store.test.ts`.
- Full `bun run validate` and `bun run test` still fail outside this slice in
  `packages/core/src/handlers/clone.test.ts`, where clone URL assertions pick
  up a real GitHub token from the local environment.
- Manual UI verification was completed against the slice worktree frontend on
  `http://localhost:4173`:
  - dashboard paused card showed the approval prompt and `Latest output`
  - chat workflow progress card showed the approval prompt, `Latest output`,
    and the paused approval controls

Finalization result:

- `compose-finalize` completed and wrote:
  - `commit-message.txt`
  - `pr-title.txt`
  - `pr-body.md`
  - `pr-request.json`
  - `pr-summary.md`
- `finalize` then failed because `.archon/scripts/github-pr.ts` exited with:
  `ERROR: ARCHON_ARTIFACTS_DIR is required`
- This is a workflow-system closeout defect, not a Slice 1 feature defect.

## Restart Note: Patched Slice 1 PIV Run

The original blocked run `d6935b177a930832c0f6ddfb9db4ca7d` was abandoned after
the Codex-only PIV progression patch landed locally. A fresh Slice 1 run was
started from local `dev` so the new worktree would include the patch commit.

Verified current state for the restarted run:

- Run `0fcda4d1b1b047ea74b1d59028f8e595` is `paused` at `explore` iteration 1.
- Approval metadata now includes `completeOnUserInput` aliases:
  `ready`, `create the plan`, `let's go`, `proceed`, `i'm done`.
- The fresh run reached a normal paused checkpoint and produced a scoped
  exploration summary instead of getting stuck in the old explore-to-plan
  control defect.

Current operator state:

- This slice is back on the normal PIV path.
- The patched `ready` approval advanced the run without relying on a
  model-emitted `PLAN_READY` tag alone.
- The next action is a human approval decision on the generated Slice 1
  implementation plan.
- Verified progression after restart: `explore` completed, `detect-project`
  completed, `create-plan` completed, and the run paused at `refine-plan`
  iteration 1.

## Historical Finding: Pre-Patch Explore-To-Plan Control Defect

The Slice 1 PRD and exploration plan are clear enough to implement, but the
current `archon-piv-loop-codex` run did not move from `explore` to structured
plan creation through the normal approval path.

Verified observations:

- Archon persisted `loop_user_input: "ready"` for run
  `d6935b177a930832c0f6ddfb9db4ca7d`.
- The workflow status endpoint reports the run as `paused` with approval
  `nodeId: "explore"` and `iteration: 5`.
- The run log has no `workflow_failed`, `node_failed`, or
  `loop_iteration_failed` events for this diagnostic check.
- The implementation worktree is clean, so no Slice 1 implementation changes
  were made by the PIV run.
- The temporary Web `failed` badge is explained by the current approval path:
  interactive-loop approvals transition the run to `failed` as a resumable
  marker before the next resume turns it back into `running` or `paused`.

Operational decision:

- Do not keep approving this run repeatedly.
- Treat Slice 1 as PIV-control blocked, not feature-plan blocked.
- Fix or bypass the explore-to-plan transition mechanism before using this PIV
  loop for further umbrella slices.

# Problem Statement

When an interactive Archon workflow pauses, the human operator needs to see the
latest useful workflow output without manually digging through run logs.

The inspected run showed three separate issues:

1. `approval.lastOutput` is intentionally bounded to 8000 characters.
2. For interactive loops, the stored snapshot can represent accumulated
   iteration output rather than just the final answer block.
3. Web surfaces do not currently render `approval.lastOutput` even when it is
   already available to the frontend.

The first issue is acceptable. The second and third issues need separate slices.
Do not solve all of them in one patch.

# Verified Current State

- `packages/workflows/src/dag-executor.ts` bounds `approval.lastOutput` with the
  suffix `[truncated]`.
- `packages/workflows/src/dag-executor.ts` writes `lastOutput` into interactive
  loop approval metadata and emits it on `approval_pending`.
- `packages/core/src/db/workflows.ts` persists approval metadata when pausing.
- `packages/core/src/db/workflows.ts` resumes a run by setting status back to
  `running` without clearing the old `metadata.approval` blob.
- `packages/server/src/routes/api.ts` returns workflow run records with raw
  metadata through the workflow run list endpoint.
- `packages/server/src/routes/schemas/workflow.schemas.ts` exposes `metadata` as
  `z.record(z.unknown())`, so `metadata.approval.lastOutput` is available if the
  database row contains it.
- `packages/cli/src/commands/workflow.ts` renders `Latest output` for paused
  runs.
- `packages/web/src/components/chat/WorkflowProgressCard.tsx` renders only the
  paused approval message today.
- `packages/web/src/components/dashboard/WorkflowRunCard.tsx` renders only the
  paused approval message today.

# Peer Review Result

External peer review was run in `advisory-challenge` mode using the opposite
runtime reviewer.

Result:

- Stance: supportive
- Issues: 5
- Reviewer match: opposite
- Gate quality: preferred
- Rerun recommendation: stop

Accepted peer-review changes:

- Add an explicit `status === "paused"` gate requirement to Slice 1.
- Name the concrete Web files in Slice 1.
- Keep `[truncated]` suffix detection as a temporary Slice 1 compromise.
- Define `finalAssistantOutput` before any Slice 2 implementation.
- Explicitly defer Slack, Telegram, GitHub, and other non-Web adapters.

# Slice 1: Web Paused Output Parity (Implementation-Ready)

## Goal

Make Web surfaces show the paused output Archon already stores, without changing
runtime metadata or workflow state semantics.

## Scope

Update:

- `packages/web/src/components/chat/WorkflowProgressCard.tsx`
- `packages/web/src/components/dashboard/WorkflowRunCard.tsx`

Behavior:

- Keep `approval.message` as the short gate prompt.
- Render `approval.lastOutput` below it as `Latest output`.
- Gate all new `lastOutput` rendering on `status === "paused"`.
- Do not render stale `metadata.approval.lastOutput` for `running`,
  `completed`, `failed`, or `cancelled` runs.
- If `lastOutput` ends with `[truncated]`, show a clear clipped-snapshot notice.
- Keep the output visually bounded with stable layout, for example a max-height
  scrollable `pre-wrap` text block.

## Explicit Non-Scope

Do not include in Slice 1:

- new metadata fields
- `lastOutputTruncated`
- `finalAssistantOutput`
- stale approval metadata cleanup
- full-output endpoint
- run-log reading
- Slack, Telegram, GitHub, or other non-Web adapter behavior

## Acceptance Criteria

- A paused workflow in the Web chat workflow progress card shows:
  - the approval prompt
  - `Latest output` when `approval.lastOutput` exists
- A paused workflow in the dashboard run card shows:
  - the approval prompt
  - `Latest output` when `run.metadata.approval.lastOutput` exists
- All new latest-output rendering is gated on `status === "paused"`.
- A snapshot ending with `[truncated]` shows a visible clipped-output warning.
- No backend schema or workflow persistence change is required for this slice.

## Validation

Run the narrowest useful checks first:

```bash
bun run type-check
bun run lint
```

Then run targeted Web tests if a suitable existing test home is available. If no
component-level test harness exists for these cards, add the smallest practical
test at the helper/store level and document the remaining UI test gap.

Before merge or PR, run:

```bash
bun run validate
```

# Slice 2: Paused Snapshot Contract Design (Follow-Up)

## Goal

Make the paused snapshot more semantically useful than the current accumulated
iteration-output snapshot.

## Required Design Decision

Define what `finalAssistantOutput` means before implementation.

Possible definitions to evaluate:

- the last assistant event in an iteration
- the last tool-free assistant turn
- the tail of the cleaned iteration output
- a structured output block explicitly emitted by the workflow prompt

Do not implement this slice until the extraction boundary is explicit.

## Candidate Scope

- Keep current `lastOutput` for compatibility.
- Add typed metadata such as:
  - `lastOutputTruncated: boolean`
  - `finalAssistantOutput?: string`
  - `finalAssistantOutputTruncated?: boolean`
- Add executor tests that prove long iteration output can coexist with a useful
  shorter final output.

## Risk

Medium. The current executor tracks accumulated iteration text, not a clean
final-answer boundary.

# Slice 3: Runtime Metadata Hygiene (Follow-Up)

## Goal

Avoid stale approval metadata looking like a live pause after resume.

## Candidate Scope

- Decide whether resume should clear `metadata.approval` or move it to
  `metadata.lastApproval`.
- Preserve enough history for debugging and audit.
- Confirm approve/reject/resume paths still work for both approval nodes and
  interactive loops.

## Acceptance Direction

- `status === "paused"` remains the only actionable pause signal.
- A `running` workflow does not carry live-looking approval metadata.

## Risk

Medium. This changes workflow state semantics and should not be bundled with Web
display parity.

# Slice 4: Full Output Fallback (Follow-Up)

## Goal

Provide authoritative full paused output on demand when the bounded status
snapshot is clipped.

## Candidate Scope

- Add a narrow API/helper to read the relevant assistant output from the run log.
- Show a `View full paused output` action only when the bounded snapshot is
  clipped.
- Keep full output out of normal status payloads.
- Return clear errors for missing, unreadable, or unavailable logs.

## Risk

Medium. This crosses database state, filesystem logs, API shape, and Web UI.

# Slice 5: Non-Web Adapter Review (Follow-Up)

## Goal

Decide whether non-Web adapters need equivalent paused-output handling.

## Scope

Assess but do not implement in Slice 1:

- Slack
- Telegram
- GitHub
- Discord or any future adapter

The likely rule is adapter-specific: avoid dumping large paused output into chat
platforms by default, but provide a clear way to inspect it.

# Implementation Gate

Only Slice 1 is approved for first implementation.

Slices 2 through 5 are retained in this plan to preserve the product direction,
but each requires separate review before coding.

# Open Questions

- Should Slice 2 prefer tail output over final-turn extraction if provider event
  boundaries are unreliable?
- Should Slice 3 preserve old approval metadata in workflow events only, or keep
  a compact `lastApproval` metadata field?
- Should Slice 4 read from JSONL logs directly, or should future workflow events
  persist enough output to avoid filesystem log coupling?
