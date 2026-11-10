/**
 * The stored work items no queue pickup can act on, for a queue's idle outcome.
 *
 * Pickup skips a document that does not parse, and leaves an item to a claim its
 * document recorded before claims took an engine lease, because no lease proves that
 * claim's run ended. Both leave the item stuck on every pass. A queue whose pickup claimed nothing names
 * them, so a person looks, instead of reporting an empty queue.
 */

import { stateDocuments } from './state.ts';
import { heldBy, parseWorkItem, type WorkItem } from './workitem.ts';

export interface Stuck {
  readonly name: string;
  readonly reason: string;
}

/** Reads only. `runId` is this run, whose own claims are never stuck. */
export function stuckItems(runId: string): Stuck[] {
  const stuck: Stuck[] = [];
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
    const held = heldBy({ doc, lease: stored.lease });
    if (held !== null && held !== runId && stored.lease?.live !== true) {
      stuck.push({
        name: stored.name,
        reason: `claimed by run ${held}, which holds no engine lease on it; clear the claim with a conditional \`archon state put\``,
      });
    }
  }
  return stuck;
}

/** `idle` itself when nothing is stuck; otherwise each stuck item by name and reason. */
export function idleSummary(idle: string, stuck: readonly Stuck[]): string {
  if (stuck.length === 0) return idle;
  const items = stuck.map(item => `${item.name} (${item.reason})`).join('; ');
  return `Nothing was claimed, but pickup could not act on ${String(stuck.length)} stored item(s), which need a person: ${items}.`;
}
