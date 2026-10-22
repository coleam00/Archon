import { waitMessageRenderer } from './attention-message';
import { sendPauseNotice, statusAfterPauseFailure } from '../../pause';
import { randomUUID } from 'node:crypto';
import { nodeInvocationKey } from '../../../node-record-reader';
import { finishNodeExecution } from '../../../node-execution';
import type { NodeExecutionRecord } from '../../../schemas/node-execution';
import { serializeNodeOutput, type NodeExecutionResult } from '../../../node-record-serialization';
import {
  persistNodeEvent,
  recordDerivedNodeState,
  recordNodeState,
} from '../../../node-event-write';
import type { IWorkflowPlatform } from '../../../deps';
import { attentionAnswerLines, spellWorkflowCommand } from '../../../deps';
import {
  attentionForm,
  attentionOccurrence,
  attentionOptions,
  type WorkflowAttentionWaitContext,
} from '../../../schemas/workflow-run';
import { waitOutputFormat } from '../../../schemas/wait-node';
import type { WaitCondition, WaitNode, WorkflowWaitContext } from '../../../schemas';
import { type BodySessionCursorAncestry, type SessionCursor } from '../../../schemas';
import { readWorkflowWaitContext, waitUntilTimestampSchema, waitCondition } from '../../../schemas';
import { waitCompletionEvents } from '../../../store';
import {
  declaredOutputPathsFromSchema,
  canonicalValueText,
  parseWholeInputsRef,
} from '../../../output-ref';
import { getLog } from '../../log';
import { getStaleCachedDependencies } from '../../stale-dependencies';
import { beginExecution, type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  substituteNodeOutputRefs,
  resolveAttentionOptions,
} from '../../references';

export interface WaitLoopOwner {
  groupId: string;
  iteration: number;
  sessionId: string | null;
  sessionProvider: string | null;
  bodySessionCursors?: Record<string, SessionCursor>;
  bodySessionCursorAncestry?: BodySessionCursorAncestry;
}

/** An answer a resume discarded: the occurrence it answered and what changed since. */
interface DiscardedAnswer {
  readonly occurrence: string;
  readonly changed: readonly string[];
}

/**
 * The persisted wait context this invocation resumes: the run's stored wait when it
 * belongs to this node (or this loop-group iteration's body wait), unless it holds an
 * answer to a question this pass no longer asks. Then the wait starts fresh and
 * `discarded` says why.
 */
function resumableWaitContext(
  ctx: RunLayersContext,
  node: WaitNode,
  loopOwner: WaitLoopOwner | undefined,
  render: (text: string) => string
): { persisted: WorkflowWaitContext | undefined; discarded?: DiscardedAnswer } {
  const raw = readWorkflowWaitContext(ctx.workflowRun.metadata?.wait);
  if (!raw) return { persisted: undefined };
  const owned =
    loopOwner === undefined
      ? raw.owner === 'node' && raw.nodeId === node.id
      : raw.owner === 'loop_group' &&
        raw.nodeId === loopOwner.groupId &&
        raw.bodyWaitId === node.id &&
        raw.iteration === loopOwner.iteration;
  if (!owned) return { persisted: undefined };
  const discarded = staleAnswer(ctx, node, raw, render);
  return discarded === undefined ? { persisted: raw } : { persisted: undefined, discarded };
}

/**
 * An answer belongs to the question it answered: the message, form and options recorded
 * when the wait paused. When a resume re-ran something upstream (a failed node retried,
 * an `always_run` producer, a stale cache) and the question this pass renders differs,
 * the answer is discarded so the run never acts on an answer to a different question.
 *
 * A wait that was already re-asked once keeps its answer, so a question rendered from a
 * value that changes on every resume cannot be asked forever.
 */
function staleAnswer(
  ctx: RunLayersContext,
  node: WaitNode,
  persisted: WorkflowWaitContext,
  render: (text: string) => string
): DiscardedAnswer | undefined {
  if (persisted.kind !== 'attention' || persisted.answer === undefined) return undefined;
  if (persisted.reaskedFrom !== undefined) return undefined;
  if (persisted.owner === 'node' && ctx.priorCompletedNodes === undefined) return undefined;
  const condition = waitCondition(node.wait);
  if (condition.kind !== 'attention') return undefined;
  const options = resolveAttentionOptions(node.id, condition.options, ctx.nodeOutputs) ?? [];
  const same =
    render(condition.message).trim() === persisted.message &&
    condition.form === attentionForm(persisted) &&
    JSON.stringify(options) === JSON.stringify(persisted.options ?? []);
  if (same) return undefined;
  const changed =
    ctx.priorCompletedNodes === undefined
      ? []
      : getStaleCachedDependencies(
          node,
          ctx.nodeOutputs,
          ctx.priorCompletedNodes,
          ctx.replayedFailures
        );
  getLog().warn(
    { workflowRunId: ctx.workflowRun.id, nodeId: node.id, changedDependencies: changed },
    'dag.wait_answer_discarded_stale_question'
  );
  return { occurrence: attentionOccurrence(persisted), changed };
}

/** One invocation of a wait node: what it resumes, when it runs, and its execution record. */
interface WaitPass {
  ctx: RunLayersContext;
  node: WaitNode;
  loopOwner: WaitLoopOwner | undefined;
  now: Date;
  render: (text: string) => string;
  pauseFields: ReturnType<typeof waitMessageRenderer>['pauseFields'];
  persisted: WorkflowWaitContext | undefined;
  discarded: DiscardedAnswer | undefined;
  execution: NodeExecutionRecord | undefined;
}

/** Execute a durable wait without holding a subprocess or provider slot. */
export async function executeWaitNode(
  ctx: RunLayersContext,
  node: WaitNode,
  loopOwner?: WaitLoopOwner
): Promise<NodeExecutionResult> {
  const now = new Date();
  const { render, pauseFields } = waitMessageRenderer(ctx, node, loopOwner);
  const { persisted, discarded } = resumableWaitContext(ctx, node, loopOwner, render);
  const execution = await beginWaitExecution(ctx, node, persisted);
  const pass = { ctx, node, loopOwner, now, render, pauseFields, persisted, discarded, execution };
  const context = persisted ?? armWait(pass);
  return isResumable(pass, context) ? settleWait(pass, context) : pauseWait(pass, context);
}

/**
 * The invocation a resume left unfinished, or a fresh one for a wait that is not yet
 * persisted. A persisted wait with no unfinished invocation records nothing new.
 */
async function beginWaitExecution(
  ctx: RunLayersContext,
  node: WaitNode,
  persisted: WorkflowWaitContext | undefined
): Promise<NodeExecutionRecord | undefined> {
  const execution =
    ctx.unfinishedInvocations?.get(
      nodeInvocationKey(ctx.stepNamePrefix + node.id, ctx.loopGroupPath)
    ) ?? (persisted === undefined ? beginExecution(ctx, node) : undefined);
  if (execution !== undefined && persisted === undefined) {
    await recordNodeState({ store: ctx.deps.store, logDir: ctx.logDir }, execution);
  }
  return execution;
}

function waitOwner(node: WaitNode, loopOwner: WaitLoopOwner | undefined) {
  if (loopOwner === undefined) return { owner: 'node', nodeId: node.id } as const;
  return {
    owner: 'loop_group',
    nodeId: loopOwner.groupId,
    bodyWaitId: node.id,
    iteration: loopOwner.iteration,
    sessionId: loopOwner.sessionId,
    sessionProvider: loopOwner.sessionProvider,
    ...(loopOwner.bodySessionCursors !== undefined
      ? { bodySessionCursors: loopOwner.bodySessionCursors }
      : {}),
    ...(loopOwner.bodySessionCursorAncestry !== undefined
      ? { bodySessionCursorAncestry: loopOwner.bodySessionCursorAncestry }
      : {}),
  } as const;
}

/** A fresh wait context for the node's condition, resolved against this pass. */
function armWait(pass: WaitPass): WorkflowWaitContext {
  const { node, now } = pass;
  const owner = waitOwner(node, pass.loopOwner);
  const condition = waitCondition(node.wait);
  switch (condition.kind) {
    case 'duration':
      return {
        ...owner,
        kind: 'time',
        pauseId: randomUUID(),
        waitingSince: now.toISOString(),
        resumeAt: new Date(now.getTime() + condition.durationMs).toISOString(),
      };
    case 'until': {
      const resumeAtMs = Date.parse(renderUntil(pass, condition.timestamp));
      return {
        ...owner,
        kind: 'time',
        pauseId: randomUUID(),
        waitingSince: now.toISOString(),
        resumeAt: new Date(resumeAtMs).toISOString(),
      };
    }
    case 'event': {
      const event = pass.render(condition.event).trim();
      if (event === '') {
        throw new Error(`Wait node '${node.id}' resolved 'event' to an empty string`);
      }
      return {
        ...owner,
        kind: 'event',
        pauseId: randomUUID(),
        event,
        waitingSince: now.toISOString(),
        resumeAt: new Date(now.getTime() + condition.deadlineMs).toISOString(),
      };
    }
    case 'attention':
      return { ...owner, ...armAttention(pass, condition) };
  }
}

/** The `until:` timestamp after substitution, refused unless it is a valid timestamp. */
function renderUntil(pass: WaitPass, timestamp: string): string {
  const { ctx, node } = pass;
  const inputsName = parseWholeInputsRef(timestamp);
  let rendered: string;
  if (inputsName !== undefined) {
    const runInputs = resolveRunInputs(ctx.workflowRun);
    if (!runInputs || !Object.hasOwn(runInputs, inputsName)) {
      throw new Error(`Wait node '${node.id}' references unknown input '$INPUTS.${inputsName}'`);
    }
    rendered = canonicalValueText(runInputs[inputsName]);
  } else {
    rendered = substituteNodeOutputRefs(timestamp, ctx.nodeOutputs, ctx.loopBodyScopes);
  }
  if (!waitUntilTimestampSchema.safeParse(rendered).success) {
    throw new Error(
      `Wait node '${node.id}' has an invalid 'until' timestamp after substitution: '${rendered}'`
    );
  }
  return rendered;
}

function armAttention(pass: WaitPass, condition: Extract<WaitCondition, { kind: 'attention' }>) {
  const { node, render, discarded } = pass;
  const message = render(condition.message).trim();
  if (message === '') {
    throw new Error(`Wait node '${node.id}' resolved 'attention' to an empty message`);
  }
  const options = resolveAttentionOptions(node.id, condition.options, pass.ctx.nodeOutputs);
  const labels =
    condition.labels === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(condition.labels).map(([key, value]) => [key, render(value)])
        );
  return {
    kind: 'attention',
    waitingSince: pass.now.toISOString(),
    message,
    pauseId: randomUUID(),
    form: condition.form,
    ...(options !== undefined ? { options } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(discarded !== undefined ? { reaskedFrom: discarded.occurrence } : {}),
    ...pass.pauseFields,
  } as const;
}

/** True when the wait completes on this pass instead of pausing. */
function isResumable(pass: WaitPass, context: WorkflowWaitContext): boolean {
  if (context.kind === 'event' && context.signaledAt !== undefined) return true;
  if (context.kind !== 'attention') return pass.now.getTime() >= Date.parse(context.resumeAt);
  // An answered attention wait completes with its answer. A bare `resume` completes only a
  // message-form wait, with empty text, which keeps waits paused before answers existed
  // continuable; any other form pauses again until it is answered.
  return (
    pass.persisted !== undefined &&
    (context.answer !== undefined || attentionForm(context) === 'message')
  );
}

/** Persist the wait and pause the run; an attention wait also notifies the conversation. */
async function pauseWait(
  pass: WaitPass,
  context: WorkflowWaitContext
): Promise<NodeExecutionResult> {
  const { ctx, node, persisted, execution } = pass;
  const { workflowRun, deps, platform, stepNamePrefix } = ctx;
  let paused = false;
  try {
    await deps.store.pauseWorkflowRunForWait(
      workflowRun.id,
      context,
      persisted === undefined
        ? { kind: 'started', stepName: stepNamePrefix + node.id }
        : { kind: 'continued' }
    );
    paused = true;
  } catch (pauseError) {
    const status = await statusAfterPauseFailure(deps.store, workflowRun.id, pauseError);
    if (status === 'running') throw pauseError;
    getLog().warn(
      { workflowRunId: workflowRun.id, nodeId: node.id, status: status ?? 'deleted' },
      'dag.wait_pause_skipped_external_transition'
    );
  }
  if (paused && context.kind === 'attention') {
    await sendPauseNotice(
      deps,
      platform,
      ctx.conversationId,
      workflowRun.id,
      node.id,
      attentionOccurrence(context),
      stepNamePrefix + node.id,
      attentionNotification(platform, workflowRun.id, context, pass.discarded)
    );
  }
  if (execution === undefined) return { state: 'running', output: '' };
  if (!paused) return serializeNodeOutput(execution);
  return recordNodeState(
    { store: deps.store, logDir: ctx.logDir },
    finishNodeExecution(execution, { status: 'suspended', point: 'wait' }, { output: { text: '' } })
  );
}

/** Complete the node with the wait's outcome, clearing a persisted wait cursor. */
async function settleWait(
  pass: WaitPass,
  context: WorkflowWaitContext
): Promise<NodeExecutionResult> {
  const { ctx, node, persisted, execution } = pass;
  const { workflowRun, deps, logDir } = ctx;
  const result = waitResult(pass.now, context);
  // An attention wait's node output is its answer; the wait outcome row keeps `result`.
  const answer = context.kind === 'attention' ? (context.answer ?? { text: '' }) : undefined;
  const nodeValue = answer ?? result;
  const output = JSON.stringify(nodeValue);
  const declaredOutputPaths = declaredOutputPathsFromSchema(waitOutputFormat(node.wait));
  const completed =
    execution === undefined
      ? undefined
      : finishNodeExecution(
          execution,
          { status: 'completed' },
          {
            durationMs: result.waited_ms,
            output: { text: output, structured: nodeValue, declaredOutputPaths },
          }
        );
  const completion = {
    stepName: ctx.stepNamePrefix + node.id,
    result,
    ...(answer !== undefined ? { answer } : {}),
    execution: completed,
  };
  if (persisted !== undefined) {
    const outcome = await deps.store.clearWorkflowWaitContext(workflowRun.id, context, completion);
    if (!outcome.cleared) {
      throw new Error(`Wait node '${node.id}' lost ownership of its persisted wait cursor`);
    }
    // The store wrote the node_completed row inside the cursor-clearing transaction and
    // handed it back; the transcript and emitter derive from that row, not a rebuilt one.
    await recordDerivedNodeState({ logDir }, node, outcome.nodeEvent);
  } else {
    const rows = waitCompletionEvents(workflowRun.id, completion);
    await deps.store.createWorkflowEvent(rows.outcome);
    await persistNodeEvent(deps.store, rows.node);
    await recordDerivedNodeState({ logDir }, node, rows.node);
  }
  if (completed !== undefined) return serializeNodeOutput(completed);
  return { state: 'completed', output, structuredOutput: nodeValue, declaredOutputPaths };
}

function waitResult(now: Date, context: WorkflowWaitContext) {
  const signaled = context.kind === 'event' && context.signaledAt !== undefined;
  return {
    status: context.kind === 'event' && !signaled ? 'expired' : 'satisfied',
    waited_ms: Math.max(0, now.getTime() - Date.parse(context.waitingSince)),
    ...(context.kind === 'event'
      ? {
          event: context.event,
          ...(context.payload !== undefined ? { payload: context.payload } : {}),
        }
      : {}),
  } as const;
}

/** The message an attention wait sends when it pauses: the question and how to answer it. */
function attentionNotification(
  surface: IWorkflowPlatform,
  runId: string,
  wait: WorkflowAttentionWaitContext,
  discarded?: DiscardedAnswer
): string {
  const answer = attentionAnswerLines(surface, {
    runId,
    form: attentionForm(wait),
    options: [...attentionOptions(wait)],
    occurrence: attentionOccurrence(wait),
  });
  const changed =
    discarded === undefined
      ? []
      : [
          `Your earlier answer was discarded because ${discarded.changed.length > 0 ? discarded.changed.join(', ') : 'what this question is built from'} changed, so the question below is not the one you answered.`,
        ];
  return [
    `⏸️ **Workflow run \`${runId}\` needs attention**`,
    ...changed,
    wait.message,
    [...answer, `Abandon: \`${spellWorkflowCommand(surface, `abandon ${runId}`)}\``].join('\n'),
  ].join('\n\n');
}
