import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { resolveAttentionProject } from '@archon/core/operations/attention-queue';
import {
  MetricsByModelNodeError,
  MetricsQueryError,
  queryMetrics,
  resolveMetricsSplit,
  resolveMetricsWindow,
} from '@archon/workflows/metrics';
import type {
  MetricByModel,
  MetricCohort,
  MetricCompare,
  MetricCost,
  MetricDefinition,
  MetricInstrumentReport,
  MetricModelGroup,
  MetricRefusal,
  MetricReport,
  MetricsReport,
} from '@archon/workflows/schemas/metric';
import { writeStderr, writeStdout } from '../utils/stdout';

export interface MetricsCommandOptions {
  since?: string;
  until?: string;
  subject?: string;
  /** Compare records whose producing runs started before and at or after this ISO time. */
  compare?: string;
  /** Split each metric by the model label that ran this node; exclusive with `compare`. */
  byModel?: string;
  /** A codebase id, name or project key, resolved as `workflow attention --project` does. */
  project?: string;
  json?: boolean;
}

// Scripts branch on these, never on message text.
const EXIT = { ok: 0, usage: 1, unknownNode: 2, refused: 4 } as const;

type MetricsHost = Pick<WorkflowHost, 'deps' | 'records'>;

class MetricsUsageError extends Error {}

async function resolveCodebaseId(host: MetricsHost, spec: string): Promise<string> {
  const project = await resolveAttentionProject(host.records.codebases, spec);
  if (project.codebaseId === null) {
    throw new MetricsUsageError(`Project '${spec}' is not a registered codebase.`);
  }
  return project.codebaseId;
}

function latestText(latest: MetricInstrumentReport['latest']): string {
  return `latest ${String(latest.value)} at ${latest.at}${latest.subject === null ? '' : ` (${latest.subject})`}`;
}

const figure = (value: number): string => String(Number(value.toPrecision(4)));

const intervalText = (interval: MetricInstrumentReport['interval']): string =>
  interval === null ? '' : `  95% [${figure(interval.low)}, ${figure(interval.high)}]`;

function figures(entry: MetricInstrumentReport): string {
  return `value ${String(entry.value)}  n ${String(entry.n)}${intervalText(entry.interval)}  ${latestText(entry.latest)}`;
}

const runCount = (n: number, what: string): string =>
  `${String(n)} run${n === 1 ? '' : 's'} ${what}`;

/** Spend is a floor, so the runs that add nothing to it are always named. */
function costText(cost: MetricCost): string {
  const usd = cost.usd === null ? 'no cost recorded' : `at least $${figure(cost.usd)}`;
  const tokens =
    cost.input_tokens === null || cost.output_tokens === null
      ? 'no tokens recorded'
      : `${String(cost.input_tokens)} in / ${String(cost.output_tokens)} out tokens`;
  const gaps = [
    runCount(cost.runs_without_cost, 'without cost'),
    runCount(cost.runs_without_tokens, 'without tokens'),
    runCount(cost.runs_partial_cost, 'with partial cost'),
    runCount(cost.runs_missing, 'missing'),
  ];
  return `cost ${usd}, ${tokens} over ${runCount(cost.runs, 'found')}; ${gaps.join(', ')}`;
}

function cohortText(label: string, cohort: MetricCohort): string {
  const value = cohort.value === null ? 'none' : String(cohort.value);
  return `${label} ${value} (n ${String(cohort.n)}${intervalText(cohort.interval)})`;
}

function compareLines(compare: MetricCompare): string[] {
  const delta = compare.delta === null ? 'none' : figure(compare.delta);
  return [
    `compare at ${compare.at}: ${cohortText('before', compare.before)}, ${cohortText('after', compare.after)}`,
    `delta ${delta}${intervalText(compare.delta_interval)}  separated: ${compare.separated ? 'yes' : 'no'}  straddling ${String(compare.straddling)}  unattributed ${String(compare.unattributed)}`,
  ];
}

function modelGroupLine(group: MetricModelGroup): string {
  const name = group.split === 'model' ? group.label : `(${group.split})`;
  const models =
    group.requested_models.length === 0 ? '' : `  requested ${group.requested_models.join(', ')}`;
  const delta =
    group.delta_vs_rest === null
      ? ''
      : `  vs rest ${figure(group.delta_vs_rest)}${intervalText(group.delta_interval_vs_rest)}  separated: ${group.separated ? 'yes' : 'no'}`;
  return `  ${name}: ${cohortText('value', group)}${delta}${models}; ${costText(group.cost)}`;
}

function byModelLines(byModel: MetricByModel): string[] {
  return [
    `by model at ${byModel.node} (unattributed ${String(byModel.unattributed)}):`,
    ...byModel.groups.map(modelGroupLine),
  ];
}

function detailLines(entry: MetricInstrumentReport, indent: string): string[] {
  return [
    costText(entry.cost),
    ...(entry.compare ? compareLines(entry.compare) : []),
    ...(entry.by_model ? byModelLines(entry.by_model) : []),
  ].map(line => `${indent}${line}`);
}

/** An instrument and the models that ran its node, such as `judge-v1 on claude/opus`. */
function identityText(instrument: string | null, measuredBy: readonly string[]): string {
  const on = measuredBy.length === 0 ? '' : ` on ${measuredBy.join(', ')}`;
  return `${instrument ?? '(no instrument)'}${on}`;
}

const sameModels = (a: readonly string[], b: readonly string[]): boolean =>
  a.join(',') === b.join(',');

function metricLines(metric: MetricReport): string[] {
  const headline = metric.instruments.find(
    i =>
      i.instrument === metric.headline_instrument &&
      sameModels(i.measured_by, metric.headline_measured_by)
  );
  const others = metric.instruments.filter(i => i !== headline);
  const headlineIdentity =
    metric.headline_instrument === null && metric.headline_measured_by.length === 0
      ? ''
      : `  [${identityText(metric.headline_instrument, metric.headline_measured_by)}]`;
  return [
    `${metric.name}  ${metric.kind}/${metric.unit}  ${headline ? figures(headline) : ''}${headlineIdentity}`,
    ...(headline ? detailLines(headline, '  ') : []),
    ...others.flatMap(entry => [
      `  ${identityText(entry.instrument, entry.measured_by)}: ${figures(entry)}`,
      ...detailLines(entry, '    '),
    ]),
  ];
}

const OBSERVATIONAL = {
  compare:
    'The comparison is observational: the cohorts also differ in the work they ran and in anything else that changed around the cut.',
  byModel:
    'The split is observational: each model ran the work it was routed, so a difference mixes the model with the work.',
} as const;

function definitionText(definition: MetricDefinition): string {
  const calibrates = definition.calibrates === null ? '' : ` calibrates ${definition.calibrates}`;
  return `${definition.kind}/${definition.unit}${calibrates}`;
}

function refusalLine(refusal: MetricRefusal): string {
  const where = `run ${refusal.run_id} node ${refusal.node_id}`;
  if (refusal.reason === 'invalid') {
    return `error: ${where} stored invalid metrics: ${refusal.errors.join('; ')}`;
  }
  const { definition, offered } = refusal;
  return `error: metric ${refusal.name} is ${definitionText(definition)}; ${where} offered ${definitionText(offered)}`;
}

/** The note a split report ends with; a report carries at most one kind of split. */
function observationalNote(report: MetricsReport): string[] {
  const entries = report.metrics.flatMap(metric => metric.instruments);
  if (entries.some(entry => entry.compare !== undefined)) return [OBSERVATIONAL.compare];
  return entries.some(entry => entry.by_model !== undefined) ? [OBSERVATIONAL.byModel] : [];
}

function reportText(report: MetricsReport): string {
  const window = `${report.window.since} to ${report.window.until}`;
  if (report.metrics.length === 0) return `No metrics from ${window}.\n`;
  const lines = [...report.metrics.flatMap(metricLines), ...observationalNote(report)];
  return `Metrics from ${window}:\n${lines.join('\n')}\n`;
}

/**
 * `archon metrics [name]`: aggregate stored metric records over a window. Exits 4 when
 * any record was refused, so a script can tell a clean report from one with conflicts,
 * and 2 when no producing run ran the `--by-model` node.
 */
export async function metricsCommand(
  host: MetricsHost,
  name: string | undefined,
  options: MetricsCommandOptions,
  io: { now?: Date; stdout?: typeof writeStdout; stderr?: typeof writeStderr } = {}
): Promise<number> {
  const stdout = io.stdout ?? writeStdout;
  const stderr = io.stderr ?? writeStderr;
  let report: MetricsReport;
  try {
    report = await queryMetrics(host.deps.store, {
      ...resolveMetricsWindow(options, io.now),
      ...(name === undefined ? {} : { name }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...resolveMetricsSplit(options),
      ...(options.project === undefined
        ? {}
        : { codebaseId: await resolveCodebaseId(host, options.project) }),
    });
  } catch (error) {
    if (!(error instanceof MetricsQueryError || error instanceof MetricsUsageError)) throw error;
    await stderr(`Error: ${error.message}\n`);
    return error instanceof MetricsByModelNodeError ? EXIT.unknownNode : EXIT.usage;
  }

  // Same document form as writeJsonLine, through the injectable stdout.
  await stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : reportText(report));
  for (const refusal of report.refused) await stderr(`${refusalLine(refusal)}\n`);
  return report.refused.length > 0 ? EXIT.refused : EXIT.ok;
}
