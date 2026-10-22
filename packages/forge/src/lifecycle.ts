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
  forgeSubjectRefSchema,
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
export const prDraftRequestSchema = requestBase.extend({
  op: z.literal('pr.draft'),
  ref: prRefSchema,
});
// The marker identifies the one canonical comment, so it has to survive a
// first-line comparison against a body the forge may have re-wrapped.
const commentMarker = text.refine(
  value => !/[\r\n]/.test(value),
  'comment marker must be one line'
);
/** The pull-request form, kept for callers and installed plugins that predate subjects. */
export const commentUpsertRequestSchema = requestBase.extend({
  op: z.literal('comment.upsert'),
  ref: prRefSchema,
  marker: commentMarker,
  body: text,
});
/** The canonical marked comment on an issue or a pull request. */
export const workItemCommentUpsertRequestSchema = requestBase.extend({
  op: z.literal('workitem.comment.upsert'),
  subject: forgeSubjectRefSchema,
  marker: commentMarker,
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
/**
 * One label added to or removed from an issue or pull request, leaving every
 * other label untouched, so concurrent writers on one item cannot drop each
 * other's labels the way two whole-set replacements can.
 */
export const workItemLabelAddRequestSchema = requestBase.extend({
  op: z.literal('workitem.label.add'),
  subject: forgeSubjectRefSchema,
  name: text,
});
export const workItemLabelRemoveRequestSchema = requestBase.extend({
  op: z.literal('workitem.label.remove'),
  subject: forgeSubjectRefSchema,
  name: text,
});
export const closeReasonSchema = z.enum(['completed', 'not_planned', 'duplicate']);
/** Close an issue, recording why. An issue already closed for another reason is refused. */
export const workItemCloseRequestSchema = requestBase.extend({
  op: z.literal('workitem.close'),
  ref: workItemRefSchema,
  reason: closeReasonSchema,
});
/** Open issues and pull requests that carry one label. */
export const workItemListRequestSchema = requestBase.extend({
  op: z.literal('workitem.list'),
  repo: repoRefSchema,
  label: text,
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
/** An issue or a pull request, as a label operation or listing observed it. */
export const subjectRecordSchema = workItemRecordSchema.extend({ kind: z.enum(['issue', 'pr']) });
export type ForgeSubjectRecord = z.infer<typeof subjectRecordSchema>;
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
/** Every review thread on a pull request, read in full: a partial list could hide an open one. */
export const prThreadsRequestSchema = requestBase.extend({
  op: z.literal('pr.threads'),
  ref: prRefSchema,
});
export const reviewThreadCommentSchema = z.object({
  id: text,
  author: sourceActorSchema.nullable(),
  body: z.string(),
  url: z.url(),
});
export const reviewThreadSchema = z.object({
  id: text,
  resolved: z.boolean(),
  outdated: z.boolean(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  comments: z.array(reviewThreadCommentSchema),
});
export type ForgeReviewThread = z.infer<typeof reviewThreadSchema>;
export const prThreadsSchema = z.object({ ref: prRefSchema, threads: z.array(reviewThreadSchema) });
/** Every conversation comment on an issue or pull request, oldest first, read in full. */
export const workItemCommentsRequestSchema = requestBase.extend({
  op: z.literal('workitem.comments'),
  subject: forgeSubjectRefSchema,
});
export const workItemCommentSchema = z.object({
  id: text,
  author: sourceActorSchema.nullable(),
  url: z.url(),
  body: z.string(),
});
/** How far a pull request's head is behind its repository's default branch, and whether it merges. */
export const prMergeStateRequestSchema = requestBase.extend({
  op: z.literal('pr.merge-state'),
  ref: prRefSchema,
});
export const prMergeStateSchema = z.object({
  ref: prRefSchema,
  head_revision: gitObjectIdSchema,
  default_branch: text,
  default_revision: gitObjectIdSchema,
  /** Commits of the default branch at `default_revision` that the head at `head_revision` lacks. */
  behind: z.number().int().nonnegative(),
  mergeable: z.enum(['clean', 'conflict', 'unknown']),
  /** The commit the pull request landed as; null until it is merged. */
  merge_commit: gitObjectIdSchema.nullable(),
});
/** A reply on one review thread of the pull request `ref`. */
export const prThreadReplyRequestSchema = requestBase.extend({
  op: z.literal('pr.thread.reply'),
  ref: prRefSchema,
  thread: text,
  body: text,
});
/** Resolve one review thread of the pull request `ref`. */
export const prThreadResolveRequestSchema = requestBase.extend({
  op: z.literal('pr.thread.resolve'),
  ref: prRefSchema,
  thread: text,
});
/** Replace an issue's body. */
export const workItemEditBodyRequestSchema = requestBase.extend({
  op: z.literal('workitem.edit-body'),
  ref: workItemRefSchema,
  body: z.string(),
});
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
  prThreadsRequestSchema,
  workItemListRequestSchema,
  workItemCommentsRequestSchema,
  prMergeStateRequestSchema,
] as const;
export const mutationRequestSchemas = [
  prMergeRequestSchema,
  checksRerunRequestSchema,
  prCreateRequestSchema,
  prEditBodyRequestSchema,
  prReadyRequestSchema,
  prDraftRequestSchema,
  commentUpsertRequestSchema,
  workItemCommentUpsertRequestSchema,
  workItemCreateRequestSchema,
  workItemCloseRequestSchema,
  workItemLabelsSetRequestSchema,
  workItemLabelAddRequestSchema,
  workItemLabelRemoveRequestSchema,
  repoLabelEnsureRequestSchema,
  prThreadReplyRequestSchema,
  prThreadResolveRequestSchema,
  workItemEditBodyRequestSchema,
] as const;
export const mutationRequestSchema = z.discriminatedUnion('op', mutationRequestSchemas);
export type ForgeMutationRequest = z.infer<typeof mutationRequestSchema>;
export const mutationOperationSchema = z.enum(
  mutationRequestSchemas.map(schema => schema.shape.op.value)
);

// Absent means the plugin does not report an author; null means the forge has none.
const authorSchema = sourceActorSchema.nullable().optional();
export const workItemViewSchema = subjectRecordSchema.extend({
  title: z.string(),
  body: z.string(),
  labels: labelNamesSchema.optional(),
  author: authorSchema,
});
export const prViewSchema = z.object({
  pr: forgePrRecordSchema,
  title: z.string(),
  body: z.string(),
  author: authorSchema,
});
export const workItemListSchema = z.object({
  repo: repoRefSchema,
  label: text,
  items: z.array(subjectRecordSchema),
});
export const workItemCommentsSchema = z.object({
  workitem: subjectRecordSchema,
  comments: z.array(workItemCommentSchema),
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
  workitem: subjectRecordSchema.optional(),
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
  z.object({ op: prThreadsRequestSchema.shape.op, value: prThreadsSchema }),
  z.object({ op: workItemViewRequestSchema.shape.op, value: workItemViewSchema }),
  z.object({ op: prViewRequestSchema.shape.op, value: prViewSchema.nullable() }),
  z.object({ op: repoLabelsListRequestSchema.shape.op, value: repoLabelsListSchema }),
  z.object({ op: workItemListRequestSchema.shape.op, value: workItemListSchema }),
  z.object({ op: workItemCommentsRequestSchema.shape.op, value: workItemCommentsSchema }),
  z.object({ op: prMergeStateRequestSchema.shape.op, value: prMergeStateSchema }),
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
  // `labels` is the item's complete label set as read back after the write.
  z.object({
    op: workItemLabelAddRequestSchema.shape.op,
    value: appliedSchema.extend({ workitem: subjectRecordSchema, labels: labelNamesSchema }),
  }),
  z.object({
    op: workItemLabelRemoveRequestSchema.shape.op,
    value: appliedSchema.extend({ workitem: subjectRecordSchema, labels: labelNamesSchema }),
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
    op: prDraftRequestSchema.shape.op,
    value: appliedSchema.extend({ pr: forgePrRecordSchema }),
  }),
  z.object({
    op: commentUpsertRequestSchema.shape.op,
    value: appliedSchema.extend({ comment: commentRecordSchema }),
  }),
  z.object({
    op: workItemCommentUpsertRequestSchema.shape.op,
    value: appliedSchema.extend({ workitem: subjectRecordSchema, comment: commentRecordSchema }),
  }),
  // `reason` is the close reason as read back after the write.
  z.object({
    op: workItemCloseRequestSchema.shape.op,
    value: appliedSchema.extend({ workitem: workItemRecordSchema, reason: closeReasonSchema }),
  }),
  z.object({
    op: prThreadReplyRequestSchema.shape.op,
    value: appliedSchema.extend({ thread: text, comment: commentRecordSchema }),
  }),
  z.object({
    op: prThreadResolveRequestSchema.shape.op,
    value: appliedSchema.extend({ thread: text, resolved: z.literal(true) }),
  }),
  z.object({
    op: workItemEditBodyRequestSchema.shape.op,
    value: appliedSchema.extend({ workitem: workItemRecordSchema, bodyDigest: text }),
  }),
] as const;

export function mutationTarget(request: ForgeMutationRequest): ForgeMutationTarget {
  if ('repo' in request) return request.repo;
  return 'subject' in request ? request.subject.ref : request.ref;
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
