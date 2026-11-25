/**
 * Where a failure reaches the run's top level (a top-level node settles `failed`): when the
 * run holds a live unknown outcome (`liveUnknownOutcomes`), fail the run now with stop reason
 * `outcome_unknown`, under the pass's own claim, so also a row its own parallel wait or gate
 * paused. A failure inside an aggregate is the aggregate's to judge: nested walks always
 * have a step prefix and stop here.
 */
import { spellWorkflowCommand } from '../deps';
import { measureFailedChangeSize } from '../change-size';
import { logWorkflowError } from '../logger';
import { safeSendMessage } from '../platform-messages';
import { executionClaim } from '../store';
import { readLiveUnknownOutcomes } from '../unknown-outcome';
import { getLog } from './log';
import type { DagNode } from '../schemas';
import type { RunLayersContext } from './run-context';
import { failRun } from './run-terminal';

/** Fail the run with stop reason `outcome_unknown` naming `nodes`, under the pass's own claim. */
export async function failRunOnUnknownOutcome(
  ctx: Pick<
    RunLayersContext,
    | 'deps'
    | 'workflowRun'
    | 'workflowName'
    | 'platform'
    | 'conversationId'
    | 'logDir'
    | 'cwd'
    | 'execContext'
    | 'totalCostUsd'
    | 'totalTokens'
  >,
  nodes: readonly string[]
): Promise<void> {
  const { deps, workflowRun, platform } = ctx;
  const named = nodes.map(node => `'${node}'`).join(', ');
  const failMsg =
    `Workflow '${ctx.workflowName}' stopped: the outcome of node${nodes.length > 1 ? 's' : ''} ${named} is unknown, ` +
    `so nothing continues the run by itself. Check what ${nodes.length > 1 ? 'they' : 'it'} did, then resume it ` +
    `(${spellWorkflowCommand(platform, `resume ${workflowRun.id}`)}) or abandon it ` +
    `(${spellWorkflowCommand(platform, `abandon ${workflowRun.id}`)}).`;
  getLog().warn({ workflowRunId: workflowRun.id, nodes }, 'dag.outcome_unknown_run_ended');
  await logWorkflowError(ctx.logDir, workflowRun.id, failMsg, {
    ...(ctx.totalCostUsd !== undefined ? { cost_usd: ctx.totalCostUsd } : {}),
    ...(ctx.totalTokens !== undefined ? { tokens: ctx.totalTokens } : {}),
  }).catch((logErr: Error) => {
    getLog().error(
      { err: logErr, workflowRunId: workflowRun.id },
      'dag.workflow_error_log_write_failed'
    );
  });
  await safeSendMessage(platform, ctx.conversationId, `❌ ${failMsg}`, {
    workflowId: workflowRun.id,
  });
  const changeSize = await measureFailedChangeSize(
    deps.store,
    workflowRun,
    ctx.cwd,
    ctx.execContext
  );
  await failRun(
    deps,
    workflowRun,
    ctx.workflowName,
    failMsg,
    'outcome_unknown',
    'dag.outcome_unknown_fail',
    {
      changeSize,
      ownClaim: executionClaim(workflowRun.metadata),
    }
  );
}

/**
 * After `layer` settled with a failure, whether the walk's own steps hold a live unknown
 * outcome. A walk that does dispatches no further layer: a loop body or composed instance
 * ends there and its aggregate fails over it.
 */
export async function walkHoldsUnknownOutcome(
  ctx: RunLayersContext,
  layer: readonly DagNode[]
): Promise<boolean> {
  if (!layer.some(node => ctx.nodeOutputs.get(node.id)?.state === 'failed')) return false;
  const nodes = await readLiveUnknownOutcomes(ctx.deps.store, ctx.workflowRun);
  return nodes.some(step => step.startsWith(ctx.stepNamePrefix));
}

/** Called where a node of a walk settled `failed`; acts only at the top level. */
export async function endRunAtUnknownOutcome(ctx: RunLayersContext): Promise<void> {
  if (ctx.stepNamePrefix !== '') return;
  const nodes = await readLiveUnknownOutcomes(ctx.deps.store, ctx.workflowRun);
  if (nodes.length > 0) await failRunOnUnknownOutcome(ctx, nodes);
}
