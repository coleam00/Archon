import { z } from 'zod';
import {
  jsonValueSchema,
  OUTPUT_REF_SOURCE,
  parseWholeInputsRef,
  parseWholeOutputRef,
} from '../output-ref';
import { AGENT_ID_REGEX, dagNodeBaseSchema } from './dag-node-base';
import { MAX_DURABLE_WAIT_MS } from './durable-wait';

/**
 * How an attention wait is answered; it fixes the node's output contract, so it is
 * always a literal. See `ATTENTION_OUTPUT_FORMATS`.
 */
export const attentionFormSchema = z.enum(['message', 'approval', 'select', 'multi_select']);
export type AttentionForm = z.infer<typeof attentionFormSchema>;

const attentionOptionIdSchema = z
  .string()
  .regex(
    AGENT_ID_REGEX,
    "must be kebab-case (lowercase letters, digits, single hyphens — e.g. 'use-main')"
  );

/**
 * One answer a `select` or `multi_select` attention wait accepts. The id is the wire
 * value the answer carries and the next node reads; kebab-case keeps it one CLI token.
 * `label` and `does` are display text. `value` is opaque to the engine: no surface shows
 * it, and a `select` answer returns the chosen option's `value` unchanged.
 */
export const attentionOptionSchema = z.strictObject({
  id: attentionOptionIdSchema,
  label: z.string().min(1).optional(),
  does: z.string().min(1).optional(),
  value: jsonValueSchema.optional(),
});
export type AttentionOption = z.infer<typeof attentionOptionSchema>;

/** The option an attention wait recommends, why, and how sure it is. Display only. */
export const attentionRecommendationSchema = z.strictObject({
  option: attentionOptionIdSchema,
  why: z.string().trim().min(1, 'must not be empty'),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});
export type AttentionRecommendation = z.infer<typeof attentionRecommendationSchema>;

/**
 * The options of an attention wait, literal or resolved at pause time from an upstream
 * output. Both pass this one schema, so a referenced list obeys the literal rules.
 */
export const attentionOptionsSchema = z
  .array(attentionOptionSchema)
  .min(1, 'must declare at least one option')
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (seen.has(option.id))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `'${option.id}' is declared more than once`,
        });
      seen.add(option.id);
    }
  });

/**
 * A label key on an attention wait. It is one CLI token with no `=`, so `--label k=v`
 * and `--set k=v` split unambiguously at the first `=`. The engine gives keys no meaning.
 *
 * `__proto__` is refused: assigning it to a plain object sets the prototype instead of
 * creating a key, so a label write would vanish and a filter on it would match everything.
 */
export const attentionLabelKeySchema = z
  .string()
  .regex(/^[^=\s]+$/u, "must be non-empty, with no '=' or whitespace")
  .refine(key => key !== '__proto__', "'__proto__' cannot be a label key");

/** An attention wait's labels: a flat map of plain strings the engine never interprets. */
export const attentionLabelsSchema = z.record(attentionLabelKeySchema, z.string());
export type AttentionLabels = z.infer<typeof attentionLabelsSchema>;

/** The answers an `approval` attention wait accepts. */
export const APPROVAL_ATTENTION_OPTIONS: readonly AttentionOption[] = [
  { id: 'approve' },
  { id: 'reject' },
];

/**
 * `attentionDeclarationProblem` over what an authored wait declares literally. A
 * referenced field is checked when the wait pauses, so referenced options defer the check;
 * a recommendation on a form that takes none is refused either way.
 */
function literalDeclarationProblem(
  value: { options?: readonly AttentionOption[] | string; recommendation?: unknown },
  form: AttentionForm
): string | undefined {
  if (value.recommendation !== undefined) {
    const formProblem = recommendationFormProblem(form);
    if (formProblem !== undefined) return formProblem;
  }
  // Referenced or missing options (the latter already refused) leave nothing to check.
  if (!Array.isArray(value.options) && form !== 'approval') return undefined;
  const recommendation = attentionRecommendationSchema.safeParse(value.recommendation);
  return attentionDeclarationProblem({
    form,
    ...(Array.isArray(value.options) ? { options: value.options } : {}),
    ...(recommendation.success ? { recommendation: recommendation.data } : {}),
  });
}

/** Why `form` takes no recommendation: only a single choice can be recommended. */
function recommendationFormProblem(form: AttentionForm): string | undefined {
  return form === 'select' || form === 'approval'
    ? undefined
    : `'recommendation' is only valid for forms 'select' and 'approval', not '${form}'`;
}

/**
 * Why a resolved attention declaration cannot pause, or undefined when it can: a
 * recommendation on a form that takes none or of an option the wait does not offer, or a
 * `value` on a `multi_select` option, whose answer returns no value. The load check runs
 * it on literal fields and the pause runs it on resolved ones, so both refuse the same.
 */
export function attentionDeclarationProblem(declaration: {
  form: AttentionForm;
  options?: readonly AttentionOption[];
  recommendation?: AttentionRecommendation;
}): string | undefined {
  const { form, recommendation } = declaration;
  const options = form === 'approval' ? APPROVAL_ATTENTION_OPTIONS : (declaration.options ?? []);
  if (form === 'multi_select' && options.some(option => option.value !== undefined))
    return "'value' is only valid on options of form 'select', not 'multi_select'";
  if (recommendation === undefined) return undefined;
  const formProblem = recommendationFormProblem(form);
  if (formProblem !== undefined) return formProblem;
  if (!options.some(option => option.id === recommendation.option))
    return `'recommendation' names option '${recommendation.option}', which the wait does not offer (${options.map(option => option.id).join(', ')})`;
  return undefined;
}

const attentionTextOutput = { type: 'string' } as const;

/** The output contract each attention form fixes: what the next node reads. */
export const ATTENTION_OUTPUT_FORMATS = {
  message: {
    type: 'object',
    properties: { text: attentionTextOutput },
    required: ['text'],
    additionalProperties: false,
  },
  approval: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: APPROVAL_ATTENTION_OPTIONS.map(option => option.id) },
      text: attentionTextOutput,
    },
    required: ['decision', 'text'],
    additionalProperties: false,
  },
  select: {
    type: 'object',
    // `value` is the chosen option's `value`, present only when that option declares one.
    properties: { decision: { type: 'string' }, text: attentionTextOutput, value: {} },
    required: ['decision', 'text'],
    additionalProperties: false,
  },
  multi_select: {
    type: 'object',
    properties: {
      decisions: { type: 'array', items: { type: 'string' } },
      text: attentionTextOutput,
    },
    required: ['decisions', 'text'],
    additionalProperties: false,
  },
} as const satisfies Record<AttentionForm, Record<string, unknown>>;

export const waitUntilTimestampSchema = z.string().datetime();
const waitUntilValueSchema = z
  .string()
  .min(1, "'wait.until' must not be empty")
  .refine(
    value =>
      new RegExp(OUTPUT_REF_SOURCE).test(value) ||
      parseWholeInputsRef(value) !== undefined ||
      waitUntilTimestampSchema.safeParse(value).success,
    "'wait.until' must be an ISO-8601 timestamp or contain a runtime reference"
  );

const waitConfigVariantSchemas = [
  z.strictObject({
    duration_ms: z.number().int().positive().max(MAX_DURABLE_WAIT_MS),
  }),
  z.strictObject({ until: waitUntilValueSchema }),
  z.strictObject({
    event: z.string().trim().min(1, "'wait.event' must not be empty"),
    deadline_ms: z.number().int().positive().max(MAX_DURABLE_WAIT_MS),
  }),
  z
    .strictObject({
      attention: z.string().trim().min(1, "'wait.attention' must not be empty"),
      form: attentionFormSchema.optional(),
      options: z
        .union([
          attentionOptionsSchema,
          z
            .string()
            .refine(
              value => parseWholeOutputRef(value)?.field !== undefined,
              "must be a list of options or one whole '$node.output.<field>' reference"
            ),
        ])
        .optional(),
      recommendation: z
        .union([
          attentionRecommendationSchema,
          z
            .string()
            .refine(
              value => parseWholeOutputRef(value)?.field !== undefined,
              "must be a recommendation or one whole '$node.output.<field>' reference"
            ),
        ])
        .optional(),
      /** Values may hold runtime references, resolved when the wait pauses. */
      labels: attentionLabelsSchema.optional(),
    })
    .superRefine((value, ctx) => {
      const form = value.form ?? 'message';
      const takesOptions = form === 'select' || form === 'multi_select';
      if (takesOptions && value.options === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: `is required for form '${form}'`,
        });
      if (!takesOptions && value.options !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: `is only valid for forms 'select' and 'multi_select', not '${form}'`,
        });
      const problem = literalDeclarationProblem(value, form);
      if (problem !== undefined) ctx.addIssue({ code: 'custom', path: [], message: problem });
    }),
] as const;
export const waitConfigKeys = new Set(
  waitConfigVariantSchemas.flatMap(schema => Object.keys(schema.shape))
);

type WaitConfigVariant = z.infer<(typeof waitConfigVariantSchemas)[number]>;
type WaitConfigKey<Variant> = Variant extends unknown ? keyof Variant : never;
type ExclusiveWaitConfig<Variant, All = Variant> = Variant extends unknown
  ? Variant & Partial<Record<Exclude<WaitConfigKey<All>, keyof Variant>, never>>
  : never;

export type WaitConfig = ExclusiveWaitConfig<WaitConfigVariant>;
export const waitConfigSchema = z
  .union(waitConfigVariantSchemas)
  .transform(value => value as WaitConfig);

/** Validated engine condition used for exhaustive wait execution. */
export type WaitCondition =
  | { kind: 'duration'; durationMs: number }
  | { kind: 'until'; timestamp: string }
  | { kind: 'event'; event: string; deadlineMs: number }
  | {
      kind: 'attention';
      message: string;
      form: AttentionForm;
      /** Literal options, or the whole `$node.output.<field>` reference resolved at pause time. */
      options?: AttentionOption[] | string;
      /** A literal recommendation, or the whole reference resolved at pause time. */
      recommendation?: AttentionRecommendation | string;
      labels?: AttentionLabels;
    };

export function waitCondition(config: WaitConfig): WaitCondition {
  if (config.duration_ms !== undefined) {
    return { kind: 'duration', durationMs: config.duration_ms };
  }
  if (config.until !== undefined) {
    return { kind: 'until', timestamp: config.until };
  }
  if (config.event !== undefined) {
    return { kind: 'event', event: config.event, deadlineMs: config.deadline_ms };
  }
  return {
    kind: 'attention',
    message: config.attention,
    form: config.form ?? 'message',
    ...(config.options !== undefined ? { options: config.options } : {}),
    ...(config.recommendation !== undefined ? { recommendation: config.recommendation } : {}),
    ...(config.labels !== undefined ? { labels: config.labels } : {}),
  };
}

export const workflowWaitResultSchema = z.object({
  status: z.enum(['satisfied', 'expired']),
  waited_ms: z.number().nonnegative(),
  event: z.string().optional(),
  payload: z.unknown().optional(),
});
export type WorkflowWaitResult = z.infer<typeof workflowWaitResultSchema>;

export const WAIT_NODE_OUTPUT_FORMAT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['satisfied', 'expired'] },
    waited_ms: { type: 'number' },
    event: { type: 'string' },
    payload: {},
  },
  required: ['status', 'waited_ms'],
  additionalProperties: false,
} as const;

/** The output contract a wait fixes: its condition's result, or an attention form's answer. */
export function waitOutputFormat(wait: WaitConfig): Record<string, unknown> {
  return wait.attention !== undefined
    ? ATTENTION_OUTPUT_FORMATS[wait.form ?? 'message']
    : WAIT_NODE_OUTPUT_FORMAT;
}

export const waitNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('wait'),
  wait: waitConfigSchema,
});
export type WaitNode = z.infer<typeof waitNodeSchema>;
