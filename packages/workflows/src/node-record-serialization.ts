import { z } from '@hono/zod-openapi';
import type { TokenUsage } from '@archon/providers/types';
import type { NodeOutput } from './schemas/workflow-run';
import { nodeSkipReasonSchema, skipCauseSchema } from './schemas/node-state';
import {
  nodeDescriptorSchema,
  nodeInvocationSchema,
  executionBindingSchema,
  executionSpendSchema,
  nodeExecutionMetadataSchema,
  type NodeExecutionRecord,
  type NodeStateRecord,
  type ExecutionOutput,
} from './schemas/node-execution';
import { executionMetadata } from './node-execution';

/** Existing flat wire keys remain readable by older binaries. */
export const serializedNodeDataSchema = z.object({
  node: nodeDescriptorSchema.optional(),
  invocation: nodeInvocationSchema.optional(),
  attempt: nodeExecutionMetadataSchema.shape.attempt.optional(),
  binding: executionBindingSchema.optional(),
  timing: nodeExecutionMetadataSchema.shape.timing.optional(),
  spend: executionSpendSchema.optional(),
  accounting: nodeExecutionMetadataSchema.shape.accounting.optional(),
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
  stop_reason: z.string().optional(),
  num_turns: z.number().optional(),
  model_usage: z.object({ requested: z.string().optional(), resolved: z.string() }).optional(),
  error: z.string().optional(),
  retryable: z.literal(false).optional(),
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
  fan_out: z.boolean().optional(),
  identity: z.string().optional(),
  ordinal: z.number().optional(),
  approval_decision: z.string().optional(),
});
export type SerializedNodeData = z.infer<typeof serializedNodeDataSchema>;

const executionEventTypes = {
  started: 'node_started',
  completed: 'node_completed',
  failed: 'node_failed',
  skipped: 'node_skipped',
  suspended: 'node_suspended',
} as const satisfies Record<NodeExecutionRecord['lifecycle']['status'], string>;
export interface SerializedNodeEvent {
  workflow_run_id: string;
  step_name: string;
  event_type:
    | (typeof executionEventTypes)[keyof typeof executionEventTypes]
    | 'node_skipped_prior_success'
    | 'node_always_run_reset'
    | 'node_prior_cache_invalidated';
  data: SerializedNodeData;
}

function outputFields(
  output: ExecutionOutput
): Pick<
  SerializedNodeData,
  | 'node_output'
  | 'node_output_truncated'
  | 'node_output_original_bytes'
  | 'node_output_spill_path'
  | 'structured_output'
  | 'declared_fields'
> {
  return {
    node_output: output.persisted?.text ?? output.text,
    ...(output.persisted?.truncated
      ? {
          node_output_truncated: true,
          ...(output.persisted.originalBytes !== undefined
            ? { node_output_original_bytes: output.persisted.originalBytes }
            : {}),
          ...(output.persisted.spillPath !== undefined
            ? { node_output_spill_path: output.persisted.spillPath }
            : {}),
        }
      : {}),
    ...(output.structured !== undefined ? { structured_output: output.structured } : {}),
    ...(output.declaredFields !== undefined ? { declared_fields: output.declaredFields } : {}),
  };
}

export function serializeNodeStateRecord(record: NodeStateRecord): SerializedNodeEvent {
  const identity = { workflow_run_id: record.runId, step_name: record.path };
  if ('cache' in record) {
    const cache = record.cache;
    if (cache.action === 'replayed')
      return {
        ...identity,
        event_type: 'node_skipped_prior_success',
        data: { node: record.node, reason: 'prior_success', ...outputFields(cache.output) },
      };
    const prior = outputFields(cache.prior);
    return {
      ...identity,
      event_type:
        cache.action === 'reset' ? 'node_always_run_reset' : 'node_prior_cache_invalidated',
      data: {
        node: record.node,
        prior_output: prior.node_output,
        ...(prior.node_output_truncated ? { prior_output_truncated: true } : {}),
        ...(prior.node_output_original_bytes !== undefined
          ? { prior_output_original_bytes: prior.node_output_original_bytes }
          : {}),
        ...(prior.node_output_spill_path !== undefined
          ? { prior_output_spill_path: prior.node_output_spill_path }
          : {}),
        ...(cache.action === 'invalidated'
          ? {
              reason: 'stale_dependency',
              invalidating_deps: cache.invalidatingDeps,
              ...(cache.prior.structured !== undefined
                ? { prior_structured_output: cache.prior.structured }
                : {}),
            }
          : {}),
      },
    };
  }
  const {
    node,
    invocation,
    attempt,
    binding,
    timing,
    spend,
    accounting,
    lifecycle,
    diagnostics: d,
  } = record;
  const legacyType = node.kind === 'exec' ? (node.runtime === 'sh' ? 'bash' : 'script') : node.kind;
  return {
    ...identity,
    event_type: executionEventTypes[lifecycle.status],
    data: {
      node,
      invocation,
      attempt,
      binding,
      timing,
      spend,
      accounting,
      type: legacyType,
      ...(node.kind === 'agent'
        ? { command: node.source.kind === 'command' ? node.source.name : null }
        : {}),
      ...(node.kind === 'loop' ? { command: node.command ?? null } : {}),
      ...(node.kind === 'exec' && node.runtime !== 'sh' ? { runtime: node.runtime } : {}),
      ...(binding.provider !== undefined ? { provider: binding.provider } : {}),
      ...(binding.model?.requested !== undefined ? { model: binding.model.requested } : {}),
      ...(binding.tier !== undefined ? { tier: binding.tier } : {}),
      ...(binding.effort !== undefined ? { effort: binding.effort } : {}),
      ...(timing.durationMs !== undefined ? { duration_ms: timing.durationMs } : {}),
      ...(spend.tokens.source === 'provider' && node.kind !== 'loop_group'
        ? { tokens: spend.tokens.value }
        : {}),
      ...(spend.costUsd.source === 'provider' ? { cost_usd: spend.costUsd.value } : {}),
      ...(spend.stopReason.source === 'provider' ? { stop_reason: spend.stopReason.value } : {}),
      ...(spend.numTurns.source === 'provider' ? { num_turns: spend.numTurns.value } : {}),
      ...(binding.model?.resolved.source === 'provider'
        ? {
            model_usage: {
              requested: binding.model.requested,
              resolved: binding.model.resolved.value,
            },
          }
        : {}),
      ...(accounting !== 'node' ? { aggregate: true } : {}),
      ...(lifecycle.status === 'failed'
        ? {
            error: lifecycle.error,
            ...(lifecycle.retryable === false ? { retryable: false as const } : {}),
          }
        : {}),
      ...(lifecycle.status === 'skipped'
        ? { reason: lifecycle.reason, cause: lifecycle.cause }
        : {}),
      ...(lifecycle.status === 'suspended' ? { suspend_point: lifecycle.point } : {}),
      ...(record.output !== undefined ? outputFields(record.output) : {}),
      ...(d?.iteration !== undefined ? { iteration: d.iteration } : {}),
      ...(d?.command !== undefined ? { command: d.command } : {}),
      ...(d?.outputType !== undefined ? { output_type: d.outputType } : {}),
      ...(d?.status !== undefined ? { status: d.status } : {}),
      ...(d?.maxIterations !== undefined ? { maxIterations: d.maxIterations } : {}),
      ...(d?.sessionSourceNodeId !== undefined
        ? { session_source_node_id: d.sessionSourceNodeId }
        : {}),
      ...(d?.sessionForkRequested !== undefined
        ? { session_fork_requested: d.sessionForkRequested }
        : {}),
      ...(d?.sessionForked !== undefined ? { session_forked: d.sessionForked } : {}),
      ...(d?.backgroundTasksIncomplete !== undefined
        ? { background_tasks_incomplete: d.backgroundTasksIncomplete }
        : {}),
      ...(d?.childRunId !== undefined ? { child_run_id: d.childRunId } : {}),
      ...(d?.fanOut !== undefined ? { fan_out: d.fanOut } : {}),
      ...(d?.identity !== undefined ? { identity: d.identity } : {}),
      ...(d?.ordinal !== undefined ? { ordinal: d.ordinal } : {}),
      ...(d?.approvalDecision !== undefined ? { approval_decision: d.approvalDecision } : {}),
      ...(d?.expr !== undefined ? { expr: d.expr } : {}),
    },
  };
}

export type NodeExecutionResult = NodeOutput & {
  costUsd?: number;
  tokens?: TokenUsage;
  loopIterations?: number;
};

/** Full session cursors never enter the record or its public projections. */
export function serializeNodeOutput(
  record: NodeExecutionRecord,
  continuation: { sessionId?: string; resumed?: boolean } = {}
): NodeExecutionResult {
  const common = {
    output: record.output?.text ?? '',
    ...(record.output?.structured !== undefined
      ? { structuredOutput: record.output.structured }
      : {}),
    ...(record.output?.declaredFields !== undefined
      ? { declaredFields: record.output.declaredFields }
      : {}),
    ...(record.spend.tokens.source === 'provider' ? { tokens: record.spend.tokens.value } : {}),
    ...(record.spend.costUsd.source === 'provider' ? { costUsd: record.spend.costUsd.value } : {}),
    ...(record.diagnostics?.loopIterations !== undefined
      ? { loopIterations: record.diagnostics.loopIterations }
      : {}),
    execution: executionMetadata(record),
  };
  const lifecycle = record.lifecycle;
  switch (lifecycle.status) {
    case 'failed':
      return {
        ...common,
        state: 'failed',
        error: lifecycle.error,
        ...(lifecycle.retryable === false ? { retryable: false } : {}),
      };
    case 'skipped':
      return { ...common, state: 'skipped', cause: lifecycle.cause };
    case 'completed':
      return { ...common, ...continuation, state: 'completed' };
    case 'started':
    case 'suspended':
      return { ...common, ...continuation, state: 'running' };
  }
}

export function nodeRecordName(record: NodeStateRecord): string {
  return record.node.kind === 'agent' && record.node.source.kind === 'command'
    ? record.node.source.name
    : record.node.id;
}

export function serializeNodeTranscript(
  record: NodeStateRecord
): Omit<import('./logger').WorkflowEvent, 'ts' | 'workflow_id'> | undefined {
  if ('cache' in record)
    return record.cache.action === 'replayed'
      ? { type: 'node_skipped', step: record.node.id, content: 'prior_success' }
      : undefined;
  const lifecycle = record.lifecycle;
  const execution = executionMetadata(record);
  const base = { step: record.node.id, execution };
  const usage = {
    ...(record.spend.tokens.source === 'provider' ? { tokens: record.spend.tokens.value } : {}),
    ...(record.spend.costUsd.source === 'provider' ? { cost_usd: record.spend.costUsd.value } : {}),
  };
  const content =
    record.node.kind === 'agent'
      ? record.node.source.kind === 'command'
        ? record.node.source.name
        : '<inline>'
      : record.node.kind === 'exec'
        ? record.node.runtime === 'sh'
          ? '<bash>'
          : '<script>'
        : `<${record.node.kind}>`;
  switch (lifecycle.status) {
    case 'started':
      return { ...base, type: 'node_start', content };
    case 'completed':
      return {
        ...base,
        ...usage,
        type: 'node_complete',
        content,
        ...(record.timing.durationMs !== undefined
          ? { duration_ms: record.timing.durationMs }
          : {}),
      };
    case 'failed':
      return { ...base, ...usage, type: 'node_error', error: lifecycle.error };
    case 'skipped':
      return { ...base, type: 'node_skipped', content: lifecycle.reason, cause: lifecycle.cause };
    case 'suspended':
      return { ...base, type: 'node_suspended', content: lifecycle.point };
  }
}

export function serializeNodeEmitter(
  record: NodeStateRecord
): import('./event-emitter').WorkflowEmitterEvent | undefined {
  const base = { runId: record.runId, nodeId: record.node.id, nodeName: nodeRecordName(record) };
  if ('cache' in record)
    return record.cache.action === 'replayed'
      ? { ...base, type: 'node_skipped_prior_success' }
      : undefined;
  const lifecycle = record.lifecycle;
  const execution = executionMetadata(record);
  switch (lifecycle.status) {
    case 'started':
      return {
        ...base,
        execution,
        type: 'node_started',
        ...(record.binding.provider !== undefined ? { provider: record.binding.provider } : {}),
        ...(record.binding.model?.requested !== undefined
          ? { model: record.binding.model.requested }
          : {}),
        ...(record.binding.tier !== undefined ? { tier: record.binding.tier } : {}),
        ...(record.binding.effort !== undefined ? { effort: record.binding.effort } : {}),
      };
    case 'completed':
      return {
        ...base,
        execution,
        type: 'node_completed',
        ...(record.timing.durationMs !== undefined ? { duration: record.timing.durationMs } : {}),
        ...(record.spend.costUsd.source === 'provider'
          ? { costUsd: record.spend.costUsd.value }
          : {}),
        ...(record.spend.stopReason.source === 'provider'
          ? { stopReason: record.spend.stopReason.value }
          : {}),
        ...(record.spend.numTurns.source === 'provider'
          ? { numTurns: record.spend.numTurns.value }
          : {}),
      };
    case 'failed':
      return { ...base, execution, type: 'node_failed', error: lifecycle.error };
    case 'skipped':
      return lifecycle.reason === 'prior_success'
        ? { ...base, type: 'node_skipped_prior_success' }
        : {
            ...base,
            execution,
            type: 'node_skipped',
            reason: lifecycle.reason,
            cause: lifecycle.cause,
          };
    case 'suspended':
      return { ...base, execution, type: 'node_suspended' };
  }
}
