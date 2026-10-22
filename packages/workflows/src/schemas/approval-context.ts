/**
 * The gate a paused run sits at (`metadata.approval`), and the decisions that read it.
 */
import { z } from 'zod';
import { tokenUsageSchema } from '@archon/provider-contract';
import { approvalDecisionConfigSchema } from './gate-node';
import { nodeExecutionMetadataSchema } from './node-execution';
import { suspendReasonSchema } from './node-state';
import { recordSurfaceSchema } from './record-surface';
import { isTerminalRunStatus, type WorkflowRunStatus } from './run-status';
import { bodySessionCursorAncestrySchema, bodySessionCursorsSchema } from './run-wait';

/**
 * True when `type` is `undefined` (every pause before the field existed, or a plain
 * approval gate that omits it) or a recognized `SuspendReason`. Shared by the CLI
 * `--detach` precheck (`assertApprovable`/`assertRejectable`) and the real
 * approve/reject resolution's exhaustive switches so a precheck success can never
 * diverge from what resolution actually does — an unrecognized reason must be
 * rejected at the SAME point by both, not silently absorbed by one and only later
 * caught by the other (#2489).
 */
export function isRecognizedSuspendReason(type: string | undefined): boolean {
  return type === undefined || suspendReasonSchema.safeParse(type).success;
}

/** Approval context stored in workflow run metadata when paused for human review. */
const approvalContextBaseSchema = z.object({
  nodeId: z.string(),
  /** Unique occurrence identity; absent only on pauses created by older builds. */
  pauseId: z.string().optional(),
  message: z.string(),
  /**
   * Distinguishes the pause kind — see `SuspendReason` (node-state.ts) for the resume-path
   * pointer each variant carries:
   *  - `approval`         — a DAG approval node awaiting a human decision.
   *  - `interactive_loop` — an interactive loop gate.
   *  - `writeback`        — the ENGINE-level container write-back gate (Phase C):
   *    no DAG node behind it (`nodeId` is the synthetic `__writeback__`), the
   *    overlay diff of a finished container run awaiting approve→apply / reject→
   *    discard. Reuses the approve/reject CAS machinery; the executor's resume
   *    path branches on the persisted `pending_writeback` marker, not this node.
   *  - `child_workflow`   — a `workflow:` sub-run node (#2121 Phase 2) whose CHILD
   *    run paused at its own gate. The parent pauses "blocked on child"; `nodeId`
   *    is the parent's workflow node, `childRunId` the paused child. The reviewer
   *    approves the CHILD by run id; when the child terminates, the parent_run_id
   *    auto-resume hook re-enters the parent (executor.ts), which re-runs the
   *    workflow node, finds the child terminal, and threads its output. NO
   *    node_completed is written for the parent's node on this pause.
   *  - `fan_out`          — a `fan_out:` workflow node (#4044) whose children have not
   *    all finished because some paused. `nodeId` is the fan-out node, `childRunIds`
   *    the children it waits on. Each child is answered by its own run id; the parent
   *    re-enters once `isFanOutBlockReleased` holds and joins as usual.
   */
  type: suspendReasonSchema.optional(),
  /**
   * Child run id when `type === 'child_workflow'` — the specific paused sub-run
   * the parent is blocked on. Read by the parent auto-resume guard so a DIFFERENT
   * child of the same parent can't trigger the wrong re-entry.
   */
  childRunId: z.string().optional(),
  /**
   * `type === 'fan_out'` only: every non-terminal child of the node at pause time, in
   * item order. A paused child keeps its `max_parallel` slot, so this holds at most
   * the numeric `max_parallel` bound, or all resolved items for `max_parallel: all`.
   */
  childRunIds: z.array(z.string()).optional(),
  /**
   * `type === 'fan_out'` only: items with no child run yet because the `max_parallel`
   * window is full of unfinished children.
   */
  unspawnedItems: z.number().int().min(0).optional(),
  /**
   * Set only on an ESCALATED pause: a `gate:` node that is the sole terminal sink
   * of a `loop_group` body (#2707 step 3), still `type: 'approval'`. The enclosing
   * loop_group's own id occupies `nodeId` — required for the top-level DAG's
   * resume walk to find it (it only knows top-level node ids, never a nested body
   * id) — so this field carries the body gate's own bare id, the one piece the
   * group address would otherwise hide. `approveWorkflow`/`rejectWorkflow`/
   * `respondToWorkflowWithDeclaredDecision` read it to namespace the resolution's
   * `node_completed` event as `<nodeId>.<bodyGateId>` instead of bare `nodeId` —
   * the exact `<groupId>.<bodyId>` step name #2748's `outerNodeOutputs`
   * pre-population already keys on, so the gate's own resolved decision is
   * findable again after a resume the same way any other body node's output is.
   * Absent for every other pause kind, including an ordinary top-level gate.
   */
  bodyGateId: z.string().optional(),
  /** Current loop iteration when paused (interactive loops only). */
  iteration: z.number().optional(),
  /**
   * Session ID to restore on resume (interactive loops only). Gate pauses write an
   * explicit null when the loop has no session cursor to restore; readers treat that
   * exactly like an absent key.
   */
  sessionId: z.string().nullable().optional(),
  /**
   * Provider that created `sessionId` (#1992). Persisted by loop_group gates and
   * restored together with the session id so a resumed loop never threads the
   * session into a node that resolves to a different provider (cross-provider
   * resume is impossible). Same null-means-no-cursor convention as `sessionId`.
   * Absent on single-node loop gates — those restore the session into the same
   * node, so the provider is the same by construction.
   */
  sessionProvider: z.string().nullable().optional(),
  bodySessionCursors: bodySessionCursorsSchema.optional(),
  bodySessionCursorAncestry: bodySessionCursorAncestrySchema.optional(),
  /** When true, the user's approval comment is stored as `$nodeId.output`. Legacy-mode gates only (see `onRejectPrompt`). */
  captureResponse: z.boolean().optional(),
  /** The on_reject prompt template (stored at pause time so reject handlers don't need the workflow def). */
  onRejectPrompt: z.string().optional(),
  /** Max rejection attempts before cancellation (default 3). */
  onRejectMaxAttempts: z.number().optional(),
  /**
   * Gate resolution marker. Set by approve/reject handlers while the run STAYS
   * 'paused' awaiting auto-resume (#2075): 'approved' = approval recorded,
   * 'rejected' = rejection recorded with an on_reject rework staged.
   * null/undefined = gate unresolved (awaiting the human).
   *
   * Lifecycle: never cleared on resume — matching the never-clear convention for
   * approval_response/rejection_reason/loop_user_input (consumed in place). The
   * next fresh pause is what resets it: pauseWorkflowRun REPLACES the whole
   * approval object, so a gate that sets no `resolved` stores none and a prior
   * gate's 'approved' cannot survive to block it (#2673).
   */
  resolved: z.enum(['approved', 'rejected']).nullable().optional(),
  /**
   * Audit facts of the answer that set `resolved`: the surface it arrived through
   * (`cli`, `api`, `manage_run`, or a chat platform id) and when it was committed. Never
   * who answered. Replaced with the rest of the context by the next pause.
   */
  answeredVia: recordSurfaceSchema.optional(),
  answeredAt: z.string().optional(),
  /**
   * Interactive-loop only. True when the iteration this gate paused on emitted the
   * completion signal (detectCompletionSignal / until_bash exit 0). Read at resume by
   * executeLoopNode/executeLoopGroupNode: a signal-bearing gate approved WITHOUT feedback
   * finalizes the node from `signaledOutput` instead of re-running. Cleared by the next
   * fresh pause the same way `resolved` is — the whole approval object is replaced.
   */
  completionSignaled: z.boolean().nullable().optional(),
  /**
   * Interactive-loop only. The (stripped) output of the signal-bearing paused iteration,
   * persisted so the finalize path can write node_completed with the real output for
   * downstream `$nodeId.output` refs. Only set when completionSignaled is true; null otherwise.
   */
  signaledOutput: z.string().nullable().optional(),
  /**
   * Interactive-loop only. The signal-bearing iteration's structured payload (#2637),
   * persisted beside `signaledOutput` so a bare-approve finalize attaches the same
   * `structuredOutput` a natural completion would — without it the two completion
   * routes of one node diverge in `$node.output.field` strictness (finalize would
   * land in the strict text-parse tier while natural completion stays lenient).
   * Only set when completionSignaled is true AND the iteration produced a payload;
   * null otherwise. Absent on gates paused by builds predating this field — those
   * finalize text-only, exactly as before.
   */
  signaledStructuredOutput: z.unknown().optional(),
  /**
   * Single-node `loop` gate only. The paused iteration's (stripped) output, whether or not
   * it signaled, restored on resume as the previous output that `$LOOP_PREV_OUTPUT` and
   * until_bash read. A `loop_group` restores it from its body's persisted rows instead.
   * Absent on gates paused by builds predating this field; those resume with it empty.
   */
  iterationOutput: z.string().optional(),
  /**
   * Interactive-loop only, and written by the single-node `loop` gate ONLY. Cumulative
   * token usage through this pause, restored when the loop resumes so later gates and
   * terminal metadata retain every pre-gate iteration. The historical name remains for
   * compatibility with already-paused runs. A `loop_group` gate deliberately omits it:
   * body nodes persist their own namespaced usage rows before the pause.
   */
  signaledTokens: tokenUsageSchema.nullable().optional(),
  /** Cumulative USD cost through this single-node loop pause; paired with signaledTokens. */
  signaledCostUsd: z.number().nullable().optional(),
  /** Original execution facts retained across a gate; no private session handle. */
  execution: nodeExecutionMetadataSchema.optional(),
  /**
   * Interactive-loop only. Read-once snapshot of the resolved loop prompt
   * template, whether authored as `loop.prompt` or loaded from `loop.command`,
   * persisted at gate pause so the resumed invocation reuses the exact text the
   * run started with. This also takes precedence over an included loop command's
   * load-time compiled prompt/error after rediscovery. Absent on runs paused by builds
   * that predate this field; those resume from the current prompt or command source.
   */
  commandSnapshot: z.string().nullable().optional(),
});

/** Authored vocabularies are required and nonempty; older default gates may omit both fields. */
const approvalDecisionsSchema = z.union([
  z.object({
    decisionsAuthored: z.literal(true),
    decisions: z.array(approvalDecisionConfigSchema).min(1),
  }),
  z.object({
    decisionsAuthored: z.literal(false).optional(),
    decisions: z.array(approvalDecisionConfigSchema).optional(),
  }),
]);

export const approvalContextSchema = approvalContextBaseSchema.and(approvalDecisionsSchema);
export const expectedApprovalGateSchema = z.union([
  z.string().min(1),
  z.object({ nodeId: z.string().min(1), pauseId: z.string().min(1) }),
]);

export type ApprovalContext = z.infer<typeof approvalContextSchema>;

/** Old node-only buttons may resolve only contexts without a pause identity. */
export type ExpectedApprovalGate = z.infer<typeof expectedApprovalGateSchema>;

/**
 * Top-level (non-`approval`) run-metadata keys of the interactive-loop gate
 * protocol, written by approveWorkflow and read at resume by
 * executeLoopNode/executeLoopGroupNode (#2074). Deliberately NOT a Zod schema —
 * run metadata stays schemaless JSON; this alias exists solely so the write and
 * read sites share one key spelling (a typo is a compile error), nothing broader.
 */
export interface LoopGateRunMetadata {
  /** $LOOP_USER_INPUT for the resumed iteration (approve comment; defaults to 'Approved'). */
  loop_user_input?: string;
  /**
   * True iff the approve carried real (non-whitespace) feedback. False/absent =
   * bare approve — finalize-eligible when the gate's completionSignaled is true.
   */
  loop_feedback_given?: boolean;
}

/**
 * True when the run's current approval gate has already been resolved
 * (approved, or rejected with a staged on_reject rework) and the run is
 * paused only while awaiting resume. Guards double-approve/reject, and keeps a
 * resolved gate out of the chat agent's prompt context (#2565) — it is waiting
 * on the machine, not on a human.
 */
export function isGateResolved(approval: ApprovalContext): boolean {
  return approval.resolved === 'approved' || approval.resolved === 'rejected';
}

/**
 * Type guard for ApprovalContext.
 * Validates the gate identity, message and decision vocabulary.
 * Use before accessing `workflowRun.metadata.approval` to prevent runtime throws on
 * malformed metadata (e.g., stale data from older runs where metadata shape differs).
 */
export function isApprovalContext(val: unknown): val is ApprovalContext {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>).nodeId === 'string' &&
    typeof (val as Record<string, unknown>).message === 'string' &&
    approvalDecisionsSchema.safeParse(val).success
  );
}

/**
 * True when a paused run's gate state, on its own, is worth resuming even with
 * ZERO completed DAG nodes — i.e. resolving the run left no `node_completed`
 * row anywhere, but the executor still knows how to make forward progress.
 * Exhaustively switched over `SuspendReason` (#2714) so a future fifth reason
 * cannot silently repeat the gap this closes: a plain `approval` gate whose
 * staged legacy `on_reject` rework was invisible to `hydrateResumableRun`
 * because `rejectWorkflow`'s stage-rework path never writes `node_completed`
 * (only `metadata.approval.resolved`/`rejection_reason`/`rejection_count`).
 *
 * - `interactive_loop` / `child_workflow` / `fan_out` — always true: these kinds
 *   are re-entered by the node executor's own re-read of its state,
 *   independent of `priorCompletedNodes` (`executeLoopNode`/
 *   `executeLoopGroupNode`/`executeWorkflowNode` under dag/nodes/).
 * - `writeback` — always false: there is no DAG node behind this gate to
 *   re-run (`nodeId` is the synthetic `__writeback__`); resolving it flows
 *   through the container write-back resume path, never a node re-run.
 * - `approval` / `undefined` — true ONLY for a genuinely staged legacy
 *   on_reject rework: `resolved === 'rejected'`, a non-empty top-level
 *   `rejection_reason`, and `onRejectPrompt` still present on the approval
 *   context (the same legacy-mode signal `executeApprovalNode` itself checks
 *   before re-running the rework prompt). A new-mode gate (#2707 step 1)
 *   never needs this carve-out: both approve and reject write
 *   `node_completed` immediately, so `priorCompletedNodes` already contains
 *   it by the time this function would be asked.
 */
export function reRunsOwnNodeOnResume(
  approval: ApprovalContext | undefined,
  metadata: Record<string, unknown> | undefined
): boolean {
  if (approval === undefined) return false;
  switch (approval.type) {
    case 'interactive_loop':
    case 'child_workflow':
    case 'fan_out':
      return true;
    case 'writeback':
      return false;
    case 'approval':
    case undefined: {
      const rejectionReason = metadata?.rejection_reason;
      return (
        approval.resolved === 'rejected' &&
        approval.onRejectPrompt !== undefined &&
        typeof rejectionReason === 'string' &&
        rejectionReason !== ''
      );
    }
    default: {
      const unreachable: never = approval.type;
      throw new Error(`reRunsOwnNodeOnResume: unhandled gate type '${String(unreachable)}'`);
    }
  }
}

/**
 * True when `run` is currently paused blocked on the child sub-run `childRunId`
 * (#2121 Phase 2) — i.e. a `paused` run whose `metadata.approval` is a
 * `child_workflow` gate pointing at that child, or a `fan_out` gate listing it in
 * `childRunIds`. This is the single source of the
 * "parent blocked on this child" invariant, shared by the abandon-strand detector
 * (`findParentBlockedOn`, @archon/core) and the auto-resume hook
 * (`maybeResumeParentRun`, @archon/workflows) so the two cannot drift if the gate
 * shape changes. Reads defensively from possibly-malformed metadata.
 */
export function isRunBlockedOnChild(
  run: { status: WorkflowRunStatus; metadata?: Record<string, unknown> },
  childRunId: string
): boolean {
  if (run.status !== 'paused') return false;
  const approval = run.metadata?.approval;
  if (!isApprovalContext(approval)) return false;
  if (approval.type === 'child_workflow') return approval.childRunId === childRunId;
  if (approval.type === 'fan_out') return approval.childRunIds?.includes(childRunId) === true;
  return false;
}

/**
 * True when a parent paused on a `fan_out` gate should continue: every child it waits
 * on is terminal (or has no row), or a slot is free for an unspawned item. A paused
 * child holds its `max_parallel` slot, so with `unspawnedItems > 0` one finished child
 * is enough to let the next item start. `childStatus` returns undefined for a missing row.
 * False for every other gate type.
 */
export function isFanOutBlockReleased(
  approval: ApprovalContext,
  childStatus: (childRunId: string) => WorkflowRunStatus | undefined
): boolean {
  if (approval.type !== 'fan_out') return false;
  const ids = approval.childRunIds ?? [];
  const finished = ids.filter(id => {
    const status = childStatus(id);
    return status === undefined || isTerminalRunStatus(status);
  }).length;
  return finished === ids.length || ((approval.unspawnedItems ?? 0) > 0 && finished > 0);
}
