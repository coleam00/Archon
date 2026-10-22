import { ParentStatusReadError } from '../parent-status-read';
import { readSubrunMetadata } from '../schemas';
import type { IWorkflowStore } from '../store';
import { childRunUsage } from './child-run';
import { sumReportedCost, sumFanOutTokens, type RunUsageFigures } from './usage';

export async function readInterruptedRunUsage(
  store: Pick<IWorkflowStore, 'getDagResumeSnapshot' | 'findChildRuns'>,
  runId: string,
  error: unknown
): Promise<RunUsageFigures> {
  const durable = await store.getDagResumeSnapshot(runId);
  if (!(error instanceof ParentStatusReadError)) return durable;
  const unresolvedChildren = new Set(
    [...(durable.unfinishedInvocations?.values() ?? [])]
      .filter(
        execution =>
          execution.node.kind === 'workflow' &&
          (execution.lifecycle.status === 'started' || execution.lifecycle.status === 'suspended')
      )
      .map(execution => execution.path)
  );
  if (unresolvedChildren.size === 0) return durable;
  const contributions: RunUsageFigures[] = [durable];
  for (const child of await store.findChildRuns(runId)) {
    const { parentNodeId } = readSubrunMetadata(child.metadata);
    if (parentNodeId !== undefined && unresolvedChildren.has(parentNodeId)) {
      contributions.push(childRunUsage(child));
    }
  }
  // Unresolved child spend has no parent node event yet. Include it in this
  // run's telemetry only; recovery seeds from events and later charges the
  // child's full outcome once, rather than replaying this temporary roll-up.
  return {
    costUsd: sumReportedCost(contributions),
    tokens: sumFanOutTokens(contributions),
    tokensUnknown: contributions.some(usage => usage.tokensUnknown),
  };
}
