/**
 * The stored work items no queue pickup can act on, for a queue's idle outcome.
 *
 * Pickup skips a document that does not parse, and holds a claim whose run holds no
 * engine lease on it (a claim written before claims took one), because it never releases
 * a claim it cannot prove ended. And the build queue never picks up an item it recorded
 * `asking` once the run that asked is gone without an answer, as after the wait refused
 * the ask and the failed run was abandoned: only a re-triage starts it over.
 * All three leave the item stuck on every pass. A queue whose pickup claimed nothing names
 * them and ends its run as a failed outcome, so a person looks, instead of reporting an
 * empty queue.
 */

import { state } from 'archon:script';
import { buildWaits } from './build.ts';
import { claimEnded, parseWorkItem, type WorkItem } from './workitem.ts';

export interface Stuck {
  readonly name: string;
  readonly reason: string;
}

/**
 * Why an item the build queue recorded `asking` is stuck, or null: no live run holds it,
 * so nothing waits on the question, and no re-triage has started it over since.
 */
function unansweredAsk(doc: WorkItem, unowned: boolean): string | null {
  const build = doc.facts.build;
  if (build?.status !== 'asking' || !unowned || buildWaits(doc)) return null;
  const ask = build.decisions.at(-1);
  const by = ask === undefined ? '' : ` (run ${ask.run_id}, ${ask.decision}: ${ask.reason})`;
  return `issue ${String(doc.subject.number)} is recorded asking${by}, but no run waits on that question; re-triage it to start it over`;
}

/** Reads only. `runId` is this run, whose own claims are never stuck. */
export function stuckItems(runId: string): Stuck[] {
  const stuck: Stuck[] = [];
  for (const stored of state.listValues('work/')) {
    if (stored.value === null) continue;
    let doc: WorkItem;
    try {
      doc = parseWorkItem(stored.value);
    } catch (error) {
      const reason = `its document does not parse: ${error instanceof Error ? error.message : String(error)}`;
      stuck.push({ name: stored.name, reason });
      continue;
    }
    const { claim } = doc;
    const asked = unansweredAsk(doc, claim === null || claimEnded(claim.run_id, stored));
    if (asked !== null) stuck.push({ name: stored.name, reason: asked });
    if (claim !== null && claim.run_id !== runId && stored.lease?.runId !== claim.run_id) {
      stuck.push({
        name: stored.name,
        reason: `claimed by run ${claim.run_id}, which holds no engine lease on it; clear the claim with a conditional \`archon state put\``,
      });
    }
  }
  return stuck;
}

/**
 * The outcome of a run whose pickup claimed nothing: `idle` itself, healthy, when nothing
 * is stuck; otherwise each stuck item by name and reason, not healthy, which the
 * workflow's `outcome_field` records as a failed outcome.
 */
export function idleOutcome(idle: string, stuck: readonly Stuck[]): { summary: string; healthy: boolean } {
  if (stuck.length === 0) return { summary: idle, healthy: true };
  const items = stuck.map(item => `${item.name} (${item.reason})`).join('; ');
  return {
    summary: `Nothing was claimed, but pickup could not act on ${String(stuck.length)} stored item(s), which need a person: ${items}.`,
    healthy: false,
  };
}
