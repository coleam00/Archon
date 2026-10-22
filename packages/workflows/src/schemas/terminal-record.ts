import { z } from 'zod';
import { fanOutOutcomeSchema } from './fan-out-outcome';
import { nodeArtifactSchema } from './node-artifact';
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
});
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
