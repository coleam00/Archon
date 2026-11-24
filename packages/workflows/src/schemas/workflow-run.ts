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

export const ITEM_KEY_MAX_LENGTH = 200;
/** An item's key within its project. The engine gives it no meaning and never parses it. */
export const itemKeySchema = z.string().min(1).max(ITEM_KEY_MAX_LENGTH);

export const ITEM_TITLE_MAX_LENGTH = 300;
/**
 * What an item is called, for a reader. Whoever knows it sets it (`archon workflow title`)
 * and setting it again replaces it; the engine gives it no meaning and never derives it
 * from the key or any other text.
 */
export const itemTitleSchema = z
  .string()
  .trim()
  .min(1, 'A title needs text')
  .max(ITEM_TITLE_MAX_LENGTH, `A title is at most ${String(ITEM_TITLE_MAX_LENGTH)} characters`);

/**
 * The durable thing runs are about: a key within a project (`ProjectRef.key`), and its
 * title. Every read from the store carries `title`, null until one is set; it is optional
 * so an item serialized before titles existed still reads.
 */
export const workflowItemSchema = z.object({
  id: z.string(),
  projectKey: z.string(),
  key: itemKeySchema,
  title: z.string().nullish(),
});
export type WorkflowItem = z.infer<typeof workflowItemSchema>;

/** Refuse a key the store cannot hold, in words the operator who named it can act on. */
export function assertItemKey(key: string): void {
  if (!itemKeySchema.safeParse(key).success)
    throw new Error(`An item key must be 1 to ${String(ITEM_KEY_MAX_LENGTH)} characters.`);
}

/**
 * A continuation cannot stay on the continued run's item because it runs in another
 * project. Chat and the API reach it as well as the CLI, so the message names no flag.
 */
export class ContinuedItemProjectError extends Error {}

export const workflowRunSchema = z.object({
  origin: workflowRunOriginSchema.nullable(),
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  codebase_id: z.string().nullable(),
  status: workflowRunStatusSchema,
  /**
   * The authored verdict of a workflow whose `returns.outcome` is a boolean. Kept for
   * readers that predate `completed_outcome`; written at completion, as that is.
   */
  outcome: workflowRunOutcomeSchema.nullable(),
  /**
   * The outcome this run completed with, from `returns.outcome`: an enum value as it is,
   * a boolean as `succeeded` or `failed`. Written only in the write that completes the
   * run, so a reader that sees one can rely on the run being over. Null for any run that
   * did not complete, or whose workflow declares no outcome.
   */
  completed_outcome: z.string().nullable(),
  user_message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  started_at: z.date(),
  active_phase_started_at: z.date().nullable(),
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
  /**
   * The item this run belongs to. Written once at creation and the only place a run's
   * item is read from. Null for a run started with no item, and for a `workflow:`
   * sub-run, which belongs to its item through `parent_run_id`.
   */
  item_id: z.string().nullable(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/**
 * The outcome to show for a run. A run completed by a binary from before
 * `completed_outcome` has only `outcome`; a run that did not complete shows none, though
 * an older binary may have written `outcome` on it while it ran.
 */
export function displayedRunOutcome(
  run: Pick<WorkflowRun, 'status' | 'outcome' | 'completed_outcome'>
): string | null {
  return run.completed_outcome ?? (run.status === 'completed' ? run.outcome : null);
}

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
