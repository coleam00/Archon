/**
 * The stored work items no queue pickup can act on, for a queue's idle outcome.
 *
 * Pickup skips a document that does not parse, on every pass. A queue whose pickup
 * claimed nothing names them, so a person looks, instead of reporting an empty queue.
 */

import { stateDocuments } from './state.ts';
import { parseWorkItem } from './workitem.ts';

export interface Stuck {
  readonly name: string;
  readonly reason: string;
}

/** Reads only. */
export function stuckItems(): Stuck[] {
  const stuck: Stuck[] = [];
  for (const stored of stateDocuments('work/')) {
    if (stored.value === null) continue;
    try {
      parseWorkItem(stored.value);
    } catch (error) {
      const reason = `its document does not parse: ${error instanceof Error ? error.message : String(error)}`;
      stuck.push({ name: stored.name, reason });
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
