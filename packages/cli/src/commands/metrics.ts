import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { resolveAttentionProject } from '@archon/core/operations/attention-queue';
import { MetricsWindowError, queryMetrics, resolveMetricsWindow } from '@archon/workflows/metrics';
import type {
  MetricInstrumentReport,
  MetricRefusal,
  MetricReport,
  MetricsReport,
} from '@archon/workflows/schemas/metric';
import { writeStderr, writeStdout } from '../utils/stdout';

export interface MetricsCommandOptions {
  since?: string;
  until?: string;
  subject?: string;
  /** A codebase id, name or project key, resolved as `workflow attention --project` does. */
  project?: string;
  json?: boolean;
}

// Scripts branch on these, never on message text.
const EXIT = { ok: 0, usage: 1, refused: 4 } as const;

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

function metricLines(metric: MetricReport): string[] {
  const headline = metric.instruments.find(i => i.instrument === metric.headline_instrument);
  const others = metric.instruments.filter(i => i !== headline);
  const figures = (entry: MetricInstrumentReport): string =>
    `value ${String(entry.value)}  n ${String(entry.n)}  ${latestText(entry.latest)}`;
  const instrument = (name: string | null): string => name ?? '(no instrument)';
  return [
    `${metric.name}  ${metric.kind}/${metric.unit}  ${headline ? figures(headline) : ''}${
      metric.headline_instrument === null ? '' : `  [${metric.headline_instrument}]`
    }`,
    ...others.map(entry => `  ${instrument(entry.instrument)}: ${figures(entry)}`),
  ];
}

function refusalLine(refusal: MetricRefusal): string {
  const where = `run ${refusal.run_id} node ${refusal.node_id}`;
  if (refusal.reason === 'invalid') {
    return `error: ${where} stored invalid metrics: ${refusal.errors.join('; ')}`;
  }
  const { definition, offered } = refusal;
  return `error: metric ${refusal.name} is ${definition.kind}/${definition.unit}; ${where} offered ${offered.kind}/${offered.unit}`;
}

function reportText(report: MetricsReport): string {
  const window = `${report.window.since} to ${report.window.until}`;
  if (report.metrics.length === 0) return `No metrics from ${window}.\n`;
  return `Metrics from ${window}:\n${report.metrics.flatMap(metricLines).join('\n')}\n`;
}

/**
 * `archon metrics [name]`: aggregate stored metric records over a window. Exits 4 when
 * any record was refused, so a script can tell a clean report from one with conflicts.
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
    const window = resolveMetricsWindow(options, io.now);
    report = await queryMetrics(host.deps.store, {
      ...window,
      ...(name === undefined ? {} : { name }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(options.project === undefined
        ? {}
        : { codebaseId: await resolveCodebaseId(host, options.project) }),
    });
  } catch (error) {
    if (!(error instanceof MetricsWindowError || error instanceof MetricsUsageError)) throw error;
    await stderr(`Error: ${error.message}\n`);
    return EXIT.usage;
  }

  // Same document form as writeJsonLine, through the injectable stdout.
  await stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : reportText(report));
  for (const refusal of report.refused) await stderr(`${refusalLine(refusal)}\n`);
  return report.refused.length > 0 ? EXIT.refused : EXIT.ok;
}
