import { COST_TOLERANCE_USD } from './dag/usage';
import {
  countedUsage,
  type DagUsageFold,
  type DagUsageObservation,
  type UsageContribution,
} from './dag-usage-fold';
import { parseRunUsage, hasUnknownTokenTotal, type RunUsageFigures } from './schemas/run-usage';
import { runGraphSchema, RUN_GRAPH_METADATA_KEY } from './schemas/terminal-record';
import {
  USAGE_METRICS,
  usageNodeIdentitySchema,
  type MetricCoverage,
  type RunUsageReport,
  type UsageCoverage,
  type UsageLimitation,
  type UsageMetric,
  type UsageNodeIdentity,
  type UsageTotals,
} from './schemas/run-usage-report';
import type { WorkflowRun } from './schemas/workflow-run';
import { DEFERRED_NODE_USAGE_EVENT_TYPE } from './node-record-serialization';

type ReportRun = Pick<WorkflowRun, 'id' | 'metadata'>;
export type ChildUsageReport =
  | { report: RunUsageReport }
  | { reason: 'child_unavailable' | 'child_cycle' };

export function validUsageAmount(metric: UsageMetric, value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (metric === 'usd' || Number.isInteger(value))
  );
}

export function usageAmountsAgree(
  metric: UsageMetric,
  left: number | null | undefined,
  right: number | null | undefined
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return metric === 'usd' ? Math.abs(left - right) <= COST_TOLERANCE_USD : left === right;
}

export function usageFiguresTotals(usage: RunUsageFigures): UsageTotals {
  return {
    usd: usage.costUsd ?? null,
    inputTokens: usage.tokens?.input ?? null,
    outputTokens: usage.tokens?.output ?? null,
  };
}

function storedTotals(run: ReportRun): UsageTotals {
  const unknown = hasUnknownTokenTotal(run.metadata);
  const values = {
    usd: run.metadata.total_cost_usd,
    inputTokens: unknown ? undefined : run.metadata.total_tokens_in,
    outputTokens: unknown ? undefined : run.metadata.total_tokens_out,
  };
  return {
    usd: validUsageAmount('usd', values.usd) ? values.usd : null,
    inputTokens: validUsageAmount('inputTokens', values.inputTokens) ? values.inputTokens : null,
    outputTokens: validUsageAmount('outputTokens', values.outputTokens)
      ? values.outputTokens
      : null,
  };
}

function totalLimitation(
  run: ReportRun,
  metric: UsageMetric,
  total: number | null
): UsageLimitation[] {
  if (validUsageAmount(metric, total)) return [];
  const fields = {
    usd: 'total_cost_usd',
    inputTokens: 'total_tokens_in',
    outputTokens: 'total_tokens_out',
  } as const;
  const raw = run.metadata[fields[metric]];
  const invalid = raw != null && !validUsageAmount(metric, raw);
  return [{ runId: run.id, reason: invalid ? 'total_invalid' : 'total_unavailable' }];
}

export function unknownRunUsageReport(
  run: ReportRun,
  reason: UsageLimitation['reason']
): RunUsageReport {
  const totals = storedTotals(run);
  const metric = (key: UsageMetric): MetricCoverage => ({
    state: 'unknown',
    aiNodes: null,
    observedAiNodes: 0,
    contributedAiNodes: 0,
    contributors: [],
    recordedNodes: [],
    gaps: [],
    partial: [],
    limitations: [{ runId: run.id, reason }, ...totalLimitation(run, key, totals[key])],
  });
  return {
    totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
      excluded: [],
    },
  };
}

function identity(runId: string, observation: DagUsageObservation): UsageNodeIdentity {
  return usageNodeIdentitySchema.parse({ runId, ...observation });
}

export function uniqueUsageNodes(nodes: readonly UsageNodeIdentity[]): UsageNodeIdentity[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    const key = JSON.stringify([node.runId, node.path]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function aiObservation(
  observation: DagUsageObservation,
  history: readonly DagUsageObservation[] = []
): boolean {
  return (
    observation.nodeKind === 'agent' ||
    (observation.nodeKind === 'loop' &&
      (observation.provider !== undefined ||
        history.some(
          prior =>
            prior.path === observation.path &&
            prior.nodeKind === 'loop' &&
            prior.provider !== undefined
        )))
  );
}

function exclusion(
  observation: DagUsageObservation
): UsageCoverage['excluded'][number]['reason'] | undefined {
  if (observation.eventType === 'node_skipped') return 'skipped';
  if (observation.eventType === 'node_skipped_prior_success') return 'replayed';
  const spend = observation.measurement;
  if (
    spend?.tokens.source === 'unavailable' &&
    spend.tokens.reason === 'not_applicable' &&
    spend.costUsd.source === 'unavailable' &&
    spend.costUsd.reason === 'not_applicable'
  )
    return 'not_applicable';
  return undefined;
}

function skippedAfterExecution(fold: DagUsageFold, observation: DagUsageObservation): boolean {
  return (
    observation.eventType === 'node_skipped' &&
    fold.observations.some(
      prior =>
        prior.path === observation.path &&
        prior.invocationId === observation.invocationId &&
        executedObservation(prior) &&
        exclusion(prior) === undefined
    )
  );
}

function excludedNodes(fold: DagUsageFold): UsageCoverage['excluded'] {
  return fold.observations.flatMap(observation => {
    const reason = exclusion(observation);
    if (
      !aiObservation(observation, fold.observations) ||
      skippedAfterExecution(fold, observation) ||
      reason === undefined ||
      observation.eventType === 'node_started'
    )
      return [];
    const measurement = observation.measurement;
    return [
      {
        ...identity(fold.runId, observation),
        reason,
        ...(observation.skipReason === undefined
          ? {}
          : { lifecycleReason: observation.skipReason }),
        ...(measurement?.tokens.source === 'unavailable'
          ? { tokensReason: measurement.tokens.reason }
          : {}),
        ...(measurement?.costUsd.source === 'unavailable'
          ? { costReason: measurement.costUsd.reason }
          : {}),
      },
    ];
  });
}

function executedObservation(observation: DagUsageObservation): boolean {
  return (
    observation.eventType === 'node_completed' ||
    observation.eventType === 'node_failed' ||
    observation.eventType === 'node_suspended' ||
    observation.eventType === DEFERRED_NODE_USAGE_EVENT_TYPE
  );
}

function consumedObservations(fold: DagUsageFold): DagUsageObservation[] {
  const selected = allContributions(fold.usageContributions)
    .map(contribution => contribution.evidence)
    .filter(observation => observation !== undefined);
  const observations = fold.observations.filter(observation => {
    if (
      !aiObservation(observation, fold.observations) ||
      exclusion(observation) !== undefined ||
      !executedObservation(observation)
    )
      return false;
    if (observation.accounting === 'aggregate' || observation.accounting === 'amendment')
      return false;
    return observation.nodeKind !== 'loop';
  });
  return [
    ...observations,
    ...selected.filter(
      observation =>
        observation.nodeKind === 'loop' &&
        aiObservation(observation, fold.observations) &&
        exclusion(observation) === undefined
    ),
  ];
}

function allContributions(contributions: readonly UsageContribution[]): UsageContribution[] {
  return contributions.flatMap(contribution => [
    contribution,
    ...allContributions(contribution.coveredContributions ?? []),
  ]);
}

function unfinishedObservations(fold: DagUsageFold): DagUsageObservation[] {
  return fold.observations.filter(
    start =>
      start.eventType === 'node_started' &&
      aiObservation(start, fold.observations) &&
      !fold.observations.some(
        end =>
          end.path === start.path &&
          (executedObservation(end) || end.eventType === 'node_skipped') &&
          (start.attemptId === undefined ||
            end.attemptId === start.attemptId ||
            (end.eventType === DEFERRED_NODE_USAGE_EVENT_TYPE &&
              end.invocationId === start.invocationId))
      )
  );
}

function populationLimitations(run: ReportRun, fold: DagUsageFold): UsageLimitation[] {
  const limitations: UsageLimitation[] = [];
  for (const observation of fold.observations) {
    if (
      observation.nodeKind === undefined ||
      (observation.nodeKind === 'loop' && !aiObservation(observation, fold.observations))
    )
      limitations.push({ runId: run.id, path: observation.path, reason: 'node_kind_unavailable' });
  }
  const graph = runGraphSchema.safeParse(run.metadata[RUN_GRAPH_METADATA_KEY]);
  if (graph.success)
    for (const path of graph.data.node_ids)
      if (
        !fold.observations.some(
          observation => observation.path === path && observation.nodeKind !== undefined
        )
      )
        limitations.push({ runId: run.id, path, reason: 'node_kind_unavailable' });
  if (fold.observations.length === 0 && !(graph.success && graph.data.node_ids.length === 0))
    limitations.push({ runId: run.id, reason: 'history_absent' });
  return limitations;
}

function measurementValue(
  observation: DagUsageObservation,
  metric: UsageMetric
): number | undefined {
  const measurement =
    metric === 'usd' ? observation.measurement?.costUsd : observation.measurement?.tokens;
  if (measurement?.source !== 'provider') return undefined;
  if (metric === 'usd' && typeof measurement.value === 'number') return measurement.value;
  if (typeof measurement.value !== 'number')
    return metric === 'inputTokens' ? measurement.value.input : measurement.value.output;
  return undefined;
}

function observationCoverage(
  runId: string,
  observations: readonly DagUsageObservation[],
  metric: UsageMetric
): Pick<MetricCoverage, 'recordedNodes' | 'gaps' | 'partial' | 'limitations'> {
  const result: Pick<MetricCoverage, 'recordedNodes' | 'gaps' | 'partial' | 'limitations'> = {
    recordedNodes: [],
    gaps: [],
    partial: [],
    limitations: [],
  };
  for (const observation of observations) {
    const node = identity(runId, observation);
    const measurement =
      metric === 'usd' ? observation.measurement?.costUsd : observation.measurement?.tokens;
    if (measurement === undefined) {
      result.gaps.push({ ...node, source: 'coverage', reason: 'measurement_source_absent' });
      result.limitations.push({ runId, path: node.path, reason: 'measurement_source_absent' });
    } else if (measurement.source === 'unavailable') {
      result.gaps.push({ ...node, source: 'node', reason: measurement.reason });
    } else if (!validUsageAmount(metric, measurementValue(observation, metric))) {
      result.gaps.push({ ...node, source: 'coverage', reason: 'record_unreadable' });
      result.limitations.push({ runId, path: node.path, reason: 'record_unreadable' });
    } else {
      result.recordedNodes.push(node);
      if ('partial' in measurement && measurement.partial === true)
        result.partial.push({ ...node, partial: true });
    }
  }
  return result;
}

function contributionAmount(
  contribution: UsageContribution,
  metric: UsageMetric
): number | undefined {
  if (metric === 'usd') return contribution.costUsd;
  if (contribution.tokensUnknown) return undefined;
  return metric === 'inputTokens' ? contribution.tokens?.input : contribution.tokens?.output;
}

function sumContributions(
  contributions: readonly UsageContribution[],
  metric: UsageMetric
): number | undefined {
  if (metric !== 'usd' && contributions.some(contribution => contribution.tokensUnknown))
    return undefined;
  const values = contributions.flatMap(contribution => {
    const amount = contributionAmount(contribution, metric);
    return amount === undefined ? [] : [amount];
  });
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

function attributedContributors(
  runId: string,
  contributions: readonly UsageContribution[],
  metric: UsageMetric,
  limitations: UsageLimitation[],
  history: readonly DagUsageObservation[]
): UsageNodeIdentity[] {
  return contributions.flatMap(contribution => {
    const evidence = contribution.evidence;
    if (contribution.coveredContributions !== undefined) {
      if (
        !usageAmountsAgree(
          metric,
          contributionAmount(contribution, metric),
          sumContributions(contribution.coveredContributions, metric)
        )
      ) {
        limitations.push({ runId, path: contribution.stepName, reason: 'scope_unattributed' });
        return [];
      }
      return attributedContributors(
        runId,
        contribution.coveredContributions,
        metric,
        limitations,
        history
      );
    }
    if (evidence !== undefined && aiObservation(evidence, history)) {
      return validUsageAmount(metric, contributionAmount(contribution, metric)) &&
        validUsageAmount(metric, measurementValue(evidence, metric))
        ? [identity(runId, evidence)]
        : [];
    }
    if (evidence?.nodeKind !== 'workflow' && contributionAmount(contribution, metric) !== undefined)
      limitations.push({ runId, path: contribution.stepName, reason: 'scope_unattributed' });
    return [];
  });
}

function contradictoryTerminals(fold: DagUsageFold): UsageLimitation[] {
  const seen = new Map<string, DagUsageObservation>();
  const limitations: UsageLimitation[] = [];
  for (const observation of fold.observations) {
    if (
      !observation.attemptId ||
      !executedObservation(observation) ||
      observation.eventType === 'node_suspended'
    )
      continue;
    const key = JSON.stringify([observation.path, observation.attemptId]);
    const previous = seen.get(key);
    if (
      previous !== undefined &&
      JSON.stringify(previous.measurement) !== JSON.stringify(observation.measurement)
    )
      limitations.push({ runId: fold.runId, path: observation.path, reason: 'record_unreadable' });
    seen.set(key, observation);
  }
  return limitations;
}

function coverageState(
  total: number | null,
  population: number | null,
  contributors: readonly UsageNodeIdentity[],
  gaps: MetricCoverage['gaps'],
  partial: MetricCoverage['partial'],
  limitations: readonly UsageLimitation[]
): MetricCoverage['state'] {
  if (population === 0 && limitations.length === 0 && gaps.length === 0) return 'not_applicable';
  if (total === null || contributors.length === 0) return 'unknown';
  if (
    population !== null &&
    gaps.length === 0 &&
    partial.length === 0 &&
    limitations.length === 0 &&
    contributors.length === population
  )
    return 'complete';
  return 'partial';
}

function hasUnknownPopulation(limitations: readonly UsageLimitation[]): boolean {
  return limitations.some(
    limitation =>
      limitation.reason !== 'total_unavailable' &&
      limitation.reason !== 'total_invalid' &&
      limitation.reason !== 'total_mismatch' &&
      limitation.reason !== 'unfinished_execution'
  );
}

function childMetricCoverage(
  fold: DagUsageFold,
  children: ReadonlyMap<string, ChildUsageReport>,
  metric: UsageMetric,
  opaquePaths: readonly string[] = []
): {
  reports: MetricCoverage[];
  limitations: UsageLimitation[];
  excluded: UsageCoverage['excluded'];
} {
  const result: {
    reports: MetricCoverage[];
    limitations: UsageLimitation[];
    excluded: UsageCoverage['excluded'];
  } = { reports: [], limitations: [], excluded: [] };
  for (const [childId, baseline] of fold.reportedChildUsage) {
    const child = children.get(childId);
    const path = fold.childUsagePaths.get(childId)?.values().next().value;
    if (child === undefined || 'reason' in child) {
      result.limitations.push({
        runId: childId,
        path,
        reason: child?.reason ?? 'child_unavailable',
      });
      continue;
    }
    const expected = usageFiguresTotals(baseline)[metric];
    const paths = [...(fold.childUsagePaths.get(childId) ?? [])];
    const opaque = opaquePaths.some(scope =>
      paths.some(path => path === scope || path.startsWith(`${scope}__`))
    );
    const matches = !opaque && usageAmountsAgree(metric, expected, child.report.totals[metric]);
    const coverage = child.report.coverage[metric];
    result.reports.push(
      matches ? coverage : { ...coverage, contributors: [], contributedAiNodes: 0 }
    );
    if (!matches && !opaque)
      result.limitations.push({ runId: childId, path, reason: 'child_usage_mismatch' });
    result.excluded.push(...child.report.coverage.excluded);
  }
  for (const path of fold.unattributedChildUsagePaths)
    result.limitations.push({ runId: fold.runId, path, reason: 'scope_unattributed' });
  return result;
}

function metricPopulationNodes(coverage: MetricCoverage): UsageNodeIdentity[] {
  return uniqueUsageNodes([
    ...coverage.recordedNodes,
    ...coverage.gaps,
    ...coverage.partial,
    ...coverage.contributors,
  ]);
}

function buildMetricCoverage(
  run: ReportRun,
  fold: DagUsageFold,
  totals: UsageTotals,
  metric: UsageMetric,
  children: ReadonlyMap<string, ChildUsageReport>,
  readLimitations: readonly UsageLimitation[]
): MetricCoverage {
  const observations = consumedObservations(fold);
  const evidence = observationCoverage(run.id, observations, metric);
  const unfinished = unfinishedObservations(fold);
  const child = childMetricCoverage(fold, children, metric);
  const limitations = [
    ...readLimitations,
    ...populationLimitations(run, fold),
    ...contradictoryTerminals(fold),
    ...evidence.limitations,
    ...child.limitations,
  ];
  let contributors = attributedContributors(
    run.id,
    fold.usageContributions,
    metric,
    limitations,
    fold.observations
  );
  const opaquePaths = limitations
    .filter(limitation => limitation.runId === run.id && limitation.reason === 'scope_unattributed')
    .flatMap(limitation => (limitation.path === undefined ? [] : [limitation.path]));
  const attributedChildren = childMetricCoverage(fold, children, metric, opaquePaths);
  contributors.push(...attributedChildren.reports.flatMap(report => report.contributors));
  const population = uniqueUsageNodes(
    [...observations, ...unfinished]
      .map(observation => identity(run.id, observation))
      .concat(child.reports.flatMap(metricPopulationNodes))
  );
  const gaps = [
    ...evidence.gaps,
    ...child.reports.flatMap(report => report.gaps),
    ...unfinished.map(observation => ({
      ...identity(run.id, observation),
      source: 'coverage' as const,
      reason: 'unfinished_execution' as const,
    })),
  ];
  limitations.push(...child.reports.flatMap(report => report.limitations));
  const aiNodes =
    hasUnknownPopulation(limitations) || child.reports.some(report => report.aiNodes === null)
      ? null
      : population.length;
  if (aiNodes !== 0) limitations.push(...totalLimitation(run, metric, totals[metric]));
  const selectedTotal = usageFiguresTotals(countedUsage(fold))[metric];
  if (
    totals[metric] !== null &&
    (fold.usageContributions.length > 0 || (totals[metric] !== 0 && aiNodes === 0)) &&
    !usageAmountsAgree(metric, totals[metric], selectedTotal)
  ) {
    limitations.push({ runId: run.id, reason: 'total_mismatch' });
    contributors = [];
  }
  if (totals[metric] === null) contributors = [];
  const uniqueContributors = uniqueUsageNodes(contributors);
  const partial = [...evidence.partial, ...child.reports.flatMap(report => report.partial)];
  const legacyRecorded = allContributions(fold.usageContributions).flatMap(contribution => {
    const observation = contribution.evidence;
    return observation !== undefined &&
      aiObservation(observation, fold.observations) &&
      observation.measurement === undefined &&
      validUsageAmount(metric, contributionAmount(contribution, metric))
      ? [identity(run.id, observation)]
      : [];
  });
  return {
    state: coverageState(totals[metric], aiNodes, uniqueContributors, gaps, partial, limitations),
    aiNodes,
    observedAiNodes: population.length,
    contributedAiNodes: uniqueContributors.length,
    contributors: uniqueContributors,
    recordedNodes: uniqueUsageNodes([
      ...evidence.recordedNodes,
      ...legacyRecorded,
      ...child.reports.flatMap(report => report.recordedNodes),
    ]),
    gaps,
    partial,
    limitations,
  };
}

export function buildRunUsageReport(
  run: ReportRun,
  fold: DagUsageFold,
  options: {
    children?: ReadonlyMap<string, ChildUsageReport>;
    limitations?: readonly UsageLimitation[];
  } = {}
): RunUsageReport {
  const totals = storedTotals(run);
  const children = options.children ?? new Map();
  const metric = (key: UsageMetric) =>
    buildMetricCoverage(run, fold, totals, key, children, options.limitations ?? []);
  return {
    totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
      excluded: [...excludedNodes(fold), ...childMetricCoverage(fold, children, 'usd').excluded],
    },
  };
}

export function itemRunUsageReport(run: ReportRun, report: RunUsageReport): RunUsageReport {
  const totals = usageFiguresTotals(parseRunUsage(run.metadata));
  const metric = (key: UsageMetric): MetricCoverage => {
    const coverage = report.coverage[key];
    if (validUsageAmount(key, totals[key])) return coverage;
    if (coverage.state === 'not_applicable') return coverage;
    return {
      ...coverage,
      state: 'unknown',
      contributors: [],
      contributedAiNodes: 0,
      limitations: coverage.limitations.some(
        limitation =>
          limitation.runId === run.id &&
          (limitation.reason === 'total_invalid' || limitation.reason === 'total_unavailable')
      )
        ? coverage.limitations
        : [...coverage.limitations, ...totalLimitation(run, key, totals[key])],
    };
  };
  return {
    totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
      excluded: report.coverage.excluded,
    },
  };
}

function aggregateMetric(
  reports: readonly RunUsageReport[],
  metric: UsageMetric,
  total: number | null,
  missingRunIds: readonly string[]
): MetricCoverage {
  const members = reports.map(report => report.coverage[metric]);
  const limitations = [
    ...members.flatMap(member => member.limitations),
    ...missingRunIds.map(runId => ({ runId, reason: 'history_unavailable' as const })),
  ];
  const population = uniqueUsageNodes(members.flatMap(metricPopulationNodes));
  const known = missingRunIds.length === 0 && members.every(member => member.aiNodes !== null);
  const aiNodes = known ? population.length : null;
  const contributors =
    total === null ? [] : uniqueUsageNodes(members.flatMap(member => member.contributors));
  const gaps = members.flatMap(member => member.gaps);
  const partial = members.flatMap(member => member.partial);
  return {
    state: coverageState(total, aiNodes, contributors, gaps, partial, limitations),
    aiNodes,
    observedAiNodes: population.length,
    contributedAiNodes: contributors.length,
    contributors,
    recordedNodes: uniqueUsageNodes(members.flatMap(member => member.recordedNodes)),
    gaps,
    partial,
    limitations,
  };
}

export function aggregateUsageReports(
  reports: readonly RunUsageReport[],
  options: { missingRunIds?: readonly string[]; unknownTokens?: boolean } = {}
): RunUsageReport {
  const amount = (metric: UsageMetric): number | null => {
    if (metric !== 'usd' && options.unknownTokens) return null;
    const values = reports.flatMap(report =>
      validUsageAmount(metric, report.totals[metric]) ? [report.totals[metric]] : []
    );
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
  };
  const totals = {
    usd: amount('usd'),
    inputTokens: amount('inputTokens'),
    outputTokens: amount('outputTokens'),
  };
  const metric = (key: UsageMetric) =>
    aggregateMetric(reports, key, totals[key], options.missingRunIds ?? []);
  return {
    totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
      excluded: reports.flatMap(report => report.coverage.excluded),
    },
  };
}

function formattedAmount(metric: UsageMetric, amount: number | null): string {
  if (!validUsageAmount(metric, amount)) return 'unknown';
  return metric === 'usd'
    ? `$${amount.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 12 })}`
    : String(amount);
}

function coverageText(coverage: MetricCoverage): string {
  const count = `${String(coverage.contributedAiNodes)}/${coverage.aiNodes === null ? '?' : String(coverage.aiNodes)} AI nodes`;
  if (coverage.state === 'complete') return `${count}; all executed AI nodes recorded this metric`;
  if (coverage.state === 'not_applicable') return `${count}; no executed AI nodes`;
  return `${count}; ${coverage.state}`;
}

export function formatUsageReport(report: RunUsageReport): string[] {
  const labels = {
    usd: 'Cost',
    inputTokens: 'Input tokens',
    outputTokens: 'Output tokens',
  } as const;
  const lines = ['  Usage (recorded totals):'];
  for (const metric of USAGE_METRICS) {
    const coverage = report.coverage[metric];
    lines.push(
      `    ${labels[metric]}: ${formattedAmount(metric, report.totals[metric])} (${coverageText(coverage)})`
    );
    for (const gap of coverage.gaps)
      lines.push(
        `      ${gap.runId}/${gap.path}${gap.attemptId ? ` (attempt ${gap.attemptId})` : ''}: ${gap.source} ${gap.reason}`
      );
    for (const partial of coverage.partial)
      lines.push(`      ${partial.runId}/${partial.path}: recorded partial measurement`);
    for (const limitation of coverage.limitations)
      lines.push(
        `      ${limitation.runId}${limitation.path === undefined ? '' : `/${limitation.path}`}: coverage ${limitation.reason}`
      );
  }
  for (const excluded of report.coverage.excluded)
    lines.push(
      `    Excluded ${excluded.runId}/${excluded.path}: ${excluded.lifecycleReason ?? excluded.reason}`
    );
  return lines;
}
