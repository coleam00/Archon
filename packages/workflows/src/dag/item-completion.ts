/**
 * What the write that completes a top-level run records about its item beside the status:
 * the result its asks-settled bindings will read, and the stop when nothing follows the run.
 */
import type { RunEndedStarts, WorkflowDeps } from '../deps';
import { isFinalOutcome } from '../completed-outcome';
import type { JsonValue } from '../output-ref';
import { asksResultMetadata, itemStoppedMetadata } from '../schemas/run-metadata';
import type { ReturnedResult, RunTerminalContext } from './run-terminal';

/** The asking run's result, kept on its row for the bindings its settled asks start. */
export function keptAsksResult(
  completion: Parameters<WorkflowDeps['store']['completeWorkflowRun']>[3],
  value: JsonValue | undefined
): Record<string, string> {
  return completion?.asks === undefined || value === undefined ? {} : asksResultMetadata(value);
}

/**
 * The stop this completion records, or undefined when the run's item keeps moving or the
 * run is on none. An item stops when a top-level run on it completes with a declared outcome
 * that is not final, its end started nothing, and it left no ask or wait: nothing follows,
 * so the attention queue lists the item until a newer run starts on it. Without a reader of
 * run-ended bindings the engine cannot know that nothing started, so it records nothing.
 * A declared `returns.summary` is read from the result, which is read for it.
 */
export function stoppedItem(
  { deps, workflow, workflowRun }: Pick<RunTerminalContext, 'deps' | 'workflow' | 'workflowRun'>,
  { outcome, asks, waits }: ReturnedResult,
  starts: RunEndedStarts,
  result: JsonValue | undefined
): Record<string, unknown> | undefined {
  if (workflowRun.parent_run_id !== null || workflowRun.item_id === null) return undefined;
  if (outcome === undefined || deps.runEndedStarts === undefined) return undefined;
  if (isFinalOutcome(workflow, outcome.value)) return undefined;
  if ((asks?.length ?? 0) > 0 || (waits?.length ?? 0) > 0) return undefined;
  if (starts.receipts.length > 0 || starts.linked.length > 0) return undefined;
  const field = workflow.result?.summary;
  const value =
    field !== undefined && result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result[field]
      : undefined;
  return itemStoppedMetadata(typeof value === 'string' ? value : null);
}
