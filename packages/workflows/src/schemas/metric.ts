/**
 * Metric records: the shape a node returns under its reserved top-level `metrics`
 * output key, and the report `queryMetrics` aggregates them into.
 *
 * Records are strict so they cannot carry free text beyond a bounded subject and
 * instrument: no credentials, prompt contents or user messages.
 */
import { z } from 'zod';

const metricNameSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, 'must be dot-separated lowercase segments of [a-z0-9_]');

/** Run ids are UUIDs, or 32 hex characters on rows written before ids had dashes. */
const runIdSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    'must be a run id'
  );

const recordFields = {
  name: metricNameSchema,
  unit: z.string().regex(/^[a-z0-9_%/.-]{1,32}$/, 'must be 1-32 characters of [a-z0-9_%/.-]'),
  subject: z.string().max(256).nullable(),
  /** When the outcome happened; defaults to the node's completion time. */
  at: z.iso.datetime({ offset: true }).optional(),
  /** The runs that produced the outcome. Stored and validated; read from slice 1b on. */
  runs: z
    .array(runIdSchema)
    .min(1)
    .max(20)
    .refine(ids => new Set(ids).size === ids.length, 'must not repeat a run id')
    .optional(),
  /** Author-declared identity of the measuring code, for example a judge's hash. */
  instrument: z
    .string()
    .regex(/^[A-Za-z0-9_.:@/-]{1,128}$/, 'must be 1-128 characters of [A-Za-z0-9_.:@/-]')
    .optional(),
  /** The node that did the measuring. Stored and validated; read from slice 1c on. */
  instrument_node: z.string().min(1).max(255).optional(),
};

export const metricRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...recordFields,
    kind: z.literal('count'),
    value: z.number().nonnegative(),
  }),
  z.strictObject({
    ...recordFields,
    kind: z.literal('score'),
    value: z.number(),
    /** The metric this score calibrates. */
    calibrates: metricNameSchema.optional(),
  }),
]);
export type MetricRecord = z.infer<typeof metricRecordSchema>;
export type MetricKind = MetricRecord['kind'];

/** The output shape a metric node returns. Other top-level keys are the author's. */
export const metricOutputSchema = z.object({ metrics: z.array(metricRecordSchema) });

const metricDefinitionSchema = z.object({
  kind: z.enum(['count', 'score']),
  unit: z.string(),
  calibrates: z.string().nullable(),
});
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

const metricSourceFields = {
  run_id: z.string(),
  workflow_name: z.string(),
  node_id: z.string(),
  completed_at: z.string(),
};

export const metricRefusalSchema = z.discriminatedUnion('reason', [
  z.object({
    reason: z.literal('invalid'),
    ...metricSourceFields,
    errors: z.array(z.string()),
  }),
  z.object({
    reason: z.literal('definition_conflict'),
    ...metricSourceFields,
    name: z.string(),
    /** The name's definition, fixed by its earliest stored record. */
    definition: metricDefinitionSchema,
    offered: metricDefinitionSchema,
  }),
]);
export type MetricRefusal = z.infer<typeof metricRefusalSchema>;

const metricSeriesPointSchema = z.object({
  /** UTC day, `YYYY-MM-DD`. */
  day: z.string(),
  value: z.number(),
  n: z.number().int(),
});

const metricInstrumentReportSchema = z.object({
  instrument: z.string().nullable(),
  /** The sum for a `count`, the mean for a `score`. */
  value: z.number(),
  n: z.number().int(),
  latest: z.object({ value: z.number(), at: z.string(), subject: z.string().nullable() }),
  series: z.array(metricSeriesPointSchema),
});
export type MetricInstrumentReport = z.infer<typeof metricInstrumentReportSchema>;

const metricReportSchema = z.object({
  name: z.string(),
  ...metricDefinitionSchema.shape,
  /** The instrument of the name's most recent record in the window. */
  headline_instrument: z.string().nullable(),
  instruments: z.array(metricInstrumentReportSchema),
});
export type MetricReport = z.infer<typeof metricReportSchema>;

export const metricsReportSchema = z.object({
  /** The half-open window `[since, until)`, as ISO times. */
  window: z.object({ since: z.string(), until: z.string() }),
  metrics: z.array(metricReportSchema),
  refused: z.array(metricRefusalSchema),
});
export type MetricsReport = z.infer<typeof metricsReportSchema>;
