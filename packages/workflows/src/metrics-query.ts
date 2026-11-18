/**
 * The inputs of a metrics query: its window and split, resolved from the syntax the CLI
 * and the API share, and the errors a malformed or unmatched input raises.
 */
import { z } from 'zod';
import { metricDimensionKeySchema } from './schemas/metric';

/**
 * How a query splits each group. A model split stands alone; a dimension split may also
 * compare cohorts, within each of its groups.
 */
export type MetricsSplit =
  | { compareAt?: undefined; byModelNode?: undefined; byDimension?: undefined }
  /** Split each group into runs started before and at or after this time. */
  | { compareAt: Date; byModelNode?: undefined; byDimension?: undefined }
  /** Split each group by the model label that ran this node in its producing runs. */
  | { byModelNode: string; compareAt?: undefined; byDimension?: undefined }
  /** Split each group by the value its records carry for this dimension key. */
  | { byDimension: string; compareAt?: Date; byModelNode?: undefined };

export type MetricsQuery = {
  /** Inclusive start of the window. */
  since: Date;
  /** Exclusive end of the window. */
  until: Date;
  name?: string;
  subject?: string;
  codebaseId?: string;
} & MetricsSplit;

/** A malformed window, cut or split. */
export class MetricsQueryError extends Error {}

/** No producing run ran the `--by-model` node; `seenNodeIds` are the AI nodes they ran. */
export class MetricsByModelNodeError extends MetricsQueryError {
  constructor(
    readonly node: string,
    readonly seenNodeIds: readonly string[]
  ) {
    super(
      `no producing run ran an AI node "${node}"; AI nodes they ran: ${
        seenNodeIds.length === 0 ? 'none' : seenNodeIds.join(', ')
      }`
    );
  }
}

/** No record in the window carries the `--by-dimension` key; `seenKeys` are the keys they carry. */
export class MetricsDimensionKeyError extends MetricsQueryError {
  constructor(
    readonly key: string,
    readonly seenKeys: readonly string[]
  ) {
    super(
      `no record carries a dimension "${key}"; dimensions they carry: ${
        seenKeys.length === 0 ? 'none' : seenKeys.join(', ')
      }`
    );
  }
}

/** At most this many node ids or dimension keys are listed in a split error. */
export const SEEN_LIMIT = 50;

const DAY_MS = 86_400_000;
export const DEFAULT_METRICS_WINDOW_DAYS = 30;
const DURATION_UNIT_MS = new Map([
  ['m', 60_000],
  ['h', 3_600_000],
  ['d', DAY_MS],
  ['w', 7 * DAY_MS],
]);
const instantSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const INSTANT_FORMS =
  'an ISO date or a time with an offset, such as 2026-10-01 or 2026-10-01T12:00:00Z';

function parseInstant(field: string, value: string, forms = INSTANT_FORMS): Date {
  if (!instantSchema.safeParse(value).success) {
    throw new MetricsQueryError(`${field} must be ${forms}; got ${JSON.stringify(value)}`);
  }
  return new Date(value);
}

/**
 * Resolve a window from the CLI's and API's shared syntax. `since` is a duration
 * (`40m`, `24h`, `7d`, `2w`) counted back from `until`, or an ISO date or time; `until`
 * defaults to `now` and `since` to {@link DEFAULT_METRICS_WINDOW_DAYS} days before it.
 * A date without a time is UTC midnight.
 */
export function resolveMetricsWindow(
  input: { since?: string; until?: string },
  now: Date = new Date()
): { since: Date; until: Date } {
  const until = input.until === undefined ? now : parseInstant('until', input.until);
  const since = resolveSince(input.since, until);
  if (since.getTime() >= until.getTime()) {
    throw new MetricsQueryError('since must be before until');
  }
  return { since, until };
}

/**
 * Resolve the CLI's and API's split: a `compare` cut (an ISO date or time), a `byModel`
 * node, or a `byDimension` key, which may come with a cut.
 */
export function resolveMetricsSplit(input: {
  compare?: string;
  byModel?: string;
  byDimension?: string;
}): MetricsSplit {
  if (input.byModel !== undefined && input.byDimension !== undefined) {
    throw new MetricsQueryError(
      'by-model and by-dimension cannot be combined; run one query for each'
    );
  }
  if (input.compare !== undefined && input.byModel !== undefined) {
    throw new MetricsQueryError('compare and by-model cannot be combined; run one query for each');
  }
  const compareAt =
    input.compare === undefined ? undefined : parseInstant('compare', input.compare);
  if (input.byDimension !== undefined) {
    if (!metricDimensionKeySchema.safeParse(input.byDimension).success) {
      throw new MetricsQueryError(
        `by-dimension must be a key of 1-32 characters of [a-z0-9_]; got ${JSON.stringify(input.byDimension)}`
      );
    }
    return compareAt === undefined
      ? { byDimension: input.byDimension }
      : { byDimension: input.byDimension, compareAt };
  }
  if (compareAt !== undefined) return { compareAt };
  if (input.byModel === '') throw new MetricsQueryError('by-model needs a node id');
  return input.byModel === undefined ? {} : { byModelNode: input.byModel };
}

function resolveSince(since: string | undefined, until: Date): Date {
  if (since === undefined) return new Date(until.getTime() - DEFAULT_METRICS_WINDOW_DAYS * DAY_MS);
  const duration = /^(\d+)([a-z])$/.exec(since);
  const unitMs = duration === null ? undefined : DURATION_UNIT_MS.get(duration[2]);
  if (duration === null || unitMs === undefined) {
    return parseInstant(
      'since',
      since,
      `a duration such as 40m, 24h, 7d or 2w, or ${INSTANT_FORMS}`
    );
  }
  const start = new Date(until.getTime() - Number(duration[1]) * unitMs);
  if (Number.isNaN(start.getTime())) {
    throw new MetricsQueryError(`since "${since}" reaches before the earliest representable date`);
  }
  return start;
}
