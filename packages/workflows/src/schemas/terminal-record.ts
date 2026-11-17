import { z } from 'zod';
import { gitObjectIdSchema } from './checkout-observation';
import { fanOutOutcomeSchema } from './fan-out-outcome';
import { nodeArtifactSchema } from './node-artifact';
import { nodeFailureKindSchema } from './node-execution';
import {
  nodeStateSchema,
  nodeSkipReasonSchema,
  skipCauseSchema,
  workflowRunOutcomeSchema,
  terminalWorkflowRunStatusSchema,
} from './workflow-run';

export const RUN_GRAPH_METADATA_KEY = 'terminal_graph';
export const runGraphSchema = z.object({
  node_ids: z.array(z.string()),
  returns: z.string().optional(),
});
export type RunGraph = z.infer<typeof runGraphSchema>;
export const terminalStatusSchema = terminalWorkflowRunStatusSchema;

/** Run metadata key where a completed run's host-assessed disposition waits for the record. */
export const WORKTREE_DISPOSITION_METADATA_KEY = 'worktree_disposition';
/** What happens to the worktree a run created once the run is terminal, and why it stays. */
export const worktreeDispositionSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('release') }),
  z.object({
    disposition: z.literal('retained'),
    reason: z.enum([
      'resumable',
      'cancelled',
      'workspace_retained',
      'in_use',
      'uncommitted_changes',
      'unpushed_commits',
      'published_branch',
      'check_failed',
    ]),
    detail: z.string().optional(),
  }),
]);
export type WorktreeDisposition = z.infer<typeof worktreeDispositionSchema>;

/** Run metadata key where a completed run's result commit waits for the record. */
export const RESULT_COMMIT_METADATA_KEY = 'result_commit';
/**
 * The commit a completed run's result holds at (#5769): the commit its checkout was on when
 * its `returns:` node completed, only when the checkout was clean at that commit then and
 * still is when the run completes. A result that holds at no commit says why: `dirty` (a
 * tracked change or an untracked file), `not_git`, `unavailable` (the engine could not read
 * the checkout, or its backend), `unborn` (no commit yet), `moved` (HEAD moved after the
 * `returns:` node completed, even to another commit and back, or a run that takes no path
 * lock is not on the commit it started on or saw HEAD move since its first pass began), `concurrent` (the `returns:` node ran,
 * or could have run, beside other nodes, which may have moved the checkout while it judged), `unobserved` (no
 * `returns:` node completed in the pass that completed the run: none is declared, or a
 * resume replayed it; HEAD or its branch keeps no reflog to show it did not move; or a run that takes no
 * path lock has no git start commit or start mark recorded, as on a resume).
 */
export const resultCommitSchema = z.discriminatedUnion('held', [
  z.object({ held: z.literal(true), commit: gitObjectIdSchema }),
  z.object({
    held: z.literal(false),
    reason: z.enum([
      'dirty',
      'not_git',
      'unavailable',
      'unborn',
      'moved',
      'concurrent',
      'unobserved',
    ]),
  }),
]);
export type ResultCommit = z.infer<typeof resultCommitSchema>;

export const artifactManifestSchema = z.object({
  root: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number().nonnegative(),
      metadata: nodeArtifactSchema.optional(),
    })
  ),
  limitations: z.array(
    z.object({
      path: z.string(),
      kind: z.enum([
        'missing',
        'unreadable',
        'invalid_metadata',
        'link_excluded',
        'unsupported_entry',
        'root_unavailable',
      ]),
      code: z.string().optional(),
    })
  ),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export const runNodeStateSchema = z.object({
  node_id: z.string(),
  state: nodeStateSchema,
  error: z.string().optional(),
  /** Why a failed node failed, as recorded: the name a `retry.on_error` policy targets. */
  failure_kind: nodeFailureKindSchema.optional(),
  reason: nodeSkipReasonSchema.optional(),
  cause: skipCauseSchema.optional(),
  /** A `workflow:` fan-out node's per-slot record; the node's state says nothing about its children. */
  fan_out_outcome: fanOutOutcomeSchema.optional(),
});
export type RunNodeState = z.infer<typeof runNodeStateSchema>;

export const terminalRecordSchema = z.object({
  run_id: z.string(),
  status: terminalStatusSchema,
  outcome: workflowRunOutcomeSchema.nullable(),
  /**
   * The run's `completed_outcome` when the record was written: the outcome a completed run
   * completed with, named outcomes included. Absent from records written before it existed.
   */
  completed_outcome: z.string().min(1).nullable().optional(),
  error: z.string().nullable(),
  first_failed_node: z.string().nullable(),
  nodes: z.array(runNodeStateSchema),
  returns: z.discriminatedUnion('availability', [
    z.object({ availability: z.literal('available'), node_id: z.string(), value: z.unknown() }),
    z.object({
      availability: z.literal('unavailable'),
      node_id: z.string().nullable(),
      reason: z.enum([
        'not_declared',
        'graph_unavailable',
        'node_not_completed',
        'output_not_persisted',
      ]),
    }),
    z.object({
      availability: z.literal('truncated'),
      node_id: z.string(),
      spill_path: z.string().nullable(),
      original_bytes: z.number().nullable(),
    }),
  ]),
  artifacts: artifactManifestSchema,
  /**
   * Present only when the run holds proof that it created its worktree; on a completed
   * run, only when that worktree is on the run's own generated branch.
   */
  worktree_disposition: worktreeDispositionSchema.optional(),
  /**
   * Present only on a completed run recorded since #5769. Absent means the result holds at
   * no commit: a reader never takes another commit in its place.
   */
  result_commit: resultCommitSchema.optional(),
});
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
