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

const offsetTimeSchema = z.iso.datetime({ offset: true });

/**
 * An ISO time with an offset. Published as `format: date-time` (RFC 3339, which requires
 * the offset) rather than as zod's generated pattern, which no provider needs to see.
 */
const isoTimeSchema = z
  .string()
  .refine(value => offsetTimeSchema.safeParse(value).success, 'must be an ISO time with an offset')
  .meta({ format: 'date-time' });

const recordFields = {
  name: metricNameSchema,
  unit: z.string().regex(/^[a-z0-9_%/.-]{1,32}$/, 'must be 1-32 characters of [a-z0-9_%/.-]'),
  subject: z.string().max(256).nullable(),
  /** When the outcome happened; defaults to the node's completion time. */
  at: isoTimeSchema.optional(),
  /** The runs that produced the outcome; without it, the run that returned the record. */
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

/**
 * A two-sided 95% interval. `null` for a `count`, for fewer than two records, or for a
 * difference whose sides have no spread.
 */
const metricIntervalSchema = z.object({ low: z.number(), high: z.number() }).nullable();

/**
 * Spend of the distinct runs that produced a group's records. Every figure is a floor:
 * a run that recorded no cost or no tokens adds nothing to it and is counted instead.
 */
const metricCostSchema = z.object({
  /** Total USD of the runs that recorded a cost; `null` when none did. */
  usd: z.number().nullable(),
  /** Input and output tokens of the runs that recorded tokens; `null` when none did. */
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  /** Producing runs found. */
  runs: z.number().int(),
  runs_without_cost: z.number().int(),
  runs_without_tokens: z.number().int(),
  /** Named runs that no longer exist. */
  runs_missing: z.number().int(),
});
export type MetricCost = z.infer<typeof metricCostSchema>;

const metricCohortSchema = z.object({
  /** `null` when the cohort holds no record. */
  value: z.number().nullable(),
  n: z.number().int(),
  interval: metricIntervalSchema,
});
export type MetricCohort = z.infer<typeof metricCohortSchema>;

/**
 * Records split by when their producing runs started. Observational: anything else that
 * changed around the cut is mixed into the difference.
 */
const metricCompareSchema = z.object({
  /** The cut, as an ISO time. */
  at: z.string(),
  /** Records whose producing runs all started before the cut. */
  before: metricCohortSchema,
  /** Records whose producing runs all started at or after it. */
  after: metricCohortSchema,
  /** `after.value − before.value`; `null` when either cohort is empty. */
  delta: z.number().nullable(),
  /** Newcombe's interval for a rate, Welch's for other scores. */
  delta_interval: metricIntervalSchema,
  /** `delta_interval` excludes zero. */
  separated: z.boolean(),
  /** Records with producing runs on both sides of the cut, in neither cohort. */
  straddling: z.number().int(),
  /** Records whose named runs no longer exist, in neither cohort. */
  unattributed: z.number().int(),
});
export type MetricCompare = z.infer<typeof metricCompareSchema>;

const metricInstrumentReportSchema = z.object({
  instrument: z.string().nullable(),
  /** The sum for a `count`, the mean for a `score`. */
  value: z.number(),
  n: z.number().int(),
  /** Wilson's interval when every value is 0 or 1, otherwise the t interval of the mean. */
  interval: metricIntervalSchema,
  cost: metricCostSchema,
  /** Present when the query names a cut. */
  compare: metricCompareSchema.optional(),
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
