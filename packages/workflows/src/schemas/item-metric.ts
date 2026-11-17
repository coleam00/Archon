/**
 * Item metrics: per-item figures a workflow pack declares in `<pack>/.shared/item-metrics.json`,
 * evaluated by the engine over the window read of a project's items (`archon metrics`).
 *
 * A definition is data with fixed semantics: a share of items, a count per item, or a
 * duration between two recorded times, optionally grouped by a declared field. What a
 * figure means stays the pack's: which workflow is a review round, which outcome or the
 * recorded merge counts as merged. There is no expression language; every object is
 * strict, so a key the engine does not know is refused when the file is read.
 */
import { z } from 'zod';
import { itemAnswerKindSchema } from '../item-read';
import { metricNameSchema } from './metric';
import { workflowRunStatusSchema } from './run-status';
import { workflowSourceSchema } from './workflow';

const valuesSchema = z.array(z.string().min(1)).min(1);

/** A run matches when each given field lists its value. An empty filter matches every run. */
const runFilterSchema = z.strictObject({
  workflow: valuesSchema.optional(),
  status: z.array(workflowRunStatusSchema).min(1).optional(),
  outcome: valuesSchema.optional(),
});
export type ItemMetricRunFilter = z.infer<typeof runFilterSchema>;

/**
 * An item matches when every given condition holds: `merged` is whether a merge is
 * recorded on it, `has_run` that one of its runs matches, `last_run` that its latest
 * started run does.
 */
const itemConditionSchema = z.strictObject({
  merged: z.boolean().optional(),
  has_run: runFilterSchema.optional(),
  last_run: runFilterSchema.optional(),
});
export type ItemMetricCondition = z.infer<typeof itemConditionSchema>;

/** A recorded time on an item: its merge, or the start or end of its first or last matching run. */
const timePointSchema = z.union([
  z.literal('merged'),
  z.strictObject({
    run: z.enum(['first', 'last']),
    at: z.enum(['started', 'completed']),
    of: runFilterSchema.optional(),
  }),
]);
export type ItemMetricTimePoint = z.infer<typeof timePointSchema>;

export const itemMetricGroupBySchema = z.enum([
  'first_run.workflow',
  'last_run.workflow',
  'last_run.outcome',
]);

const base = {
  name: metricNameSchema,
  /** Narrows the population: the items with a run in the window that match. */
  items: itemConditionSchema.optional(),
  group_by: itemMetricGroupBySchema.optional(),
};

export const itemMetricDefinitionSchema = z.union([
  /** The share of the population that matches `where`. */
  z.strictObject({ ...base, op: z.literal('share'), where: itemConditionSchema }),
  /** The item's runs that match `runs`, per item. */
  z.strictObject({
    ...base,
    op: z.literal('count'),
    of: z.literal('runs'),
    runs: runFilterSchema.optional(),
  }),
  /** The item's answers of the given kinds (every kind when absent), per item. */
  z.strictObject({
    ...base,
    op: z.literal('count'),
    of: z.literal('answers'),
    kinds: z.array(itemAnswerKindSchema).min(1).optional(),
  }),
  /** The hours from `from` to `to`, per item that has both. */
  z.strictObject({
    ...base,
    op: z.literal('duration'),
    from: timePointSchema,
    to: timePointSchema,
  }),
]);
export type ItemMetricDefinition = z.infer<typeof itemMetricDefinitionSchema>;

export const ITEM_METRICS_FILE = 'item-metrics.json';

export const itemMetricsFileSchema = z.strictObject({
  metrics: z
    .array(itemMetricDefinitionSchema)
    .min(1)
    .max(50)
    .refine(metrics => new Set(metrics.map(metric => metric.name)).size === metrics.length, {
      message: 'metric names must be unique',
    }),
});

/** `value` is null when nothing in the population could give one. */
const figuresSchema = z.union([
  z.object({
    op: z.literal('share'),
    value: z.number().nullable(),
    numerator: z.number().int(),
    denominator: z.number().int(),
  }),
  z.object({
    op: z.literal('count'),
    /** The mean per item. */
    value: z.number().nullable(),
    total: z.number().int(),
    n: z.number().int(),
  }),
  z.object({
    op: z.literal('duration'),
    /** The mean in hours over the items that have both times. */
    value: z.number().nullable(),
    unit: z.literal('hours'),
    n: z.number().int(),
    /** Items of the population lacking either time. */
    missing: z.number().int(),
  }),
]);
export type ItemMetricFigures = z.infer<typeof figuresSchema>;

export const itemMetricResultSchema = z.intersection(
  z.object({
    name: z.string(),
    /** Present when the definition groups: the same figures for each group, null last. */
    groups: z
      .array(z.intersection(z.object({ group: z.string().nullable() }), figuresSchema))
      .optional(),
  }),
  figuresSchema
);
export type ItemMetricResult = z.infer<typeof itemMetricResultSchema>;

export const itemMetricsReportSchema = z.object({
  project: z.string(),
  window: z.object({ since: z.string().datetime(), until: z.string().datetime() }),
  /** Items with a run started in the window, before any definition narrows them. */
  items: z.number().int(),
  /** Keys of items whose read reported a part it could not read; their figures may be short. */
  degraded_items: z.array(z.string()),
  packs: z.array(
    z.object({
      /** The pack's folder name, or `owner/name` for an installed pack. */
      pack: z.string(),
      source: workflowSourceSchema,
      metrics: z.array(itemMetricResultSchema),
    })
  ),
  /** Declarations that could not be read or did not validate; the other packs still report. */
  errors: z.array(z.object({ pack: z.string(), source: workflowSourceSchema, error: z.string() })),
});
export type ItemMetricsReport = z.infer<typeof itemMetricsReportSchema>;
