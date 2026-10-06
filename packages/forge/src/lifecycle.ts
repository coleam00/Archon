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
import {
  gitObjectIdSchema,
  prRefSchema,
  repoRefSchema,
  workItemRefSchema,
  sourceActorSchema,
} from './identity';

import { checkSelectionSchema, selectedChecksSchema } from './checks';

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

export const labelNamesSchema = z
  .array(text)
  .refine(names => new Set(names).size === names.length, 'label names must be unique');
export const repoLabelsListRequestSchema = requestBase.extend({
  op: z.literal('repo.labels.list'),
  repo: repoRefSchema,
});
export const repoLabelsListSchema = z.object({
  repo: repoRefSchema,
  labels: z.array(z.object({ name: text })),
});
export const workItemCreateRequestSchema = requestBase
  .extend({
    op: z.literal('workitem.create'),
    repo: repoRefSchema,
    title: text,
    body: text,
    marker: text.refine(value => !/[\r\n]/.test(value), 'marker must be one line'),
  })
  .refine(
    value => value.body.split(/\r?\n/, 1)[0] === value.marker,
    'body must begin with the exact marker'
  );
export const workItemLabelsSetRequestSchema = requestBase.extend({
  op: z.literal('workitem.labels.set'),
  ref: workItemRefSchema,
  labels: labelNamesSchema,
});
export const repoLabelEnsureRequestSchema = requestBase.extend({
  op: z.literal('repo.label.ensure'),
  repo: repoRefSchema,
  name: text,
  color: z
    .string()
    .regex(/^[0-9a-fA-F]{6}$/)
    .transform(value => value.toLowerCase()),
  description: z.string(),
});
export const workItemRecordSchema = z.object({
  ref: workItemRefSchema,
  kind: z.literal('issue'),
  url: z.url(),
  state: z.enum(['open', 'closed']),
});
export type ForgeWorkItemRecord = z.infer<typeof workItemRecordSchema>;
export const labelRecordSchema = z.object({ name: text, color: text, descriptionDigest: text });
export type ForgeLabelRecord = z.infer<typeof labelRecordSchema>;
export const mergeConditionsSchema = z.strictObject({
  head: gitObjectIdSchema.optional(),
  base: gitObjectIdSchema.optional(),
  tree: gitObjectIdSchema.optional(),
});
export const mergeConditionSchema = mergeConditionsSchema.keyof();
export const prMergeRequestSchema = requestBase.extend({
  op: z.literal('pr.merge'),
  ref: prRefSchema,
  method: z.enum(['merge', 'squash']),
  conditions: mergeConditionsSchema,
});
export const checksRerunRequestSchema = requestBase.extend({
  op: z.literal('checks.rerun'),
  ref: prRefSchema,
  revision: gitObjectIdSchema,
  units: selectedChecksSchema,
});
export const prReviewsRequestSchema = requestBase.extend({
  op: z.literal('pr.reviews'),
  ref: prRefSchema,
});
export const reviewItemSchema = z.object({
  kind: z.enum(['review', 'review_comment']),
  id: text,
  author: sourceActorSchema.nullable(),
  commit: gitObjectIdSchema.nullable(),
  state: text.nullable(),
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  url: z.url(),
  body: z.string(),
});
export const prReviewsSchema = z.object({ ref: prRefSchema, items: z.array(reviewItemSchema) });
export const landedSchema = z.object({
  commit: gitObjectIdSchema.nullable(),
  tree: gitObjectIdSchema.nullable(),
  parents: z.array(gitObjectIdSchema).nullable(),
});
export const rerunEvidenceSchema = z.object({
  revision: gitObjectIdSchema,
  requested: selectedChecksSchema,
  observed: checkSelectionSchema,
});
export const mergeEvidenceSchema = z.object({
  method: prMergeRequestSchema.shape.method,
  conditions: mergeConditionsSchema,
  landed: landedSchema.optional(),
});

export const lifecycleReadRequestSchemas = [
  workItemViewRequestSchema,
  prViewRequestSchema,
  repoLabelsListRequestSchema,
  prReviewsRequestSchema,
] as const;
export const mutationRequestSchemas = [
  prMergeRequestSchema,
  checksRerunRequestSchema,
  prCreateRequestSchema,
  prEditBodyRequestSchema,
  prReadyRequestSchema,
  commentUpsertRequestSchema,
  workItemCreateRequestSchema,
  workItemLabelsSetRequestSchema,
  repoLabelEnsureRequestSchema,
] as const;
export const mutationRequestSchema = z.discriminatedUnion('op', mutationRequestSchemas);
export type ForgeMutationRequest = z.infer<typeof mutationRequestSchema>;
export const mutationOperationSchema = z.enum(
  mutationRequestSchemas.map(schema => schema.shape.op.value)
);

export const workItemViewSchema = workItemRecordSchema.extend({
  kind: z.enum(['issue', 'pr']),
  title: z.string(),
  body: z.string(),
  labels: labelNamesSchema.optional(),
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

/** The repository or item addressed by a mutation. */
export const mutationTargetSchema = z.union([prRefSchema, repoRefSchema]);
export type ForgeMutationTarget = z.infer<typeof mutationTargetSchema>;

const failureBase = z.object({
  op: mutationOperationSchema,
  target: mutationTargetSchema,
  merge: mergeEvidenceSchema.optional(),
  rerun: rerunEvidenceSchema.optional(),
});
const failureObservations = {
  observed: forgePrRecordSchema.optional(),
  workitem: workItemRecordSchema.optional(),
  label: labelRecordSchema.optional(),
};
export const mutationFailureSchema = z
  .discriminatedUnion('outcome', [
    failureBase.extend({ outcome: z.literal('refused'), ...failureObservations }),
    failureBase.extend({
      outcome: z.literal('verification_failed'),
      ...failureObservations,
      comment: commentRecordSchema.optional(),
      // What may remain on the forge, in the operator's terms, so reconciliation
      // starts from evidence rather than from a retry.
      leaveBehind: text,
    }),
    // Nothing was read back, so an unknown outcome carries no observation.
    failureBase.extend({ outcome: z.literal('outcome_unknown') }),
  ])
  .superRefine((value, ctx) => {
    if (
      (value.merge && value.op !== 'pr.merge') ||
      (value.rerun && value.op !== 'checks.rerun') ||
      (value.outcome === 'refused' && value.rerun && value.rerun.observed.length > 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Mutation evidence belongs to its operation' });
  });
export type ForgeMutationFailure = z.infer<typeof mutationFailureSchema>;

const appliedSchema = z.object({
  target: mutationTargetSchema,
  outcome: z.literal('applied'),
  changed: z.boolean(),
});

export const lifecycleReadResultSchemas = [
  z.object({ op: prReviewsRequestSchema.shape.op, value: prReviewsSchema }),
  z.object({ op: workItemViewRequestSchema.shape.op, value: workItemViewSchema }),
  z.object({ op: prViewRequestSchema.shape.op, value: prViewSchema.nullable() }),
  z.object({ op: repoLabelsListRequestSchema.shape.op, value: repoLabelsListSchema }),
] as const;
export const mutationResultSchemas = [
  z.object({
    op: workItemCreateRequestSchema.shape.op,
    value: appliedSchema.extend({
      workitem: workItemRecordSchema,
      markerDigest: text,
      titleDigest: text,
      bodyDigest: text,
    }),
  }),
  z.object({
    op: workItemLabelsSetRequestSchema.shape.op,
    value: appliedSchema.extend({ workitem: workItemRecordSchema, labels: labelNamesSchema }),
  }),
  z.object({
    op: repoLabelEnsureRequestSchema.shape.op,
    value: appliedSchema.extend({ label: labelRecordSchema }),
  }),
  z.object({
    op: prMergeRequestSchema.shape.op,
    value: appliedSchema.extend({
      target: prRefSchema,
      changed: z.literal(true),
      pr: forgePrRecordSchema,
      method: prMergeRequestSchema.shape.method,
      conditions: mergeConditionsSchema,
      enforcedConditions: z.array(mergeConditionSchema),
      landed: landedSchema,
    }),
  }),
  z.object({
    op: checksRerunRequestSchema.shape.op,
    value: appliedSchema.extend({
      target: prRefSchema,
      changed: z.literal(true),
      ref: prRefSchema,
      revision: gitObjectIdSchema,
      units: selectedChecksSchema,
    }),
  }),
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
  return 'repo' in request ? request.repo : request.ref;
}

export function mutationAttempt(
  request: ForgeMutationRequest
): Pick<ForgeMutationFailure, 'merge' | 'rerun'> {
  if (request.op === 'pr.merge')
    return { merge: { method: request.method, conditions: request.conditions } };
  if (request.op === 'checks.rerun')
    return { rerun: { revision: request.revision, requested: request.units, observed: [] } };
  return {};
}
