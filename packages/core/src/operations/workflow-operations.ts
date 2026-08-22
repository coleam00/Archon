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

/**
 * Cascade-cancel the `workflow:` sub-run tree under `rootId` (#2121 Phase 2 / D7).
 * A child sub-run shares the parent's conversation and runs in-process, so
 * abandoning the parent must flip every non-terminal DESCENDANT to cancelled — not
 * just direct children (a child may itself spawn grandchildren). Cooperative: each
 * cancelled run's executor between-layer status poll then aborts it (~10s; there is
 * no hard subprocess kill in slice 1). Best-effort — a per-run failure is logged,
 * never thrown, so the parent abandon always succeeds; the failure COUNT is
 * returned so callers can tell the user part of the tree may still be alive.
 */
async function cascadeCancelChildren(rootId: string): Promise<{ failures: number }> {
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  let processed = 0;
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
        await workflowDb.cancelWorkflowRun(child.id);
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
  return { failures };
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
export function assertApprovable(run: WorkflowRun): ApprovalContext {
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
  let cancelled: boolean;
  try {
    ({ cancelled } = await workflowDb.cancelWorkflowRun(runId));
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, runId },
      'operations.workflow_abandon_failed'
    );
    throw new Error(`Failed to abandon workflow run ${runId}: ${err.message}`);
  }
  // Cascade-cancel the sub-run tree — ONLY when OUR cancel won the CAS (same guard as
  // the container reclaim below): a false `cancelled` means a concurrent transition
  // already took the run terminal, so its children are not ours to cancel.
  let cascadeFailures = 0;
  if (cancelled) {
    ({ failures: cascadeFailures } = await cascadeCancelChildren(runId));
  }
  // Abandoning a CHILD strands a parent paused on it (the auto-resume hook only
  // fires from inside the child's own execution) — detect and surface that so the
  // caller can point the user at the blocked parent.
  const blockedParentRunId = cancelled ? await findParentBlockedOn(run) : null;
  // M2 — reclaim a container run's container + upper volume immediately, in the SHARED
  // op so EVERY abandon surface (CLI, web API, chat, manage_run, Slack-cancel) frees the
  // resources now rather than waiting for the scheduled reaper. Best-effort: a reclaim
  // failure is logged (the reaper retries) — never thrown. Runs wherever the op executes
  // (CLI/server), which is where docker is reachable.
  //
  // ONLY when OUR cancel actually won the CAS (`cancelled === true`). cancelWorkflowRun
  // is `UPDATE … WHERE status NOT IN (completed, cancelled)`, so a false result means a
  // concurrent transition (a resume or completion) already took the run terminal and now
  // OWNS the environment — reclaiming here would pull the container out from under it.
  if (
    cancelled &&
    run.metadata?.isolation === 'container' &&
    typeof run.metadata.isolation_env_id === 'string'
  ) {
    try {
      // Lazy import: `cleanup-service` pulls the docker/isolation/git chain, which the
      // operations module (and its lightweight tests) otherwise never need — load it
      // only when a container run is actually abandoned.
      const { reclaimContainerEnv } = await import('../services/cleanup-service');
      await reclaimContainerEnv(run.metadata.isolation_env_id);
    } catch (err) {
      getLog().warn({ err, runId }, 'operations.workflow_abandon_container_reclaim_failed');
    }
  }
  return { run, cascadeFailures, blockedParentRunId };
}

export interface AbandonConversationRunsResult {
  /** Runs this call actually took to 'cancelled'. */
  abandoned: number;
  /**
   * Runs that could not be abandoned (already terminal by the time we got to
   * them, or a DB failure). Non-zero means part of the set may still be alive.
   */
  failures: number;
  /**
   * Sum of `cascadeFailures` returned by every per-run `abandonWorkflow` call:
   * descendants the cascade failed to cancel (capped at MAX_CASCADE_RUNS, or
   * hit a per-child throw). Non-zero means part of the abandoned trees may
   * still be alive — surface a warning to the user.
   */
  cascadeFailures: number;
  /**
   * First abandoned run that left a parent paused blocked-on-child (stranded
   * parent id), or null. The user must resume or abandon that parent to
   * unstick the tree — nothing auto-resumes it.
   */
  blockedParentRunId: string | null;
}

/**
 * Abandon every RESUMABLE run belonging to a conversation.
 *
 * Backs `/reset`: with these gone, the resume lookups find nothing, so the next
 * message starts fresh instead of continuing a stale run.
 *
 * Routes through `abandonWorkflow` per run rather than issuing one bulk UPDATE.
 * That op is where abandon semantics live for EVERY surface (CLI, web API, chat,
 * manage_run, Slack-cancel) — the CAS guard, the sub-run cascade, and the
 * immediate container + upper-volume reclaim. A bulk UPDATE here would be a
 * sixth abandon surface that silently skips all three.
 *
 * Only 'paused'/'failed' rows are selected (see
 * findResumableRunIdsForConversation): live `pending`/`running` work is never
 * touched, since it may belong to a different process altogether. The returned
 * `cascadeFailures`/`blockedParentRunId` mirror what `abandonWorkflow` itself
 * surfaces on every other abandon surface — `/reset` must report them too,
 * otherwise a partial-cascade abandonment can be read as "everything starts
 * fresh" while part of the run tree is still alive.
 *
 * Best-effort per run: a row can go terminal between the SELECT and the abandon,
 * which makes `abandonWorkflow` throw. That is counted, not propagated — one
 * racing run must not abort the whole reset. That said, the SELECT itself
 * already filters to `paused`/`failed`, so the only rows that can race to a
 * terminal state are the ones a concurrent cascade from an earlier loop
 * iteration already cancelled — pre-checking the row here keeps those from
 * being mis-counted as abandon failures (#2731 R2).
 */
export async function abandonResumableRunsForConversation(
  conversationId: string
): Promise<AbandonConversationRunsResult> {
  const runIds = await workflowDb.findResumableRunIdsForConversation(conversationId);
  let abandoned = 0;
  let failures = 0;
  let cascadeFailures = 0;
  let blockedParentRunId: string | null = null;
  for (const runId of runIds) {
    // Skip rows a previous loop iteration's cascade already took terminal
    // (#2731 R2): without this precheck, abandonWorkflow throws "Cannot abandon
    // run with status 'cancelled'" and the op reports a false partial-failure
    // for what was actually a successful cascade. Same predicate the cascade
    // itself uses to decide which children to cancel.
    let current: WorkflowRun | null;
    try {
      current = await workflowDb.getWorkflowRun(runId);
    } catch (err) {
      getLog().warn(
        { err, runId, conversationId },
        'operations.workflow_abandon_for_conversation_lookup_failed'
      );
      failures++;
      continue;
    }
    if (!current) {
      // SELECT said the row exists but a concurrent deleter just removed it.
      // Treat as already-handled, not a failure.
      continue;
    }
    if (current.status === 'completed' || current.status === 'cancelled') {
      continue;
    }
    try {
      const { cascadeFailures: runCascade, blockedParentRunId: blocked } =
        await abandonWorkflow(runId);
      abandoned++;
      cascadeFailures += runCascade;
      if (blockedParentRunId === null) blockedParentRunId = blocked;
    } catch (err) {
      getLog().warn(
        { err, runId, conversationId },
        'operations.workflow_abandon_for_conversation_failed'
      );
      failures++;
    }
  }
  if (abandoned > 0 || failures > 0) {
    getLog().info(
      { conversationId, abandoned, failures, cascadeFailures, blockedParentRunId },
      'operations.workflow_abandon_for_conversation_completed'
    );
  }
  return { abandoned, failures, cascadeFailures, blockedParentRunId };
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
  comment?: string
): Promise<ApprovalOperationResult> {
  const run = await getRunOrThrow(runId, 'operations.workflow_approve_lookup_failed');
  const approval = assertApprovable(run);

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
          step_name: approval.nodeId,
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
      step_name: approval.nodeId,
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
