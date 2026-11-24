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
 * `state`, the first that holds: `running`, a run of the item is running; `waiting`, a run
 * is paused, a question is open on the item, or it waits for an event outside Archon;
 * `queued`, a start is admitted or waits for admission and has not begun; `failed`, the run
 * `runId` names failed; `resting`, nothing runs, is queued or waits, so nothing moves the
 * item until something starts a run on it.
 */
export const itemStandingSchema = z.object({
  runId: z.string().nullable(),
  state: z.enum(['running', 'waiting', 'queued', 'failed', 'resting']),
});
export type ItemStanding = z.infer<typeof itemStandingSchema>;

/** The one rule for where an item stands; see `itemStandingSchema`. `runs` are in start order. */
export function itemStanding(facts: {
  runs: readonly Pick<WorkflowRun, 'id' | 'status'>[];
  queued: readonly unknown[];
  held: readonly unknown[];
  waits: readonly unknown[];
  questions: readonly unknown[];
}): ItemStanding {
  const { runs } = facts;
  const status = (wanted: WorkflowRun['status']): boolean =>
    runs.some(run => run.status === wanted);
  const live = runs.filter(run => ['pending', 'running', 'paused'].includes(run.status));
  const at = live.at(-1) ?? runs.at(-1);
  const state = status('running')
    ? 'running'
    : status('paused') || facts.questions.length > 0 || facts.waits.length > 0
      ? 'waiting'
      : status('pending') || facts.queued.length > 0 || facts.held.length > 0
        ? 'queued'
        : at?.status === 'failed'
          ? 'failed'
          : 'resting';
  return { runId: at?.id ?? null, state };
}
