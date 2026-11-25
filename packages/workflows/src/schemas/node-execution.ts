import { runUsageSchema } from './run-usage';
import { declaredOutputPathsSchema } from '../output-ref';
import { z } from 'zod';
import { fanOutOutcomeSchema } from './fan-out-outcome';
import {
  providerFailureSchema,
  SESSION_PREVIEW_LENGTH,
  tokenUsageSchema,
} from '@archon/provider-contract';
import { agentNodeSchema } from './agent-node';
import { execNodeSchema } from './exec-node';
import { loopNodeSchema } from './loop-node';
import { loopGroupNodeSchema } from './dag-node';
import { gateNodeSchema } from './gate-node';
import { haltNodeSchema } from './halt-node';
import { waitNodeSchema } from './wait-node';
import { workflowNodeSchema } from './workflow-node';
import { composeFanOutNodeSchema } from './include-node';
import { effortLevelSchema } from './effort';
import { tierNameSchema } from './model-binding';
import { nodeSkipReasonSchema, skipCauseSchema, suspendReasonSchema } from './node-state';
import { checkoutObservationSchema } from './checkout-observation';

export const unavailableMeasurementSchema = z.object({
  source: z.literal('unavailable'),
  /** `incomplete` invalidates totals; `unknown` describes an unspecified reporting capability. */
  reason: z.enum([
    'unsupported',
    'not_reported',
    'unknown',
    'not_applicable',
    'invalid',
    'incomplete',
  ]),
});
export function reportedMeasurementSchema<T extends z.ZodType>(
  value: T
): z.ZodDiscriminatedUnion<
  [
    z.ZodObject<{ source: z.ZodLiteral<'provider'>; value: T }>,
    typeof unavailableMeasurementSchema,
  ],
  'source'
> {
  return z.discriminatedUnion('source', [
    z.object({ source: z.literal('provider'), value }),
    unavailableMeasurementSchema,
  ]);
}
export const executionSpendSchema = z.object({
  tokens: reportedMeasurementSchema(tokenUsageSchema),
  costUsd: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('provider'),
      value: z.number(),
      /**
       * The attempt made provider calls whose cost was not all reported, so
       * `value` is a floor. A run budget treats such a cost as unavailable.
       */
      partial: z.literal(true).optional(),
    }),
    unavailableMeasurementSchema,
  ]),
  stopReason: reportedMeasurementSchema(z.string()),
  numTurns: reportedMeasurementSchema(z.number()),
});

/**
 * Where a node that came in through an include was written: its own id there, the
 * workflow that declared it, and the include node ids that brought it in, outermost
 * first. A node id `rounds__review__review` reads `{ nodeId: 'review', includes:
 * ['rounds', 'review'] }`. Absent on a node of the run's own workflow.
 */
export const composedNodeOriginSchema = z.object({
  nodeId: z.string(),
  workflow: z.string(),
  includes: z.array(z.string()),
});
export type ComposedNodeOrigin = z.infer<typeof composedNodeOriginSchema>;

const composedField = { composed: composedNodeOriginSchema.optional() };

export const nodeDescriptorSchema = z.discriminatedUnion('kind', [
  agentNodeSchema.pick({ id: true, kind: true }).extend({
    ...composedField,
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('inline') }),
      z.object({ kind: z.literal('command'), name: z.string() }),
    ]),
  }),
  execNodeSchema.pick({ id: true, kind: true, runtime: true }).extend(composedField),
  loopNodeSchema
    .pick({ id: true, kind: true })
    .extend({ ...composedField, command: z.string().optional() }),
  loopGroupNodeSchema.pick({ id: true, kind: true }).extend(composedField),
  gateNodeSchema.pick({ id: true, kind: true }).extend(composedField),
  haltNodeSchema.pick({ id: true, kind: true }).extend(composedField),
  waitNodeSchema.pick({ id: true, kind: true }).extend(composedField),
  workflowNodeSchema
    .pick({ id: true, kind: true })
    .extend({ ...composedField, fanOut: z.literal(true).optional() }),
  composeFanOutNodeSchema.pick({ id: true, kind: true }).extend(composedField),
  z.object({ kind: z.literal('compose_fan_out_instance'), id: z.string() }),
]);
export type NodeDescriptor = z.infer<typeof nodeDescriptorSchema>;

/** A descriptor's include origin, for the readers that put it next to the node's name. */
export function composedOrigin(node: NodeDescriptor): ComposedNodeOrigin | undefined {
  return 'composed' in node ? node.composed : undefined;
}

export const nodeInvocationSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime({ offset: true }),
  loopPath: z.array(z.object({ groupId: z.string(), iteration: z.number().int() })),
  /**
   * The checkout when this invocation's first attempt started. Later attempts, inner loop
   * turns, and a resumed continuation keep it; only a new invocation samples again.
   * Absent for node kinds that do not execute against the checkout.
   */
  checkoutStart: checkoutObservationSchema.optional(),
});
export type NodeInvocation = z.infer<typeof nodeInvocationSchema>;

export const executionBindingSchema = z.object({
  provider: z.string().optional(),
  model: z
    .object({
      requested: z.string().optional(),
      resolved: reportedMeasurementSchema(z.string()),
    })
    .optional(),
  tier: tierNameSchema.optional(),
  effort: effortLevelSchema.optional(),
  sessionPreview: z.string().max(SESSION_PREVIEW_LENGTH).optional(),
  sessionOrigin: z.enum(['fresh', 'resumed', 'resume-failed-cold']).optional(),
});
export type ExecutionBinding = z.infer<typeof executionBindingSchema>;

/**
 * Why a node failed, recorded where the failure is known rather than re-read from
 * `error` prose later. `fatal`/`transient`/`rate_limited`/`overloaded`/`unknown` classify a provider
 * error; `schema_unmet` is a final output that did not meet its schema, found by the provider or
 * by the engine's own validation; the rest name engine-detected causes. Every kind maps to a retry class in
 * `executor-shared.ts`. Absent on records written before this field existed; retry
 * treats an absent kind as `unknown`.
 *
 * `outcome_unknown` says the engine does not know whether the node's side effect happened,
 * so nothing may run it again by itself (`unknown-outcome.ts`). That is distinct from
 * `retryable: false`, which only stops the node's immediate retry.
 */
export const nodeFailureKindSchema = z.enum([
  'fatal',
  'transient',
  'unknown',
  'rate_limited',
  'overloaded',
  'timeout',
  'exec_failed',
  'output_contract',
  'schema_unmet',
  'max_iterations',
  'child_failed',
  'cancelled',
  'config',
  'outcome_unknown',
]);
export type NodeFailureKind = z.infer<typeof nodeFailureKindSchema>;

export const executionLifecycleSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started') }),
  z.object({ status: z.literal('completed') }),
  z.object({
    status: z.literal('failed'),
    error: z.string(),
    retryable: z.literal(false).optional(),
    failureKind: nodeFailureKindSchema.optional(),
    /** The provider's own typed failure, unchanged, when a provider reported one. */
    providerFailure: providerFailureSchema.optional(),
    /** Numeric exit code from the subprocess, when one was available. Absent for spawn failures, timeouts, and cancellations. */
    exitCode: z.number().optional(),
  }),
  z.object({ status: z.literal('skipped'), reason: nodeSkipReasonSchema, cause: skipCauseSchema }),
  z.object({
    status: z.literal('suspended'),
    point: z.union([suspendReasonSchema, z.literal('wait')]),
  }),
]);

/** Output is intentionally not part of the public execution metadata in live/log sinks. */
export const executionOutputSchema = z.object({
  text: z.string(),
  structured: z.unknown().optional(),
  declaredOutputPaths: declaredOutputPathsSchema.optional(),
  persisted: z
    .object({
      text: z.string(),
      truncated: z.boolean(),
      originalBytes: z.number().optional(),
      spillPath: z.string().optional(),
    })
    .optional(),
});
export type ExecutionOutput = z.infer<typeof executionOutputSchema>;

/**
 * Why a node's optional MCP declaration did not reach its provider. A server that
 * reached the provider and failed to connect is recorded by the provider's own
 * `mcp_server_status` event instead.
 */
export const mcpUnavailableReasonSchema = z.enum(['provider_unsupported', 'config_missing']);

export const mcpUnavailableSchema = z.object({
  /** The path as the node declared it. */
  path: z.string(),
  reason: mcpUnavailableReasonSchema,
  /** The servers the config file names, when the file was readable. */
  servers: z.array(z.string()).optional(),
});
export type McpUnavailable = z.infer<typeof mcpUnavailableSchema>;

/**
 * Why one optional skill did not reach the node's provider. A required name is
 * never recorded here: it keeps the provider's existing missing-skill behavior.
 */
export const skillUnavailableReasonSchema = z.enum(['provider_unsupported', 'not_installed']);

export const skillUnavailableSchema = z.object({
  name: z.string(),
  reason: skillUnavailableReasonSchema,
});
export type SkillUnavailable = z.infer<typeof skillUnavailableSchema>;

// A child run's usage reaches its parent through run metadata, which carries counters
// only. Its request evidence (`calls`) lives in the child run's own node records.
export const childUsageSchema = runUsageSchema.extend({
  childRunId: z.string(),
  tokens: tokenUsageSchema.omit({ calls: true, callsPartial: true }).optional(),
});

export const executionDiagnosticsSchema = z.object({
  iteration: z.number().optional(),
  loopIterations: z.number().optional(),
  outputType: z.string().optional(),
  command: z.string().optional(),
  status: z.string().optional(),
  maxIterations: z.number().optional(),
  sessionSourceNodeId: z.string().optional(),
  sessionForkRequested: z.boolean().optional(),
  sessionForked: z.boolean().optional(),
  backgroundTasksIncomplete: z.array(z.string()).optional(),
  /** The child run this node ran, or is suspended on. */
  childRunId: z.string().optional(),
  /** Cumulative child totals covered by this node's incremental spend. */
  childUsage: z.array(childUsageSchema).optional(),
  /**
   * The node FAILED because this child run is still live and ownership is ambiguous;
   * abandoning that run is what unblocks the parent. Distinct from `childRunId` so a
   * reader never turns "the child this node ran" into advice to abandon it.
   */
  blockedOnChildRunId: z.string().optional(),
  fanOut: z.boolean().optional(),
  /** A settled `workflow:` fan-out's per-slot record and tally. */
  fanOutOutcome: fanOutOutcomeSchema.optional(),
  identity: z.string().optional(),
  ordinal: z.number().optional(),
  approvalDecision: z.string().optional(),
  expr: z.string().optional(),
  /** The node's optional MCP servers were not loaded, and why. */
  mcpUnavailable: mcpUnavailableSchema.optional(),
  /** Optional skills that were not passed to the provider, and why. */
  skillsUnavailable: z.array(skillUnavailableSchema).optional(),
});
export type ExecutionDiagnostics = z.infer<typeof executionDiagnosticsSchema>;

export const nodeExecutionMetadataSchema = z.object({
  runId: z.string(),
  path: z.string(),
  node: nodeDescriptorSchema,
  invocation: nodeInvocationSchema,
  attempt: z.object({
    id: z.string(),
    startedAt: z.string().datetime({ offset: true }),
    /** The checkout when this attempt started; the attempt's own sample, not the invocation's. */
    checkoutStart: checkoutObservationSchema.optional(),
  }),
  binding: executionBindingSchema,
  timing: z.object({
    startedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().optional(),
  }),
  spend: executionSpendSchema,
  accounting: z.enum(['node', 'aggregate', 'instance', 'amendment']),
  lifecycle: executionLifecycleSchema,
});
export type NodeExecutionMetadata = z.infer<typeof nodeExecutionMetadataSchema>;

/** Run identity comes from the event envelope; lifecycle is reconstructed from its type. */
export const nodeExecutionMetadataPayloadSchema = nodeExecutionMetadataSchema.omit({
  runId: true,
  path: true,
  lifecycle: true,
});

/** What a node row's `cost_usd` measures: the node's own spend, or a total restating spend other rows carry. */
export const nodeCostScopeSchema = z.enum(['own', 'total']);
export type NodeCostScope = z.infer<typeof nodeCostScopeSchema>;

export const nodeExecutionRecordSchema = nodeExecutionMetadataSchema.extend({
  output: executionOutputSchema.optional(),
  diagnostics: executionDiagnosticsSchema.optional(),
  /**
   * The full provider session id this attempt ended in. It can resume the conversation,
   * so only the durable row stores it; `executionMetadata` drops it, which keeps it out
   * of the transcript and the emitter.
   */
  sessionId: z.string().min(1).optional(),
});
export type NodeExecutionRecord = z.infer<typeof nodeExecutionRecordSchema>;

/** Cache decisions have no attempt, provider binding, timing or newly consumed spend. */
export const nodeCacheRecordSchema = z.object({
  runId: z.string(),
  path: z.string(),
  node: nodeDescriptorSchema,
  cache: z.discriminatedUnion('action', [
    z.object({ action: z.literal('replayed'), output: executionOutputSchema }),
    z.object({ action: z.literal('reset'), prior: executionOutputSchema }),
    z.object({
      action: z.literal('invalidated'),
      prior: executionOutputSchema,
      invalidatingDeps: z.array(z.string()),
    }),
  ]),
});
export type NodeCacheRecord = z.infer<typeof nodeCacheRecordSchema>;
export type NodeStateRecord = NodeExecutionRecord | NodeCacheRecord;
