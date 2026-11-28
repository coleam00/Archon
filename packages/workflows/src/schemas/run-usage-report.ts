import { z } from 'zod';
import {
  nodeDescriptorSchema,
  nodeInvocationSchema,
  unavailableMeasurementSchema,
} from './node-execution';

/** Which run and node a usage record is about. Internal to the report builder. */
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

/** What the report builder found about evidence it could not use. */
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
export type UsageLimitationReason = z.infer<typeof usageLimitationReasonSchema>;

/** One finding of the report builder: a run, optionally a node in it, and what is wrong. */
export interface UsageLimitation {
  runId: string;
  path?: string;
  reason: UsageLimitationReason;
}
export type UnavailableMeasurementReason = z.infer<
  typeof unavailableMeasurementSchema.shape.reason
>;

/**
 * Why a node, a run or a child run has no usable figure for a metric: what the node itself
 * recorded about its measurement, or what the report found about the evidence.
 */
export const usageGapReasonSchema = z.enum([
  ...unavailableMeasurementSchema.shape.reason.options,
  ...usageLimitationReasonSchema.options,
  'partial_measurement',
]);
export type UsageGapReason = z.infer<typeof usageGapReasonSchema>;

/**
 * One gap. A node gap names its node and one reason it has no usable figure; a node with
 * two reasons has two gaps. A run-level gap has no path. `runId` is present only for a gap
 * in a child run: the report's own run is known to the reader.
 */
export const usageGapSchema = z.object({
  path: z.string().optional(),
  reason: usageGapReasonSchema,
  runId: z.string().optional(),
});
export type UsageGap = z.infer<typeof usageGapSchema>;

/**
 * Coverage of one metric. `expectedNodes` is how many executed AI nodes should have recorded
 * the metric, null when the evidence cannot establish that count; `recordedNodes` is how many
 * of them did. Nodes that recorded are not listed: only gaps are.
 */
export const metricCoverageSchema = z.object({
  state: z.enum(['complete', 'partial', 'unknown', 'not_applicable']),
  recordedNodes: z.number().int().nonnegative(),
  expectedNodes: z.number().int().nonnegative().nullable(),
  gaps: z.array(usageGapSchema),
});
export type MetricCoverage = z.infer<typeof metricCoverageSchema>;

export const usageTotalsSchema = z.object({
  usd: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type UsageMetric = keyof UsageTotals;
export const USAGE_METRICS = usageTotalsSchema.keyof().options;
// Keyed by the totals schema, so coverage cannot gain or lose a metric the totals lack.
export const usageCoverageSchema = z.record(z.enum(USAGE_METRICS), metricCoverageSchema);
export type UsageCoverage = z.infer<typeof usageCoverageSchema>;
export const runUsageReportSchema = z.object({
  totals: usageTotalsSchema,
  coverage: usageCoverageSchema,
});
export type RunUsageReport = z.infer<typeof runUsageReportSchema>;
