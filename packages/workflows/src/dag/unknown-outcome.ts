/**
 * Where a walk reaches a failure whose outcome is unknown (`liveUnknownOutcomes`): the walk
 * starts nothing more, and at the top level the pass fails the run with stop reason
 * `outcome_unknown`, under its own claim, so also a row its own parallel wait or gate paused.
 */
import { spellWorkflowCommand } from '../deps';
import { measureFailedChangeSize } from '../change-size';
import { logWorkflowError } from '../logger';
import { safeSendMessage } from '../platform-messages';
import { executionClaim } from '../store';
import { readLiveUnknownOutcomes } from '../unknown-outcome';
import { getLog } from './log';
import type { LayerNodeResult, RunLayersContext } from './run-context';
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
 * Called where a node of a walk settled: whether it failed while the run holds a live
 * unknown outcome. When it did, the walk starts nothing more, and the top-level walk fails
 * the run. Which node the outcome belongs to is not asked here: any failure stops the walk
 * while one is live, which errs toward stopping.
 */
export async function reachedUnknownOutcome(
  ctx: RunLayersContext,
  settled: LayerNodeResult
): Promise<boolean> {
  if (settled.output.state !== 'failed') return false;
  const live = await readLiveUnknownOutcomes(ctx.deps.store, ctx.workflowRun);
  if (live.length === 0) return false;
  if (ctx.stepNamePrefix === '') await failRunOnUnknownOutcome(ctx, live);
  return true;
}
