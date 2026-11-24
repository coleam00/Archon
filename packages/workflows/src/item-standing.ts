/**
 * Where an item stands: the one rule every reader of an item places it by. The item read
 * (`item-read.ts`) derives it on each read from the facts it lists; nothing about it is stored.
 */
import { z } from 'zod';
import type { WorkflowRun } from './schemas/workflow-run';

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
 * - `resting`, for an item with a recorded merge: its change landed, whatever its last run did.
 * - `failed`: the run `runId` names failed.
 * - `stopped`: that run completed where nothing starts and left no ask or wait (the
 *   attention queue's `stopped` item).
 * - `resting`: nothing runs, is queued or waits.
 *
 * A `failed` or `stopped` item needs a decision: nothing moves it but a newer run.
 */
export const itemStandingSchema = z.object({
  runId: z.string().nullable(),
  state: z.enum(['running', 'waiting', 'queued', 'failed', 'stopped', 'resting']),
});
export type ItemStanding = z.infer<typeof itemStandingSchema>;

/** The one rule for where an item stands; see `itemStandingSchema`. `runs` are in start order. */
export function itemStanding(facts: {
  runs: readonly Pick<WorkflowRun, 'id' | 'status'>[];
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
    if (facts.merged) return 'resting';
    if (at?.status === 'failed') return 'failed';
    return stopped ? 'stopped' : 'resting';
  })();
  return { runId: at?.id ?? null, state };
}
