/**
 * The open-work inbox shared by the CLI and the API. Candidates are read without a limit so
 * an item whose end holds cannot consume the requested page. `readHoldingItemEnd` owns the
 * end rule; a run on no item remains eligible under the store's status and adopter rules.
 */
import { readHoldingItemEnd, type ItemEndStore } from '@archon/workflows/item-end';
import { readRunItemId } from '@archon/workflows/item-of-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';

type OpenWorkStore = ItemEndStore & Pick<IWorkflowStore, 'findOpenWorkRuns' | 'getWorkflowRun'>;

export async function readOpenWorkRuns(
  store: OpenWorkStore,
  options: { codebaseId?: string; limit: number }
): Promise<WorkflowRun[]> {
  const candidates = await store.findOpenWorkRuns({
    codebaseId: options.codebaseId,
    limit: null,
  });
  const runs: WorkflowRun[] = [];
  for (const run of candidates) {
    if (runs.length === options.limit) break;
    const itemId = await readRunItemId(store, run);
    if (itemId !== null && (await readHoldingItemEnd(store, itemId)) !== null) continue;
    runs.push(run);
  }
  return runs;
}
