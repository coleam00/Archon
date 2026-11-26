/**
 * Where an item stands: the one rule every reader of an item places it by. The item read
 * (`item-read.ts`) derives it on each read from the facts it lists; nothing about it is stored.
 */
import { z } from 'zod';
import { runPackKey } from './run-pack';
import { observesItemRecorded } from './schemas/item-role';
import { readItemFinal } from './schemas/run-metadata';
import { displayedRunOutcome, type WorkflowRun } from './schemas/workflow-run';

/**
 * `runId` is the own run that says which workflow the item is on: the latest started of its
 * steps that have not ended (pending, running or paused), else the latest started of all its
 * steps. A run that observes the item (`observesItemRecorded`) is no step: it moves the item
 * nowhere, so the state below reads past it as the engine's stop and end rules do. Null when
 * the item has no readable step. The run's `workflow` and `pack` are in `runs`.
 *
 * `pack` is the key of the pack the item counts for: the pack `runId`'s run recorded at
 * dispatch, else the one the newest of its other runs, observers included, recorded. Only the key is needed, so
 * a run from an older build that recorded the key without the workflow's name still counts.
 * Read from what runs recorded, never from a run's public name (`run-pack.ts`). Null when no
 * run of the item recorded one.
 *
 * Its parts are the items joined to it by an active `part_of` link pointing at it; a part is
 * done when it merged, an operator's end holds on it, or it stands `done`, as a work order
 * counts its members. What it depends on are the items its own active `depends_on` links
 * point at; one of those is done when it merged or stands `done`, never by an end alone.
 *
 * `state`, the first that holds:
 * - `running`: a run of the item is running.
 * - `waiting`: a run is paused, a question is open on the item, or it waits for an event
 *   outside Archon.
 * - `queued`: a start is admitted or waits for admission and has not begun.
 * - `done`: its change merged, whatever its last run did, or it has parts and every one of
 *   them is done, or the run `runId` names is from before item ends and recorded its outcome
 *   final (`item_final`).
 * - `resting`, when it has parts: its work goes on in them, so it never needs a decision of
 *   its own, whatever its last run did, and an end its outcome recorded does not finish them.
 * - `done`, when the end that holds on it (`readHoldingItemEnd`) is the engine's: a run's
 *   outcome its workflow declares finishes the item (`returns.ends`).
 * - `resting`, when an operator's end holds on it: the end is the decision a failed or
 *   stopped item waited for, and nothing more will happen on it.
 * - `failed`: that run failed.
 * - `waiting`, when an item it depends on is not done: it waits for that item.
 * - `stopped`: that run completed with an outcome and nothing followed: the engine recorded
 *   the stop (the attention queue's `stopped` item), or the run is from before stops were
 *   recorded, or its next start was refused or never prepared; or a
 *   start no run caused was refused on it and nothing started since (`refused_start`).
 * - `resting`: nothing runs, is queued or waits, and none of the above: its last run was
 *   cancelled or declared no outcome, or it has no run.
 *
 * A `failed` or `stopped` item needs a decision: it stays so until a newer run starts on it,
 * its change merges or it is ended. An item reads `done` only when the engine knows it is.
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
  /**
   * Who recorded the end that holds on the item (`readHoldingItemEnd`), or null: the engine,
   * for an outcome that finishes the item (`via: 'engine'`), or an operator.
   */
  ended: 'outcome' | 'operator' | null;
  /** The item's parts, each with whether it is done (merged, ended, or standing `done`). */
  parts: readonly { done: boolean }[];
  /** What the item depends on, each with whether it is done (merged, or standing `done`). */
  dependsOn: readonly { done: boolean }[];
}): ItemStanding {
  const { runs, parts } = facts;
  const steps = runs.filter(run => !observesItemRecorded(run.metadata));
  const status = (wanted: WorkflowRun['status']): boolean =>
    steps.some(run => run.status === wanted);
  const live = steps.filter(run => ['pending', 'running', 'paused'].includes(run.status));
  const at = live.at(-1) ?? steps.at(-1);
  // A stop and a refused start take no answer: they need a decision, so they do not make the
  // item wait. Every other question is one the item waits on.
  const needsDecision = (kind: string): boolean => kind === 'stopped' || kind === 'refused_start';
  const stopped = facts.questions.some(question => needsDecision(question.kind));
  const asked = facts.questions.some(question => !needsDecision(question.kind));
  // An item with no parts is not done by them: `every` holds on an empty list.
  const partsDone = parts.length > 0 && parts.every(part => part.done);
  const state = ((): ItemStanding['state'] => {
    if (status('running')) return 'running';
    if (status('paused') || asked || facts.waits.length > 0) return 'waiting';
    if (status('pending') || facts.queued.length > 0 || facts.held.length > 0) return 'queued';
    if (facts.merged || partsDone || (at !== undefined && readItemFinal(at.metadata)))
      return 'done';
    if (parts.length > 0) return 'resting';
    if (facts.ended === 'outcome') return 'done';
    if (facts.ended === 'operator') return 'resting';
    if (at?.status === 'failed') return 'failed';
    if (facts.dependsOn.some(other => !other.done)) return 'waiting';
    // A completed run with an outcome that nothing followed, recorded as a stop or not.
    const completed = at?.status === 'completed' && displayedRunOutcome(at) !== null;
    return stopped || completed ? 'stopped' : 'resting';
  })();
  const keys = runs.map(runPackKey).filter(key => key !== null);
  const pack = (at === undefined ? null : runPackKey(at)) ?? keys.at(-1) ?? null;
  return { runId: at?.id ?? null, state, pack };
}
