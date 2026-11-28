import {
  USAGE_METRICS,
  type MetricCoverage,
  type RunUsageReport,
  type UsageCoverage,
  type UsageGapReason,
  type UsageMetric,
} from './schemas/run-usage-report';
import { validUsageAmount } from './run-usage-report';

function formattedAmount(metric: UsageMetric, amount: number | null): string {
  if (!validUsageAmount(metric, amount)) return 'unknown';
  return metric === 'usd'
    ? `$${amount.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 12 })}`
    : String(amount);
}

const METRIC_LABELS = {
  usd: 'cost',
  inputTokens: 'input tokens',
  outputTokens: 'output tokens',
} as const;

/** Reads after the metrics it belongs to, or on its own for a run-level gap. */
const GAP_TEXT: Record<UsageGapReason, string> = {
  unsupported: 'not recorded (unsupported)',
  not_reported: 'not reported',
  unknown: 'not recorded (reason unknown)',
  not_applicable: 'not applicable',
  invalid: 'recorded value is invalid',
  incomplete: 'recorded as incomplete',
  history_unavailable: 'run history could not be read',
  history_absent: 'no run history was recorded',
  record_unreadable: 'recorded usage does not read',
  measurement_source_absent: 'no measurement was recorded',
  node_kind_unavailable: 'node kind unknown, so it is not counted',
  unfinished_execution: 'execution has no recorded end',
  total_unavailable: 'total was not recorded',
  total_invalid: 'recorded total is invalid',
  total_mismatch: 'recorded total disagrees with the node records',
  scope_unattributed: 'usage cannot be attributed to one node',
  child_unavailable: 'child run could not be read',
  child_usage_mismatch: "child run's usage disagrees with the parent's record",
  child_cycle: 'child runs form a cycle',
  partial_measurement: 'recorded only as a floor',
};

function nodeCountText(coverage: MetricCoverage): string {
  return `${String(coverage.recordedNodes)}/${
    coverage.expectedNodes === null ? '?' : String(coverage.expectedNodes)
  } AI nodes`;
}

/** One line per node that is a gap, naming every metric it is a gap for. */
function nodeGapLines(coverage: UsageCoverage): string[] {
  const groups = new Map<
    string,
    { path: string; child: boolean; metrics: string[]; reason: UsageGapReason }
  >();
  for (const metric of USAGE_METRICS) {
    for (const gap of coverage[metric].gaps) {
      if (gap.path === undefined) continue;
      // A node can miss two metrics for two different reasons; those are two lines.
      const key = JSON.stringify([gap.runId ?? '', gap.path, gap.reason]);
      const group = groups.get(key) ?? {
        path: gap.path,
        child: gap.runId !== undefined,
        metrics: [],
        reason: gap.reason,
      };
      group.metrics.push(METRIC_LABELS[metric]);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(
    group =>
      `    ${group.path}${group.child ? ' (child run)' : ''}: ${joinLabels(group.metrics)} ${
        GAP_TEXT[group.reason]
      }`
  );
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** One line per distinct gap about a run rather than a node, after the node lines. */
function runGapLines(coverage: UsageCoverage): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const metric of USAGE_METRICS) {
    for (const gap of coverage[metric].gaps) {
      if (gap.path !== undefined) continue;
      const key = JSON.stringify([gap.runId ?? '', gap.reason]);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`    ${gap.runId === undefined ? '' : 'child run: '}${GAP_TEXT[gap.reason]}`);
    }
  }
  return lines;
}

/**
 * One line when every applicable metric is complete, and nothing when no AI node ran.
 * Otherwise each metric carries its state and counts, and one short line follows per gap.
 * No run, invocation or attempt id appears: the JSON report has them where they exist.
 */
export function formatUsageReport(report: RunUsageReport): string[] {
  const coverage = report.coverage;
  const applicable = USAGE_METRICS.filter(metric => coverage[metric].state !== 'not_applicable');
  if (applicable.length === 0) return [];
  const amounts = USAGE_METRICS.map(
    metric => `${METRIC_LABELS[metric]} ${formattedAmount(metric, report.totals[metric])}`
  );
  if (applicable.every(metric => coverage[metric].state === 'complete'))
    return [
      `  Usage: ${amounts.join(', ')}, recorded by all ${nodeCountText(
        coverage[applicable[0] ?? 'usd']
      )}.`,
    ];
  const parts = USAGE_METRICS.map((metric, index) => {
    const state = coverage[metric].state;
    if (state === 'not_applicable') return `${amounts[index]} (no AI nodes)`;
    return `${amounts[index]} (${state}; ${nodeCountText(coverage[metric])} recorded)`;
  });
  return [`  Usage: ${parts.join(', ')}.`, ...nodeGapLines(coverage), ...runGapLines(coverage)];
}
