import { z } from 'zod';
import {
  nodeDescriptorSchema,
  nodeInvocationSchema,
  unavailableMeasurementSchema,
} from './node-execution';
import { serializedNodeDataSchema } from '../node-record-serialization';

export const usageNodeIdentitySchema = z.object({
  runId: z.string(),
  path: z.string(),
  nodeKind: z.enum(nodeDescriptorSchema.options.map(option => option.shape.kind.value)).optional(),
  provider: z.string().optional(),
  invocationId: z.string().optional(),
  loopPath: nodeInvocationSchema.shape.loopPath.optional(),
  attemptId: z.string().optional(),
});
export type UsageNodeIdentity = z.infer<typeof usageNodeIdentitySchema>;

export const usageLimitationReasonSchema = z.enum([
  'history_unavailable',
  'history_absent',
  'record_unreadable',
  'measurement_source_absent',
  'node_kind_unavailable',
  'unfinished_execution',
  'total_unavailable',
  'total_invalid',
  'total_mismatch',
  'scope_unattributed',
  'child_unavailable',
  'child_usage_mismatch',
  'child_cycle',
]);
export const usageLimitationSchema = z.object({
  runId: z.string(),
  path: z.string().optional(),
  reason: usageLimitationReasonSchema,
});
export type UsageLimitation = z.infer<typeof usageLimitationSchema>;

export const usageGapSchema = z.discriminatedUnion('source', [
  usageNodeIdentitySchema.extend({
    source: z.literal('node'),
    reason: unavailableMeasurementSchema.shape.reason,
  }),
  usageNodeIdentitySchema.extend({
    source: z.literal('coverage'),
    reason: usageLimitationReasonSchema,
  }),
]);
export const metricCoverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'unknown', 'not_applicable']),
  aiNodes: z.number().int().nonnegative().nullable(),
  observedAiNodes: z.number().int().nonnegative(),
  contributedAiNodes: z.number().int().nonnegative(),
  contributors: z.array(usageNodeIdentitySchema),
  recordedNodes: z.array(usageNodeIdentitySchema),
  gaps: z.array(usageGapSchema),
  partial: z.array(usageNodeIdentitySchema.extend({ partial: z.literal(true) })),
  limitations: z.array(usageLimitationSchema),
});
export type MetricCoverage = z.infer<typeof metricCoverageSchema>;

export const usageCoverageSchema = z.object({
  usd: metricCoverageSchema,
  inputTokens: metricCoverageSchema,
  outputTokens: metricCoverageSchema,
  excluded: z.array(
    usageNodeIdentitySchema.extend({
      reason: z.enum(['skipped', 'replayed', 'not_applicable']),
      lifecycleReason: serializedNodeDataSchema.shape.reason,
      tokensReason: unavailableMeasurementSchema.shape.reason.optional(),
      costReason: unavailableMeasurementSchema.shape.reason.optional(),
    })
  ),
});
export type UsageCoverage = z.infer<typeof usageCoverageSchema>;
export const usageTotalsSchema = z.object({
  usd: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageMetric = keyof UsageTotals;
export const USAGE_METRICS = usageTotalsSchema.keyof().options;
export const runUsageReportSchema = z.object({
  totals: usageTotalsSchema,
  coverage: usageCoverageSchema,
});
export type RunUsageReport = z.infer<typeof runUsageReportSchema>;
export const recordedSpendSchema = usageTotalsSchema.extend({ coverage: usageCoverageSchema });
