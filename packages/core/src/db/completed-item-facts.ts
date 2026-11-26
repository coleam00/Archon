/**
 * What the write that completes a top-level run records on its item beside the status, in
 * that write's transaction and only when it won: the asks the run leaves open, the waits it
 * leaves, and the end its finishing outcome records. Each replaces or adds on its own table;
 * this is the one call `completeWorkflowRun` makes for them.
 */
import type { IWorkflowStore } from '@archon/workflows/store';
import { openItemAsksForCompletedRun } from './item-asks';
import { recordCompletedRunEnd } from './item-ends';
import { openItemWaitsForCompletedRun } from './item-waits';
import type { TransactionQuery } from './resource-slots';

export async function recordCompletedItemFacts(
  query: TransactionQuery,
  runId: string,
  result: Parameters<IWorkflowStore['completeWorkflowRun']>[3]
): Promise<void> {
  // The asks replace its workflow's open set on the item, and the waits likewise.
  if (result?.asks !== undefined) await openItemAsksForCompletedRun(query, runId, result.asks);
  if (result?.waits !== undefined) await openItemWaitsForCompletedRun(query, runId, result.waits);
  if (result?.end !== undefined) await recordCompletedRunEnd(query, runId, result.end);
}
