/**
 * An ask: a decision a completed run leaves for an operator, opened on the run's item when
 * the run completes (`returns: { node, asks: <property> }`). This module owns its shape and
 * the descriptions the model reads with it. The loader adds the asks JSON Schema
 * (`itemAsksJsonSchema`) to the returns node's `output_format`, so no workflow restates it,
 * and providers deliver its descriptions with the rest of the output schema: they are an
 * ask's tool description.
 *
 * A workflow may declare the one set of options every ask it leaves offers
 * (`returns: { ..., options: [...] }`), because an answer's option id routes what starts
 * next. The model then writes no options: its schema has none, and its recommendation is
 * limited to the declared ids. The engine puts the declared options into each ask when the
 * run completes, so a stored ask has the same shape either way.
 *
 * The option and recommendation derive from the schemas a `wait: attention` node uses. What
 * an ask adds is a context, a cost per option and artifact links.
 */
import { z } from 'zod';
import { artifactPointerSchema } from './artifact-pointer';
import { type ItemAct, itemActFields } from './item-act';
import type { SourceReceiptAcceptance } from './resource-start';
import { attentionAnswerSchema } from './run-wait';
import { askOptionSchema, type DeclaredAskOption, refineOptionIds } from './ask-option';
import { attentionRecommendationSchema, OTHER_ATTENTION_OPTION } from './wait-node';

/** What the asks property is for, read by the model as the property's description. */
export const ITEM_ASKS_DESCRIPTION = [
  'Decisions you leave for an operator. Leave one when finishing your work needs a decision that is not yours to make:',
  'the work can be read two ways that lead to different changes; doing it means giving up something the project holds to;',
  'or the right answer depends on where the project is going or what it costs someone else.',
  'Do not leave one for a choice you can make yourself (make it and say why), for something the project already decided,',
  'for something you can find out by reading or running, for a doubt rather than a decision, or to ask permission to do your work.',
  'If nobody would choose differently from you, it is not an ask. Leave every decision you need, not only the first.',
  'What happens after: when this run completes, each ask opens for an operator on the item the run is for. The operator answers it',
  '(choosing an option, accepting the recommendation, or saying what to do instead) or withdraws it.',
  'When every ask is answered or withdrawn, the set is settled and the engine records it on the item.',
  'A later completed run of this workflow on the same item replaces the asks still open.',
  'Work that depends on an open ask should wait for its answer, not build on your recommendation.',
  'Leave the list empty when there is nothing to decide.',
].join(' ');

// The pointer shape, with what each field holds for the model that writes it.
const askArtifactSchema = artifactPointerSchema
  .extend({
    type: artifactPointerSchema.shape.type.describe('Always "archon_artifact".'),
    run_id: artifactPointerSchema.shape.run_id.describe(
      'The id of this run ($WORKFLOW_ID); a pointer names its own run only.'
    ),
    path: artifactPointerSchema.shape.path.describe(
      "The file's path relative to this run's artifacts directory ($ARTIFACTS_DIR)."
    ),
  })
  .describe('A file this run wrote under its artifacts directory.');

/** The recommendation an ask carries, with `option` limited by the schema given. */
function recommendationSchema<O extends z.ZodType<string>>(option: O) {
  return attentionRecommendationSchema
    .pick({ option: true, why: true })
    .extend({
      option,
      why: attentionRecommendationSchema.shape.why.describe(
        'Why that option, in a sentence or two. If you are not sure, say what would change your mind.'
      ),
    })
    .nullable()
    .describe(
      'The option you recommend and why, or null when you have no basis to choose between the options: the operator then sees that the ask has none. Do not name an option you would not choose.'
    );
}

const askFields = {
  question: z
    .string()
    .min(1)
    .describe(
      'One sentence that can be answered by picking an option. Name the thing: the file, the command, the behaviour.'
    ),
  context: z
    .string()
    .min(1)
    .describe(
      'What is at stake and why it came up, in a few sentences: what you found, not how you found it. The operator reads it later, without your run open.'
    ),
  options: z
    .array(askOptionSchema)
    .min(2)
    .describe(
      `Two to four real choices. The id '${OTHER_ATTENTION_OPTION.id}' is reserved: every ask also offers it, answered with text.`
    ),
  recommendation: recommendationSchema(
    attentionRecommendationSchema.shape.option.describe('The id of the option you would take.')
  ),
  artifacts: z
    .array(askArtifactSchema)
    .describe(
      'Artifacts of this run the operator should read to decide, as artifact pointers; empty when there are none.'
    ),
};

/** Why an ask's parts disagree, by path, or nothing: the checks a JSON Schema cannot hold. */
function refineAsk(
  ask: { options: readonly { id: string }[]; recommendation: { option: string } | null },
  ctx: z.RefinementCtx
): void {
  refineOptionIds(ask.options, ctx, ['options']);
  const recommended = ask.recommendation?.option;
  if (recommended !== undefined && !ask.options.some(option => option.id === recommended))
    ctx.addIssue({
      code: 'custom',
      path: ['recommendation', 'option'],
      message: `names '${recommended}', which is not one of the ask's options`,
    });
}

/** An ask as a run leaves it: the shape the model writes and the store opens. */
export const itemAskSchema = z.strictObject(askFields).superRefine(refineAsk);
export type ItemAsk = z.infer<typeof itemAskSchema>;

/** The asks property's value. */
export const itemAsksSchema = z.array(itemAskSchema).describe(ITEM_ASKS_DESCRIPTION);

/**
 * An ask as a store reads it back. More than one binary reads the stored JSON, so a key a
 * newer one added is tolerated rather than refused; the rest holds the write shape.
 */
export const storedItemAskSchema = z
  .looseObject({
    ...askFields,
    options: z.array(askOptionSchema.loose()).min(2),
    recommendation: attentionRecommendationSchema.loose().nullable(),
  })
  .superRefine(refineAsk);
export type StoredAsk = z.infer<typeof storedItemAskSchema>;

/**
 * The asks property's value when the workflow declares its options: each ask has no
 * options of its own, and its recommendation names a declared id or is null. The option
 * list in the recommendation's description is what the model reads to choose; the ask's
 * own description names the declared ids for an ask that wrote options anyway.
 */
function declaredItemAsksSchema(options: readonly DeclaredAskOption[]) {
  const offered = options
    .map(option => `'${option.id}': ${option.does} (cost: ${option.cost})`)
    .join('; ');
  const { options: _options, ...fields } = askFields;
  const ids = options.map(option => `'${option.id}'`).join(', ');
  return z
    .array(
      z
        .strictObject({
          ...fields,
          recommendation: recommendationSchema(
            z
              .enum(options.map(option => option.id))
              .describe(`The id of the option you would take. Every ask offers: ${offered}.`)
          ),
        })
        // Output validation quotes this when an ask carries a key it does not declare,
        // so an ask written with its own options is told what to write instead.
        .describe(
          `An ask of a workflow whose returns.options supplies its options, so write no options: every ask offers ${ids}. Recommend one by its id, or leave the recommendation null.`
        )
    )
    .describe(ITEM_ASKS_DESCRIPTION);
}

/** A JSON Schema of the asks property without zod's dialect key. */
function asksJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: 'input' });
  return json;
}

/** The asks property's JSON Schema for a workflow that declares no options. Built once. */
const ITEM_ASKS_JSON_SCHEMA: Readonly<Record<string, unknown>> = asksJsonSchema(itemAsksSchema);

/**
 * A fresh JSON Schema of the asks property, added to the returns node's `output_format`, so
 * no two nodes share one object. With declared options it is built from them; the same
 * options always build an equal schema, which the load-time contract compares.
 */
export function itemAsksJsonSchema(
  options?: readonly DeclaredAskOption[]
): Record<string, unknown> {
  if (options !== undefined) return asksJsonSchema(declaredItemAsksSchema(options));
  return structuredClone(ITEM_ASKS_JSON_SCHEMA) as Record<string, unknown>;
}

/**
 * `value` as a list of asks, or why it is not one, naming the first problem's path. With
 * declared options, `value` is read as the model writes it then and each ask gets them.
 */
export function parseItemAsks(
  value: unknown,
  options?: readonly DeclaredAskOption[]
): { readonly asks: ItemAsk[] } | { readonly problem: string } {
  if (options === undefined) return asksOrProblem(itemAsksSchema.safeParse(value), asks => asks);
  return asksOrProblem(declaredItemAsksSchema(options).safeParse(value), asks =>
    asks.map(({ question, context, recommendation, artifacts }) => ({
      question,
      context,
      options: options.map(option => ({ ...option })),
      recommendation,
      artifacts,
    }))
  );
}

function asksOrProblem<T>(
  parsed: z.ZodSafeParseResult<T>,
  toAsks: (data: T) => ItemAsk[]
): { readonly asks: ItemAsk[] } | { readonly problem: string } {
  if (parsed.success) return { asks: toAsks(parsed.data) };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { problem: 'is not a list of asks' };
  const path = issue.path
    .map(part => (typeof part === 'number' ? `[${String(part)}]` : `.${String(part)}`))
    .join('');
  return { problem: path === '' ? issue.message : `${path} ${issue.message}` };
}

/** How an ask closed: answered, withdrawn, or replaced by a newer set from its workflow. */
export const itemAskClosureSchema = z.enum(['answered', 'withdrawn', 'replaced']);
export type ItemAskClosure = z.infer<typeof itemAskClosureSchema>;

/** Who answered or withdrew an ask, through which surface and when: an act on its item. */
export const itemAskActSchema = z.object(itemActFields);
export type ItemAskAct = z.infer<typeof itemAskActSchema>;

/** An ask as the store holds it: what the run left, and how it closed once it did. */
export interface StoredItemAsk {
  id: string;
  itemId: string;
  /** The run that left the ask; its asks are one set. */
  runId: string;
  workflowName: string;
  position: number;
  ask: StoredAsk;
  openedAt: string;
  closed:
    | null
    | { as: 'answered'; answer: z.infer<typeof attentionAnswerSchema>; act: ItemAskAct }
    | { as: 'withdrawn'; act: ItemAskAct }
    | { as: 'replaced'; at: string; byRunId: string };
}

/** Who answers or withdraws an ask, as the surface resolved them. */
export type ItemAskActInput = ItemAct;

/** What became of answering or withdrawing an ask. */
export type ItemAskCloseResult =
  /** No ask has this id. */
  | { kind: 'not_found' }
  /**
   * This write closed it; `settled` when it closed the last open ask of its set.
   * `startReceipts` are the starts that settlement caused (asks-settled bindings), written
   * in the same transaction; empty when the close did not settle the set.
   */
  | {
      kind: 'closed';
      ask: StoredItemAsk;
      settled: boolean;
      startReceipts: readonly SourceReceiptAcceptance[];
    }
  /** It was already closed the same way: nothing changed. */
  | { kind: 'unchanged'; ask: StoredItemAsk }
  /** It was already closed another way, which stands. */
  | { kind: 'refused'; ask: StoredItemAsk };

/** Data of the `asks_settled` event: how many asks of the set were answered and withdrawn. */
export const asksSettledDataSchema = z.object({
  answered: z.number().int().nonnegative(),
  withdrawn: z.number().int().nonnegative(),
});
export type AsksSettledData = z.infer<typeof asksSettledDataSchema>;

/** Data of the `ask_answered` and `ask_withdrawn` events. */
export const askClosedEventDataSchema = z
  .object(itemActFields)
  .omit({ at: true })
  .extend({
    ask: z.string().min(1),
    /** Set on `ask_answered` only. */
    answer: attentionAnswerSchema.optional(),
  });
export type AskClosedEventData = z.infer<typeof askClosedEventDataSchema>;

/**
 * The option an answer chose and what it does, or undefined when the answer chose none
 * the ask offers. `other` reads as the reserved option: its answer text says what to do.
 */
export function chosenAskOption(
  ask: StoredAsk,
  answer: z.infer<typeof attentionAnswerSchema>
): { id: string; does: string } | undefined {
  if (!('decision' in answer)) return undefined;
  const option = ask.options.find(candidate => candidate.id === answer.decision);
  if (option !== undefined) return { id: option.id, does: option.does };
  return answer.decision === OTHER_ATTENTION_OPTION.id
    ? { id: OTHER_ATTENTION_OPTION.id, does: OTHER_ATTENTION_OPTION.does }
    : undefined;
}
