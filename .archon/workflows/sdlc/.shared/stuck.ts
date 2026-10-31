/**
 * The stored work items a queue's pickup did not take, for that queue's outcome.
 *
 * Pickup skips a document that does not parse, and holds a claim whose run the engine
 * reports no status for, because it never releases a claim it cannot prove terminal.
 * Both leave the item stuck on every pass. A queue whose pickup claimed nothing names
 * them, so a person looks, instead of reporting an empty queue. Given its pickup, a
 * queue also learns which items it would take that a live run holds, so a sweep that
 * cannot claim one says why. Every claim is judged by `claimDisposition`, the rule
 * pickup releases by, and nothing here releases one.
 */

import { claimDisposition, runStatus, stateDocuments } from './state.ts';
import { parseWorkItem, type Pickup, type WorkItem } from './workitem.ts';

export interface Stuck {
  readonly name: string;
  readonly reason: string;
}

/** An item the pickup waits for that another live run holds. */
export interface Held {
  readonly doc: WorkItem;
  readonly run_id: string;
  readonly status: string;
}

/**
 * Reads only. `runId` is this run, whose own claims are neither stuck nor held. A
 * claim pickup would release is neither: the next pickup takes the item back.
 */
export function unclaimedItems(runId: string, pickup?: Pickup): { stuck: Stuck[]; held: Held[] } {
  const stuck: Stuck[] = [];
  const held: Held[] = [];
  for (const stored of stateDocuments('work/')) {
    if (stored.value === null) continue;
    let doc: WorkItem;
    try {
      doc = parseWorkItem(stored.value);
    } catch (error) {
      const reason = `its document does not parse: ${error instanceof Error ? error.message : String(error)}`;
      stuck.push({ name: stored.name, reason });
      continue;
    }
    const claim = doc.claim;
    if (claim === null || claim.run_id === runId) continue;
    const status = runStatus(claim.run_id);
    if (status === null) {
      stuck.push({ name: stored.name, reason: `claimed by run ${claim.run_id}, which the engine reports no status for` });
    } else if (claimDisposition(status) === 'hold' && pickup?.waits(doc) === true) {
      held.push({ doc, run_id: claim.run_id, status });
    }
  }
  return { stuck, held };
}

export function stuckItems(runId: string): Stuck[] {
  return unclaimedItems(runId).stuck;
}

/** `idle` itself when nothing is stuck; otherwise each stuck item by name and reason. */
export function idleSummary(idle: string, stuck: readonly Stuck[]): string {
  if (stuck.length === 0) return idle;
  const items = stuck.map(item => `${item.name} (${item.reason})`).join('; ');
  return `Nothing was claimed, but pickup could not act on ${String(stuck.length)} stored item(s), which need a person: ${items}.`;
}
