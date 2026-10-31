/**
 * Metrics: aggregate the metric records nodes returned under their reserved `metrics`
 * output key, by name, window and instrument.
 *
 * Every rule about which stored records count lives here; the stores return raw rows.
 */
import { z } from 'zod';
import {
  meanInterval,
  newcombeDifference,
  welchDifference,
  wilsonInterval,
  type Interval,
} from './metrics-stats';
import {
  metricRecordSchema,
  type MetricCohort,
  type MetricCompare,
  type MetricCost,
  type MetricDefinition,
  type MetricInstrumentReport,
  type MetricRecord,
  type MetricRefusal,
  type MetricReport,
  type MetricsReport,
} from './schemas/metric';
import type { NodeDescriptor } from './schemas/node-execution';
import { parseRunUsage } from './schemas/run-usage';
import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore, MetricRecordRow } from './store';

export type MetricsStore = Pick<
  IWorkflowStore,
  'listMetricRecords' | 'listEventsForRuns' | 'getWorkflowRunsByIds'
>;

export interface MetricsQuery {
  /** Inclusive start of the window. */
  since: Date;
  /** Exclusive end of the window. */
  until: Date;
  name?: string;
  subject?: string;
  codebaseId?: string;
  /** Split each group into runs started before and at or after this time. */
  compareAt?: Date;
}

/** A malformed window or cut. */
export class MetricsQueryError extends Error {}

const DAY_MS = 86_400_000;
export const DEFAULT_METRICS_WINDOW_DAYS = 30;
const DURATION_UNIT_MS = { h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS } as const;
const instantSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const INSTANT_FORMS =
  'an ISO date or a time with an offset, such as 2026-10-01 or 2026-10-01T12:00:00Z';

function parseInstant(field: string, value: string, forms = INSTANT_FORMS): Date {
  if (!instantSchema.safeParse(value).success) {
    throw new MetricsQueryError(`${field} must be ${forms}; got "${value}"`);
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
    throw new MetricsQueryError('since must be before until');
  }
  return { since, until };
}

/** Resolve a `--compare` cut: an ISO date or a time with an offset. */
export function resolveCompareCut(value: string): Date {
  return parseInstant('compare', value);
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
    throw new MetricsQueryError(`since "${since}" reaches before the earliest representable date`);
  }
  return start;
}

/** One parsed record that counts. */
interface CountedRecord {
  record: MetricRecord;
  /** `at`, else the completion time, in ms. */
  time: number;
  /** The run that returned the record. */
  runId: string;
}

/** The runs the report reads, by id, and the cut it compares at. */
interface ReportContext {
  runs: ReadonlyMap<string, WorkflowRun>;
  compareAt: Date | undefined;
}

const RUN_CHUNK = 500;

/**
 * Nodes whose completion restates another node's structured output: a child workflow's
 * `returns:` value, a loop group's last body node, a fan-out instance's `returns:` node.
 * That node's own completion already carries the records.
 */
const RELAYING_NODE_TYPES: ReadonlySet<string> = new Set([
  'workflow',
  'loop_group',
  'compose_fan_out_instance',
] satisfies NodeDescriptor['kind'][]);

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

/** A record's `runs`, or the run that returned it. */
const producingRunIds = (entry: CountedRecord): readonly string[] =>
  entry.record.runs ?? [entry.runId];

const isRate = (values: readonly number[]): boolean =>
  values.every(value => value === 0 || value === 1);

const successes = (values: readonly number[]): number => values.filter(value => value === 1).length;

function valueInterval(
  kind: MetricDefinition['kind'],
  rate: boolean,
  values: readonly number[]
): Interval | null {
  if (kind === 'count' || values.length < 2) return null;
  return rate ? wilsonInterval(successes(values), values.length) : meanInterval(values);
}

/** Sums over the distinct producing runs; a run without a figure is counted, never zero. */
function costReport(records: readonly CountedRecord[], runs: ReportContext['runs']): MetricCost {
  const cost: MetricCost = {
    usd: null,
    input_tokens: null,
    output_tokens: null,
    runs: 0,
    runs_without_cost: 0,
    runs_without_tokens: 0,
    runs_missing: 0,
  };
  for (const id of new Set(records.flatMap(producingRunIds))) {
    const run = runs.get(id);
    if (run === undefined) {
      cost.runs_missing += 1;
      continue;
    }
    cost.runs += 1;
    const usage = parseRunUsage(run.metadata);
    if (usage.costUsd === undefined) cost.runs_without_cost += 1;
    else cost.usd = (cost.usd ?? 0) + usage.costUsd;
    if (usage.tokens === undefined) {
      cost.runs_without_tokens += 1;
    } else {
      cost.input_tokens = (cost.input_tokens ?? 0) + usage.tokens.input;
      cost.output_tokens = (cost.output_tokens ?? 0) + usage.tokens.output;
    }
  }
  return cost;
}

type Cohort = 'before' | 'after' | 'straddling' | 'unattributed';

/**
 * A record belongs to the cohort of its producing runs' start, not to its `at`. A record
 * with any named run gone is unattributed: the gone run's start is unknown, so neither
 * cohort's rule can be checked, and crediting the run that returned it would place the
 * record after any cut older than the metric run.
 */
function cohortOf(entry: CountedRecord, runs: ReportContext['runs'], cut: number): Cohort {
  const starts = producingRunIds(entry).map(id => runs.get(id)?.started_at.getTime());
  if (!starts.every(start => start !== undefined)) return 'unattributed';
  if (starts.every(start => start < cut)) return 'before';
  return starts.every(start => start >= cut) ? 'after' : 'straddling';
}

function compareReport(
  kind: MetricDefinition['kind'],
  records: readonly CountedRecord[],
  runs: ReportContext['runs'],
  cut: Date
): MetricCompare {
  const values: Record<Cohort, number[]> = {
    before: [],
    after: [],
    straddling: [],
    unattributed: [],
  };
  for (const entry of records)
    values[cohortOf(entry, runs, cut.getTime())].push(entry.record.value);
  const rate = isRate(records.map(({ record }) => record.value));
  const cohort = (cohortValues: readonly number[]): MetricCohort => ({
    value: cohortValues.length === 0 ? null : aggregate(kind, cohortValues),
    n: cohortValues.length,
    interval: valueInterval(kind, rate, cohortValues),
  });
  const before = cohort(values.before);
  const after = cohort(values.after);
  const deltaInterval = differenceInterval(kind, rate, values.after, values.before);
  return {
    at: cut.toISOString(),
    before,
    after,
    delta: before.value === null || after.value === null ? null : after.value - before.value,
    delta_interval: deltaInterval,
    separated: deltaInterval !== null && (deltaInterval.low > 0 || deltaInterval.high < 0),
    straddling: values.straddling.length,
    unattributed: values.unattributed.length,
  };
}

/** The interval of `after − before`: Newcombe's for a rate, Welch's for other scores. */
function differenceInterval(
  kind: MetricDefinition['kind'],
  rate: boolean,
  after: readonly number[],
  before: readonly number[]
): Interval | null {
  if (kind === 'count' || after.length < 2 || before.length < 2) return null;
  if (!rate) return welchDifference(after, before);
  return newcombeDifference(
    { successes: successes(after), n: after.length },
    { successes: successes(before), n: before.length }
  );
}

function instrumentReport(
  kind: MetricDefinition['kind'],
  instrument: string | null,
  records: readonly CountedRecord[],
  context: ReportContext
): MetricInstrumentReport {
  const latest = newestOf(records);
  const values = records.map(({ record }) => record.value);
  const byDay = new Map<string, number[]>();
  for (const { record, time } of records) {
    const day = new Date(time).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), record.value]);
  }
  return {
    instrument,
    value: aggregate(kind, values),
    n: records.length,
    interval: valueInterval(kind, isRate(values), values),
    cost: costReport(records, context.runs),
    ...(context.compareAt === undefined
      ? {}
      : { compare: compareReport(kind, records, context.runs, context.compareAt) }),
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
 * 1. Only a node's latest terminal event in its run counts, and only from the node that
 *    produced the output, not from a node that relays it.
 * 2. A name's earliest stored record on the install, in recorded order, fixes its
 *    definition (`kind`, `unit`, `calibrates`), whatever codebase is queried. A later
 *    record that disagrees is refused and reported with both definitions, so a name keeps
 *    one meaning.
 * 3. The latest record per `(name, subject, instrument)` replaces earlier ones for a
 *    non-null subject, so a re-measurement never double-counts. A `subject: null`
 *    record counts once per run and node, by rule 1.
 * 4. A record falls in the window by `at`, else by its completion time.
 * 5. Each name reports one entry per instrument, so two instruments are never averaged.
 * 6. A record's producing runs are its `runs`, else the run that returned it. Cost sums
 *    each distinct producing run once, and `compareAt` splits records by when those runs
 *    started, not by `at`.
 *
 * Refusals are reported for the queried name and window. A stored output the record
 * schema rejects (written before the schema, or unreadable) has no trusted name, so it
 * is reported only when no name is queried. The stores skip a `metrics: null` output, which
 * holds no record; only an output written before the key was reserved can carry one.
 */
export async function queryMetrics(
  store: MetricsStore,
  query: MetricsQuery
): Promise<MetricsReport> {
  const rows = (await store.listMetricRecords()).filter(
    row => row.nodeType === null || !RELAYING_NODE_TYPES.has(row.nodeType)
  );
  const counted = await latestTerminalEventIds(store, [...new Set(rows.map(row => row.runId))]);
  const since = query.since.getTime();
  const until = query.until.getTime();
  const inWindow = (time: number): boolean => time >= since && time < until;
  const { records, refused } = collectRecords(
    rows.filter(row => counted.has(row.eventId)),
    row => query.codebaseId === undefined || row.codebaseId === query.codebaseId
  );

  const byName = new Map<string, CountedRecord[]>();
  for (const entry of records) {
    const { record, time } = entry;
    if (!inWindow(time)) continue;
    if (query.name !== undefined && record.name !== query.name) continue;
    if (query.subject !== undefined && record.subject !== query.subject) continue;
    byName.set(record.name, [...(byName.get(record.name) ?? []), entry]);
  }
  const context: ReportContext = {
    runs: await runsOf(store, [...byName.values()].flat()),
    compareAt: query.compareAt,
  };
  const queried = (refusal: MetricRefusal): boolean =>
    query.name === undefined ||
    (refusal.reason === 'definition_conflict' && refusal.name === query.name);

  return {
    window: { since: query.since.toISOString(), until: query.until.toISOString() },
    metrics: [...byName]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, named]) => nameReport(name, named, context)),
    refused: refused
      .filter(({ refusal, time }) => inWindow(time) && queried(refusal))
      .map(({ refusal }) => refusal),
  };
}

/** The producing runs of `records`, read once. */
async function runsOf(
  store: MetricsStore,
  records: readonly CountedRecord[]
): Promise<ReportContext['runs']> {
  const ids = [...new Set(records.flatMap(producingRunIds))];
  if (ids.length === 0) return new Map();
  return new Map((await store.getWorkflowRunsByIds(ids)).map(run => [run.id, run]));
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
 * Apply the definition rule over every counted row in recorded order, then the
 * latest-per-subject rule over the `selected` ones. Returns every surviving record and
 * every refusal among the selected rows, at any time.
 */
function collectRecords(
  rows: readonly MetricRecordRow[],
  selected: (row: MetricRecordRow) => boolean
): {
  records: CountedRecord[];
  refused: Refused[];
} {
  const definitions = new Map<string, MetricDefinition>();
  const refused: Refused[] = [];
  const admitted: CountedRecord[] = [];
  for (const row of rows) {
    // An unselected row still fixes the definitions of the names it carries.
    const result = admitRow(definitions, row);
    if (!selected(row)) continue;
    refused.push(...result.refused);
    admitted.push(...result.admitted);
  }
  return { records: latestPerSubject(admitted), refused };
}

function admitRow(
  definitions: Map<string, MetricDefinition>,
  row: MetricRecordRow
): { admitted: CountedRecord[]; refused: Refused[] } {
  const parsed = z.array(metricRecordSchema).safeParse(row.metrics);
  if (!parsed.success) return { admitted: [], refused: [invalidRefusal(row, parsed.error)] };
  const admitted: CountedRecord[] = [];
  const refused: Refused[] = [];
  for (const record of parsed.data) {
    const time = Date.parse(record.at ?? row.completedAt);
    const conflict = admitDefinition(definitions, record);
    if (conflict === null) {
      admitted.push({ record, time, runId: row.runId });
    } else {
      refused.push({
        time,
        refusal: { reason: 'definition_conflict', ...source(row), name: record.name, ...conflict },
      });
    }
  }
  return { admitted, refused };
}

/** Records in recorded order, keeping only the latest per non-null subject. */
function latestPerSubject(records: readonly CountedRecord[]): CountedRecord[] {
  const bySubject = new Map<string, CountedRecord>();
  const unkeyed: CountedRecord[] = [];
  for (const entry of records) {
    const { name, subject, instrument } = entry.record;
    if (subject === null) unkeyed.push(entry);
    else bySubject.set(JSON.stringify([name, subject, instrument ?? null]), entry);
  }
  return [...unkeyed, ...bySubject.values()];
}

const newestOf = (records: readonly CountedRecord[]): CountedRecord =>
  records.reduce((a, b) => (b.time >= a.time ? b : a));

/** `records` is non-empty, and every record carries the name's one definition. */
function nameReport(
  name: string,
  records: readonly CountedRecord[],
  context: ReportContext
): MetricReport {
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
      .map(([instrument, group]) => instrumentReport(definition.kind, instrument, group, context)),
  };
}
