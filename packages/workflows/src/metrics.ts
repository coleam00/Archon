/**
 * Metrics: aggregate the metric records nodes returned under their reserved `metrics`
 * output key, by name, window and instrument.
 *
 * Every rule about which stored records count lives here; the stores return raw rows.
 */
import { z } from 'zod';
import {
  metricRecordSchema,
  type MetricDefinition,
  type MetricInstrumentReport,
  type MetricRecord,
  type MetricRefusal,
  type MetricReport,
  type MetricsReport,
} from './schemas/metric';
import type { IWorkflowStore, MetricRecordRow } from './store';

export type MetricsStore = Pick<IWorkflowStore, 'listMetricRecords' | 'listEventsForRuns'>;

export interface MetricsQuery {
  /** Inclusive start of the window. */
  since: Date;
  /** Exclusive end of the window. */
  until: Date;
  name?: string;
  subject?: string;
  codebaseId?: string;
}

export class MetricsWindowError extends Error {}

const DAY_MS = 86_400_000;
export const DEFAULT_METRICS_WINDOW_DAYS = 30;
const DURATION_UNIT_MS = { h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS } as const;
const instantSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const INSTANT_FORMS =
  'an ISO date or a time with an offset, such as 2026-10-01 or 2026-10-01T12:00:00Z';

function parseInstant(field: string, value: string, forms = INSTANT_FORMS): Date {
  if (!instantSchema.safeParse(value).success) {
    throw new MetricsWindowError(`${field} must be ${forms}; got "${value}"`);
  }
  return new Date(value);
}

/**
 * Resolve a window from the CLI's and API's shared syntax. `since` is a duration
 * (`24h`, `7d`, `2w`) counted back from `until`, or an ISO date or time; `until`
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
    throw new MetricsWindowError('since must be before until');
  }
  return { since, until };
}

function resolveSince(since: string | undefined, until: Date): Date {
  if (since === undefined) return new Date(until.getTime() - DEFAULT_METRICS_WINDOW_DAYS * DAY_MS);
  const duration = /^(\d+)([hdw])$/.exec(since);
  if (duration === null) {
    return parseInstant('since', since, `a duration such as 24h, 7d or 2w, or ${INSTANT_FORMS}`);
  }
  const unit = duration[2] as keyof typeof DURATION_UNIT_MS;
  const start = new Date(until.getTime() - Number(duration[1]) * DURATION_UNIT_MS[unit]);
  if (Number.isNaN(start.getTime())) {
    throw new MetricsWindowError(`since "${since}" reaches before the earliest representable date`);
  }
  return start;
}

/** One parsed record that counts. */
interface CountedRecord {
  record: MetricRecord;
  /** `at`, else the completion time, in ms. */
  time: number;
}

const RUN_CHUNK = 500;

/**
 * Ids of the events that are their node's latest terminal event in their run. A
 * completion later amended to `node_failed`, or superseded by a re-execution, is not.
 */
async function latestTerminalEventIds(
  store: MetricsStore,
  runIds: readonly string[]
): Promise<Set<string>> {
  const latest = new Set<string>();
  for (let start = 0; start < runIds.length; start += RUN_CHUNK) {
    const byRun = await store.listEventsForRuns(runIds.slice(start, start + RUN_CHUNK), [
      'node_completed',
      'node_failed',
    ]);
    for (const events of byRun.values()) {
      const lastByNode = new Map<string, string>();
      for (const event of events) {
        if (event.step_name !== null) lastByNode.set(event.step_name, event.id);
      }
      for (const id of lastByNode.values()) latest.add(id);
    }
  }
  return latest;
}

function definitionOf(record: MetricRecord): MetricDefinition {
  return {
    kind: record.kind,
    unit: record.unit,
    calibrates: record.kind === 'score' ? (record.calibrates ?? null) : null,
  };
}

const sameDefinition = (a: MetricDefinition, b: MetricDefinition): boolean =>
  a.kind === b.kind && a.unit === b.unit && a.calibrates === b.calibrates;

type MetricSource = Pick<MetricRefusal, 'run_id' | 'workflow_name' | 'node_id' | 'completed_at'>;

function source(row: MetricRecordRow): MetricSource {
  return {
    run_id: row.runId,
    workflow_name: row.workflowName,
    node_id: row.nodeId,
    completed_at: row.completedAt,
  };
}

function aggregate(kind: MetricDefinition['kind'], values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  return kind === 'count' ? sum : sum / values.length;
}

function instrumentReport(
  kind: MetricDefinition['kind'],
  instrument: string | null,
  records: readonly CountedRecord[]
): MetricInstrumentReport {
  const latest = newestOf(records);
  const byDay = new Map<string, number[]>();
  for (const { record, time } of records) {
    const day = new Date(time).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), record.value]);
  }
  return {
    instrument,
    value: aggregate(
      kind,
      records.map(({ record }) => record.value)
    ),
    n: records.length,
    latest: {
      value: latest.record.value,
      at: new Date(latest.time).toISOString(),
      subject: latest.record.subject,
    },
    series: [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, values]) => ({ day, value: aggregate(kind, values), n: values.length })),
  };
}

const byInstrument = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b);

/**
 * Aggregate stored metric records over `[since, until)`.
 *
 * 1. Only a node's latest terminal event in its run counts.
 * 2. A name's earliest stored record, in recorded order, fixes its definition
 *    (`kind`, `unit`, `calibrates`). A later record that disagrees is refused and
 *    reported with both definitions, so a name keeps one meaning.
 * 3. The latest record per `(name, subject, instrument)` replaces earlier ones for a
 *    non-null subject, so a re-measurement never double-counts. A `subject: null`
 *    record counts once per run and node, by rule 1.
 * 4. A record falls in the window by `at`, else by its completion time.
 * 5. Each name reports one entry per instrument, so two instruments are never averaged.
 *
 * Refusals are reported for the queried name and window. A stored output the record
 * schema rejects (written before the schema, or unreadable) has no trusted name, so it
 * is reported only when no name is queried.
 */
export async function queryMetrics(
  store: MetricsStore,
  query: MetricsQuery
): Promise<MetricsReport> {
  const rows = await store.listMetricRecords(
    query.codebaseId === undefined ? {} : { codebaseId: query.codebaseId }
  );
  const counted = await latestTerminalEventIds(store, [...new Set(rows.map(row => row.runId))]);
  const since = query.since.getTime();
  const until = query.until.getTime();
  const inWindow = (time: number): boolean => time >= since && time < until;
  const { records, refused } = collectRecords(rows.filter(row => counted.has(row.eventId)));

  const byName = new Map<string, CountedRecord[]>();
  for (const entry of records) {
    const { record, time } = entry;
    if (!inWindow(time)) continue;
    if (query.name !== undefined && record.name !== query.name) continue;
    if (query.subject !== undefined && record.subject !== query.subject) continue;
    byName.set(record.name, [...(byName.get(record.name) ?? []), entry]);
  }
  const queried = (refusal: MetricRefusal): boolean =>
    query.name === undefined ||
    (refusal.reason === 'definition_conflict' && refusal.name === query.name);

  return {
    window: { since: query.since.toISOString(), until: query.until.toISOString() },
    metrics: [...byName]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, named]) => nameReport(name, named)),
    refused: refused
      .filter(({ refusal, time }) => inWindow(time) && queried(refusal))
      .map(({ refusal }) => refusal),
  };
}

/** A refusal with the time it is placed in a window by. */
interface Refused {
  refusal: MetricRefusal;
  time: number;
}

function invalidRefusal(row: MetricRecordRow, error: z.ZodError): Refused {
  return {
    time: Date.parse(row.completedAt),
    refusal: {
      reason: 'invalid',
      ...source(row),
      errors: error.issues.map(
        issue => `/metrics/${issue.path.map(String).join('/')}: ${issue.message}`
      ),
    },
  };
}

/** Fix a name's definition on its first record; return the conflict a later one makes. */
function admitDefinition(
  definitions: Map<string, MetricDefinition>,
  record: MetricRecord
): { definition: MetricDefinition; offered: MetricDefinition } | null {
  const offered = definitionOf(record);
  const definition = definitions.get(record.name);
  if (definition === undefined) definitions.set(record.name, offered);
  return definition === undefined || sameDefinition(definition, offered)
    ? null
    : { definition, offered };
}

/**
 * Apply the definition rule and the latest-per-subject rule over counted rows in recorded
 * order, returning every surviving record and every refusal, at any time.
 */
function collectRecords(rows: readonly MetricRecordRow[]): {
  records: CountedRecord[];
  refused: Refused[];
} {
  const definitions = new Map<string, MetricDefinition>();
  const refused: Refused[] = [];
  const bySubject = new Map<string, CountedRecord>();
  const unkeyed: CountedRecord[] = [];

  for (const row of rows) {
    const parsed = z.array(metricRecordSchema).safeParse(row.metrics);
    if (!parsed.success) {
      refused.push(invalidRefusal(row, parsed.error));
      continue;
    }
    for (const record of parsed.data) {
      const time = Date.parse(record.at ?? row.completedAt);
      const conflict = admitDefinition(definitions, record);
      if (conflict) {
        refused.push({
          time,
          refusal: {
            reason: 'definition_conflict',
            ...source(row),
            name: record.name,
            ...conflict,
          },
        });
      } else if (record.subject === null) {
        unkeyed.push({ record, time });
      } else {
        const key = JSON.stringify([record.name, record.subject, record.instrument ?? null]);
        bySubject.set(key, { record, time });
      }
    }
  }
  return { records: [...unkeyed, ...bySubject.values()], refused };
}

const newestOf = (records: readonly CountedRecord[]): CountedRecord =>
  records.reduce((a, b) => (b.time >= a.time ? b : a));

/** `records` is non-empty, and every record carries the name's one definition. */
function nameReport(name: string, records: readonly CountedRecord[]): MetricReport {
  const newest = newestOf(records);
  const definition = definitionOf(newest.record);
  const groups = new Map<string | null, CountedRecord[]>();
  for (const entry of records) {
    const instrument = entry.record.instrument ?? null;
    groups.set(instrument, [...(groups.get(instrument) ?? []), entry]);
  }
  return {
    name,
    ...definition,
    headline_instrument: newest.record.instrument ?? null,
    instruments: [...groups]
      .sort(([a], [b]) => byInstrument(a, b))
      .map(([instrument, group]) => instrumentReport(definition.kind, instrument, group)),
  };
}
