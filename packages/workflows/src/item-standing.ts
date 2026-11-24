/**
 * Where an item stands: the one rule every reader of an item places it by. The item read
 * (`item-read.ts`) derives it on each read from the facts it lists; nothing about it is stored.
 */
import { z } from 'zod';
import { readItemFinal } from './schemas/run-metadata';
import { displayedRunOutcome, type WorkflowRun } from './schemas/workflow-run';

/**
 * `runId` is the own run that says which workflow the item is on: the latest started of its
 * runs that have not ended (pending, running or paused), else the latest started of all.
 * Null when the item has no readable run. The run's `workflow` and `pack` are in `runs`.
 *
 * `state`, the first that holds:
 * - `running`: a run of the item is running.
 * - `waiting`: a run is paused, a question is open on the item, or it waits for an event
 *   outside Archon.
 * - `queued`: a start is admitted or waits for admission and has not begun.
 * - `done`: its change merged, whatever its last run did, or the run `runId` names completed
 *   with an outcome its workflow declares final (`returns.final`).
 * - `failed`: that run failed.
 * - `stopped`: that run completed with an outcome and nothing followed: the engine recorded
 *   the stop (the attention queue's `stopped` item), or the run is from before stops and
 *   final outcomes were recorded, or its next start was refused or never prepared.
 * - `resting`: nothing runs, is queued or waits, and none of the above: its last run was
 *   cancelled or declared no outcome, or it has no run.
 *
 * A `failed` or `stopped` item needs a decision: nothing moves it but a newer run. An item
 * reads `done` only when the engine knows it is.
 */
export const ITEM_STANDING_STATES = [
  'running',
  'waiting',
  'queued',
  'failed',
  'stopped',
  'done',
  'resting',
] as const;
export const itemStandingSchema = z.object({
  runId: z.string().nullable(),
  state: z.enum(ITEM_STANDING_STATES),
});
export type ItemStanding = z.infer<typeof itemStandingSchema>;

/** The one rule for where an item stands; see `itemStandingSchema`. `runs` are in start order. */
export function itemStanding(facts: {
  runs: readonly Pick<
    WorkflowRun,
    'id' | 'status' | 'outcome' | 'completed_outcome' | 'metadata'
  >[];
  queued: readonly unknown[];
  held: readonly unknown[];
  waits: readonly unknown[];
  questions: readonly { kind: string }[];
  merged: boolean;
}): ItemStanding {
  const { runs } = facts;
  const status = (wanted: WorkflowRun['status']): boolean =>
    runs.some(run => run.status === wanted);
  const live = runs.filter(run => ['pending', 'running', 'paused'].includes(run.status));
  const at = live.at(-1) ?? runs.at(-1);
  const stopped = facts.questions.some(question => question.kind === 'stopped');
  const asked = facts.questions.some(question => question.kind !== 'stopped');
  const state = ((): ItemStanding['state'] => {
    if (status('running')) return 'running';
    if (status('paused') || asked || facts.waits.length > 0) return 'waiting';
    if (status('pending') || facts.queued.length > 0 || facts.held.length > 0) return 'queued';
    if (facts.merged || (at !== undefined && readItemFinal(at.metadata))) return 'done';
    if (at?.status === 'failed') return 'failed';
    // A completed run with an outcome that nothing followed, recorded as a stop or not.
    const ended = at?.status === 'completed' && displayedRunOutcome(at) !== null;
    return stopped || ended ? 'stopped' : 'resting';
  })();
  return { runId: at?.id ?? null, state };
}
