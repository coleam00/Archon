/**
 * Where a walk reaches a failure whose outcome is unknown (`unknownOutcomes`) that the failed
 * node owns: the walk starts nothing more, and at the top level the pass fails the run with
 * stop reason `outcome_unknown`, under its own claim, so also a row its own parallel wait or
 * gate paused.
 */
import { spellWorkflowCommand } from '../deps';
import { measureFailedChangeSize } from '../change-size';
import { logWorkflowError } from '../logger';
import { safeSendMessage } from '../platform-messages';
import { executionClaim } from '../store';
import { composeFanOutScopeSegment } from '../fan-out-identity';
import { loopBodyStepNamePrefix } from '../graph-plan';
import type { DagNode } from '../schemas';
import { readUnknownOutcomes, type UnknownOutcome } from '../unknown-outcome';
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
 * Called where a node of a walk settled: whether it failed over a live unknown outcome it
 * owns. When it did, the walk starts nothing more, and the top-level walk fails the run.
 * Only what the failed node ran decides: its own record, the body of the loop group it is,
 * or the instances of the composed fan-out it is. Another node's unknown outcome does not
 * make an ordinary failure stop the walk.
 *
 * A loop body is told by the record's loop frame, not by a `<step>.` prefix: node ids may
 * contain dots (see `dag-structure`), so a top-level `prep.write` is not the body of a loop
 * group `prep`. A composed scope can be told by its prefix, since its marker cannot occur in
 * a node id.
 */
export async function reachedUnknownOutcome(
  ctx: RunLayersContext,
  node: Pick<DagNode, 'id'>,
  settled: LayerNodeResult
): Promise<boolean> {
  if (settled.output.state !== 'failed') return false;
  const live = (await readUnknownOutcomes(ctx.deps.store, ctx.workflowRun)).filter(
    outcome => outcome.absorbedBy === undefined
  );
  if (!live.some(outcome => ownedBy(ctx, node.id, outcome))) return false;
  if (ctx.stepNamePrefix === '')
    await failRunOnUnknownOutcome(
      ctx,
      live.map(outcome => outcome.path)
    );
  return true;
}

function ownedBy(
  { stepNamePrefix, loopGroupPath }: Pick<RunLayersContext, 'stepNamePrefix' | 'loopGroupPath'>,
  nodeId: string,
  { path, loopPath }: UnknownOutcome
): boolean {
  const step = stepNamePrefix + nodeId;
  if (path === step) return true;
  // A record without node metadata cannot say what ran it: err toward stopping.
  if (loopPath === undefined) return true;
  const depth = loopGroupPath.length;
  const inBody =
    loopPath[depth]?.groupId === nodeId &&
    loopGroupPath.every((frame, index) => loopPath[index]?.groupId === frame.groupId) &&
    path.startsWith(loopBodyStepNamePrefix(step));
  return (
    inBody ||
    path.startsWith(`${stepNamePrefix}${composeFanOutScopeSegment(nodeId, loopGroupPath)}__`)
  );
}
