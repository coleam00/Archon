/**
 * One item is worked by at most one run of a workflow at a time. Every admission decision
 * (a new start, a hand start's slot, a drain, a pending run's claim, a failed run's resume)
 * reads the live runs on items and decides with these functions, so the rule has one owner.
 * Nothing about the item is stored: the rule reads runs and start requests.
 */
import { TERMINAL_WORKFLOW_STATUSES, type WorkflowRunStatus } from './schemas/run-status';

/** A non-terminal top-level run on an item, as a store reads it for admission. */
export interface ItemRunRow {
  id: string;
  workflow_name: string;
  item_id: string;
  status: WorkflowRunStatus;
  /** Whether the run has an admitted start request. */
  admitted: boolean;
}

/**
 * Whether a run holds its item for its workflow. A run holds it from admission until it is
 * terminal, paused runs included. A pending run with no admitted start request is a hand
 * start that has not won its turn: it waits and holds nothing, so a dead hand start never
 * holds an item. A failed run is terminal and holds nothing until it is resumed.
 */
export function holdsItem(run: Pick<ItemRunRow, 'status' | 'admitted'>): boolean {
  if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) return false;
  return run.status !== 'pending' || run.admitted;
}

/** The key the rule is decided on: one workflow on one item. */
export function itemHoldKey(workflow: string, itemId: string): string {
  return JSON.stringify([workflow, itemId]);
}

/** Holders by `itemHoldKey`, the first holder in `rows` per key. Pass rows oldest first. */
export function itemHolders(rows: Iterable<ItemRunRow>): Map<string, string> {
  const held = new Map<string, string>();
  for (const run of rows) {
    const key = itemHoldKey(run.workflow_name, run.item_id);
    if (holdsItem(run) && !held.has(key)) held.set(key, run.id);
  }
  return held;
}

/** The run, other than `runId` itself, that holds `itemId` for `workflow`; undefined when none. */
export function itemHolder(
  held: ReadonlyMap<string, string>,
  start: { runId: string; workflow: string; itemId: string | null }
): string | undefined {
  if (start.itemId === null) return undefined;
  const holder = held.get(itemHoldKey(start.workflow, start.itemId));
  return holder === start.runId ? undefined : holder;
}
