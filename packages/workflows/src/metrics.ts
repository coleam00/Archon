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
  readRunSteps,
  readTerminalEvents,
  type RunStep,
  type RunStepIndex,
  type TerminalEvents,
} from './metrics-steps';
import {
  metricRecordSchema,
  type MetricByModel,
  type MetricCohort,
  type MetricCompare,
  type MetricCost,
  type MetricDefinition,
  type MetricInstrumentReport,
  type MetricModelGroup,
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
  'listMetricRecords' | 'listEventsForRuns' | 'getWorkflowRunsByIds' | 'listWorkflowRuns'
>;

/** A query compares cohorts or models, never both. */
export type MetricsSplit =
  | { compareAt?: undefined; byModelNode?: undefined }
  /** Split each group into runs started before and at or after this time. */
  | { compareAt: Date; byModelNode?: undefined }
  /** Split each group by the model label that ran this node in its producing runs. */
  | { byModelNode: string; compareAt?: undefined };

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

const SEEN_NODE_LIMIT = 50;

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

/** Resolve the CLI's and API's split: a `compare` cut (an ISO date or time) or a `byModel` node. */
export function resolveMetricsSplit(input: { compare?: string; byModel?: string }): MetricsSplit {
  if (input.compare !== undefined && input.byModel !== undefined) {
    throw new MetricsQueryError('compare and by-model cannot be combined; run one query for each');
  }
  if (input.compare !== undefined) return { compareAt: parseInstant('compare', input.compare) };
  if (input.byModel === '') throw new MetricsQueryError('by-model needs a node id');
  return input.byModel === undefined ? {} : { byModelNode: input.byModel };
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
  /** The sorted labels that ran `instrument_node`; with `instrument`, the record's instrument. */
  measuredBy: readonly string[];
}

/** A record admitted by the definition rule, before its measured-by is read. */
type AdmittedRecord = Omit<CountedRecord, 'measuredBy'>;

/** The runs the report reads, by id, their AI steps, and how it splits groups. */
interface ReportContext {
  runs: ReadonlyMap<string, WorkflowRun>;
  steps: RunStepIndex;
  split: MetricsSplit;
}

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
function costReport(records: readonly CountedRecord[], context: ReportContext): MetricCost {
  const cost: MetricCost = {
    usd: null,
    input_tokens: null,
    output_tokens: null,
    runs: 0,
    runs_without_cost: 0,
    runs_without_tokens: 0,
    runs_partial_cost: 0,
    runs_missing: 0,
  };
  for (const id of new Set(records.flatMap(producingRunIds))) {
    const run = context.runs.get(id);
    if (run === undefined) {
      cost.runs_missing += 1;
      continue;
    }
    cost.runs += 1;
    const usage = parseRunUsage(run.metadata);
    if (usage.costUsd === undefined) {
      cost.runs_without_cost += 1;
    } else {
      cost.usd = (cost.usd ?? 0) + usage.costUsd;
      if (context.steps.treeSteps(id).some(step => step.costless)) cost.runs_partial_cost += 1;
    }
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
    separated: separates(deltaInterval),
    straddling: values.straddling.length,
    unattributed: values.unattributed.length,
  };
}

const separates = (interval: Interval | null): boolean =>
  interval !== null && (interval.low > 0 || interval.high < 0);

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

type ModelSplit = { split: 'model'; label: string } | { split: 'mixed' | 'none' };

const splitKey = (split: ModelSplit): string =>
  split.split === 'model' ? `model:${split.label}` : split.split;

/**
 * The model split of a record at `node`, with the steps that ran it, or `null` when a named
 * run no longer exists.
 */
function modelSplitOf(
  entry: CountedRecord,
  context: ReportContext,
  node: string
): { split: ModelSplit; steps: RunStep[] } | null {
  const ids = producingRunIds(entry);
  if (!ids.every(id => context.runs.has(id))) return null;
  const steps = ids.flatMap(id => context.steps.treeSteps(id)).filter(s => s.nodeId === node);
  const labels = [...new Set(steps.map(step => step.label))];
  const [label] = labels;
  if (labels.length > 1) return { split: { split: 'mixed' }, steps };
  return { split: label === undefined ? { split: 'none' } : { split: 'model', label }, steps };
}

interface ModelBucket {
  split: ModelSplit;
  records: CountedRecord[];
  steps: RunStep[];
}

const SPLIT_ORDER = { model: 0, mixed: 1, none: 2 } as const;

const byBucket = (a: ModelBucket, b: ModelBucket): number =>
  SPLIT_ORDER[a.split.split] - SPLIT_ORDER[b.split.split] ||
  splitKey(a.split).localeCompare(splitKey(b.split));

const distinct = (values: readonly (string | null)[]): string[] =>
  [...new Set(values.filter(value => value !== null))].sort();

function modelGroup(
  kind: MetricDefinition['kind'],
  rate: boolean,
  bucket: ModelBucket,
  rest: readonly number[],
  context: ReportContext
): MetricModelGroup {
  const values = bucket.records.map(({ record }) => record.value);
  const value = aggregate(kind, values);
  const deltaInterval = differenceInterval(kind, rate, values, rest);
  const fields = {
    value,
    n: values.length,
    interval: valueInterval(kind, rate, values),
    cost: costReport(bucket.records, context),
    requested_models: distinct(bucket.steps.map(step => step.requestedModel)),
    resolved_models: distinct(bucket.steps.map(step => step.resolvedModel)),
    delta_vs_rest: rest.length === 0 ? null : value - aggregate(kind, rest),
    delta_interval_vs_rest: deltaInterval,
    separated: separates(deltaInterval),
  };
  return { ...bucket.split, ...fields };
}

/** Split records by the model label that ran `node`; each group compares with the other models. */
function byModelReport(
  kind: MetricDefinition['kind'],
  records: readonly CountedRecord[],
  context: ReportContext,
  node: string
): MetricByModel {
  const buckets = new Map<string, ModelBucket>();
  let unattributed = 0;
  for (const entry of records) {
    const found = modelSplitOf(entry, context, node);
    if (found === null) {
      unattributed += 1;
      continue;
    }
    const key = splitKey(found.split);
    const bucket = buckets.get(key) ?? { split: found.split, records: [], steps: [] };
    bucket.records.push(entry);
    bucket.steps.push(...found.steps);
    buckets.set(key, bucket);
  }
  const rate = isRate(records.map(({ record }) => record.value));
  const sorted = [...buckets.values()].sort(byBucket);
  const modelValues = (except: ModelBucket): number[] =>
    sorted
      .filter(bucket => bucket !== except && bucket.split.split === 'model')
      .flatMap(bucket => bucket.records.map(({ record }) => record.value));
  return {
    node,
    groups: sorted.map(bucket => modelGroup(kind, rate, bucket, modelValues(bucket), context)),
    unattributed,
  };
}

function splitReports(
  kind: MetricDefinition['kind'],
  records: readonly CountedRecord[],
  context: ReportContext
): Pick<MetricInstrumentReport, 'compare' | 'by_model'> {
  const { compareAt, byModelNode } = context.split;
  if (compareAt !== undefined) {
    return { compare: compareReport(kind, records, context.runs, compareAt) };
  }
  return byModelNode === undefined
    ? {}
    : { by_model: byModelReport(kind, records, context, byModelNode) };
}

function instrumentReport(
  kind: MetricDefinition['kind'],
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
    instrument: latest.record.instrument ?? null,
    measured_by: [...latest.measuredBy],
    value: aggregate(kind, values),
    n: records.length,
    interval: valueInterval(kind, isRate(values), values),
    cost: costReport(records, context),
    ...splitReports(kind, records, context),
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

type Identity = Pick<MetricInstrumentReport, 'instrument' | 'measured_by'>;

/** Instruments by name, `null` first, then by the models that measured them. */
const byIdentity = (a: Identity, b: Identity): number => {
  if (a.instrument !== b.instrument) {
    if (a.instrument === null) return -1;
    return b.instrument === null ? 1 : a.instrument.localeCompare(b.instrument);
  }
  return a.measured_by.join(',').localeCompare(b.measured_by.join(','));
};

/**
 * Aggregate stored metric records over `[since, until)`.
 *
 * 1. Only the latest terminal event of a node position counts, a position being the node
 *    and the loop iterations it ran in, and only from the node that produced the output,
 *    not from a node that relays it.
 * 2. A name's earliest stored record on the install, in recorded order, fixes its
 *    definition (`kind`, `unit`, `calibrates`), whatever codebase is queried. A later
 *    record that disagrees is refused and reported with both definitions, so a name keeps
 *    one meaning.
 * 3. A record's instrument is its `instrument` with its measured-by: the model labels that
 *    ran its `instrument_node` in the run that returned it and the runs below it. Only that
 *    node counts, so another AI node in the metric workflow leaves the instrument as it is.
 * 4. The latest record per `(name, subject, instrument, measured-by)` replaces earlier ones
 *    for a non-null subject, so a re-measurement never double-counts and a second judge
 *    model keeps the first one's records. A `subject: null` record counts once per run and
 *    node position, by rule 1.
 * 5. A record falls in the window by `at`, else by its completion time.
 * 6. Each name reports one entry per instrument and measured-by, so two instruments are
 *    never averaged.
 * 7. A record's producing runs are its `runs`, else the run that returned it. Cost sums
 *    each distinct producing run once. `compareAt` splits records by when those runs
 *    started, not by `at`; `byModelNode` splits them by the model labels that ran that
 *    node in those runs and the runs below them.
 *
 * Refusals are reported for the queried name and window. A stored output the record
 * schema rejects (written before the schema, or unreadable) has no trusted name, so it
 * is reported only when no name is queried. The stores skip a `metrics: null` output, which
 * holds no record; only an output written before the key was reserved can carry one.
 *
 * Throws {@link MetricsByModelNodeError} when `byModelNode` names a node that no found
 * producing run ran, so a mistyped node is not reported as a table of `none`. The check
 * needs at least one producing run that still exists: a window with no records reports
 * none, and records whose producing runs were all deleted are reported `unattributed`
 * without checking the node.
 */
export async function queryMetrics(
  store: MetricsStore,
  query: MetricsQuery
): Promise<MetricsReport> {
  const rows = (await store.listMetricRecords()).filter(
    row => row.nodeType === null || !RELAYING_NODE_TYPES.has(row.nodeType)
  );
  const terminal = await readTerminalEvents(
    store,
    rows.map(row => row.runId)
  );
  const counted = new Set([...terminal.values()].flat().map(event => event.id));
  const since = query.since.getTime();
  const until = query.until.getTime();
  const inWindow = (time: number): boolean => time >= since && time < until;
  const { admitted, refused } = collectRecords(
    rows.filter(row => counted.has(row.eventId)),
    row => query.codebaseId === undefined || row.codebaseId === query.codebaseId
  );
  const wanted = admitted.filter(
    ({ record }) =>
      (query.name === undefined || record.name === query.name) &&
      (query.subject === undefined || record.subject === query.subject)
  );
  const records = latestPerSubject(await withMeasuredBy(store, wanted, terminal)).filter(
    ({ time }) => inWindow(time)
  );
  const context = await reportContext(store, records, terminal, query);

  const byName = new Map<string, CountedRecord[]>();
  for (const entry of records) {
    byName.set(entry.record.name, [...(byName.get(entry.record.name) ?? []), entry]);
  }
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

/** Add each record's measured-by, read from the run that returned it and the runs below. */
async function withMeasuredBy(
  store: MetricsStore,
  records: readonly AdmittedRecord[],
  known: TerminalEvents
): Promise<CountedRecord[]> {
  const judged = records.filter(({ record }) => record.instrument_node !== undefined);
  const steps = await readRunSteps(
    store,
    judged.map(({ runId }) => runId),
    known
  );
  return records.map(entry => {
    const node = entry.record.instrument_node;
    const labels =
      node === undefined
        ? []
        : steps
            .treeSteps(entry.runId)
            .filter(step => step.nodeId === node)
            .map(step => step.label);
    return { ...entry, measuredBy: [...new Set(labels)].sort() };
  });
}

/** Read the producing runs of `records` and their steps; check a by-model node ran. */
async function reportContext(
  store: MetricsStore,
  records: readonly CountedRecord[],
  known: TerminalEvents,
  split: MetricsSplit
): Promise<ReportContext> {
  const runs = await runsOf(store, records);
  const context = { runs, steps: await readRunSteps(store, [...runs.keys()], known), split };
  if (split.byModelNode !== undefined) assertNodeRan(context, split.byModelNode);
  return context;
}

function assertNodeRan(context: ReportContext, node: string): void {
  if (context.runs.size === 0) return;
  const seen = new Set<string>();
  for (const id of context.runs.keys()) {
    const steps = context.steps.treeSteps(id);
    if (steps.some(step => step.nodeId === node)) return;
    for (const step of steps) seen.add(step.nodeId);
  }
  throw new MetricsByModelNodeError(node, [...seen].sort().slice(0, SEEN_NODE_LIMIT));
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
 * Apply the definition rule over every counted row in recorded order. Returns every
 * admitted record and every refusal among the `selected` rows, at any time.
 */
function collectRecords(
  rows: readonly MetricRecordRow[],
  selected: (row: MetricRecordRow) => boolean
): {
  admitted: AdmittedRecord[];
  refused: Refused[];
} {
  const definitions = new Map<string, MetricDefinition>();
  const refused: Refused[] = [];
  const admitted: AdmittedRecord[] = [];
  for (const row of rows) {
    // An unselected row still fixes the definitions of the names it carries.
    const result = admitRow(definitions, row);
    if (!selected(row)) continue;
    refused.push(...result.refused);
    admitted.push(...result.admitted);
  }
  return { admitted, refused };
}

function admitRow(
  definitions: Map<string, MetricDefinition>,
  row: MetricRecordRow
): { admitted: AdmittedRecord[]; refused: Refused[] } {
  const parsed = z.array(metricRecordSchema).safeParse(row.metrics);
  if (!parsed.success) return { admitted: [], refused: [invalidRefusal(row, parsed.error)] };
  const admitted: AdmittedRecord[] = [];
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

const identityKey = (entry: CountedRecord): string =>
  JSON.stringify([entry.record.instrument ?? null, entry.measuredBy]);

/** Records in recorded order, keeping only the latest per non-null subject and instrument. */
function latestPerSubject(records: readonly CountedRecord[]): CountedRecord[] {
  const bySubject = new Map<string, CountedRecord>();
  const unkeyed: CountedRecord[] = [];
  for (const entry of records) {
    const { name, subject } = entry.record;
    if (subject === null) unkeyed.push(entry);
    else bySubject.set(JSON.stringify([name, subject, identityKey(entry)]), entry);
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
  const groups = new Map<string, CountedRecord[]>();
  for (const entry of records) {
    const key = identityKey(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return {
    name,
    ...definition,
    headline_instrument: newest.record.instrument ?? null,
    headline_measured_by: [...newest.measuredBy],
    instruments: [...groups.values()]
      .map(group => instrumentReport(definition.kind, group, context))
      .sort(byIdentity),
  };
}
