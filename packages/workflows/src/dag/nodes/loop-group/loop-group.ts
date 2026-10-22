import { isWorkflowExecutionInterruption } from '../../../execution-interruption';
import { safeSendMessage } from '../../../platform-messages';
import { describeUnmetCompletion } from '../../../executor-shared';
import { finishNodeExecution } from '../../../node-execution';
import { serializeNodeOutput, type NodeExecutionResult } from '../../../node-record-serialization';
import { type NodeExecutionRecord } from '../../../schemas/node-execution';
import { NodeEventWriteError, recordNodeState } from '../../../node-event-write';
import type { LoopGroupNode } from '../../../schemas';
import { resolvedBodyNodes } from '../../../graph-plan';
import { type ModelAliasPreset, type TierName } from '../../../model-validation';
import { getLog } from '../../log';
import { RunSourceUnreadableError } from '../../node-source';
import { beginExecution, type RunLayersContext } from '../../run-context';
import type { LoopGroupBodyResult, LoopGroupRun, LoopGroupProgress } from './loop-group-state';
import {
  completeEscalatedResume,
  finalizeGroupOnBareApprove,
  initialLoopGroupState,
  readLoopGroupResume,
  restoreLoopPrevOutputs,
  resumeTerminalWait,
} from './resume';
import { runLoopGroupIteration } from './iteration';

/**
 * Execute a loop-group node — runs a multi-node sub-DAG body repeatedly until a
 * completion condition (`until` signal in the iteration's output, and/or
 * `until_bash` exit code) or `max_iterations`.
 *
 * Mirrors {@link executeLoopNode} at subgraph granularity: each iteration runs the body's
 * topological layers via {@link runLayers} against a fresh scoped `nodeOutputs` map. The
 * body is a sealed sub-DAG. Every persisted body event — both runLayers' own control
 * events (skip/trigger_rule/when) AND the node executors' lifecycle events
 * (node_started/node_completed/node_failed, and tool/task/hook activity) — is namespaced
 * `{groupId}.{nodeId}` via `stepNamePrefix`, composing across nested groups; body node
 * lifecycle rows also carry the current `iteration` in their `data` (#2090). The in-process
 * emitter payloads stay raw (unprefixed nodeId) so live SSE/CLI consumers are unaffected.
 * `$LOOP_PREV.<id>.output` refs in body prompts resolve against a snapshot of the
 * *previous* iteration's body outputs (empty on iteration 1).
 *
 * `$groupId.output` (visible to the outer DAG) = the final iteration's output, chosen by
 * `loopGroupIterationOutput`.
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) — the outer DAG executor owns run lifecycle
 * - Loop is encapsulated inside this one node; the outer DAG stays acyclic
 * - Usage (cost/tokens) is summed across iterations and returned on the final result,
 *   so the outer `runLayers` aggregates the group as one node's worth of usage
 */
export async function executeLoopGroupNode(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  workflowProvider: string | undefined,
  workflowModel: string | undefined,
  workflowTier: TierName | undefined,
  workflowPreset: ModelAliasPreset | undefined
): Promise<NodeExecutionResult> {
  const execution = beginExecution(ctx, node);
  await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    {
      ...execution,
      lifecycle: { status: 'started' },
    }
  );
  const progress: LoopGroupProgress = { usage: {}, lastStartedIteration: 0 };
  let result: LoopGroupBodyResult;
  try {
    result = await executeLoopGroupBody(
      ctx,
      node,
      execution,
      progress,
      workflowProvider,
      workflowModel,
      workflowTier,
      workflowPreset
    );
  } catch (error) {
    // These interruptions leave lifecycle ownership to run recovery.
    if (
      isWorkflowExecutionInterruption(error) ||
      error instanceof NodeEventWriteError ||
      error instanceof RunSourceUnreadableError
    )
      throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    getLog().error({ err, nodeId: node.id }, 'loop_group_node.execution_failed');
    result = {
      state: 'failed',
      output: '',
      error: err.message,
      failureKind: 'unknown',
      ...progress.usage,
      loopIterations: progress.lastStartedIteration,
    };
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `Loop-group node '${node.id}' failed: ${err.message}`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
  }
  return recordGroupResult(ctx, execution, result);
}

async function recordGroupResult(
  ctx: RunLayersContext,
  execution: NodeExecutionRecord,
  result: LoopGroupBodyResult
): Promise<NodeExecutionResult> {
  if (result.execution?.lifecycle.status === 'suspended') return result;
  let lifecycle: Parameters<typeof finishNodeExecution>[1];
  switch (result.state) {
    case 'failed':
      lifecycle = {
        status: 'failed',
        error: result.error,
        ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
        ...(result.providerFailure !== undefined
          ? { providerFailure: result.providerFailure }
          : {}),
      };
      break;
    case 'skipped':
      lifecycle = { status: 'skipped', reason: 'trigger_rule', cause: result.cause };
      break;
    case 'running': {
      const suspensionPoint = result.suspensionPoint;
      // A deferred body gate or terminal wait leaves the group running with its usage.
      if (suspensionPoint === undefined) return runningGroupOutput(execution, result);
      lifecycle = { status: 'suspended', point: suspensionPoint };
      break;
    }
    default:
      lifecycle = { status: 'completed' };
  }

  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(execution, lifecycle, {
      output: {
        text: result.output,
        ...('structuredOutput' in result ? { structured: result.structuredOutput } : {}),
      },
      costUsd: result.costUsd,
      tokens: result.tokens,
      tokensUnknown: result.tokensUnknown,
      diagnostics: { loopIterations: result.loopIterations },
    })
  );
}

function runningGroupOutput(
  execution: NodeExecutionRecord,
  result: LoopGroupBodyResult
): NodeExecutionResult {
  return {
    ...serializeNodeOutput(execution),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
    ...(result.tokensUnknown ? { tokensUnknown: true } : {}),
  };
}

async function executeLoopGroupBody(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  execution: NodeExecutionRecord,
  progress: LoopGroupProgress,
  workflowProvider: string | undefined,
  workflowModel: string | undefined,
  workflowTier: TierName | undefined,
  workflowPreset: ModelAliasPreset | undefined
): Promise<LoopGroupBodyResult> {
  const { platform, conversationId, workflowRun } = ctx;
  const group = node.loop_group;
  const bodyNodes = resolvedBodyNodes(group);
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  const stepName = ctx.stepNamePrefix + node.id;
  const run: LoopGroupRun = {
    ctx,
    node,
    bodyNodes,
    stepName,
    bodyStepNamePrefix: `${stepName}.`,
    directBodyIds: new Set(bodyNodes.map(n => n.id)),
    msgContext,
    execution,
    progress,
    workflowProvider,
    workflowModel,
    workflowTier,
    workflowPreset,
    resume: readLoopGroupResume(ctx, node, bodyNodes, stepName, progress),
  };
  const { resume } = run;

  const finalized = await finalizeGroupOnBareApprove(run);
  if (finalized !== undefined) return finalized;
  if (resume.isEscalatedWaitResume) {
    const waiting = await resumeTerminalWait(run);
    if (waiting !== undefined) return waiting;
  }
  const loopPrevOutputs = resume.isLoopResume ? restoreLoopPrevOutputs(run) : undefined;
  const resumedCompletion = await completeEscalatedResume(run, loopPrevOutputs);
  if (resumedCompletion !== undefined) return resumedCompletion;

  const state = initialLoopGroupState(run, loopPrevOutputs);
  const { startIteration, iterationLimit } = resume;
  for (let i = startIteration; i <= iterationLimit; i++) {
    const result = await runLoopGroupIteration(run, state, i);
    if (result !== undefined) return result;
  }

  // Max iterations exceeded.
  const errorMsg = `Loop-group node '${node.id}' exceeded max iterations (${String(iterationLimit)}) ${describeUnmetCompletion(group)}`;
  getLog().warn(
    { nodeId: node.id, maxIterations: iterationLimit, signal: group.until },
    'loop_group_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return {
    state: 'failed',
    output: state.lastOutput,
    error: errorMsg,
    failureKind: 'max_iterations',
    ...progress.usage,
    // A bare approve past the cap resumes beyond iterationLimit and runs nothing.
    loopIterations: Math.max(iterationLimit, startIteration - 1),
  };
}
