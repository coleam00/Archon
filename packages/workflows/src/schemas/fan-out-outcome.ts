import { z } from 'zod';
import { runCancelReasonSchema } from './run-terminal-reason';

/**
 * What became of one `workflow:` fan-out slot, read from its durable child run once every
 * slot settled. `cancelled_unattributed` covers rows cancelled before cancellation reasons
 * were recorded: who cancelled them cannot be told apart any more.
 */
export const fanOutSlotOutcomeSchema = z.enum([
  'completed',
  'failed',
  'not_started',
  'cancelled_by_engine',
  'cancelled_by_workflow',
  'cancelled_out_of_band',
  'cancelled_unattributed',
]);
export type FanOutSlotOutcome = z.infer<typeof fanOutSlotOutcomeSchema>;

export const fanOutCancelledOutcomeSchema = fanOutSlotOutcomeSchema.extract([
  'cancelled_by_engine',
  'cancelled_by_workflow',
  'cancelled_out_of_band',
  'cancelled_unattributed',
]);
export type FanOutCancelledOutcome = z.infer<typeof fanOutCancelledOutcomeSchema>;

const slotIndex = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

export const fanOutSlotSchema = z.discriminatedUnion('outcome', [
  z.object({ index: slotIndex, outcome: z.literal('completed'), child_run_id: z.string() }),
  z.object({
    index: slotIndex,
    outcome: z.literal('failed'),
    child_run_id: z.string(),
    error: z.string().optional(),
  }),
  // No child run exists, so this error is the slot's only record.
  z.object({ index: slotIndex, outcome: z.literal('not_started'), error: z.string() }),
  z.object({
    index: slotIndex,
    outcome: fanOutCancelledOutcomeSchema,
    child_run_id: z.string(),
    cancel_reason: runCancelReasonSchema.optional(),
  }),
]);
export type FanOutSlot = z.infer<typeof fanOutSlotSchema>;

const outcomeCounts = {
  completed: count,
  failed: count,
  not_started: count,
  cancelled_by_engine: count,
  cancelled_by_workflow: count,
  cancelled_out_of_band: count,
  cancelled_unattributed: count,
} satisfies Record<FanOutSlotOutcome, typeof count>;

export const fanOutTallySchema = z.object({ total: count, ...outcomeCounts });
export type FanOutTally = z.infer<typeof fanOutTallySchema>;

const fanOutTallyKeys = Object.keys(fanOutTallySchema.shape) as (keyof FanOutTally)[];

function tallySlots(slots: readonly FanOutSlot[]): FanOutTally {
  const tally: FanOutTally = {
    total: slots.length,
    completed: 0,
    failed: 0,
    not_started: 0,
    cancelled_by_engine: 0,
    cancelled_by_workflow: 0,
    cancelled_out_of_band: 0,
    cancelled_unattributed: 0,
  };
  for (const slot of slots) tally[slot.outcome] += 1;
  return tally;
}

/**
 * Every slot of a settled `workflow:` fan-out, in item order, with the tally they add up
 * to. Parsing rejects a tally that disagrees with its slots, so a reader can trust either.
 */
export const fanOutOutcomeSchema = z
  .object({ tally: fanOutTallySchema, slots: z.array(fanOutSlotSchema) })
  .superRefine((value, ctx) => {
    if (value.slots.some((slot, i) => slot.index !== i)) {
      ctx.addIssue({ code: 'custom', message: 'fan-out slots must be indexed 0..n-1 in order' });
    }
    const expected = tallySlots(value.slots);
    if (fanOutTallyKeys.some(key => value.tally[key] !== expected[key])) {
      ctx.addIssue({ code: 'custom', message: 'fan-out tally disagrees with its slots' });
    }
  });
export type FanOutOutcome = z.infer<typeof fanOutOutcomeSchema>;

/** The only constructor: the tally is computed from the slots, never supplied. */
export function fanOutOutcome(slots: FanOutSlot[]): FanOutOutcome {
  return { tally: tallySlots(slots), slots };
}

const UNFINISHED_LABELS = {
  failed: 'failed',
  not_started: 'not started',
  cancelled_by_engine: 'cancelled by the engine',
  cancelled_by_workflow: 'cancelled by their own workflow',
  cancelled_out_of_band: 'cancelled out of band',
  cancelled_unattributed: 'cancelled with no recorded cause',
} satisfies Record<Exclude<FanOutSlotOutcome, 'completed'>, string>;

/** Human label for a slot outcome, shared by the engine notice and the CLI. */
export function fanOutSlotOutcomeLabel(outcome: FanOutSlotOutcome): string {
  return outcome === 'completed' ? 'completed' : UNFINISHED_LABELS[outcome];
}

/** `2 of 5 children did not complete (1 failed, 1 not started)`. */
export function describeUnfinishedFanOut(tally: FanOutTally): string {
  const parts = fanOutSlotOutcomeSchema.options.flatMap(outcome =>
    outcome !== 'completed' && tally[outcome] > 0
      ? [`${String(tally[outcome])} ${UNFINISHED_LABELS[outcome]}`]
      : []
  );
  return (
    `${String(tally.total - tally.completed)} of ${String(tally.total)} children did not complete` +
    ` (${parts.join(', ')})`
  );
}
