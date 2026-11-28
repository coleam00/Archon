/**
 * An ask's option, and the options a workflow declares for every ask it leaves
 * (`returns.options`). Apart from `schemas/item-ask.ts` so the workflow schema can declare
 * them without importing the ask's run and store types, which import it back.
 */
import { z } from 'zod';
import { attentionOptionSchema, OTHER_ATTENTION_OPTION } from './wait-node';

// Every property of the shape is required, so a provider in OpenAI strict mode (Codex),
// which refuses an optional property, takes it as it is. A list that may be empty stands
// in for an optional one, a nullable value (the recommendation) stands in for an absent
// one, and the wait's optional `label` and `confidence` are left out.
export const askOptionSchema = attentionOptionSchema
  .pick({ id: true, does: true })
  .extend({
    id: attentionOptionSchema.shape.id.describe(
      "The option's id: kebab-case, one token (e.g. 'keep-the-flag'). The answer names it."
    ),
    does: z
      .string()
      .min(1)
      .describe('What choosing this option does: the change or action that follows from it.'),
    cost: z
      .string()
      .min(1)
      .describe('What this option costs: what is given up, what breaks, what has to follow.'),
  })
  .describe('One real choice. An option nobody would pick is not an option.');

/** Why a list of options cannot be one ask's options, under `path`: a reserved or repeated id. */
export function refineOptionIds(
  options: readonly { id: string }[],
  ctx: z.RefinementCtx,
  path: readonly PropertyKey[]
): void {
  const seen = new Set<string>();
  for (const [index, option] of options.entries()) {
    if (option.id === OTHER_ATTENTION_OPTION.id)
      ctx.addIssue({
        code: 'custom',
        path: [...path, index, 'id'],
        message: `'${OTHER_ATTENTION_OPTION.id}' is reserved: every ask offers it`,
      });
    else if (seen.has(option.id))
      ctx.addIssue({
        code: 'custom',
        path: [...path, index, 'id'],
        message: `'${option.id}' is declared more than once`,
      });
    seen.add(option.id);
  }
}

/**
 * An option as a workflow declares it (`returns.options`): the model's shape plus `label`,
 * the short words a person reads where the option is shown or was chosen. The label is the
 * author's, never the model's, so `askOptionSchema`, the shape the model writes, stays
 * without it for OpenAI strict mode.
 */
export const declaredAskOptionSchema = askOptionSchema.extend({
  label: z.string().trim().min(1).max(80).optional(),
});
export type DeclaredAskOption = z.infer<typeof declaredAskOptionSchema>;

/**
 * The options a workflow declares for every ask it leaves (`returns.options`): at least
 * two, no id twice, and not the reserved `other`, which every ask offers anyway.
 */
export const declaredAskOptionsSchema = z
  .array(declaredAskOptionSchema)
  .min(2)
  .superRefine((options, ctx) => refineOptionIds(options, ctx, []));

/**
 * The options every ask of a stage offers, as the pack graph serves them: its declared
 * `returns.options` in order, each with its `label` when it declares one, then the reserved
 * `other`, labelled by the engine. Null when the stage declares none (its asks write their
 * own options).
 */
export const stageAskOptionsSchema = z
  .array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      does: z.string().optional(),
      cost: z.string().optional(),
    })
  )
  .nullable();

export function stageAskOptions(
  declared: readonly DeclaredAskOption[] | undefined
): z.infer<typeof stageAskOptionsSchema> {
  if (declared === undefined) return null;
  return [...declared.map(option => ({ ...option })), { ...OTHER_ATTENTION_OPTION }];
}
