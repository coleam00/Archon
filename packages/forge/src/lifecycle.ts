/**
 * Work-item and pull-request lifecycle operations, and the evidence a mutation
 * owes its caller.
 *
 * A write that cannot prove it landed is not a failure a caller may retry blindly.
 * Every mutation therefore resolves to exactly one of four outcomes: `applied`
 * (performed and read back), `refused` (nothing was written), `verification_failed`
 * (the write was acknowledged but the read-back disagreed), or `outcome_unknown`
 * (the request may or may not have reached the forge). The last two carry what a
 * reconciling operator needs, never a promise that the mutation was prevented.
 */

import { z } from 'zod';
import { gitObjectIdSchema, prRefSchema, repoRefSchema, workItemRefSchema } from './identity';

const text = z.string().min(1);

/** Branch names and object IDs stay separate facts for every consumer. */
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

const requestBase = z.object({ operationId: text });

export const workItemViewRequestSchema = requestBase.extend({
  op: z.literal('workitem.view'),
  ref: workItemRefSchema,
});
/**
 * A pull request by number, or the one open pull request for a qualified head.
 * The head form answers "does this branch already have a pull request", so it
 * resolves to nothing rather than to a pull request that was closed earlier.
 */
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
  // The marker identifies the one canonical comment, so it has to survive a
  // first-line comparison against a body the forge may have re-wrapped.
  marker: text.refine(value => !/[\r\n]/.test(value), 'comment marker must be one line'),
  body: text,
});

export const lifecycleReadRequestSchemas = [
  workItemViewRequestSchema,
  prViewRequestSchema,
] as const;
export const mutationRequestSchemas = [
  prCreateRequestSchema,
  prEditBodyRequestSchema,
  prReadyRequestSchema,
  commentUpsertRequestSchema,
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
export type ForgeCommentRecord = z.infer<typeof commentRecordSchema>;

/** What a mutation addressed: a repository for a create, the pull request otherwise. */
export const mutationTargetSchema = z.union([prRefSchema, repoRefSchema]);
export type ForgeMutationTarget = z.infer<typeof mutationTargetSchema>;

const failureBase = z.object({ op: mutationOperationSchema, target: mutationTargetSchema });
export const mutationFailureSchema = z.discriminatedUnion('outcome', [
  failureBase.extend({ outcome: z.literal('refused'), observed: forgePrRecordSchema.optional() }),
  failureBase.extend({
    outcome: z.literal('verification_failed'),
    observed: forgePrRecordSchema.optional(),
    comment: commentRecordSchema.optional(),
    // What may remain on the forge, in the operator's terms, so reconciliation
    // starts from evidence rather than from a retry.
    leaveBehind: text,
  }),
  // Nothing was read back, so an unknown outcome carries no observation.
  failureBase.extend({ outcome: z.literal('outcome_unknown') }),
]);
export type ForgeMutationFailure = z.infer<typeof mutationFailureSchema>;

const appliedSchema = z.object({
  target: mutationTargetSchema,
  outcome: z.literal('applied'),
  changed: z.boolean(),
});

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
] as const;

export function mutationTarget(request: ForgeMutationRequest): ForgeMutationTarget {
  return request.op === 'pr.create' ? request.repo : request.ref;
}
