/**
 * Zod schemas for workflow run state types: the run row here, and each area of the
 * run's state in its own module, all re-exported from this one.
 */
import { z } from 'zod';
import { checkoutObservationSchema } from './checkout-observation';
import { workflowRunOutcomeSchema, workflowRunStatusSchema } from './run-status';

export * from './run-status';
export * from './run-wait';
export * from './pause-occurrence';
export * from './node-output';
export * from './run-metadata';
export * from './approval-context';
export * from './run-attention';

// ---------------------------------------------------------------------------
// NodeState
// ---------------------------------------------------------------------------

export { nodeStateSchema, skipCauseSchema, nodeSkipReasonSchema } from './node-state';
export type { NodeState, SkipCause, NodeSkipReason } from './node-state';
export { suspendReasonSchema } from './node-state';
export type { SuspendReason } from './node-state';

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

export const workflowRunOriginSchema = z
  .object({
    conversationId: z.string().optional(),
    parentConversationId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

export type WorkflowRunOrigin = z.infer<typeof workflowRunOriginSchema>;

export const workflowRunSchema = z.object({
  origin: workflowRunOriginSchema.nullable(),
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  codebase_id: z.string().nullable(),
  status: workflowRunStatusSchema,
  outcome: workflowRunOutcomeSchema.nullable(),
  user_message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
  working_path: z.string().nullable(),
  user_id: z.string().nullable(),
  /**
   * Run-tree parent (#2121 Phase 2). Set when this run is a `workflow:` sub-run
   * spawned as one node of a parent run; null for top-level runs. Self-referential
   * FK with ON DELETE SET NULL (a deleted parent orphans, never cascades). Paired
   * with `metadata.parent_node_id` so the parent can re-find WHICH node's child on
   * resume.
   */
  parent_run_id: z.string().nullable(),
  /**
   * Between-run continuation (#2747). The terminal run whose estate (branch/
   * worktree + artifacts-by-reference via `$ADOPTED_RUN_DIR`) this run
   * explicitly adopted. Written once at run creation, never on resume (the
   * `output_root` write-once precedent). Reverse lookup (`adopted_by`) reads
   * the same column — the chain walks in both directions with no second
   * column. Also carries supersession (`--supersedes`), which records
   * provenance WITHOUT lane inheritance; the mode lives in run metadata.
   */
  adopted_from_run_id: z.string().nullable(),
  /**
   * Durable pointer to this run's storage tree (#2200) — the resolved
   * `~/.archon/workspaces/<project>/` root its artifacts, logs, and state live
   * under. Written ONCE at run start and never rewritten (a resume must not
   * re-derive it). Readers prefer it and only fall back to deriving identity
   * from the codebase row when it is null, which is what keeps historical
   * artifacts addressable across a codebase rename (#1192). Null on rows
   * created before the column existed.
   */
  output_root: z.string().nullable(),
  /**
   * The checkout this run started from (#3305): observed once, immediately after the run
   * won its execution claim and before its first node, then never rewritten. A resume
   * keeps it. Null means not recorded — a run from before this column, or one that never
   * started — which is different from a recorded `not_git` or `unavailable` observation.
   */
  checkout_baseline: checkoutObservationSchema.nullable(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

// ---------------------------------------------------------------------------
// ArtifactType
// ---------------------------------------------------------------------------

export const artifactTypeSchema = z.enum([
  'pr',
  'commit',
  'file_created',
  'file_modified',
  'branch',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;
