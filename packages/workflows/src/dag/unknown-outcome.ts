/**
 * The rule that a node whose outcome is unknown is not run again by itself. When a failure
 * reaches the run's top level (a top-level node settles `failed`) and the run's stored node
 * records hold a node whose latest record is a failure of kind `outcome_unknown`, the run
 * fails right then with stop reason `outcome_unknown`, also when a parallel wait or gate of
 * the same pass already paused it. Nothing after that continues it: the walk stops at its
 * next status check, and every wait, release, pause and claim compares and sets on a
 * running row. Inside an aggregate the failure is an ordinary failed instance; an
 * `all_done` join absorbs it and the run goes on as before.
 */
import { spellWorkflowCommand } from '../deps';
import { measureFailedChangeSize } from '../change-size';
import { logWorkflowError } from '../logger';
import { safeSendMessage } from '../platform-messages';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from '../store';
import type { WorkflowRun } from '../schemas/workflow-run';
import { buildRunNodeStates } from '../terminal-record';
import { getLog } from './log';
import type { RunLayersContext } from './run-context';
import { failRun } from './run-terminal';

/** The step paths whose latest stored record is a failure of kind `outcome_unknown`. */
export async function unknownOutcomeNodes(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  run: Pick<WorkflowRun, 'id' | 'metadata'>
): Promise<string[]> {
  const events = (await store.listEventsForRuns([run.id], NODE_STATE_EVENT_TYPES)).get(run.id);
  return buildRunNodeStates(run, events ?? [])
    .filter(node => node.state === 'failed' && node.failure_kind === 'outcome_unknown')
    .map(node => node.node_id);
}

/**
 * Called where a node of a walk settled `failed`. At the top level (an empty step prefix),
 * fails the run with stop reason `outcome_unknown` when its records hold such a node;
 * otherwise the failure goes on as any failure. Nested walks (loop bodies, composed
 * instances) always have a prefix: there the failure is an instance's, which its aggregate
 * judges. A second call, or a run another writer ended first, is a no-op: the failure write
 * never moves a terminal row.
 */
export async function endRunOnUnknownOutcome(ctx: RunLayersContext): Promise<void> {
  if (ctx.stepNamePrefix !== '') return;
  const { deps, workflowRun, platform, conversationId } = ctx;
  const nodes = await unknownOutcomeNodes(deps.store, workflowRun);
  if (nodes.length === 0) return;
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
  await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
    workflowId: workflowRun.id,
  });
  const changeSize = await measureFailedChangeSize(
    deps.store,
    workflowRun,
    ctx.cwd,
    ctx.execContext
  );
  // The pass still holds the run's live owner, so a row its own parallel wait or gate
  // paused is its own to fail.
  await failRun(
    deps,
    workflowRun,
    ctx.workflowName,
    failMsg,
    'outcome_unknown',
    'dag.outcome_unknown_fail',
    { changeSize, includePaused: true }
  );
}
