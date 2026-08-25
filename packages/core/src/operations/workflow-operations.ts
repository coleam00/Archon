/**
 * Shared workflow business logic — approve, reject, status, resume, abandon.
 *
 * Both CLI and command-handler are thin formatting adapters over these functions.
 * Operations throw on errors; callers catch and format for their platform.
 */
import { createLogger, captureApprovalResolved } from '@archon/paths';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  isApprovalContext,
  isGateResolved,
  isRunBlockedOnChild,
  isRecognizedSuspendReason,
} from '@archon/workflows/schemas/workflow-run';
import type {
  WorkflowRun,
  ApprovalContext,
  LoopGateRunMetadata,
} from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '../db/workflows';
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';

// Lazy logger — NEVER at module scope
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('operations');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface WorkflowStatusData {
  runs: WorkflowRun[];
}

export interface ApprovalOperationResult {
  /**
   * True when the gate was ALREADY resolved as approved and this call returned
   * the resume context instead of recording a fresh approval. Only ever set
   * when the caller opts in via `allowAlreadyApproved`.
   */
  alreadyApproved?: boolean;
  workflowName: string;
  workingPath: string | null;
  userMessage: string | null;
  codebaseId: string | null;
  /** Internal DB UUID — resolve via getConversationById() to get platform_conversation_id. */
  conversationId: string;
  type: 'interactive_loop' | 'approval_gate';
}

export interface RejectionOperationResult {
  workflowName: string;
  workingPath: string | null;
  userMessage: string | null;
  codebaseId: string | null;
  /** Internal DB UUID — resolve via getConversationById() to get platform_conversation_id. */
  conversationId: string;
  /**
   * true = run cancelled; false = staying paused/resumable for one of two
   * reasons distinguished by `newMode` below — a legacy `on_reject` rework
   * being staged, or (#2707 step 1) a new-mode gate resolving with structured
   * output. Callers rendering a message MUST branch on `newMode`, not assume
   * `cancelled === false` means "a rework prompt is about to run."
   */
  cancelled: boolean;
  /** true when cancelled specifically because max rejection attempts were reached (legacy on_reject only) */
  maxAttemptsReached: boolean;
  /**
   * true when this was the engine-level container write-back gate (Phase C). The
   * run stays resumable (never cancelled) so the resume DISCARDS the overlay and
   * completes with a note; lets the CLI/chat print "discarding" instead of the
   * on_reject-rework message.
   */
  writeBack: boolean;
  /**
   * true when this rejection resolved a #2707 step-1 new-mode gate (author
   * explicitly declared `approval.decisions:`) with structured
   * `{decision:'reject', text}` output rather than staging a legacy
   * `on_reject` rework. Only meaningful when `cancelled === false` and
   * `writeBack === false` — distinguishes "resolved, run continues per the
   * workflow's own `when:` wiring" from "a rework prompt is about to run."
   */
  newMode: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safety bound on the abandon cascade walk (guards against corrupted run trees). */
const MAX_CASCADE_RUNS = 500;

type CancelWorkflowRun = (runId: string) => Promise<{ cancelled: boolean }>;

/**
 * Cascade-cancel the `workflow:` sub-run tree under `rootId` (#2121 Phase 2 / D7).
 * A child sub-run shares the parent's conversation and runs in-process, so
 * abandoning the parent walks every DESCENDANT, not just direct children (a child
 * may itself spawn grandchildren). `cancelRun` supplies the mutation used for
 * each descendant. Best-effort — a per-run failure is logged, never thrown, so
 * the parent abandon always succeeds; the failure COUNT is returned so callers
 * can tell the user part of the tree may still be alive.
 */
async function cascadeCancelChildren(
  rootId: string,
  cancelRun: CancelWorkflowRun
): Promise<{ cancelled: number; failures: number }> {
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  let processed = 0;
  let cancelled = 0;
  let failures = 0;
  while (queue.length > 0 && processed < MAX_CASCADE_RUNS) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    processed++;
    let children: WorkflowRun[];
    try {
      children = await workflowDb.findChildRuns(parentId);
    } catch (err) {
      getLog().warn({ err, parentId }, 'operations.workflow_abandon_cascade_lookup_failed');
      failures++;
      continue;
    }
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id); // traverse deeper even under an already-terminal child
      if (child.status === 'completed' || child.status === 'cancelled') continue;
      try {
        const result = await cancelRun(child.id);
        if (result.cancelled) cancelled++;
      } catch (err) {
        getLog().warn(
          { err, childId: child.id },
          'operations.workflow_abandon_cascade_cancel_failed'
        );
        failures++;
      }
    }
  }
  // Truncation is NOT silent success: if we hit the cap with the queue non-empty,
  // an unbounded-deep/wide tree still has live descendants we never reached. Surface
  // it via the same `failures` channel (caller reports "part of the tree may still be
  // alive") AND a distinct log line, rather than returning a false all-clear.
  if (queue.length > 0) {
    getLog().warn(
      { rootId, cap: MAX_CASCADE_RUNS, unreached: queue.length },
      'operations.workflow_abandon_cascade_truncated'
    );
    failures += queue.length;
  }
  return { cancelled, failures };
}

/**
 * If `run` is a `workflow:` sub-run whose PARENT is currently paused blocked on it,
 * return the parent's run id — abandoning the child strands that parent (nothing
 * re-fires the auto-resume hook for a terminal-via-abandon child), so callers must
 * tell the user to resume (fails the node cleanly) or abandon the parent too.
 * Best-effort: lookup failures are logged and read as "no blocked parent".
 */
async function findParentBlockedOn(run: WorkflowRun): Promise<string | null> {
  if (!run.parent_run_id) return null;
  try {
    const parent = await workflowDb.getWorkflowRun(run.parent_run_id);
    // Shared invariant (isRunBlockedOnChild) — same predicate the auto-resume hook
    // uses, so the two can't drift if the child_workflow gate shape changes.
    if (parent && isRunBlockedOnChild(parent, run.id)) return parent.id;
    return null;
  } catch (err) {
    getLog().warn(
      { err, runId: run.id, parentRunId: run.parent_run_id },
      'operations.workflow_abandon_parent_lookup_failed'
    );
    return null;
  }
}

/** Reclaim a container owned by a run this process successfully cancelled. */
async function reclaimCancelledRunContainer(run: WorkflowRun): Promise<void> {
  if (
    run.metadata?.isolation !== 'container' ||
    typeof run.metadata.isolation_env_id !== 'string'
  ) {
    return;
  }
  try {
    const { reclaimContainerEnv } = await import('../services/cleanup-service');
    await reclaimContainerEnv(run.metadata.isolation_env_id);
  } catch (err) {
    getLog().warn({ err, runId: run.id }, 'operations.workflow_abandon_container_reclaim_failed');
  }
}

async function getRunOrThrow(runId: string, logEvent: string): Promise<WorkflowRun> {
  let run: WorkflowRun | null;
  try {
    run = await workflowDb.getWorkflowRun(runId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, errorType: err.constructor.name, runId }, logEvent);
    throw new Error(`Failed to look up workflow run ${runId}: ${err.message}`);
  }
  if (!run) {
    throw new Error(`Workflow run not found: ${runId}`);
  }
  return run;
}

/**
 * The five preconditions `approveWorkflow` enforces, as ONE reusable gate.
 *
 * Extracted so the CLI's read-only `--detach` precheck validates exactly what the
 * child will enforce. A partial copy is worse than none: the parent acks
 * `{ ok: true }` and the child then dies unseen in its log — precisely the failure
 * `--detach` exists to prevent, on the surface nobody is watching.
 *
 * Pure and synchronous (the caller already holds the run), so both the operation
 * and the CLI precheck can call it without a second DB round-trip.
 *
 * Returns the validated context so callers keep today's narrowing — `nodeId` is a
 * required field on ApprovalContext, so no intersection type is needed.
 */
/**
 * The `step_name` a gate resolution's `node_completed` event should be written
 * under. Ordinarily just `approval.nodeId`. On an ESCALATED body-terminal-gate
 * pause (#2707 step 3), `nodeId` holds the ENCLOSING loop_group's id instead —
 * required so the top-level DAG's resume walk finds it — and `bodyGateId`
 * carries the actual gate's own id. Namespacing the write as `<nodeId>.
 * <bodyGateId>` matches the exact `<groupId>.<bodyId>` step name #2748's
 * `outerNodeOutputs` pre-population already keys on, so the gate's own
 * resolved decision is findable again after a resume the same way any other
 * body node's output is. Every other pause kind has no `bodyGateId`, so this
 * is a no-op there.
 */
function resolvedNodeCompletedStepName(approval: ApprovalContext): string {
  return approval.bodyGateId !== undefined
    ? `${approval.nodeId}.${approval.bodyGateId}`
    : approval.nodeId;
}

export function assertApprovable(
  run: WorkflowRun,
  options?: { allowAlreadyApproved?: boolean }
): ApprovalContext {
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot approve run with status '${run.status}'. Only paused runs can be approved.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  if (!approval?.nodeId) {
    throw new Error('Workflow run is paused but missing approval context.');
  }
  if (!isRecognizedSuspendReason(approval.type)) {
    // Shares this check with rejectWorkflow's precondition gate and with
    // approveWorkflow's own exhaustive switch (#2489) so a --detach precheck
    // success can never diverge from what resolution actually does — see
    // isRecognizedSuspendReason's doc comment.
    throw new Error(
      `Run ${run.id} has an unrecognized gate type '${String(approval.type)}'. This Archon build cannot resolve it.`
    );
  }
  if (approval.type === 'child_workflow') {
    // A parent blocked on a `workflow:` sub-run has no approvable gate of its
    // own — the pause resolves automatically when the child run completes.
    // Falling through to the generic branch would stamp a node_completed for the
    // parent's workflow node with empty output (the child's real output is then
    // discarded on resume) and orphan the still-paused child. Redirect the
    // operator to the child run, where the actual gate lives.
    throw new Error(
      `Run ${run.id} is paused waiting on sub-run ${approval.childRunId ?? '<unknown>'} ` +
        `('workflow:' node '${approval.nodeId}'). Approve or reject the child run instead` +
        (approval.childRunId ? `: /workflow approve ${approval.childRunId}` : '.')
    );
  }
  if (isGateResolved(approval)) {
    // Opt-in idempotency, checked HERE rather than before the call so that every
    // gate above still runs: a resolved `child_workflow` pause must still
    // redirect to the child, and an unrecognized suspend reason must still
    // refuse, regardless of who is asking. The caller distinguishes this return
    // from a fresh one with its own isGateResolved check.
    if (options?.allowAlreadyApproved && approval.resolved === 'approved') {
      return approval;
    }
    // Fast-path friendly error for the common (sequential) case. The run stays
    // 'paused' after a resolution, so the status check alone no longer blocks a
    // second approve. This in-memory read can still race a concurrent approve —
    // the resolveApprovalGate CAS is the real arbiter; a second approve that
    // slips past this read loses the atomic UPDATE and throws the same way.
    throw new Error(
      `Workflow run ${run.id} was already ${String(approval.resolved)} and is awaiting resume.`
    );
  }
  return approval;
}

/**
 * The FOUR preconditions `rejectWorkflow` enforces. Deliberately NOT the same
 * gate as `assertApprovable`: reject has no `nodeId` requirement — it falls back
 * to `approval?.nodeId ?? 'unknown'` when writing its audit event, so a run whose
 * approval metadata fails `isApprovalContext` (missing/malformed `nodeId`/`message`)
 * is still legitimately rejectable. A well-formed context with an unrecognized
 * `type` is NOT one of those cases — it throws via the suspend-reason check below,
 * same as approve. Merging the two gates would either break reject or over-permit
 * approve.
 */
export function assertRejectable(run: WorkflowRun): ApprovalContext | undefined {
  if (run.status !== 'paused') {
    throw new Error(
      `Cannot reject run with status '${run.status}'. Only paused runs can be rejected.`
    );
  }
  const rawApproval = run.metadata.approval;
  const approval: ApprovalContext | undefined = isApprovalContext(rawApproval)
    ? rawApproval
    : undefined;
  if (!isRecognizedSuspendReason(approval?.type)) {
    // Shares this check with assertApprovable and with rejectWorkflow's own
    // exhaustive switch (#2489) — see isRecognizedSuspendReason's doc comment.
    throw new Error(
      `Run ${run.id} has an unrecognized gate type '${String(approval?.type)}'. This Archon build cannot resolve it.`
    );
  }
  if (approval?.type === 'child_workflow') {
    // Same redirect as assertApprovable: the parent's pause is not a rejectable
    // gate — cancelling the parent here would silently orphan the still-paused
    // child run. Reject the child (its own gate) or abandon the parent (which
    // cascade-cancels the subtree) instead.
    throw new Error(
      `Run ${run.id} is paused waiting on sub-run ${approval.childRunId ?? '<unknown>'} ` +
        `('workflow:' node '${approval.nodeId}'). Reject the child run instead` +
        (approval.childRunId ? `: /workflow reject ${approval.childRunId}` : '.') +
        ' To discard the whole tree, abandon this run.'
    );
  }
  if (approval && isGateResolved(approval)) {
    throw new Error(
      `Workflow run ${run.id} was already ${String(approval.resolved)} and is awaiting resume.`
    );
  }
  return approval;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * List all running and paused workflow runs.
 */
export async function getWorkflowStatus(): Promise<WorkflowStatusData> {
  const runs = await workflowDb.listWorkflowRuns({
    status: ['running', 'paused'],
    limit: 50,
  });
  return { runs };
}

/**
 * Validate that a run can be resumed and return it.
 * Does NOT execute the workflow — callers decide whether to run.
 */
export async function resumeWorkflow(runId: string): Promise<WorkflowRun> {
  const run = await getRunOrThrow(runId, 'operations.workflow_resume_lookup_failed');
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new Error(
      `Cannot resume run with status '${run.status}'. Only failed or paused runs can be resumed.`
    );
  }
  return run;
}

export interface AbandonWorkflowResult {
  run: WorkflowRun;
  /** Whether this call won the state transition to `cancelled`. */
  cancelled: boolean;
  /**
   * Number of sub-run descendants the cascade failed to cancel (best-effort walk;
   * failures are also logged). Non-zero means part of the tree may still be alive.
   */
  cascadeFailures: number;
  /**
   * When the abandoned run was itself a `workflow:` sub-run and its parent is
   * paused blocked on it: the parent's run id. Nothing auto-resumes that parent
   * (the hook only fires from inside the child's own execution) — the user should
   * resume it (fails the node cleanly) or abandon it too.
   */
  blockedParentRunId: string | null;
}

interface AbandonAttemptResult extends AbandonWorkflowResult {
  cancelledDescendants: number;
}

async function cancelRunAndCleanup(
  run: WorkflowRun,
  cancelRun: CancelWorkflowRun
): Promise<AbandonAttemptResult> {
  let cancelled: boolean;
  try {
    ({ cancelled } = await cancelRun(run.id));
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, runId: run.id },
      'operations.workflow_abandon_failed'
    );
    throw new Error(`Failed to abandon workflow run ${run.id}: ${err.message}`);
  }

  // The same cancellation policy applies to descendants. This keeps `/reset`'s
  // resumable-only ownership boundary intact through the complete run tree.
  let cascadeFailures = 0;
  let cancelledDescendants = 0;
  if (cancelled) {
    ({ cancelled: cancelledDescendants, failures: cascadeFailures } = await cascadeCancelChildren(
      run.id,
      cancelRun
    ));
  }
  const blockedParentRunId = cancelled ? await findParentBlockedOn(run) : null;

  // Reclaim only when our cancel won the CAS. A miss means another lifecycle
  // owner now controls the run and its environment.
  if (cancelled) await reclaimCancelledRunContainer(run);
  return { run, cancelled, cancelledDescendants, cascadeFailures, blockedParentRunId };
}

/**
 * Abandon a workflow run (marks it as cancelled).
 *
 * Running, paused, AND failed runs can be abandoned. A `failed` run is terminal
 * per TERMINAL_WORKFLOW_STATUSES but remains resumable, so the user must be able
 * to discard it — hence the inline check here intentionally diverges from that
 * constant and blocks only the two non-resumable terminal states.
 */
export async function abandonWorkflow(runId: string): Promise<AbandonWorkflowResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_abandon_lookup_failed');
  if (run.status === 'completed' || run.status === 'cancelled') {
    throw new Error(
      `Cannot abandon run with status '${run.status}'. Only running, paused, or failed runs can be abandoned.`
    );
  }
  const result = await cancelRunAndCleanup(run, workflowDb.cancelWorkflowRun);
  return {
    run: result.run,
    cancelled: result.cancelled,
    cascadeFailures: result.cascadeFailures,
    blockedParentRunId: result.blockedParentRunId,
  };
}

export interface AbandonConversationRunsResult {
  /** Runs this call actually took to 'cancelled'. */
  abandoned: number;
  /**
   * First cancelled run that left a parent outside the conversation-scoped
   * mutation paused blocked-on-child (stranded parent id), or null. The user
   * must resume or abandon that parent to unstick the tree.
   */
  blockedParentRunId: string | null;
}

/**
 * Abandon every RESUMABLE run belonging to a conversation.
 *
 * Backs `/reset`: with these gone, the resume lookups find nothing, so the next
 * message starts fresh instead of continuing a stale run.
 *
 * The DB owns selection and cancellation in one transaction. This matters when
 * selected paused roots overlap through an unselected running intermediate:
 * traversing each tree independently can visit the same descendant twice and
 * retain a transient first failure after the second visit succeeds. The bulk
 * mutation returns exactly the rows it cancelled, so counts and final parent
 * diagnostics come from one operation-wide outcome. Explicit `/workflow
 * abandon` keeps its broader running/paused/failed cascading policy.
 */
export async function abandonResumableRunsForConversation(
  conversationId: string
): Promise<AbandonConversationRunsResult> {
  const runs = await workflowDb.cancelResumableRunsForConversation(conversationId);
  let blockedParentRunId: string | null = null;
  for (const run of runs) {
    await reclaimCancelledRunContainer(run);
    const blocked = await findParentBlockedOn(run);
    if (blockedParentRunId === null) blockedParentRunId = blocked;
  }
  if (runs.length > 0) {
    getLog().info(
      { conversationId, abandoned: runs.length, blockedParentRunId },
      'operations.workflow_abandon_for_conversation_completed'
    );
  }
  return {
    abandoned: runs.length,
    blockedParentRunId,
  };
}

export interface ApproveWorkflowOptions {
  /**
   * Return the resume context instead of throwing when the gate is already
   * resolved as APPROVED.
   *
   * A gate approved from the dashboard is recorded but not auto-resumed when the
   * run has no parent conversation — which is every CLI-created run
   * (`tryAutoResumeAfterGate` returns early). The run is then paused-and-approved,
   * and the natural next command, `archon workflow approve`, throws
   * "already approved and is awaiting resume" — so approving again cannot work and
   * the only way forward is `archon workflow resume`, which the error does not name.
   *
   * Callers whose very next step is to resume (the CLI) can opt in: the user's
   * intent is unambiguous and the gate already carries the decision. Rejection is
   * deliberately NOT covered — re-running a reject would re-run its on_reject
   * prompt, which is a side effect, not an idempotent no-op.
   *
   * Off by default, so HTTP and chat callers keep the strict double-resolution error.
   */
  allowAlreadyApproved?: boolean;
}

/**
 * Approve a paused workflow run.
 *
 * Handles both interactive_loop and standard approval gate paths.
 * The run STAYS 'paused' — the resolution is recorded on the approval context
 * (`metadata.approval.resolved`, #2075) and the resume machinery already picks
 * up paused runs (resumableStatusClause / findResumableRunByParentConversation).
 * Does NOT auto-resume — callers decide whether to execute.
 */
export async function approveWorkflow(
  runId: string,
  comment?: string,
  options?: ApproveWorkflowOptions
): Promise<ApprovalOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_approve_lookup_failed');
  const approval = assertApprovable(run, {
    allowAlreadyApproved: options?.allowAlreadyApproved === true,
  });
  if (isGateResolved(approval)) {
    // Opt-in idempotency: the gate already says approved, so hand back the same
    // resume context a fresh approval would have produced. No CAS, no second
    // audit event, no telemetry — nothing is being resolved here, only read.
    // Only reachable when the caller opted in; assertApprovable throws otherwise.
    return {
      alreadyApproved: true,
      workflowName: run.workflow_name,
      workingPath: run.working_path,
      userMessage: run.user_message,
      codebaseId: run.codebase_id,
      conversationId: run.conversation_id,
      type: approval.type === 'interactive_loop' ? 'interactive_loop' : 'approval_gate',
    };
  }

  // Whitespace-only comments count as absent (mirrors feedbackProvided below):
  // HTTP/CLI/chat pass the raw comment through since #2074, so '   ' would
  // otherwise be recorded verbatim where the documented default is 'Approved'.
  const approvalComment = comment !== undefined && comment.trim().length > 0 ? comment : 'Approved';
  const isInteractiveLoop = approval.type === 'interactive_loop';

  // Build the resolution metadata AND the audit events for this gate type.
  // IMPORTANT: metadata is MERGED (not replaced) and the approval context is
  // rewritten whole (spread + resolved) so it survives intact for the resumed
  // executor's startIteration detection. Both are handed to the CAS below, which
  // stamps the metadata and writes the events in ONE transaction — the atomic
  // double-resolution guard (#2113) and the atomic audit trail (#2146).
  //
  // Exhaustively switched on the suspend reason (#2489) so a future reason value
  // fails loudly here instead of silently taking the generic 'approval' shape
  // below. `assertApprovable` (above) already redirects `child_workflow` before
  // this point — its arm here is an unreachable fail-loud backstop, not live code.
  let metadataPayload: Record<string, unknown>;
  let events: workflowDb.GateResolutionEvent[];
  switch (approval.type) {
    case 'writeback': {
      // Engine-level container write-back gate (Phase C): record the approval so the
      // resumed executor applies the overlay diff to the live root. The gate discriminates
      // on the gate's OWN `metadata.approval.resolved` (set here) — NOT the run-wide
      // `approval_response`, which is kept only for backward-compat/telemetry (H1). NO
      // node_completed event — there is no DAG node behind this gate (`nodeId` is synthetic).
      metadataPayload = {
        approval: { ...approval, resolved: 'approved' },
        approval_response: 'approved',
      };
      events = [
        {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: { decision: 'approved', comment: approvalComment, gate: 'writeback' },
        },
      ];
      break;
    }
    case 'interactive_loop': {
      // Finalize-vs-iterate discriminator (#2074): derived from the RAW comment,
      // not approvalComment (which defaults to 'Approved') — a bare approve on a
      // signal-bearing gate finalizes at resume; real feedback runs another iteration.
      const feedbackProvided = comment !== undefined && comment.trim().length > 0;
      // loop_user_input keeps the 'Approved' default so the iterate path (non-signaled
      // gates) still feeds the AI an approval token via $LOOP_USER_INPUT. Typed via
      // LoopGateRunMetadata so the key spellings match the executor's resume-time
      // read sites (a typo here is a compile error).
      const gateRunMetadata: LoopGateRunMetadata = {
        loop_user_input: approvalComment,
        loop_feedback_given: feedbackProvided,
      };
      metadataPayload = { approval: { ...approval, resolved: 'approved' }, ...gateRunMetadata };
      // Interactive loop gate — user input already stored in metadata for the next
      // iteration. Note: node_completed is NOT written here. The executor writes it
      // when the AI emits the completion signal (meaning the user actually approved)
      // — or, for a signal-bearing gate approved without feedback, at resume time
      // from the persisted signaledOutput (#2074). Writing it here would cause the
      // resume to skip the loop node entirely.
      events = [
        {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: { decision: 'approved', comment: approvalComment, iteration: approval.iteration },
        },
      ];
      break;
    }
    case 'approval':
    case undefined: {
      metadataPayload = {
        approval: { ...approval, resolved: 'approved' },
        approval_response: 'approved',
        rejection_reason: '',
        rejection_count: 0,
      };
      // New-mode resolution is opt-in: only a gate whose author explicitly
      // wrote `approval.decisions:` (decisionsAuthored) — never merely "no
      // on_reject" — gets structured output. No workflow authored before
      // #2707 step 1 can have written `decisions:`, so every already-authored
      // gate (bare, or `capture_response`-only) keeps its exact pre-PR plain-
      // text/empty output regardless of on_reject. `text` is the raw comment
      // (possibly empty), not `approvalComment`'s display default.
      const isNewMode = approval.onRejectPrompt == null && approval.decisionsAuthored === true;
      const nodeOutput = isNewMode
        ? JSON.stringify({ decision: 'approve', text: comment ?? '' })
        : approval.captureResponse === true
          ? approvalComment
          : '';
      events = [
        {
          event_type: 'node_completed',
          step_name: resolvedNodeCompletedStepName(approval),
          data: {
            node_output: nodeOutput,
            approval_decision: 'approved',
            ...(isNewMode
              ? { structured_output: { decision: 'approve', text: comment ?? '' } }
              : {}),
          },
        },
        {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: { decision: 'approved', comment: approvalComment },
        },
      ];
      break;
    }
    case 'child_workflow':
      // Unreachable: assertApprovable already redirects a child_workflow gate to the
      // child run before this point. Fail loud rather than silently falling through
      // to the generic 'approval' shape above if that guard is ever bypassed.
      throw new Error(
        `approveWorkflow: unexpected child_workflow gate reached resolution for run ${runId}`
      );
    default: {
      const unreachable: never = approval.type;
      throw new Error(`approveWorkflow: unhandled gate type '${String(unreachable)}'`);
    }
  }

  // Compare-and-swap: stamp the resolution AND write the audit events ONLY while
  // the gate is still open, all in one transaction. This atomic UPDATE — not the
  // isGateResolved read above — is the real arbiter, so a concurrent second
  // approve loses here (resolved=false) and throws BEFORE any events/telemetry
  // land, eliminating the duplicates (#2113); folding the events into the same
  // transaction means a failed event write rolls the resolution back so a retry
  // can win the still-open gate (#2146). The run stays 'paused'; resume is
  // guarded independently by resumeWorkflowRun's CAS.
  const { resolved: won } = await workflowDb.resolveApprovalGate(runId, metadataPayload, events);
  if (!won) {
    throw new Error(`Workflow run ${runId} was already resolved and is awaiting resume.`);
  }

  // Won the CAS — resolution + audit events already committed atomically.
  // Anonymous telemetry: binary resolution only — no ids/comments/names.
  captureApprovalResolved({ resolution: 'approved' });
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    type: isInteractiveLoop ? 'interactive_loop' : 'approval_gate',
  };
}

/**
 * Reject a paused workflow run.
 *
 * If `onRejectPrompt` is set and under max attempts, the run stays 'paused'
 * with the rejection staged on the approval context (`resolved: 'rejected'`,
 * #2075) — the resume machinery picks it up and runs the on_reject rework.
 * Otherwise, cancels the run.
 */
export async function rejectWorkflow(
  runId: string,
  reason?: string
): Promise<RejectionOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_reject_lookup_failed');
  const approval = assertRejectable(run);

  // Exhaustively switched on the suspend reason (#2489) so a future reason value
  // fails loudly here instead of silently taking the generic rework/cancel path
  // below. `assertRejectable` (above) already redirects `child_workflow` before
  // this point — its arm here is an unreachable fail-loud backstop, not live code.
  // Guarding on `approval !== undefined` first (rather than switching on
  // `approval?.type`) narrows `approval` for free inside `case 'writeback'` — an
  // undefined approval falls through to the generic path below exactly as
  // `case undefined` does for a defined approval with no `type`.
  if (approval !== undefined) {
    switch (approval.type) {
      case 'writeback': {
        // Engine-level container write-back gate (Phase C): reject means DISCARD the
        // overlay, but the RUN itself succeeded — keep it resumable (never cancel) so
        // the resumed executor discards + completes with a note. Distinct from a DAG
        // approval reject (which cancels or stages an on_reject rework).
        const rejectionEvent: workflowDb.GateResolutionEvent = {
          event_type: 'approval_received',
          step_name: approval.nodeId,
          data: { decision: 'rejected', gate: 'writeback' },
        };
        const { resolved: won } = await workflowDb.resolveApprovalGate(
          runId,
          { approval: { ...approval, resolved: 'rejected' }, approval_response: 'rejected' },
          [rejectionEvent]
        );
        if (!won) {
          throw new Error(`Workflow run ${runId} was already resolved and is awaiting resume.`);
        }
        captureApprovalResolved({ resolution: 'rejected' });
        return {
          workflowName: run.workflow_name,
          workingPath: run.working_path,
          userMessage: run.user_message,
          codebaseId: run.codebase_id,
          conversationId: run.conversation_id,
          cancelled: false,
          maxAttemptsReached: false,
          writeBack: true,
          newMode: false,
        };
      }
      case 'child_workflow':
        // Unreachable: assertRejectable already redirects a child_workflow gate to
        // the child run before this point. Fail loud rather than silently falling
        // through to the generic rework/cancel path below if that guard is ever
        // bypassed.
        throw new Error(
          `rejectWorkflow: unexpected child_workflow gate reached resolution for run ${runId}`
        );
      case 'approval':
      case 'interactive_loop':
      case undefined:
        break;
      default: {
        const unreachable: never = approval.type;
        throw new Error(`rejectWorkflow: unhandled gate type '${String(unreachable)}'`);
      }
    }
  }

  const rejectReason = reason ?? 'Rejected';
  const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
  const maxAttempts = approval?.onRejectMaxAttempts ?? 3;
  // `!= null` (not `!== undefined`): "no on_reject" reaches this read in two stored
  // shapes. Absent — every pause since #2673 (the approval object is replaced
  // wholesale, so an unset field is simply not there), and every SQLite pause before
  // it too, since json_patch is RFC 7396 and DELETED the key the old explicit-null
  // reset patched. An explicit JSON null — Postgres runs paused before #2673, where
  // `||` stored the null as written. Keep the loose check: `null !== undefined` is
  // true, so tightening would read such a run as HAVING an on_reject and stage a
  // rework the workflow never declared — and the resume path takes its prompt from
  // `node.approval.on_reject` (dag-executor), which is exactly what is missing.
  const onRejectConfigured = approval?.onRejectPrompt != null;
  const maxAttemptsReached = onRejectConfigured && currentCount + 1 >= maxAttempts;
  // The legacy on_reject rework is staged (run stays 'paused') only when a
  // prompt is set AND we're under the attempt cap.
  const willStageRework = onRejectConfigured && !maxAttemptsReached;
  // New mechanism (#2707 step 1): resolves immediately with structured
  // {decision,text} output — no staging, no attempt counter, the run just
  // stays 'paused' awaiting resume like any other completed node (see #2714:
  // this is why hydrateResumableRun needs no special-casing for it). Opt-in
  // ONLY (mirrors approveWorkflow's isNewMode — see its comment): requires
  // the author to have explicitly written `approval.decisions:`, not merely
  // "no on_reject", so an already-authored gate's reject keeps cancelling the
  // run exactly as before this PR. Within an explicitly-decisions-authored
  // gate, one declaring no 'reject' id (an approve-only gate) still falls
  // through to the cancel path below — that vocabulary gap is deliberate.
  const decisionsAuthored = approval?.decisionsAuthored === true;
  const hasRejectDecision = approval?.decisions?.some(d => d.id === 'reject') ?? false;
  const willResolveNewMode = !onRejectConfigured && decisionsAuthored && hasRejectDecision;

  // The audit event is identical for every reject outcome; the CAS writes it
  // in the SAME transaction as the resolution (#2146).
  const rejectionEvent: workflowDb.GateResolutionEvent = {
    event_type: 'approval_received',
    step_name: approval?.nodeId ?? 'unknown',
    data: { decision: 'rejected', reason: rejectReason },
  };

  // Compare-and-swap resolution guard — a concurrent second reject loses here
  // (resolved=false) and throws BEFORE any events, so the gate events can't
  // duplicate (#2113). Stage-rework and new-mode resolution both keep the run
  // 'paused' (the approval context is rewritten whole so a resumed executor
  // still sees nodeId/onRejectPrompt/decisions; `...approval` tolerates a
  // malformed context exactly as the 'unknown' nodeId fallback below). The
  // terminal cancel outcome flips paused→'cancelled' in a SINGLE atomic
  // UPDATE, so there is never a resolved-but-not-cancelled state that a failed
  // second write could strand (which a reject retry could not self-heal past
  // the guard above). Every path's audit event(s) ride the same transaction,
  // so a failed event write rolls the resolution/cancellation back rather than
  // losing the audit trail (#2146).
  let won: boolean;
  if (willResolveNewMode && approval) {
    const structuredOutput = { decision: 'reject', text: reason ?? '' };
    const nodeCompletedEvent: workflowDb.GateResolutionEvent = {
      event_type: 'node_completed',
      step_name: resolvedNodeCompletedStepName(approval),
      data: {
        node_output: JSON.stringify(structuredOutput),
        approval_decision: 'rejected',
        structured_output: structuredOutput,
      },
    };
    ({ resolved: won } = await workflowDb.resolveApprovalGate(
      runId,
      { approval: { ...approval, resolved: 'rejected' } },
      [nodeCompletedEvent, rejectionEvent]
    ));
  } else if (willStageRework) {
    ({ resolved: won } = await workflowDb.resolveApprovalGate(
      runId,
      {
        approval: { ...approval, resolved: 'rejected' },
        rejection_reason: rejectReason,
        rejection_count: currentCount + 1,
      },
      [rejectionEvent]
    ));
  } else {
    ({ resolved: won } = await workflowDb.resolveAndCancelApprovalGate(runId, [rejectionEvent]));
  }
  if (!won) {
    throw new Error(`Workflow run ${runId} was already resolved and is awaiting resume.`);
  }

  // Won the CAS — resolution/status + audit event already committed atomically.
  // Anonymous telemetry: binary resolution only — no ids/reasons/names.
  captureApprovalResolved({ resolution: 'rejected' });

  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    cancelled: !willStageRework && !willResolveNewMode,
    maxAttemptsReached,
    writeBack: false,
    newMode: willResolveNewMode,
  };
}

/**
 * Validate that `decision` is legal for the gate `run` is paused at, WITHOUT
 * mutating anything (mirrors `assertApprovable`'s read-only-precheck role for
 * CLI `--detach`). `approve`/`reject` are always legal (delegated to the
 * existing `approveWorkflow`/`rejectWorkflow` machinery by `respondToWorkflow`
 * — this function is not consulted for those two ids). Any OTHER decision is
 * legal only for a plain gate node (`approval`/`undefined` suspend type) whose
 * author explicitly declared `approval.decisions:` (`decisionsAuthored`) —
 * `writeback`/`interactive_loop`/`child_workflow` pauses have no author-
 * declared vocabulary and accept only approve/reject; a legacy gate (no
 * `decisions:` authored) also only ever has the synthesized approve/reject
 * pair (#2707 step 2).
 */
export function assertRespondable(run: WorkflowRun, decision: string): ApprovalContext {
  const approval = assertApprovable(run);
  if (approval.type !== 'approval' && approval.type !== undefined) {
    throw new Error(
      `Run ${run.id}'s gate ('${approval.type}') only accepts 'approve' or 'reject' — ` +
        `'${decision}' is not a valid response here.`
    );
  }
  if (approval.decisionsAuthored !== true) {
    throw new Error(
      `Run ${run.id}'s gate only accepts 'approve' or 'reject' — '${decision}' is not one of its ` +
        'declared decisions. Declare `approval.decisions:` on the gate node to author a broader vocabulary.'
    );
  }
  const declaredIds = (approval.decisions ?? []).map(d => d.id);
  if (!declaredIds.includes(decision)) {
    throw new Error(
      `Run ${run.id}'s gate does not declare decision '${decision}'. Declared decisions: ` +
        `${declaredIds.join(', ')}.`
    );
  }
  return approval;
}

/**
 * Resolve a paused gate with an author-declared decision beyond approve/reject
 * (#2707 step 2 — the general `workflow respond <id> <decision> [text]` verb).
 * `approve`/`reject` are NOT handled here — `respondToWorkflow` delegates those
 * to the existing `approveWorkflow`/`rejectWorkflow` functions unchanged, so
 * every gate shape that existed before this PR keeps its exact prior behavior
 * (legacy `on_reject` rework/cancel, `capture_response`, interactive_loop,
 * writeback). This function only ever resolves a new-mode plain gate node
 * (`decisionsAuthored: true`) immediately with structured `{decision, text}`
 * output — the same shape `approveWorkflow`'s new-mode branch writes, just
 * with a caller-supplied `decision` instead of the literal `'approve'`.
 */
async function respondToWorkflowWithDeclaredDecision(
  runId: string,
  decision: string,
  text?: string
): Promise<ApprovalOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_respond_lookup_failed');
  const approval = assertRespondable(run, decision);

  const structuredOutput = { decision, text: text ?? '' };
  const events: workflowDb.GateResolutionEvent[] = [
    {
      event_type: 'node_completed',
      step_name: resolvedNodeCompletedStepName(approval),
      data: {
        node_output: JSON.stringify(structuredOutput),
        approval_decision: decision,
        structured_output: structuredOutput,
      },
    },
    {
      event_type: 'approval_received',
      step_name: approval.nodeId,
      data: { decision, comment: text !== undefined && text.trim().length > 0 ? text : decision },
    },
  ];
  const { resolved: won } = await workflowDb.resolveApprovalGate(
    runId,
    { approval: { ...approval, resolved: 'approved' }, approval_response: decision },
    events
  );
  if (!won) {
    throw new Error(`Workflow run ${runId} was already resolved and is awaiting resume.`);
  }

  // Anonymous telemetry: binary resolution only — no ids/comments/names. A
  // custom decision still records as 'approved' since it resolved the gate
  // (as opposed to leaving it open) — mirrors the existing 'approved'/'rejected'
  // vocabulary rather than adding a third telemetry bucket for one caller.
  captureApprovalResolved({ resolution: 'approved' });
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    type: 'approval_gate',
  };
}

/**
 * Resolve a paused gate with any author-declared decision (#2707 step 2's
 * general drive verb — `workflow respond <run-id> <decision> [text]`).
 * `approve`/`reject` are sugar: they delegate to the existing
 * `approveWorkflow`/`rejectWorkflow` functions UNCHANGED, so every gate shape
 * that existed before this PR (legacy `on_reject`, `capture_response`,
 * `interactive_loop`, `writeback`, and step-1's new-mode 2-decision gates)
 * keeps its exact prior behavior byte-for-byte. Any other decision resolves
 * through `respondToWorkflowWithDeclaredDecision`, which only accepts a
 * decision the gate actually declared.
 */
export async function respondToWorkflow(
  runId: string,
  decision: string,
  text?: string
): Promise<ApprovalOperationResult | RejectionOperationResult> {
  if (decision === 'approve') return approveWorkflow(runId, text);
  if (decision === 'reject') return rejectWorkflow(runId, text);
  return respondToWorkflowWithDeclaredDecision(runId, decision, text);
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter: workflow_name is required; scope_key narrows to one conversation (or
 * other scope), node_id narrows to one node within that scope. Omitting both
 * scope_key and node_id deletes every row for the workflow across all scopes.
 *
 * Returns the row count deleted.
 */
export async function resetWorkflowNodeSessions(filter: {
  workflow_name: string;
  scope_key?: string;
  node_id?: string;
}): Promise<{ deleted: number }> {
  try {
    return await workflowNodeSessionDb.deleteWorkflowNodeSessions(filter);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, ...filter },
      'operations.workflow_reset_node_sessions_failed'
    );
    throw new Error(`Failed to reset workflow node sessions: ${err.message}`);
  }
}
