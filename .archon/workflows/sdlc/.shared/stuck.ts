/**
 * The stored work items no queue pickup can act on, for a queue's idle outcome.
 *
 * Pickup skips a document that does not parse, and holds a claim whose run holds no
 * engine lease on it (a claim written before claims took one), because it never releases
 * a claim it cannot prove ended. And the build queue never picks up an item it recorded
 * `asking` once the run that asked is gone without an answer, as after the wait refused
 * the ask and the failed run was abandoned: only a re-triage starts it over.
 * All three leave the item stuck on every pass. A queue whose pickup claimed nothing names
 * each of them once and ends that run as a failed outcome, so a person looks, instead of
 * reporting an empty queue.
 */

import { state, type StateLease } from 'archon:script';
import { buildWaits } from './build.ts';
import { claimEnded, type HistoryEntry, newest, parseWorkItem, type WorkItem } from './workitem.ts';

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

const REPORTED = 'stuck';

/** Why no pickup can act on a document that parses, or null. */
function stuckReason(doc: WorkItem, lease: StateLease | null, runId: string): string | null {
  const { claim } = doc;
  if (claim !== null && claim.run_id !== runId && lease?.runId !== claim.run_id) {
    return `claimed by run ${claim.run_id}, which holds no engine lease on it; clear the claim with a conditional \`archon state put\``;
  }
  return unansweredAsk(doc, claim === null || claimEnded(claim.run_id, { lease }));
}

/** Record the report on the item; false when it already is the item's newest entry, or another run changed the item first. */
function report(stored: { readonly name: string; readonly revision: number }, doc: WorkItem, entry: HistoryEntry): boolean {
  const last = doc.history.at(-1);
  if (last?.outcome === REPORTED && last.summary === entry.summary) return false;
  return state.put(stored.name, { ...doc, history: newest([...doc.history, entry]) }, { ifRevision: stored.revision }).ok;
}

/**
 * The stuck items this run reports. Each is reported once: the report is recorded on the
 * item as its newest history entry, and an item whose newest entry already is that
 * report, for the same reason, is left out until something else changes it. The record
 * is a conditional write at the revision read, so of several idle runs exactly one
 * reports an item. A document that does not parse cannot carry the record, so every idle
 * run reports it. `runId` is this run, whose own claims are never stuck.
 */
export function stuckItems(runId: string, stage: HistoryEntry['stage']): Stuck[] {
  const at = new Date().toISOString();
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
    const reason = stuckReason(doc, stored.lease, runId);
    if (reason !== null && report(stored, doc, { at, stage, run_id: runId, outcome: REPORTED, summary: reason })) {
      stuck.push({ name: stored.name, reason });
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
