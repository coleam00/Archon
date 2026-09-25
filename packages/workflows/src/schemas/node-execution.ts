import { z } from '@hono/zod-openapi';
import { tokenUsageSchema } from '@archon/provider-contract';
import {
  agentNodeSchema,
  execNodeSchema,
  loopNodeSchema,
  loopGroupNodeSchema,
  gateNodeSchema,
  haltNodeSchema,
  waitNodeSchema,
  workflowNodeSchema,
  composeFanOutNodeSchema,
} from './dag-node';
import { effortLevelSchema } from './effort';
import { tierNameSchema } from './model-binding';
import { nodeSkipReasonSchema, skipCauseSchema, suspendReasonSchema } from './node-state';
import { checkoutObservationSchema } from './checkout-observation';

export const unavailableMeasurementSchema = z.object({
  source: z.literal('unavailable'),
  reason: z.enum(['unsupported', 'not_reported', 'unknown', 'not_applicable', 'invalid']),
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
  costUsd: reportedMeasurementSchema(z.number()),
  stopReason: reportedMeasurementSchema(z.string()),
  numTurns: reportedMeasurementSchema(z.number()),
});

export const nodeDescriptorSchema = z.discriminatedUnion('kind', [
  agentNodeSchema.pick({ id: true, kind: true }).extend({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('inline') }),
      z.object({ kind: z.literal('command'), name: z.string() }),
    ]),
  }),
  execNodeSchema.pick({ id: true, kind: true, runtime: true }),
  loopNodeSchema.pick({ id: true, kind: true }).extend({ command: z.string().optional() }),
  loopGroupNodeSchema.pick({ id: true, kind: true }),
  gateNodeSchema.pick({ id: true, kind: true }),
  haltNodeSchema.pick({ id: true, kind: true }),
  waitNodeSchema.pick({ id: true, kind: true }),
  workflowNodeSchema.pick({ id: true, kind: true }),
  composeFanOutNodeSchema.pick({ id: true, kind: true }),
  z.object({ kind: z.literal('compose_fan_out_instance'), id: z.string() }),
]);
export type NodeDescriptor = z.infer<typeof nodeDescriptorSchema>;

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
  sessionPreview: z.string().max(8).optional(),
  sessionOrigin: z.enum(['fresh', 'resumed', 'resume-failed-cold']).optional(),
});
export type ExecutionBinding = z.infer<typeof executionBindingSchema>;

/**
 * Why a node failed, recorded where the failure is known rather than re-read from
 * `error` prose later. `fatal`/`transient`/`rate_limited`/`unknown` classify a provider
 * error and decide its retry; the rest name engine-detected causes. Absent on records
 * written before this field existed.
 */
export const nodeFailureKindSchema = z.enum([
  'fatal',
  'transient',
  'unknown',
  'rate_limited',
  'timeout',
  'exec_failed',
  'output_contract',
  'max_iterations',
  'child_failed',
  'cancelled',
  'config',
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
  declaredFields: z.array(z.string()).optional(),
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
  /**
   * The node FAILED because this child run is still live and ownership is ambiguous;
   * abandoning that run is what unblocks the parent. Distinct from `childRunId` so a
   * reader never turns "the child this node ran" into advice to abandon it.
   */
  blockedOnChildRunId: z.string().optional(),
  fanOut: z.boolean().optional(),
  identity: z.string().optional(),
  ordinal: z.number().optional(),
  approvalDecision: z.string().optional(),
  expr: z.string().optional(),
});

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

export const nodeExecutionRecordSchema = nodeExecutionMetadataSchema.extend({
  output: executionOutputSchema.optional(),
  diagnostics: executionDiagnosticsSchema.optional(),
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
