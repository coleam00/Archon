import { createLogger } from '@archon/paths';
import type { ItemReadSource, ItemRun } from './item-read';
import { readCompletedRunResult, resultCommitOf } from './run-result';
import { getTerminalRecord } from './terminal-record';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';

export function readItemRunResult(
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): Pick<ItemRun, 'hasResult' | 'resultCommit'> {
  try {
    return {
      hasResult: readCompletedRunResult(run, events).kind === 'result',
      resultCommit:
        run.status === 'completed' ? resultCommitOf(getTerminalRecord(run.status, events)) : null,
    };
  } catch {
    createLogger('workflow.item-read').warn(
      { workflowRunId: run.id },
      'item_read.terminal_record_unreadable'
    );
    return { hasResult: false, resultCommit: null };
  }
}

export async function itemCompletionEvents(
  source: ItemReadSource,
  runs: readonly WorkflowRun[]
): Promise<ReadonlyMap<string, WorkflowEventRow[]>> {
  const completedIds = runs.filter(run => run.status === 'completed').map(run => run.id);
  if (completedIds.length === 0) return new Map();
  return source.store.listEventsForRuns(completedIds, ['workflow_completed']);
}
