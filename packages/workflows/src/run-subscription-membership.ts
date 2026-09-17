/**
 * Ancestry-based membership check for the future per-run event subscription
 * (`IWorkflowEngine.subscribe(runId, listener)`, M6).
 *
 * A subscriber on target run `T` must also see events from every sub-run `T`
 * spawns (`workflow:` nodes), no matter how deeply nested. Rather than
 * re-polling `T`'s descendants on every event (an N+1 query that grows with
 * the tree), this walks UP from the event's own run `R` via the existing
 * `getRunAncestry` primitive: `R` belongs to `T`'s subscription iff `R === T`
 * or `T` is one of `R`'s ancestors. That walk is bounded by the same depth
 * cap `getRunAncestry` already enforces, so it stays O(depth) per event
 * regardless of how many sibling sub-runs exist.
 */
import type { WorkflowRun } from './schemas';

/** Narrow dependency: only the ancestry walk is needed, not the full store. */
export type GetRunAncestry = (runId: string) => Promise<WorkflowRun[]>;

/**
 * Does an event for run `eventRunId` belong to the subscription for target
 * run `targetRunId`? True if they're the same run, or if `targetRunId`
 * appears in `eventRunId`'s ancestry (i.e. `eventRunId` is a descendant of
 * `targetRunId`, direct or nested).
 */
export async function isRunInSubscriptionScope(
  eventRunId: string,
  targetRunId: string,
  getRunAncestry: GetRunAncestry
): Promise<boolean> {
  if (eventRunId === targetRunId) return true;
  const ancestry = await getRunAncestry(eventRunId);
  return ancestry.some(ancestor => ancestor.id === targetRunId);
}
