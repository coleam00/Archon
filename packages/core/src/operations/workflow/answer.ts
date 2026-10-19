import {
  attentionChoiceProblem,
  attentionForm,
  attentionOptions,
  pausedAttentionWait,
  runAttention,
  workflowWaitStepName,
} from '@archon/workflows/schemas/workflow-run';
import type {
  AttentionAnswer,
  WorkflowAttentionWaitContext,
  WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { RunActor, RunAction } from '../run-authorization';
import type { OperationContext } from './context';
import {
  assertAnswerAdmissible,
  ChildRunRedirectError,
  lostGateError,
  type GateAnswerOrigin,
} from './answer-admission';
import type { ApprovalOperationResult } from './approve';

/** An answer to an attention wait: the declared option ids it chooses, and free text. */
export interface AttentionAnswerRequest {
  choose: readonly string[];
  text?: string;
}

export interface AttentionAnswerOperationResult extends ApprovalOperationResult {
  type: 'attention';
  /** The answer as recorded, which is what the next node reads. */
  answer: AttentionAnswer;
}

/** An attention wait open to an answer: it has a pause identity an answer can name. */
type OpenAttentionWait = WorkflowAttentionWaitContext & { pauseId: string };

/**
 * The open attention wait `run` is paused at, refusing every state where an answer to one
 * cannot land. Read-only, so the CLI's detached pre-flight runs it too.
 */
export function assertAnswerable(run: WorkflowRun): OpenAttentionWait {
  const wait = pausedAttentionWait(run);
  if (wait === undefined) {
    const attention = runAttention(run);
    if (attention?.kind === 'blocked_on_child')
      throw new ChildRunRedirectError(run.id, [attention.childRunId], attention.nodeId, 'approve');
    if (attention?.kind === 'blocked_on_children')
      throw new ChildRunRedirectError(run.id, attention.childRunIds, attention.nodeId, 'approve');
    throw new Error(
      attention?.kind === 'awaiting_response'
        ? `Run ${run.id} is paused at a gate, not an attention wait. Answer it with approve, reject or respond.`
        : `Run ${run.id} is not paused at an attention wait (status '${run.status}').`
    );
  }
  if (wait.answer !== undefined)
    throw new Error(
      `Run ${run.id}'s attention wait was already answered and is awaiting continuation.`
    );
  if (wait.pauseId === undefined)
    throw new Error(
      `Run ${run.id} paused at an attention wait before answers existed. Continue it with resume, ` +
        'or abandon it if it should not continue.'
    );
  return { ...wait, pauseId: wait.pauseId };
}

/**
 * The answer `request` gives `wait`, validated against its form by
 * `attentionChoiceProblem`. An undeclared option is refused on every surface.
 */
export function attentionAnswerFor(
  run: WorkflowRun,
  wait: WorkflowAttentionWaitContext,
  request: AttentionAnswerRequest
): AttentionAnswer {
  const form = attentionForm(wait);
  const text = request.text ?? '';
  const declared = attentionOptions(wait).map(option => option.id);
  const problem = attentionChoiceProblem(form, declared, request.choose);
  if (problem !== undefined)
    throw new Error(`Run ${run.id}'s attention wait (form '${form}') ${problem}`);
  if (form === 'message') return { text };
  if (form === 'multi_select') return { decisions: [...request.choose], text };
  const [decision] = request.choose;
  return { decision, text };
}

/**
 * The answer `approve`, `reject` or `respond <decision>` stands for at an attention wait,
 * or undefined when the run is not paused at one. `approve` answers a message with its
 * text; otherwise the verb chooses the option of the same id, which the form validates.
 */
export function attentionSugarRequest(
  run: WorkflowRun,
  decision: string,
  text: string | undefined
): AttentionAnswerRequest | undefined {
  const wait = pausedAttentionWait(run);
  if (wait === undefined) return undefined;
  const choose = decision === 'approve' && attentionForm(wait) === 'message' ? [] : [decision];
  return text === undefined ? { choose } : { choose, text };
}

/**
 * Record an answer to the attention wait `run` is paused at. The run stays paused and
 * its answer is a due continuation, so a continuation host continues it whichever
 * surface answered. `action` is the verb the caller used, for authorization.
 */
export async function answerRun(
  ctx: OperationContext,
  run: WorkflowRun,
  request: AttentionAnswerRequest,
  actor: RunActor,
  origin: GateAnswerOrigin,
  action: RunAction
): Promise<AttentionAnswerOperationResult> {
  await ctx.assertMayAct(run, actor, action);
  assertAnswerAdmissible(run, origin);
  const wait = assertAnswerable(run);
  const answer = attentionAnswerFor(run, wait, request);
  const { answered } = await ctx.store.answerAttentionWait(run.id, {
    pauseId: wait.pauseId,
    answer,
    answeredVia: origin.via,
    answeredAt: new Date().toISOString(),
  });
  if (!answered) {
    throw await lostGateError(ctx, run.id, {
      nodeId: workflowWaitStepName(wait),
      pauseId: wait.pauseId,
    });
  }
  return {
    workflowName: run.workflow_name,
    workingPath: run.working_path,
    userMessage: run.user_message,
    codebaseId: run.codebase_id,
    conversationId: run.conversation_id,
    type: 'attention',
    answer,
  };
}

export async function answerWorkflow(
  ctx: OperationContext,
  runId: string,
  request: AttentionAnswerRequest,
  actor: RunActor,
  origin: GateAnswerOrigin
): Promise<AttentionAnswerOperationResult> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_answer_lookup_failed');
  return answerRun(ctx, run, request, actor, origin, 'respond');
}
