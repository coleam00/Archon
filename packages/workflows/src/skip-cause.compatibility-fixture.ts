// Frozen skip readers from d3bdfbb39 (#5444). Unchanged imported contracts are shared;
// cause, reason, and the complete persisted payload reader stay at their pre-provenance shape.
import { z } from 'zod';
import { declaredOutputPathsSchema } from './output-ref';
import { providerFailureSchema } from '@archon/provider-contract';
import { fanOutOutcomeSchema } from './schemas/fan-out-outcome';
import {
  childUsageSchema,
  executionBindingSchema,
  executionSpendSchema,
  nodeExecutionMetadataPayloadSchema,
  nodeFailureKindSchema,
  mcpUnavailableSchema,
} from './schemas/node-execution';

const skipCauseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('condition'), expr: z.string() }),
  z.object({ kind: z.literal('condition_parse_error'), expr: z.string() }),
  z.object({ kind: z.literal('timeout') }),
  z.object({ kind: z.literal('upstream_failed'), origin: z.string() }),
  z.object({ kind: z.literal('upstream_skipped'), origin: z.string() }),
]);

const nodeSkipReasonSchema = z.enum([
  'prior_success',
  'when_condition',
  'when_condition_parse_error',
  'trigger_rule',
  'timeout',
]);

export const oldSerializedNodeDataSchema = z.object({
  ...nodeExecutionMetadataPayloadSchema.partial().shape,
  type: z.string().optional(),
  command: z.string().nullable().optional(),
  runtime: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  tier: executionBindingSchema.shape.tier,
  effort: executionBindingSchema.shape.effort,
  duration_ms: z.number().optional(),
  tokens: executionSpendSchema.shape.tokens.options[0].shape.value.optional(),
  cost_usd: z.number().optional(),
  /** Carried gate spend; deferred `spend` contains only newly incurred usage. */
  loopBaseline: executionSpendSchema.optional(),
  cost_partial: z.literal(true).optional(),
  stop_reason: z.string().optional(),
  num_turns: z.number().optional(),
  model_usage: z.object({ requested: z.string().optional(), resolved: z.string() }).optional(),
  error: z.string().optional(),
  retryable: z.literal(false).optional(),
  failure_kind: nodeFailureKindSchema.optional(),
  provider_failure: providerFailureSchema.optional(),
  reason: z.union([nodeSkipReasonSchema, z.literal('stale_dependency')]).optional(),
  cause: skipCauseSchema.optional(),
  expr: z.string().optional(),
  suspend_point: z.string().optional(),
  node_output: z.string().optional(),
  node_output_truncated: z.boolean().optional(),
  node_output_original_bytes: z.number().optional(),
  node_output_spill_path: z.string().optional(),
  structured_output: z.unknown().optional(),
  declared_fields: z.array(z.string()).optional(),
  declared_output_paths: declaredOutputPathsSchema.optional(),
  prior_output: z.string().optional(),
  prior_output_truncated: z.boolean().optional(),
  prior_output_original_bytes: z.number().optional(),
  prior_output_spill_path: z.string().optional(),
  prior_structured_output: z.unknown().optional(),
  invalidating_deps: z.array(z.string()).optional(),
  aggregate: z.boolean().optional(),
  iteration: z.number().optional(),
  output_type: z.string().optional(),
  status: z.string().optional(),
  maxIterations: z.number().optional(),
  session_source_node_id: z.string().optional(),
  session_fork_requested: z.boolean().optional(),
  session_forked: z.boolean().optional(),
  background_tasks_incomplete: z.array(z.string()).optional(),
  child_run_id: z.string().optional(),
  child_usage: z.array(childUsageSchema).optional(),
  blocked_on_child_run_id: z.string().optional(),
  fan_out: z.boolean().optional(),
  fan_out_outcome: fanOutOutcomeSchema.optional(),
  identity: z.string().optional(),
  ordinal: z.number().optional(),
  approval_decision: z.string().optional(),
  mcp_unavailable: mcpUnavailableSchema.optional(),
  /** The full provider session id; only this durable row carries it. */
  session_id: z.string().optional(),
});

export const oldSkippedLifecycleSchema = z.object({
  status: z.literal('skipped'),
  reason: nodeSkipReasonSchema,
  cause: skipCauseSchema,
});

export const oldRunSkippedNodeSchema = z.object({
  node_id: z.string(),
  state: z.literal('skipped'),
  reason: nodeSkipReasonSchema.optional(),
  cause: skipCauseSchema.optional(),
  fan_out_outcome: fanOutOutcomeSchema.optional(),
});
