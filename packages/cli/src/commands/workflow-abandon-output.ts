import type { WorkflowHost } from '@archon/core/workflows/host-store';

export function formatAbandonResult(
  runId: string,
  {
    run,
    cascadeFailures,
    cleanupWarnings,
    releasedWorktrees,
    blockedParentRunId,
    owner,
  }: Awaited<ReturnType<WorkflowHost['operations']['abandonWorkflow']>>
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
