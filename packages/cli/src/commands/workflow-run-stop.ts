/**
 * The parts of `workflow cancel` and `workflow abandon` that act on one run: the operation,
 * its `--json` value and its human lines. The run-id and `--item` forms share them, so
 * both handle a run, and a live owner, the same way.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  CancelRefusedError,
  type CancelWorkflowResult,
  describeAbandonOwner,
  describeReleasedWorktrees,
} from '@archon/core/operations/workflow-operations';

export type AbandonResult = Awaited<ReturnType<WorkflowHost['operations']['abandonWorkflow']>>;

export function abandonOneRun(host: WorkflowHost, runId: string): Promise<AbandonResult> {
  return host.operations.abandonWorkflow(runId, { kind: 'operator' });
}

export function printAbandonResult(
  runId: string,
  {
    run,
    cascadeFailures,
    cleanupWarnings,
    releasedWorktrees,
    blockedParentRunId,
    owner,
  }: AbandonResult
): void {
  for (const line of describeAbandonOwner(owner)) console.log(line);
  console.log(`Abandoned workflow run: ${runId}`);
  console.log(`Workflow: ${run.workflow_name}`);
  for (const line of describeReleasedWorktrees(releasedWorktrees)) console.log(line);
  for (const warning of cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(cascadeFailures, blockedParentRunId);
}

function printRunTreeCancellationWarnings(
  cascadeFailures: number,
  blockedParentRunId: string | null
): void {
  if (cascadeFailures > 0) {
    console.log(
      `Warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check \`archon workflow status\`.`
    );
  }
  if (blockedParentRunId) {
    console.log(
      `Warning: parent run ${blockedParentRunId} was blocked on this sub-run and stays paused.`
    );
    console.log(
      `  Resume it so it reads this sub-run's outcome (archon workflow resume ${blockedParentRunId}) or abandon it too.`
    );
  }
}

export function formatAbandonResult(
  runId: string,
  {
    run,
    cascadeFailures,
    cleanupWarnings,
    releasedWorktrees,
    blockedParentRunId,
    owner,
  }: AbandonResult
) {
  return {
    ok: true,
    runId,
    action: 'abandon',
    status: 'cancelled',
    workflowName: run.workflow_name,
    owner:
      owner.kind === 'stopped'
        ? { outcome: 'stopped', pid: owner.pid }
        : {
            outcome: 'no_owner_answered',
            thisHost: owner.thisHost,
            recordedHost: owner.recordedOwner?.host ?? null,
            recordedPid: owner.recordedOwner?.pid ?? null,
            recordedUid: owner.recordedOwner?.uid ?? null,
            lastActivityAt: owner.lastActivityAt?.toISOString() ?? null,
          },
    ...(releasedWorktrees ? { releasedWorktrees } : {}),
    ...(cleanupWarnings ? { cleanupWarnings } : {}),
    ...(cascadeFailures > 0 ? { cascadeFailures } : {}),
    ...(blockedParentRunId ? { blockedParentRunId } : {}),
  };
}

export async function cancelOneRun(
  host: WorkflowHost,
  runId: string
): Promise<CancelWorkflowResult> {
  try {
    const result = await host.operations.cancelWorkflow(runId, { kind: 'operator' });
    if (result.kind === 'cooperative' && !result.cancelled) {
      throw new Error(`Workflow run ${runId} already finished; nothing to cancel.`);
    }
    return result;
  } catch (error) {
    if (error instanceof CancelRefusedError && error.reason === 'no_owner_answered') {
      throw new Error(`${error.message}\nAbandon it: archon workflow abandon ${runId}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function cancelResultPayload(runId: string, result: CancelWorkflowResult) {
  return {
    ok: true,
    runId,
    action: 'cancel',
    status: 'cancelled',
    processStopped: result.kind === 'stopped',
    workflowName: result.run.workflow_name,
    cleanupWarnings: result.cleanupWarnings,
    ...(result.kind === 'stopped' && result.cascadeFailures > 0
      ? { cascadeFailures: result.cascadeFailures }
      : {}),
    ...(result.kind === 'stopped' && result.blockedParentRunId
      ? { blockedParentRunId: result.blockedParentRunId }
      : {}),
  };
}

export function printCancelResult(runId: string, result: CancelWorkflowResult): void {
  if (result.kind === 'cooperative') {
    console.log(`Cancelled workflow run: ${runId}`);
    console.log(`Workflow: ${result.run.workflow_name}`);
    console.log("It runs inside its parent run's process and stops at its next status check.");
    printCleanupWarnings(result.cleanupWarnings);
    return;
  }
  console.log(`Cancelled detached workflow run: ${runId}`);
  console.log(`Workflow: ${result.run.workflow_name}`);
  console.log('Run owner stopped before run state was changed.');
  printCleanupWarnings(result.cleanupWarnings);
  printRunTreeCancellationWarnings(result.cascadeFailures, result.blockedParentRunId);
}

export function printCleanupWarnings(warnings: readonly string[] = []): void {
  for (const warning of warnings) console.log(`Warning: ${warning}`);
}
