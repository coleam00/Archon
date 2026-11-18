/**
 * A wait: something outside Archon a completed run says its item now waits for, opened on
 * the run's item when the run completes (`returns: { node, waits: <property> }`). The run
 * holds nothing while its item waits. A source plugin's event binding with `wake` names
 * the waiting workflow, the wait and the value its event carries; when that event is
 * accepted, the engine closes the set as met and starts the binding's stage on the item in
 * the same transaction. Nothing fires at the deadline: an open wait past it is listed in
 * the attention queue as overdue.
 *
 * This module owns the shape and the descriptions the model reads with it, as `item-ask.ts`
 * does for asks. The loader adds `ITEM_WAITS_JSON_SCHEMA` to the returns node's
 * `output_format`.
 */
import { z } from 'zod';

/** What the waits property is for, read by the model as the property's description. */
export const ITEM_WAITS_DESCRIPTION = [
  'What the item now waits for outside Archon, such as checks finishing or a review arriving on a change.',
  'What happens after: this run ends and holds nothing. Each wait opens on the item the run is for.',
  'When an event a binding maps to one of them arrives with exactly the `about` value you named, the set is met and the next stage starts on the item.',
  'An event about any other value (an older commit, say) starts nothing.',
  'The waits are alternatives: the first one met closes them all.',
  'When the set is still open past the time of any of them, the item is listed for an operator as overdue, naming what it waits for.',
  'A later completed run of this workflow on the same item replaces the waits still open.',
  'Leave the list empty when the item waits for nothing.',
].join(' ');

const WAIT_EVENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Every property is required, so a provider in OpenAI strict mode (Codex), which refuses an
// optional property, takes the shape as it is.
const waitFields = {
  event: z
    .string()
    .regex(WAIT_EVENT_PATTERN, 'must be lowercase letters, digits and hyphens')
    .describe(
      "The name of the event the item waits for, as the project's bindings name it (e.g. 'checks' or 'review'): lowercase letters, digits and hyphens."
    ),
  about: z
    .string()
    .min(1)
    .describe(
      "The exact value the event will carry, e.g. the full commit id of the change's head. Only an event with this value meets the wait."
    ),
  within_minutes: z
    .number()
    .int()
    .positive()
    .describe(
      'How many minutes after this run completes the event is expected. Past that the item is listed for an operator; the wait stays open.'
    ),
};

/** Why a set of waits disagrees, by path: each event is named once in a set. */
function refineWaits(waits: readonly { event: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, wait] of waits.entries()) {
    if (seen.has(wait.event))
      ctx.addIssue({
        code: 'custom',
        path: [index, 'event'],
        message: `'${wait.event}' is named more than once`,
      });
    seen.add(wait.event);
  }
}

/** A wait as a run leaves it: the shape the model writes and the store opens. */
export const itemWaitSchema = z.strictObject(waitFields);
export type ItemWait = z.infer<typeof itemWaitSchema>;

/** The waits property's value. */
export const itemWaitsSchema = z
  .array(itemWaitSchema)
  .superRefine(refineWaits)
  .describe(ITEM_WAITS_DESCRIPTION);

/**
 * The JSON Schema of the waits property, with its descriptions, added to the returns node's
 * `output_format`. Built once; readers take a copy (`itemWaitsJsonSchema`).
 */
const ITEM_WAITS_JSON_SCHEMA: Readonly<Record<string, unknown>> = (() => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(itemWaitsSchema, { io: 'input' });
  return schema;
})();

/** A fresh copy of the waits property's JSON Schema, so no two nodes share one object. */
export function itemWaitsJsonSchema(): Record<string, unknown> {
  return structuredClone(ITEM_WAITS_JSON_SCHEMA) as Record<string, unknown>;
}

/** `value` as a list of waits, or why it is not one, naming the first problem's path. */
export function parseItemWaits(
  value: unknown
): { readonly waits: ItemWait[] } | { readonly problem: string } {
  const parsed = itemWaitsSchema.safeParse(value);
  if (parsed.success) return { waits: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { problem: 'is not a list of waits' };
  const path = issue.path
    .map(part => (typeof part === 'number' ? `[${String(part)}]` : `.${String(part)}`))
    .join('');
  return { problem: path === '' ? issue.message : `${path} ${issue.message}` };
}

/** A wait as the store holds it: what the run left, and how it closed once it did. */
export interface StoredItemWait {
  id: string;
  itemId: string;
  /** The run that left the wait; its waits are one set. */
  runId: string;
  workflowName: string;
  position: number;
  event: string;
  about: string;
  openedAt: string;
  /** `openedAt` plus the wait's `within_minutes`: past it, an open wait is overdue. */
  deadlineAt: string;
  closed:
    | null
    /** An accepted event met this set; the receipt and binding it started. */
    | { as: 'met'; at: string; receiptId: string; bindingId: string }
    | { as: 'replaced'; at: string; byRunId: string }
    | { as: 'withdrawn'; at: string };
}

/**
 * What a binding that a set of waits woke passes its stage, under the binding's `wake.input`:
 * the wait the event met, the run that left it, and when it opened and fell due.
 */
export interface MetWaitInput {
  event: string;
  about: string;
  workflow: string;
  runId: string;
  waitingSince: string;
  deadline: string;
}

/** What became of withdrawing a set of waits. */
export type ItemWaitsWithdrawResult =
  /** The run left no waits. */
  | { kind: 'not_found' }
  /** This write closed the set's open waits; `waits` is the set after it. */
  | { kind: 'withdrawn'; waits: readonly [StoredItemWait, ...StoredItemWait[]] }
  /** No wait of the set was open: it was met, replaced or already withdrawn. */
  | {
      kind: 'refused';
      closedAs: NonNullable<StoredItemWait['closed']>['as'];
      waits: readonly [StoredItemWait, ...StoredItemWait[]];
    };
