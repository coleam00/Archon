import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  attentionQueueSource,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { reportItemMetrics } from '@archon/workflows/item-metrics';
import type { ItemMetricFigures, ItemMetricsReport } from '@archon/workflows/schemas/item-metric';
import { liveSourceRoots, workflowSourceConfigFrom } from '@archon/workflows/workflow-source';
import type { LiveWorkflowSourceRoots } from '@archon/workflows/workflow-source/roots';
import {
  MetricsByModelNodeError,
  MetricsDimensionKeyError,
  MetricsQueryError,
  queryMetrics,
  resolveMetricsSplit,
  resolveMetricsWindow,
} from '@archon/workflows/metrics';
import type {
  MetricByDimension,
  MetricByModel,
  MetricCohort,
  MetricCompare,
  MetricCost,
  MetricDefinition,
  MetricDimensionGroup,
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
  /** Split each metric by the value its records carry for this dimension key. */
  byDimension?: string;
  /** A codebase id, name or project key, resolved as `workflow attention --project` does. */
  project?: string;
  json?: boolean;
}

// Scripts branch on these, never on message text.
const EXIT = { ok: 0, usage: 1, unknownSplit: 2, refused: 4 } as const;

type MetricsHost = Pick<WorkflowHost, 'deps' | 'records'>;

class MetricsUsageError extends Error {}

interface MetricsProject {
  key: string;
  codebaseId: string;
  /** The codebase's checkout, whose config and `.archon/workflows` packs declare item metrics. */
  cwd: string;
}

async function resolveProject(host: MetricsHost, spec: string): Promise<MetricsProject> {
  const project = await resolveAttentionProject(host.records.codebases, spec);
  const codebase =
    project.codebaseId === null
      ? null
      : await host.records.codebases.getCodebase(project.codebaseId);
  if (codebase === null) {
    throw new MetricsUsageError(`Project '${spec}' is not a registered codebase.`);
  }
  return { key: project.key, codebaseId: codebase.id, cwd: codebase.default_cwd };
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

function vsRestText(group: MetricModelGroup | MetricDimensionGroup): string {
  return group.delta_vs_rest === null
    ? ''
    : `  vs rest ${figure(group.delta_vs_rest)}${intervalText(group.delta_interval_vs_rest)}  separated: ${group.separated ? 'yes' : 'no'}`;
}

function modelGroupLine(group: MetricModelGroup): string {
  const name = group.split === 'model' ? group.label : `(${group.split})`;
  const models =
    group.requested_models.length === 0 ? '' : `  requested ${group.requested_models.join(', ')}`;
  return `  ${name}: ${cohortText('value', group)}${vsRestText(group)}${models}; ${costText(group.cost)}`;
}

function byModelLines(byModel: MetricByModel): string[] {
  return [
    `by model at ${byModel.node} (unattributed ${String(byModel.unattributed)}):`,
    ...byModel.groups.map(modelGroupLine),
  ];
}

function dimensionGroupLines(group: MetricDimensionGroup): string[] {
  const name = group.split === 'value' ? group.label : '(none)';
  return [
    `  ${name}: ${cohortText('value', group)}${vsRestText(group)}; ${costText(group.cost)}`,
    ...(group.compare ? compareLines(group.compare).map(line => `    ${line}`) : []),
  ];
}

function byDimensionLines(byDimension: MetricByDimension): string[] {
  return [`by ${byDimension.key}:`, ...byDimension.groups.flatMap(dimensionGroupLines)];
}

function detailLines(entry: MetricInstrumentReport, indent: string): string[] {
  return [
    costText(entry.cost),
    ...(entry.compare ? compareLines(entry.compare) : []),
    ...(entry.by_model ? byModelLines(entry.by_model) : []),
    ...(entry.by_dimension ? byDimensionLines(entry.by_dimension) : []),
  ].map(line => `${indent}${line}`);
}

/** An instrument and the models that ran its node, such as `judge-v1 on claude/opus`. */
function identityText(instrument: string | null, measuredBy: readonly string[]): string {
  const on = measuredBy.length === 0 ? '' : ` on ${measuredBy.join(', ')}`;
  return `${instrument ?? '(no instrument)'}${on}`;
}

const sameModels = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((label, i) => label === b[i]);

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
  byDimension:
    'The split is observational: each value covers different work, so a difference mixes the dimension with the work.',
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

/** The notes a split report ends with: one per kind of split it carries. */
function observationalNote(report: MetricsReport): string[] {
  const entries = report.metrics.flatMap(metric => metric.instruments);
  const groups = entries.flatMap(entry => entry.by_dimension?.groups ?? []);
  const compared =
    entries.some(entry => entry.compare !== undefined) ||
    groups.some(group => group.compare !== undefined);
  return [
    ...(entries.some(entry => entry.by_dimension !== undefined) ? [OBSERVATIONAL.byDimension] : []),
    ...(entries.some(entry => entry.by_model !== undefined) ? [OBSERVATIONAL.byModel] : []),
    ...(compared ? [OBSERVATIONAL.compare] : []),
  ];
}

function itemFiguresText(figures: ItemMetricFigures): string {
  const value = figures.value === null ? 'none' : figure(figures.value);
  if (figures.op === 'share')
    return `share ${value} (${String(figures.numerator)} of ${String(figures.denominator)})`;
  if (figures.op === 'count')
    return `${value} per item (${String(figures.total)} over ${String(figures.n)} items)`;
  return `${value} hours mean (n ${String(figures.n)}, ${String(figures.missing)} missing a time)`;
}

function itemMetricsText(report: ItemMetricsReport): string {
  const lines = [
    `Item metrics for ${report.project} over ${String(report.items)} items with a run from ${report.window.since} to ${report.window.until}:`,
  ];
  if (report.degraded_items.length > 0)
    lines.push(
      `  ${String(report.degraded_items.length)} item(s) could not be read whole: ${report.degraded_items.join(', ')}`
    );
  const declared = report.packs.filter(pack => pack.metrics.length > 0);
  if (declared.length === 0) lines.push('  none declared');
  for (const pack of declared) {
    lines.push(`  ${pack.pack} (${pack.source}):`);
    for (const { name, groups, ...figures } of pack.metrics) {
      lines.push(`    ${name}  ${itemFiguresText(figures)}`);
      for (const { group, ...each } of groups ?? [])
        lines.push(`      ${group ?? '(none)'}: ${itemFiguresText(each)}`);
    }
  }
  return `${lines.join('\n')}\n`;
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
 * and 2 when no producing run ran the `--by-model` node or no record carries the
 * `--by-dimension` key.
 */
export async function metricsCommand(
  host: MetricsHost,
  name: string | undefined,
  options: MetricsCommandOptions,
  io: {
    now?: Date;
    stdout?: typeof writeStdout;
    stderr?: typeof writeStderr;
    /** Where packs declare item metrics; the project's checkout and config when absent. */
    sourceRoots?: LiveWorkflowSourceRoots;
  } = {}
): Promise<number> {
  const stdout = io.stdout ?? writeStdout;
  const stderr = io.stderr ?? writeStderr;
  let queried: { report: MetricsReport; project: MetricsProject | null };
  try {
    queried = await queryReport(host, name, options, io.now);
  } catch (error) {
    if (!(error instanceof MetricsQueryError || error instanceof MetricsUsageError)) throw error;
    await stderr(`Error: ${error.message}\n`);
    return error instanceof MetricsByModelNodeError || error instanceof MetricsDimensionKeyError
      ? EXIT.unknownSplit
      : EXIT.usage;
  }
  const { report, project } = queried;
  // Item metrics are per project and have no subject or split, so those filters leave them out.
  const split =
    options.subject !== undefined ||
    options.compare !== undefined ||
    options.byModel !== undefined ||
    options.byDimension !== undefined;
  const itemMetrics =
    project === null || split
      ? null
      : await projectItemMetrics(host, project, name, report.window, io, stderr);
  return writeReport(report, itemMetrics, options.json === true, stdout, stderr);
}

async function writeReport(
  report: MetricsReport,
  itemMetrics: ItemMetricsReport | null,
  json: boolean,
  stdout: typeof writeStdout,
  stderr: typeof writeStderr
): Promise<number> {
  // Same document form as writeJsonLine, through the injectable stdout.
  await stdout(
    json
      ? `${JSON.stringify({ ...report, item_metrics: itemMetrics }, null, 2)}\n`
      : `${reportText(report)}${itemMetrics === null ? '' : itemMetricsText(itemMetrics)}`
  );
  for (const refusal of report.refused) await stderr(`${refusalLine(refusal)}\n`);
  for (const failure of itemMetrics?.errors ?? [])
    await stderr(`error: item metrics of ${failure.pack} (${failure.source}): ${failure.error}\n`);
  return report.refused.length > 0 ? EXIT.refused : EXIT.ok;
}

async function queryReport(
  host: MetricsHost,
  name: string | undefined,
  options: MetricsCommandOptions,
  now: Date | undefined
): Promise<{ report: MetricsReport; project: MetricsProject | null }> {
  const window = resolveMetricsWindow(options, now);
  const project =
    options.project === undefined ? null : await resolveProject(host, options.project);
  const report = await queryMetrics(host.deps.store, {
    ...window,
    ...(name === undefined ? {} : { name }),
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    ...resolveMetricsSplit(options),
    ...(project === null ? {} : { codebaseId: project.codebaseId }),
  });
  return { report, project };
}

/** Null on the file store, which keeps no items; that is said on stderr, not left silent. */
async function projectItemMetrics(
  host: MetricsHost,
  project: MetricsProject,
  name: string | undefined,
  window: MetricsReport['window'],
  io: { sourceRoots?: LiveWorkflowSourceRoots },
  stderr: typeof writeStderr
): Promise<ItemMetricsReport | null> {
  const roots =
    io.sourceRoots ??
    liveSourceRoots(project.cwd, workflowSourceConfigFrom(await host.deps.loadConfig(project.cwd)));
  try {
    return await reportItemMetrics(
      attentionQueueSource(host.deps.store, host.records.isolation),
      roots,
      project.key,
      window,
      name === undefined ? {} : { name }
    );
  } catch (error) {
    if (!(error instanceof FileStoreUnsupportedError)) throw error;
    await stderr(`note: item metrics left out: ${error.message}\n`);
    return null;
  }
}
