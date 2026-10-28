import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import { recordSurfaceSchema, type RecordSurface } from '@archon/workflows/schemas/record-surface';
import {
  isApprovalContext,
  isGateResolved,
  legacyOccurrenceStep,
  pausedAttentionWait,
  runAttention,
  workflowWaitStepName,
} from '@archon/workflows/schemas/workflow-run';
import type {
  ApprovalContext,
  ExpectedApprovalGate,
  RunAttention,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { getLog, type OperationContext } from './context';

/**
 * Where an answer came from, recorded with it for audit. `via` names the surface the
 * answer arrived through: `cli`, `api`, `manage_run`, or a chat platform's id. Nothing
 * routes, restricts or branches on it, and it never names who answered. `expectedGate`
 * refuses an answer meant for an earlier pause of the same run.
 */
export interface GateAnswerOrigin {
  via: RecordSurface;
  expectedGate?: ExpectedApprovalGate;
}

/**
 * A parent blocked on `workflow:` sub-runs has no gate of its own — the decision lives
 * on each child: one for a 1:1 node, every unfinished child for a `fan_out:` node. Typed
 * rather than a prose string because the redirect command is spelled differently on
 * every surface: `message` names the child runs but never a command, and `messageFor`
 * adds the commands the rendering surface actually accepts.
 */
export class ChildRunRedirectError extends Error {
  constructor(
    readonly parentRunId: string,
    readonly childRunIds: readonly string[],
    readonly nodeId: string,
    readonly action: 'approve' | 'reject'
  ) {
    const one = childRunIds.length === 1;
    super(
      (one
        ? `Run ${parentRunId} is paused waiting on sub-run ${childRunIds[0]} ` +
          `('workflow:' node '${nodeId}'). `
        : `Run ${parentRunId} is paused waiting on sub-runs ${childRunIds.join(', ')} ` +
          `('fan_out' node '${nodeId}'). `) +
        (action === 'approve'
          ? `Approve or reject ${one ? 'the child run' : 'each paused child run'} instead.`
          : `Reject ${one ? 'the child run' : 'a paused child run'} instead, or abandon this run ` +
            'to discard the whole tree.')
    );
    this.name = 'ChildRunRedirectError';
  }

  /** The same refusal with the redirect commands spelled for `surface`. */
  messageFor(surface: WorkflowCommandSurface): string {
    const label = this.action === 'approve' ? 'Approve' : 'Reject';
    const commands = this.childRunIds
      .map(id => `\`${spellWorkflowCommand(surface, `${this.action} ${id}`)}\``)
      .join(', ');
    return `${this.message} ${label} ${this.childRunIds.length === 1 ? 'it' : 'each'} by run id: ${commands}`;
  }
}

const LOST_GATE_MESSAGE = (runId: string): string =>
  `Workflow run ${runId} was already resolved or is no longer paused at the expected gate.`;

/**
 * An answer named an occurrence that is not the run's open one. Typed so a surface can
 * report it as a conflict rather than a server failure.
 */
export class StaleGateAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleGateAnswerError';
  }
}

/** The refusal for an answer whose occurrence is not the run's open one, naming the one it is at now. */
export function staleGateError(runId: string, current: WorkflowRun | null): StaleGateAnswerError {
  const attention = current ? runAttention(current) : null;
  return new StaleGateAnswerError(
    attention?.kind === 'awaiting_response' || attention?.kind === 'attention'
      ? `${LOST_GATE_MESSAGE(runId)} It is now awaiting occurrence '${attention.occurrence}'.`
      : `${LOST_GATE_MESSAGE(runId)} It is not awaiting an answer now.`
  );
}

/**
 * The checks every answer passes before anything else judges it: the surface id is
 * well formed, and a named occurrence is the run's open one. The occurrence goes first
 * so an answer prepared for an earlier pause is reported as stale, not as an invalid
 * decision for a gate its sender never saw. Mirrors the store's own CAS predicate,
 * which still decides a race after this read. Read-only, so the CLI's detached
 * pre-flight runs it too.
 */
export function assertAnswerAdmissible(run: WorkflowRun, origin: GateAnswerOrigin): void {
  recordSurfaceSchema.parse(origin.via);
  const expected = origin.expectedGate;
  if (expected === undefined) return;
  const open = openPause(run);
  const matches =
    open !== undefined &&
    open.nodeId === (typeof expected === 'string' ? expected : expected.nodeId) &&
    (open.pauseId ?? null) === (typeof expected === 'string' ? null : expected.pauseId);
  if (!matches) throw staleGateError(run.id, run);
}

/**
 * The unanswered gate or attention wait a run is paused at, by the identity an expected
 * occurrence names: the gate's node, or the wait's step, plus its `pauseId` if it has one.
 */
function openPause(run: WorkflowRun): { nodeId: string; pauseId?: string } | undefined {
  const wait = pausedAttentionWait(run);
  if (wait !== undefined)
    return wait.answer === undefined
      ? { nodeId: workflowWaitStepName(wait), pauseId: wait.pauseId }
      : undefined;
  const gate = run.metadata.approval;
  return run.status === 'paused' && isApprovalContext(gate) && !isGateResolved(gate)
    ? gate
    : undefined;
}

/**
 * The expected gate for an occurrence id as run-attention reports it: a gate's `pauseId`,
 * or `legacy:<nodeId>` for a gate paused before pause identities existed. The prefix is
 * Archon's own token, minted by `runAttention`, not user text.
 */
export function expectedGateForOccurrence(
  run: WorkflowRun,
  occurrence: string
): ExpectedApprovalGate {
  const legacyStep = legacyOccurrenceStep(occurrence);
  if (legacyStep !== undefined) return legacyStep;
  const wait = pausedAttentionWait(run);
  const approval = run.metadata.approval;
  const nodeId =
    wait !== undefined
      ? workflowWaitStepName(wait)
      : isApprovalContext(approval)
        ? approval.nodeId
        : '';
  return { nodeId, pauseId: occurrence };
}

/**
 * A lost compare-and-swap for a named occurrence remains a conflict even when the
 * diagnostic lookup cannot read the current pause.
 */
export async function lostGateError(
  ctx: OperationContext,
  runId: string,
  expected: ExpectedApprovalGate | undefined
): Promise<Error> {
  if (expected === undefined) return new Error(LOST_GATE_MESSAGE(runId));
  let current: WorkflowRun | null;
  try {
    current = await ctx.store.getWorkflowRun(runId);
  } catch (err) {
    getLog().warn({ err, runId }, 'operations.workflow_gate_occurrence_lookup_failed');
    return new StaleGateAnswerError(LOST_GATE_MESSAGE(runId));
  }
  return staleGateError(runId, current);
}

/**
 * The text an approve, reject or respond answer carries, or undefined when it carries
 * none. Whitespace-only text is absent on every verb; explicit text is kept verbatim.
 */
export function answerText(text: string | undefined): string | undefined {
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/** Render an operation failure, including a surface-specific child-run redirect. */
export function workflowOperationErrorMessage(
  error: unknown,
  surface: WorkflowCommandSurface
): string {
  if (error instanceof ChildRunRedirectError) return error.messageFor(surface);
  return error instanceof Error ? error.message : String(error);
}

/**
 * The message for a gate `runAttention` could not read. Shared by approve and
 * reject so a corrupt row explains itself the same way at both entry points.
 */
export function unreadableGateMessage(
  run: WorkflowRun,
  attention: Extract<RunAttention, { kind: 'unreadable' }>,
  approval: ApprovalContext | undefined
): string {
  switch (attention.reason) {
    case 'malformed_gate':
      return 'Workflow run is paused but missing approval context.';
    case 'unrecognized_gate_type':
      // Shares this conclusion with approveWorkflow/rejectWorkflow's own exhaustive
      // switches (#2489) so a --detach precheck success can never diverge from what
      // resolution actually does — see isRecognizedSuspendReason's doc comment.
      return `Run ${run.id} has an unrecognized gate type '${String(approval?.type)}'. This Archon build cannot resolve it.`;
    default:
      // A block pointer with nothing to follow, or a chain the reader gave up on.
      // Never a redirect naming '<unknown>' — that is a command nobody can run.
      return `Run ${run.id} cannot be resolved: ${attention.detail}.`;
  }
}

export function usageLimitNotAGateMessage(
  run: WorkflowRun,
  attention: Extract<RunAttention, { kind: 'usage_limit' }>
): string {
  return (
    `Run ${run.id} is not at a gate: it hit a provider usage or rate limit and tries again ` +
    `by itself at ${attention.resumeAt}. Resume it to try sooner, or cancel or abandon it ` +
    'to stop it.'
  );
}
