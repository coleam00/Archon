/**
 * The stored work items no queue pickup can act on, for a queue's idle outcome.
 *
 * Pickup skips a document that does not parse, and holds a claim whose run holds no
 * engine lease on it (a claim written before claims took one), because it never releases
 * a claim it cannot prove ended.
 * Both leave the item stuck on every pass. A queue whose pickup claimed nothing names
 * them, so a person looks, instead of reporting an empty queue.
 */

import { stateDocuments } from './state.ts';
import { parseWorkItem } from './workitem.ts';

export interface Stuck {
  readonly name: string;
  readonly reason: string;
}

/** Reads only. `runId` is this run, whose own claims are never stuck. */
export function stuckItems(runId: string): Stuck[] {
  const stuck: Stuck[] = [];
  for (const stored of stateDocuments('work/')) {
    if (stored.value === null) continue;
    let claim: { readonly run_id: string } | null;
    try {
      claim = parseWorkItem(stored.value).claim;
    } catch (error) {
      const reason = `its document does not parse: ${error instanceof Error ? error.message : String(error)}`;
      stuck.push({ name: stored.name, reason });
      continue;
    }
    if (claim !== null && claim.run_id !== runId && stored.lease?.runId !== claim.run_id) {
      stuck.push({
        name: stored.name,
        reason: `claimed by run ${claim.run_id}, which holds no engine lease on it; clear the claim with a conditional \`archon state put\``,
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
