import { z } from 'zod';
import { gitObjectIdSchema, prRefSchema, repoRefSchema, workItemRefSchema } from './identity';

const text = z.string().min(1);

/** Branch names and object IDs remain separate facts across every consumer. */
export const forgePrRecordSchema = prRefSchema.extend({
  schemaVersion: z.literal(1),
  url: z.url(),
  head: text,
  base: text,
  is_draft: z.boolean(),
  state: z.enum(['open', 'closed', 'merged']),
  head_repo: repoRefSchema.nullable(),
  head_revision: gitObjectIdSchema.nullable(),
  base_revision: gitObjectIdSchema.nullable(),
  maintainer_can_modify: z.boolean().nullable(),
});
export type ForgePrRecord = z.infer<typeof forgePrRecordSchema>;

export const mergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);
export const mergeConditionsSchema = z.strictObject({
  head: gitObjectIdSchema.optional(),
  base: gitObjectIdSchema.optional(),
  resultTree: gitObjectIdSchema.optional(),
});
export const mergeConditionSchema = mergeConditionsSchema.keyof();
export const mergeCapabilitiesSchema = z.object({
  methods: z.array(mergeMethodSchema).min(1),
  atomicConditions: z.array(mergeConditionSchema),
  readback: z.array(z.enum(['commit', 'tree', 'parents'])),
});

const requestBase = z.object({ operationId: text });
export const workItemViewRequestSchema = requestBase.extend({
  op: z.literal('workitem.view'),
  ref: workItemRefSchema,
});
export const prViewRequestSchema = requestBase.extend({
  op: z.literal('pr.view'),
  selector: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('number'), ref: prRefSchema }),
    z.object({
      kind: z.literal('head'),
      repo: repoRefSchema,
      headRepo: repoRefSchema,
      head: text,
      base: text.optional(),
    }),
  ]),
});
export const prCreateRequestSchema = requestBase.extend({
  op: z.literal('pr.create'),
  repo: repoRefSchema,
  headRepo: repoRefSchema,
  head: text,
  headRevision: gitObjectIdSchema,
  base: text,
  title: text,
  body: z.string(),
  draft: z.boolean(),
});
export const prEditBodyRequestSchema = requestBase.extend({
  op: z.literal('pr.edit-body'),
  ref: prRefSchema,
  body: z.string(),
});
export const prReadyRequestSchema = requestBase.extend({
  op: z.literal('pr.ready'),
  ref: prRefSchema,
});
export const commentUpsertRequestSchema = requestBase.extend({
  op: z.literal('comment.upsert'),
  ref: prRefSchema,
  marker: text.refine(value => !value.includes('\n') && !value.includes('\r'), {
    message: 'comment marker must be one line',
  }),
  body: text,
});
export const prMergeRequestSchema = requestBase.extend({
  op: z.literal('pr.merge'),
  ref: prRefSchema,
  method: mergeMethodSchema,
  required: mergeConditionsSchema.default({}),
});
export const mutationRequestSchemas = [
  prCreateRequestSchema,
  prEditBodyRequestSchema,
  prReadyRequestSchema,
  commentUpsertRequestSchema,
  prMergeRequestSchema,
] as const;
export const mutationRequestSchema = z.discriminatedUnion('op', mutationRequestSchemas);
export type ForgeMutationRequest = z.infer<typeof mutationRequestSchema>;
export const mutationOperationSchema = z.enum(
  mutationRequestSchemas.map(schema => schema.shape.op.value)
);

export const workItemViewSchema = z.object({
  ref: workItemRefSchema,
  kind: z.enum(['issue', 'pr']),
  url: z.url(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
});
export const prViewSchema = z.object({
  pr: forgePrRecordSchema,
  title: z.string(),
  body: z.string(),
});
export const commentRecordSchema = z.object({
  ref: prRefSchema,
  id: text,
  url: z.url(),
  bodyDigest: text,
});

function evidence<T extends z.ZodType>(
  value: T
): z.ZodDiscriminatedUnion<
  [
    z.ZodObject<{ available: z.ZodLiteral<true>; value: T }>,
    z.ZodObject<{ available: z.ZodLiteral<false>; reason: typeof text }>,
  ],
  'available'
> {
  return z.discriminatedUnion('available', [
    z.object({ available: z.literal(true), value }),
    z.object({ available: z.literal(false), reason: text }),
  ]);
}
export const landedCommitSchema = z.object({
  commit: evidence(gitObjectIdSchema),
  tree: evidence(gitObjectIdSchema),
  parents: evidence(z.array(gitObjectIdSchema)),
});

const mutationEvidenceSchema = z.object({
  target: z.union([prRefSchema, repoRefSchema]),
  requested: mergeConditionsSchema,
  enforced: mergeConditionsSchema,
});
const appliedSchema = mutationEvidenceSchema.extend({
  outcome: z.literal('applied'),
  changed: z.boolean(),
});
export const mutationFailureSchema = z.discriminatedUnion('outcome', [
  mutationEvidenceSchema.extend({
    op: mutationOperationSchema,
    outcome: z.literal('refused'),
    observed: forgePrRecordSchema.optional(),
  }),
  mutationEvidenceSchema.extend({
    op: mutationOperationSchema,
    outcome: z.literal('verification_failed'),
    observed: forgePrRecordSchema.optional(),
    comment: commentRecordSchema.optional(),
    leaveBehind: text,
  }),
  mutationEvidenceSchema.extend({
    op: mutationOperationSchema,
    outcome: z.literal('outcome_unknown'),
    observed: forgePrRecordSchema.optional(),
  }),
]);
export type ForgeMutationFailure = z.infer<typeof mutationFailureSchema>;

export const lifecycleReadResultSchemas = [
  z.object({ op: workItemViewRequestSchema.shape.op, value: workItemViewSchema }),
  z.object({ op: prViewRequestSchema.shape.op, value: prViewSchema.nullable() }),
] as const;
export const mutationResultSchemas = [
  z.object({
    op: prCreateRequestSchema.shape.op,
    value: appliedSchema.extend({ pr: forgePrRecordSchema }),
  }),
  z.object({
    op: prEditBodyRequestSchema.shape.op,
    value: appliedSchema.extend({ pr: forgePrRecordSchema, bodyDigest: text }),
  }),
  z.object({
    op: prReadyRequestSchema.shape.op,
    value: appliedSchema.extend({ pr: forgePrRecordSchema }),
  }),
  z.object({
    op: commentUpsertRequestSchema.shape.op,
    value: appliedSchema.extend({ comment: commentRecordSchema }),
  }),
  z.object({
    op: prMergeRequestSchema.shape.op,
    value: appliedSchema.extend({
      pr: forgePrRecordSchema,
      method: mergeMethodSchema,
      landed: landedCommitSchema,
    }),
  }),
] as const;

export function mutationEvidence(
  request: ForgeMutationRequest
): Pick<ForgeMutationFailure, 'target' | 'requested' | 'enforced'> {
  return {
    target: request.op === 'pr.create' ? request.repo : request.ref,
    requested: request.op === 'pr.merge' ? request.required : {},
    enforced: {},
  };
}
