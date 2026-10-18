import { sendPauseNotice } from '../../pause';
import { randomUUID } from 'node:crypto';
import { nodeInvocationKey } from '../../../node-record-reader';
import { finishNodeExecution } from '../../../node-execution';
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
import { waitOutputFormat } from '../../../schemas/dag-node';
import type { WaitNode, WorkflowWaitContext } from '../../../schemas';
import { type BodySessionCursorAncestry, type SessionCursor } from '../../../schemas';
import { isWorkflowWaitContext, waitUntilTimestampSchema, waitCondition } from '../../../schemas';
import { waitCompletionEvents } from '../../../store';
import {
  declaredOutputPathsFromSchema,
  canonicalValueText,
  parseWholeInputsRef,
} from '../../../output-ref';
import { getLog } from '../../log';
import { beginExecution, type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  substituteWaitMessage,
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

/** Execute a durable wait without holding a subprocess or provider slot. */
export async function executeWaitNode(
  ctx: RunLayersContext,
  node: WaitNode,
  loopOwner?: WaitLoopOwner
): Promise<NodeExecutionResult> {
  const { workflowRun, deps, platform, conversationId, nodeOutputs, stepNamePrefix, logDir } = ctx;
  const now = new Date();
  const rawPersisted = workflowRun.metadata?.wait;
  const persisted =
    isWorkflowWaitContext(rawPersisted) &&
    (loopOwner === undefined
      ? rawPersisted.owner === 'node' && rawPersisted.nodeId === node.id
      : rawPersisted.owner === 'loop_group' &&
        rawPersisted.nodeId === loopOwner.groupId &&
        rawPersisted.bodyWaitId === node.id &&
        rawPersisted.iteration === loopOwner.iteration)
      ? rawPersisted
      : undefined;

  const execution =
    ctx.unfinishedInvocations?.get(
      nodeInvocationKey(stepNamePrefix + node.id, ctx.loopGroupPath)
    ) ?? (persisted === undefined ? beginExecution(ctx, node) : undefined);
  if (execution !== undefined && persisted === undefined) {
    await recordNodeState({ store: deps.store, logDir }, execution);
  }

  const owner =
    loopOwner === undefined
      ? ({ owner: 'node', nodeId: node.id } as const)
      : ({
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
        } as const);
  const condition = waitCondition(node.wait);
  const resolveEventText = (text: string): string =>
    substituteWaitMessage(text, ctx, resolveRunInputs(workflowRun));
  let context: WorkflowWaitContext;
  if (persisted !== undefined) {
    context = persisted;
  } else if (condition.kind === 'duration') {
    context = {
      ...owner,
      kind: 'time',
      pauseId: randomUUID(),
      waitingSince: now.toISOString(),
      resumeAt: new Date(now.getTime() + condition.durationMs).toISOString(),
    };
  } else if (condition.kind === 'until') {
    const inputsName = parseWholeInputsRef(condition.timestamp);
    let rendered: string;
    if (inputsName !== undefined) {
      const runInputs = resolveRunInputs(workflowRun);
      if (!runInputs || !Object.hasOwn(runInputs, inputsName)) {
        throw new Error(`Wait node '${node.id}' references unknown input '$INPUTS.${inputsName}'`);
      }
      rendered = canonicalValueText(runInputs[inputsName]);
    } else {
      rendered = substituteNodeOutputRefs(condition.timestamp, nodeOutputs, ctx.loopBodyScopes);
    }
    if (!waitUntilTimestampSchema.safeParse(rendered).success) {
      throw new Error(
        `Wait node '${node.id}' has an invalid 'until' timestamp after substitution: '${rendered}'`
      );
    }
    const resumeAtMs = Date.parse(rendered);
    context = {
      ...owner,
      kind: 'time',
      pauseId: randomUUID(),
      waitingSince: now.toISOString(),
      resumeAt: new Date(resumeAtMs).toISOString(),
    };
  } else if (condition.kind === 'event') {
    const event = resolveEventText(condition.event).trim();
    if (event === '') {
      throw new Error(`Wait node '${node.id}' resolved 'event' to an empty string`);
    }
    context = {
      ...owner,
      kind: 'event',
      pauseId: randomUUID(),
      event,
      waitingSince: now.toISOString(),
      resumeAt: new Date(now.getTime() + condition.deadlineMs).toISOString(),
    };
  } else {
    const message = resolveEventText(condition.message).trim();
    if (message === '') {
      throw new Error(`Wait node '${node.id}' resolved 'attention' to an empty message`);
    }
    const options = resolveAttentionOptions(node.id, condition.options, ctx.nodeOutputs);
    const labels =
      condition.labels === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(condition.labels).map(([key, value]) => [key, resolveEventText(value)])
          );
    context = {
      ...owner,
      kind: 'attention',
      waitingSince: now.toISOString(),
      message,
      pauseId: randomUUID(),
      form: condition.form,
      ...(options !== undefined ? { options } : {}),
      ...(labels !== undefined ? { labels } : {}),
    };
  }

  const resumeAtMs = context.kind === 'attention' ? undefined : Date.parse(context.resumeAt);
  const isSignaled = context.kind === 'event' && context.signaledAt !== undefined;
  const isDue = resumeAtMs !== undefined && now.getTime() >= resumeAtMs;
  // An answered attention wait completes with its answer. A bare `resume` completes only a
  // message-form wait, with empty text, which keeps waits paused before answers existed
  // continuable; any other form pauses again until it is answered.
  const isAttentionResume =
    context.kind === 'attention' &&
    persisted !== undefined &&
    (context.answer !== undefined || attentionForm(context) === 'message');
  if (!isSignaled && !isDue && !isAttentionResume) {
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
      const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
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
        conversationId,
        workflowRun.id,
        node.id,
        attentionOccurrence(context),
        stepNamePrefix + node.id,
        attentionNotification(platform, workflowRun.id, context)
      );
    }
    return execution === undefined
      ? { state: 'running', output: '' }
      : !paused
        ? serializeNodeOutput(execution)
        : recordNodeState(
            { store: deps.store, logDir },
            finishNodeExecution(
              execution,
              { status: 'suspended', point: 'wait' },
              { output: { text: '' } }
            )
          );
  }

  const status = context.kind === 'event' && !isSignaled ? 'expired' : 'satisfied';
  const result = {
    status,
    waited_ms: Math.max(0, now.getTime() - Date.parse(context.waitingSince)),
    ...(context.kind === 'event'
      ? {
          event: context.event,
          ...(context.payload !== undefined ? { payload: context.payload } : {}),
        }
      : {}),
  } as const;
  // An attention wait's node output is its answer; the wait outcome row keeps `result`.
  const answer = context.kind === 'attention' ? (context.answer ?? { text: '' }) : undefined;
  const nodeValue = answer ?? result;
  const output = JSON.stringify(nodeValue);
  const declaredOutputPaths = declaredOutputPathsFromSchema(waitOutputFormat(node.wait));
  const stepName = stepNamePrefix + node.id;
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
  if (persisted !== undefined) {
    const outcome = await deps.store.clearWorkflowWaitContext(workflowRun.id, context, {
      stepName,
      result,
      ...(answer !== undefined ? { answer } : {}),
      execution: completed,
    });
    if (!outcome.cleared) {
      throw new Error(`Wait node '${node.id}' lost ownership of its persisted wait cursor`);
    }
    // The store wrote the node_completed row inside the cursor-clearing transaction and
    // handed it back; the transcript and emitter derive from that row, not a rebuilt one.
    await recordDerivedNodeState({ logDir }, node, outcome.nodeEvent);
  } else {
    const rows = waitCompletionEvents(workflowRun.id, {
      stepName,
      result,
      ...(answer !== undefined ? { answer } : {}),
      execution: completed,
    });
    await deps.store.createWorkflowEvent(rows.outcome);
    await persistNodeEvent(deps.store, rows.node);
    await recordDerivedNodeState({ logDir }, node, rows.node);
  }
  if (completed !== undefined) return serializeNodeOutput(completed);
  return { state: 'completed', output, structuredOutput: nodeValue, declaredOutputPaths };
}

/** The message an attention wait sends when it pauses: the question and how to answer it. */
function attentionNotification(
  surface: IWorkflowPlatform,
  runId: string,
  wait: WorkflowAttentionWaitContext
): string {
  const answer = attentionAnswerLines(surface, {
    runId,
    form: attentionForm(wait),
    options: [...attentionOptions(wait)],
    occurrence: attentionOccurrence(wait),
  });
  return [
    `⏸️ **Workflow run \`${runId}\` needs attention**`,
    wait.message,
    [...answer, `Abandon: \`${spellWorkflowCommand(surface, `abandon ${runId}`)}\``].join('\n'),
  ].join('\n\n');
}
