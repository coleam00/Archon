/**
 * The provider usage-limit wait a failed pass takes instead of failing, read where the
 * run's terminal tally ends.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowUsageLimitWaitContext } from '../schemas';
import { isProviderLimit, rootFailures, type ProviderLimitFailure } from '../executor-shared';
import type { OutcomeUnknownHold } from '../outcome-unknown';
import { safeSendMessage } from '../platform-messages';
import { getLog } from './log';
import { statusAfterPauseFailure } from './pause';
import type { RunTerminalContext } from './run-terminal';

/**
 * The wait a failed pass takes instead of failing, when every failed node with no failure
 * upstream of it ({@link rootFailures}) either hit a provider usage limit whose reset the provider
 * reported, or hit a rate limit that outlasted its retries (deadline: its reported reset
 * when still ahead, else a jittered backoff). The run cannot progress before the last of
 * those deadlines, so it waits for it if it is still ahead. An expired usage reset does not prevent waiting
 * for another node's later deadline: continuation retries both failed nodes. Any other
 * failure, a usage limit without a reported reset, no deadline still ahead,
 * `autoResumeOnQuotaReset: false`, or a container run (the continuation host does not
 * continue one) leaves the run to fail, and so does a run holding an unknown outcome,
 * which may sit downstream of the limit (`always_run`, `all_done`). Only the typed class
 * says a limit is hit; the error text never does.
 */
async function usageLimitWait(
  ctx: RunTerminalContext,
  hold: OutcomeUnknownHold | undefined
): Promise<
  { wait: WorkflowUsageLimitWaitContext; cause: ProviderLimitFailure['class'] } | undefined
> {
  const { deps, workflowRun, config, execContext } = ctx;
  const skip = async (
    nodeId: string,
    reason:
      | 'reset_unavailable'
      | 'disabled'
      | 'reset_passed'
      | 'container_unsupported'
      | 'outcome_unknown'
  ): Promise<undefined> => {
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'quota_resume_skipped',
      step_name: nodeId,
      data: { reason },
    });
    return undefined;
  };
  const now = Date.now();
  let latest:
    | { nodeId: string; resumeAt: number; cause: ProviderLimitFailure['class'] }
    | undefined;
  for (const { nodeId, output } of rootFailures(ctx.workflow.nodes, ctx.nodeOutputs)) {
    const failure = output.providerFailure;
    if (!isProviderLimit(failure)) return undefined;
    const resumeAt = ctx.providerLimitDeadline(failure, now);
    if (resumeAt === undefined) return skip(nodeId, 'reset_unavailable');
    if (latest === undefined || resumeAt > latest.resumeAt)
      latest = { nodeId, resumeAt, cause: failure.class };
  }
  if (latest === undefined) return undefined;
  if (hold !== undefined) return skip(latest.nodeId, 'outcome_unknown');
  if (config.workflows?.autoResumeOnQuotaReset === false) return skip(latest.nodeId, 'disabled');
  if (latest.resumeAt <= now) return skip(latest.nodeId, 'reset_passed');
  if (execContext.kind === 'container') return skip(latest.nodeId, 'container_unsupported');
  return {
    wait: {
      owner: 'node',
      nodeId: latest.nodeId,
      kind: 'quota',
      pauseId: randomUUID(),
      waitingSince: new Date(now).toISOString(),
      resumeAt: new Date(latest.resumeAt).toISOString(),
    },
    cause: latest.cause,
  };
}

/** Pause the run on a provider-limit wait. False when the pass must fail instead. */
export async function pauseForUsageLimit(
  ctx: RunTerminalContext,
  hold: OutcomeUnknownHold | undefined
): Promise<boolean> {
  const { deps, workflowRun, workflow, platform, conversationId } = ctx;
  const limit = await usageLimitWait(ctx, hold);
  if (limit === undefined) return false;
  const { wait, cause } = limit;
  try {
    await deps.store.pauseWorkflowRunForWait(workflowRun.id, wait, {
      kind: 'started',
      stepName: wait.nodeId,
    });
  } catch (pauseError) {
    // A run cancelled or paused meanwhile keeps that status, exactly as the failure
    // branches below leave it.
    const status = await statusAfterPauseFailure(deps.store, workflowRun.id, pauseError);
    if (status === 'running') throw pauseError;
    getLog().warn({ workflowRunId: workflowRun.id }, 'dag.usage_limit_wait_status_changed');
    return true;
  }
  getLog().info(
    { workflowRunId: workflowRun.id, nodeId: wait.nodeId, resumeAt: wait.resumeAt, cause },
    'dag.usage_limit_wait_started'
  );
  await safeSendMessage(
    platform,
    conversationId,
    cause === 'rate_limited'
      ? `⏸️ Workflow '${workflow.name}' hit a provider rate limit at node '${wait.nodeId}' ` +
          `and ran out of retries. It tries again at ${wait.resumeAt}; resume it to try ` +
          'sooner, or abandon it to stop it.'
      : `⏸️ Workflow '${workflow.name}' hit a provider usage limit at node '${wait.nodeId}'. ` +
          `It waits until the limit resets at ${wait.resumeAt}, then continues.`,
    { workflowId: workflowRun.id }
  );
  return true;
}
