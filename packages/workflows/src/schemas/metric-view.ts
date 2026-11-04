/**
 * Metric views: the overview cards a workflow pack declares in
 * `<pack>/.shared/metric-views.json`, and the listing the server serves.
 *
 * A view only names metrics and labels; it computes nothing. Consoles render the three
 * shapes from the metrics report, so a pack chooses what its overview shows without any
 * console naming that pack's metrics. Do not grow this into a dashboard language: a new
 * shape must earn its place the way these three did.
 */
import { z } from 'zod';
import { metricNameSchema } from './metric';
import { workflowSourceSchema } from './workflow';

const labelSchema = z.string().min(1).max(80);

/** A count: the metric's value, with other counts beside it ("12 opened · 3 abandoned"). */
const countViewSchema = z.strictObject({
  shape: z.literal('count'),
  title: labelSchema,
  metric: metricNameSchema,
  breakdown: z
    .array(z.strictObject({ metric: metricNameSchema, label: labelSchema }))
    .max(4)
    .optional(),
});

/** A share of two counts recorded by the same instrument, with an optional calibration. */
const ratioViewSchema = z.strictObject({
  shape: z.literal('ratio'),
  title: labelSchema,
  numerator: metricNameSchema,
  denominator: metricNameSchema,
  /** Follows the denominator's value: "X of Y <denominator_label>". */
  denominator_label: labelSchema,
  calibration: z
    .strictObject({
      /**
       * A score metric that calibrates the numerator with one record per labelled case,
       * scored 1 when caught and 0 when missed; shown as "<label> 9 of 10".
       */
      metric: metricNameSchema,
      label: labelSchema,
      /** The card marks its share rough while the calibration is below this. */
      rough_below: z.number().gt(0).max(1),
    })
    .optional(),
});

/**
 * A known cost per counted item: the cost of `cost_of`'s producing runs, or of `metric`'s
 * when absent, divided by `metric`'s value.
 */
const costPerViewSchema = z.strictObject({
  shape: z.literal('cost_per'),
  title: labelSchema,
  metric: metricNameSchema,
  /** A count of the same instrument whose runs carry the whole cost, such as every PR opened. */
  cost_of: metricNameSchema.optional(),
});

export const metricViewSchema = z.discriminatedUnion('shape', [
  countViewSchema,
  ratioViewSchema,
  costPerViewSchema,
]);
export type MetricView = z.infer<typeof metricViewSchema>;

export const METRIC_VIEWS_FILE = 'metric-views.json';

export const metricViewsFileSchema = z.strictObject({
  /** Plain names for metrics, keyed by metric name. Records carry no human label. */
  names: z.record(metricNameSchema, labelSchema).optional(),
  cards: z.array(metricViewSchema).min(1).max(6),
});

export const metricViewsListingSchema = z.object({
  packs: z.array(
    z.object({
      /** The pack's folder name, or `owner/name` for an installed pack. */
      pack: z.string(),
      source: workflowSourceSchema,
      names: z.record(z.string(), z.string()),
      cards: z.array(metricViewSchema),
    })
  ),
  /** Declarations that could not be read or did not validate; the other packs still list. */
  errors: z.array(z.object({ pack: z.string(), source: workflowSourceSchema, error: z.string() })),
});
export type MetricViewsListing = z.infer<typeof metricViewsListingSchema>;
