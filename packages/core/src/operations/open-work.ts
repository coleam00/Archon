/**
 * The open-work inbox shared by the CLI and the API. Candidates are read without a limit so
 * an item whose end holds cannot consume the requested page. `readHoldingItemEnd` owns the
 * end rule; a run on no item remains eligible under the store's status and adopter rules.
 */
import { readHoldingItemEnd, type ItemEndStore } from '@archon/workflows/item-end';
import { readRunItemId } from '@archon/workflows/item-of-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import { createLogger } from '@archon/paths';

type OpenWorkStore = ItemEndStore &
  Pick<IWorkflowStore, 'findOpenWorkRuns' | 'getWorkflowRunForAttention'>;

let log: ReturnType<typeof createLogger> | undefined;

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
    const itemId = await readRunItemId(
      {
        getWorkflowRun: async id => {
          const ancestor = await store.getWorkflowRunForAttention(id);
          if (ancestor !== null && 'type' in ancestor) {
            log ??= createLogger('operations.open-work');
            log.error(
              { workflowRunId: run.id, ancestorRunId: ancestor.runId },
              'open_work_ancestry_unreadable'
            );
            // Unknown ancestry cannot prove a holding end; retain and identify the candidate.
            return null;
          }
          return ancestor;
        },
      },
      run
    );
    if (itemId !== null) {
      const end = await readHoldingItemEnd(store, itemId);
      if (end !== null && !('type' in end)) continue;
    }
    runs.push(run);
  }
  return runs;
}
