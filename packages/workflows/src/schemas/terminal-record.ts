import { z } from '@hono/zod-openapi';
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
export const terminalStatusSchema = terminalWorkflowRunStatusSchema;

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

export const terminalRecordSchema = z.object({
  run_id: z.string(),
  status: terminalStatusSchema,
  outcome: workflowRunOutcomeSchema.nullable(),
  error: z.string().nullable(),
  first_failed_node: z.string().nullable(),
  nodes: z.array(
    z.object({
      node_id: z.string(),
      state: nodeStateSchema,
      error: z.string().optional(),
      reason: nodeSkipReasonSchema.optional(),
      cause: skipCauseSchema.optional(),
    })
  ),
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
});
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
