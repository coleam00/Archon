import { z } from 'zod';
import { prRefSchema, shaSchema } from './identity-schemas';

export const PINNED_MERGE_OP = 'pr.merge-pinned';
// Fully qualified Git branch refs; Git also validates these before using them.
export const mergeBranchRefSchema = z.string().regex(/^refs\/heads\/.+/);
export const pinnedMergeRequestSchema = z.object({
  ref: prRefSchema,
  expected_head_ref: mergeBranchRefSchema,
  expected_head_sha: shaSchema,
  expected_base_ref: mergeBranchRefSchema,
  expected_base_sha: shaSchema,
  candidate_sha: shaSchema,
  checkout: z.string().min(1),
});
export type PinnedMergeRequest = z.infer<typeof pinnedMergeRequestSchema>;
export const pinnedMergePinsSchema = pinnedMergeRequestSchema.omit({ checkout: true });
export const mergeRecoverySchema = pinnedMergePinsSchema.extend({
  publication: z.enum(['not_attempted', 'unknown', 'applied']),
  temporary_ref: z.string().optional(),
  cleanup: z.enum(['not_needed', 'removed', 'retained', 'unknown']),
});
export type MergeRecovery = z.infer<typeof mergeRecoverySchema>;
export const pinnedMergeResultSchema = z.object({
  status: z.enum(['merged', 'already_merged']),
  ...mergeRecoverySchema.shape,
  publication: z.literal('applied'),
});
export type PinnedMergeResult = z.infer<typeof pinnedMergeResultSchema>;
