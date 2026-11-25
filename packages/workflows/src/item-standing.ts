/**
 * Where an item stands: the one rule every reader of an item places it by. The item read
 * (`item-read.ts`) derives it on each read from the facts it lists; nothing about it is stored.
 */
import { z } from 'zod';
import { runPackKey } from './run-pack';
import { readItemFinal } from './schemas/run-metadata';
import { displayedRunOutcome, type WorkflowRun } from './schemas/workflow-run';

/**
 * `runId` is the own run that says which workflow the item is on: the latest started of its
 * runs that have not ended (pending, running or paused), else the latest started of all.
 * Null when the item has no readable run. The run's `workflow` and `pack` are in `runs`.
 *
 * `pack` is the key of the pack the item counts for: the pack `runId`'s run recorded at
 * dispatch, else the one the newest of its other runs recorded. Only the key is needed, so
 * a run from an older build that recorded the key without the workflow's name still counts.
 * Read from what runs recorded, never from a run's public name (`run-pack.ts`). Null when no
 * run of the item recorded one.
 *
 * Its parts are the items joined to it by an active `part_of` link pointing at it. What it
 * depends on are the items its own active `depends_on` links point at.
 *
 * `state`, the first that holds:
 * - `running`: a run of the item is running.
 * - `waiting`: a run is paused, a question is open on the item, or it waits for an event
 *   outside Archon.
 * - `queued`: a start is admitted or waits for admission and has not begun.
 * - `done`: its change merged, whatever its last run did, or the run `runId` names completed
 *   with an outcome its workflow declares final (`returns.final`), or it has parts and every
 *   one of them is done.
 * - `resting`, when it has parts: its work goes on in them, so it never needs a decision of
 *   its own, whatever its last run did.
 * - `failed`: that run failed.
 * - `waiting`, when an item it depends on is not done: it waits for that item.
 * - `stopped`: that run completed with an outcome and nothing followed: the engine recorded
 *   the stop (the attention queue's `stopped` item), or the run is from before stops and
 *   final outcomes were recorded, or its next start was refused or never prepared.
 * - `resting`: nothing runs, is queued or waits, and none of the above: its last run was
 *   cancelled or declared no outcome, or it has no run.
 *
 * A `failed` or `stopped` item needs a decision: it stays so until a newer run starts on it
 * or its change merges. An item reads `done` only when the engine knows it is.
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
  pack: z.string().nullable(),
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
  /** The item's parts, each with whether it is done (merged, or standing `done`). */
  parts: readonly { done: boolean }[];
  /** What the item depends on, each with whether it is done, as for `parts`. */
  dependsOn: readonly { done: boolean }[];
}): ItemStanding {
  const { runs, parts } = facts;
  const status = (wanted: WorkflowRun['status']): boolean =>
    runs.some(run => run.status === wanted);
  const live = runs.filter(run => ['pending', 'running', 'paused'].includes(run.status));
  const at = live.at(-1) ?? runs.at(-1);
  const stopped = facts.questions.some(question => question.kind === 'stopped');
  const asked = facts.questions.some(question => question.kind !== 'stopped');
  // An item with no parts is not done by them: `every` holds on an empty list.
  const partsDone = parts.length > 0 && parts.every(part => part.done);
  const state = ((): ItemStanding['state'] => {
    if (status('running')) return 'running';
    if (status('paused') || asked || facts.waits.length > 0) return 'waiting';
    if (status('pending') || facts.queued.length > 0 || facts.held.length > 0) return 'queued';
    if (facts.merged || (at !== undefined && readItemFinal(at.metadata)) || partsDone)
      return 'done';
    if (parts.length > 0) return 'resting';
    if (at?.status === 'failed') return 'failed';
    if (facts.dependsOn.some(other => !other.done)) return 'waiting';
    // A completed run with an outcome that nothing followed, recorded as a stop or not.
    const ended = at?.status === 'completed' && displayedRunOutcome(at) !== null;
    return stopped || ended ? 'stopped' : 'resting';
  })();
  const keys = runs.map(runPackKey).filter(key => key !== null);
  const pack = (at === undefined ? null : runPackKey(at)) ?? keys.at(-1) ?? null;
  return { runId: at?.id ?? null, state, pack };
}
