/**
 * The open-work inbox shared by the CLI and the API. Candidates are read without a limit so
 * an item whose end holds cannot consume the requested page. `readHoldingItemEnd` owns the
 * end rule; a run on no item remains eligible under the store's status and adopter rules.
 */
import { readHoldingItemEnd, type ItemEndStore } from '@archon/workflows/item-end';
import { readRunItemId, WorkflowRunAncestryCycleError } from '@archon/workflows/item-of-run';
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
  // Reuse shared-tree reads for this listing; the next listing must see a reopen.
  const ancestors = new Map<string, ReturnType<IWorkflowStore['getWorkflowRunForAttention']>>();
  const ends = new Map<string, ReturnType<typeof readHoldingItemEnd>>();
  const runs: WorkflowRun[] = [];
  for (const run of candidates) {
    if (runs.length === options.limit) break;
    const itemId = await readCandidateItemId(store, run, ancestors);
    if (itemId === undefined) continue;
    if (itemId !== null) {
      let read = ends.get(itemId);
      if (read === undefined) {
        read = readHoldingItemEnd(store, itemId);
        ends.set(itemId, read);
      }
      const end = await read;
      if (end !== null && !('type' in end)) continue;
    }
    runs.push(run);
  }
  return runs;
}

async function readAncestor(
  store: OpenWorkStore,
  id: string,
  candidateId: string,
  ancestors: Map<string, ReturnType<IWorkflowStore['getWorkflowRunForAttention']>>
): Promise<WorkflowRun | null> {
  let read = ancestors.get(id);
  if (read === undefined) {
    read = store.getWorkflowRunForAttention(id);
    ancestors.set(id, read);
  }
  const ancestor = await read;
  if (ancestor !== null && 'type' in ancestor) {
    log ??= createLogger('operations.open-work');
    log.error(
      { workflowRunId: candidateId, ancestorRunId: ancestor.runId },
      'open_work_ancestry_unreadable'
    );
    // Unknown ancestry cannot prove a holding end; retain and identify the candidate.
    return null;
  }
  return ancestor;
}

/** Undefined excludes a cyclic candidate; null preserves the resolver's unknown-item behavior. */
async function readCandidateItemId(
  store: OpenWorkStore,
  run: WorkflowRun,
  ancestors: Map<string, ReturnType<IWorkflowStore['getWorkflowRunForAttention']>>
): Promise<string | null | undefined> {
  try {
    return await readRunItemId(
      { getWorkflowRun: id => readAncestor(store, id, run.id, ancestors) },
      run
    );
  } catch (error) {
    if (!(error instanceof WorkflowRunAncestryCycleError)) throw error;
    log ??= createLogger('operations.open-work');
    log.error(
      { workflowRunId: run.id, ancestorRunId: error.ancestorRunId },
      'open_work_ancestry_cycle'
    );
    return undefined;
  }
}
