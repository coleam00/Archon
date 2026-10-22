import { isWorkflowExecutionInterruption } from '../execution-interruption';
import { unreportedChildUsage } from './child-usage';
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
  if (!isWorkflowExecutionInterruption(error)) return durable;
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
      contributions.push(
        unreportedChildUsage(childRunUsage(child), durable.reportedChildUsage, child.id)
      );
    }
  }
  // This roll-up is telemetry only. Recovery still seeds from durable node events.
  return {
    costUsd: sumReportedCost(contributions),
    tokens: sumFanOutTokens(contributions),
    tokensUnknown: contributions.some(usage => usage.tokensUnknown),
  };
}
