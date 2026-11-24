/**
 * Where a binding started by a run's end or a settled set of asks reads the inputs of the
 * stage it starts. Data only: no expression, and nothing here names a workflow. The
 * trigger-file schemas that use them are in `resource-start`.
 */
import { z } from 'zod';
import { isJsonPointer } from '../json-pointer';

/**
 * Where a run-ended binding reads one input of the stage it starts: a JSON Pointer into
 * the ended run's result (its `returns:` node output), one of the ended run's own inputs
 * by name, the key of the ended run's item (which item ended, for a linked start), a
 * pointer into the started item's own entry of `linked.items`, or every answer on the item.
 */
const runInputSources = [
  z.object({ result: z.string().refine(isJsonPointer, 'Invalid JSON Pointer') }).strict(),
  z.object({ input: z.string().min(1) }).strict(),
] as const;
/** The key of the ended run's item; a pack's run-ended binding reads it as the file does. */
export const endedItemKeySourceSchema = z.object({ item: z.literal('key') }).strict();
/**
 * Every answered or withdrawn ask on the item the stage starts on, oldest answer first, so no
 * later stage asks again what was decided. Read by asks-settled and non-linked run-ended
 * bindings; a linked start is on a holder item, which is not the item whose run ended.
 */
export const itemAnswersSourceSchema = z.object({ item: z.literal('answers') }).strict();
/**
 * A JSON Pointer into the started item's own entry of the list `linked.items` names, so
 * each linked start gets its own value; `""` is the whole entry. Read only by a linked
 * run-ended binding with `items`.
 */
export const linkedEntrySourceSchema = z
  .object({ entry: z.string().refine(isJsonPointer, 'Invalid JSON Pointer') })
  .strict();
export const runEndedInputSourceSchema = z.union([
  ...runInputSources,
  endedItemKeySourceSchema,
  itemAnswersSourceSchema,
  linkedEntrySourceSchema,
]);
export type RunEndedInputSource = z.infer<typeof runEndedInputSourceSchema>;

/**
 * Where an asks-settled binding reads one input of the stage it starts: what a run-ended
 * binding reads from the run that left the asks, `{answers: true}` for the settled set
 * itself, each ask with its question, how it closed and who closed it, or
 * `{item: 'answers'}` for every answer on the item, this set's included.
 */
export const asksSettledInputSourceSchema = z.union([
  ...runInputSources,
  z.object({ answers: z.literal(true) }).strict(),
  itemAnswersSourceSchema,
]);
export type AsksSettledInputSource = z.infer<typeof asksSettledInputSourceSchema>;

/** A linked start is on a holder item, so the item's answers it would read are not its own. */
export const linkedReadsNoItemAnswers = {
  check: (trigger: { linked?: unknown; inputs?: Readonly<Record<string, object>> }): boolean =>
    trigger.linked === undefined ||
    !Object.values(trigger.inputs ?? {}).some(source => readsItemAnswers(source)),
  message: {
    message:
      "A linked start is on a holder item, so it cannot read the item's answers; read them in the started stage",
    path: ['inputs'],
  },
};

/** Only a linked start that names its items has an entry per started item to read. */
export const entryReadsNeedLinkedItems = {
  check: (trigger: {
    linked?: { items?: string };
    inputs?: Readonly<Record<string, object>>;
  }): boolean =>
    trigger.linked?.items !== undefined ||
    !Object.values(trigger.inputs ?? {}).some(source => readsLinkedEntry(source)),
  message: {
    message:
      'An input reads { entry }, but only a linked start with linked.items has an entry per started item',
    path: ['inputs'],
  },
};

/** Whether an input source is `{ entry: <pointer> }`. */
export function readsLinkedEntry(
  source: object
): source is z.infer<typeof linkedEntrySourceSchema> {
  return 'entry' in source;
}

export type ItemAnswersSource = z.infer<typeof itemAnswersSourceSchema>;

/** Whether an input source is `{ item: 'answers' }`. */
export function readsItemAnswers(source: object): source is ItemAnswersSource {
  return 'item' in source && source.item === 'answers';
}
