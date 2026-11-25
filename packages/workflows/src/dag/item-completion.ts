/**
 * What the write that completes a top-level run records about its item beside the status:
 * the result its asks-settled bindings will read, and the stop or end its ending causes.
 */
import type { RunEndedStarts, WorkflowDeps } from '../deps';
import { itemFate } from '../completed-outcome';
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

/** What the completing write records about the run's item: a stop, an end, or nothing. */
export type ItemCompletion =
  | { readonly stop: Record<string, unknown> }
  | { readonly end: { readonly reason: string; readonly node: string } };

/**
 * What this completion records about its item, by `itemFate`: the stop when nothing follows
 * the run, so the attention queue lists the item until a newer step starts on it; the end
 * when its outcome finishes the item (`returns.ends`); undefined when the item moves on, the
 * run observes it, or the run is not a top-level run on an item with an outcome. Without a
 * reader of run-ended bindings the engine cannot know that nothing started, so it records
 * nothing. A declared `returns.summary` is read from the result, which is read for it.
 */
export function itemCompletion(
  { deps, workflow, workflowRun }: Pick<RunTerminalContext, 'deps' | 'workflow' | 'workflowRun'>,
  { outcome, asks, waits }: ReturnedResult,
  starts: RunEndedStarts,
  result: JsonValue | undefined
): ItemCompletion | undefined {
  if (workflowRun.parent_run_id !== null || workflowRun.item_id === null) return undefined;
  // An outcome is read only from a completed returns node, so `node` is set with it.
  const node = workflow.returns;
  if (outcome === undefined || node === undefined || deps.runEndedStarts === undefined)
    return undefined;
  const fate = itemFate(workflow, outcome.value, {
    asks: (asks?.length ?? 0) > 0,
    waits: (waits?.length ?? 0) > 0,
    starts: starts.receipts.length > 0 || starts.linked.length > 0,
  });
  const field = workflow.result?.summary;
  const value =
    field !== undefined && result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result[field]
      : undefined;
  const summary = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  if (fate === 'stops') return { stop: itemStoppedMetadata(summary) };
  if (fate !== 'ends') return undefined;
  const reason = `Workflow '${workflow.name}' ended the item with outcome '${outcome.value}'`;
  return { end: { reason: summary === null ? reason : `${reason}: ${summary}`, node } };
}
