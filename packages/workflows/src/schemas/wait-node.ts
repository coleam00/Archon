import { z } from 'zod';
import { OUTPUT_REF_SOURCE, parseWholeInputsRef, parseWholeOutputRef } from '../output-ref';
import { AGENT_ID_REGEX, dagNodeBaseSchema } from './dag-node-base';
import { MAX_DURABLE_WAIT_MS } from './durable-wait';

/**
 * How an attention wait is answered; it fixes the node's output contract, so it is
 * always a literal. See `ATTENTION_OUTPUT_FORMATS`.
 */
export const attentionFormSchema = z.enum(['message', 'approval', 'select', 'multi_select']);
export type AttentionForm = z.infer<typeof attentionFormSchema>;

/**
 * One answer a `select` or `multi_select` attention wait accepts. The id is the wire
 * value the answer carries and the next node reads; kebab-case keeps it one CLI token.
 */
export const attentionOptionSchema = z.strictObject({
  id: z
    .string()
    .regex(
      AGENT_ID_REGEX,
      "must be kebab-case (lowercase letters, digits, single hyphens — e.g. 'use-main')"
    ),
  label: z.string().min(1).optional(),
});
export type AttentionOption = z.infer<typeof attentionOptionSchema>;

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
    properties: { decision: { type: 'string' }, text: attentionTextOutput },
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
