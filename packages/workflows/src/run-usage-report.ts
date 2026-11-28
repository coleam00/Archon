import { COST_TOLERANCE_USD } from './dag/usage';
import {
  countedUsage,
  type DagUsageFold,
  type DagUsageObservation,
  type UsageContribution,
} from './dag-usage-fold';
import { parseRunUsage, runUsageTotalFields, type RunUsageFigures } from './schemas/run-usage';
import { runGraphSchema, RUN_GRAPH_METADATA_KEY } from './schemas/terminal-record';
import {
  usageNodeIdentitySchema,
  type MetricCoverage,
  type RunUsageReport,
  type UsageGap,
  type UnavailableMeasurementReason,
  type UsageLimitation,
  type UsageMetric,
  type UsageNodeIdentity,
  type UsageTotals,
} from './schemas/run-usage-report';
import type { WorkflowRun } from './schemas/workflow-run';
import { DEFERRED_NODE_USAGE_EVENT_TYPE } from './node-record-serialization';

type ReportRun = Pick<WorkflowRun, 'id' | 'metadata'>;

/** A node the fold saw and what it recorded, before the report reduces it to a gap. */
interface EvidenceGap {
  node: UsageNodeIdentity;
  reason: UnavailableMeasurementReason | UsageLimitation['reason'];
}

/**
 * Everything the fold says about one metric. The report reduces this to a `MetricCoverage`:
 * counts and gaps, without the nodes that were fine.
 */
interface MetricEvidence {
  state: MetricCoverage['state'];
  /** The executed AI nodes that should have recorded the metric; null when unknown. */
  aiNodes: number | null;
  /** The nodes the count is over: what the run itself saw, and what its children counted. */
  population: UsageNodeIdentity[];
  contributors: UsageNodeIdentity[];
  recordedNodes: UsageNodeIdentity[];
  gaps: EvidenceGap[];
  /** Nodes whose recorded figure is a floor. */
  partial: UsageNodeIdentity[];
  limitations: UsageLimitation[];
}
export type ChildUsageReport =
  | { evidence: UsageEvidence }
  | { reason: 'child_unavailable' | 'child_cycle' };

export function validUsageAmount(metric: UsageMetric, value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (metric === 'usd' || Number.isInteger(value))
  );
}

function usageAmountsAgree(
  metric: UsageMetric,
  left: number | null | undefined,
  right: number | null | undefined
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return metric === 'usd' ? Math.abs(left - right) <= COST_TOLERANCE_USD : left === right;
}

function usageFiguresTotals(usage: RunUsageFigures): UsageTotals {
  return {
    usd: usage.costUsd ?? null,
    inputTokens: usage.tokens?.input ?? null,
    outputTokens: usage.tokens?.output ?? null,
  };
}

function storedTotals(run: ReportRun): UsageTotals {
  const usage = parseRunUsage(run.metadata, { partialTokens: true });
  return {
    usd: validUsageAmount('usd', usage.costUsd) ? usage.costUsd : null,
    inputTokens: validUsageAmount('inputTokens', usage.tokens?.input) ? usage.tokens.input : null,
    outputTokens: validUsageAmount('outputTokens', usage.tokens?.output)
      ? usage.tokens.output
      : null,
  };
}

function totalLimitation(
  run: ReportRun,
  metric: UsageMetric,
  total: number | null
): UsageLimitation[] {
  if (validUsageAmount(metric, total)) return [];
  const raw = run.metadata[runUsageTotalFields[metric]];
  const invalid = raw != null && !validUsageAmount(metric, raw);
  return [{ runId: run.id, reason: invalid ? 'total_invalid' : 'total_unavailable' }];
}

function identity(runId: string, observation: DagUsageObservation): UsageNodeIdentity {
  return usageNodeIdentitySchema.parse({ runId, ...observation });
}

function uniqueUsageNodes(nodes: readonly UsageNodeIdentity[]): UsageNodeIdentity[] {
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
): 'skipped' | 'replayed' | 'not_applicable' | undefined {
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

/**
 * AI starts that no later end closes. An end counts only when it was recorded after the
 * start: rows without attempt ids share a path across reruns, and an earlier completion
 * must not close a later start. Recording only the latest matching end index per key keeps
 * matching linear even when one path has thousands of alternating starts and ends.
 */
function unfinishedObservations(fold: DagUsageFold): DagUsageObservation[] {
  const lastDeferredByPathAndInvocation = new Map<string, number>();
  const lastNonDeferredByPath = new Map<string, number>();
  const lastNonDeferredByPathAndAttempt = new Map<string, number>();
  fold.observations.forEach((end, at) => {
    if (!executedObservation(end) && end.eventType !== 'node_skipped') return;
    if (end.eventType === DEFERRED_NODE_USAGE_EVENT_TYPE) {
      lastDeferredByPathAndInvocation.set(JSON.stringify([end.path, end.invocationId ?? null]), at);
      return;
    }
    lastNonDeferredByPath.set(end.path, at);
    if (end.attemptId !== undefined)
      lastNonDeferredByPathAndAttempt.set(JSON.stringify([end.path, end.attemptId]), at);
  });
  const closedAfter = (start: DagUsageObservation, startAt: number): boolean => {
    const deferredAt = lastDeferredByPathAndInvocation.get(
      JSON.stringify([start.path, start.invocationId ?? null])
    );
    if (deferredAt !== undefined && deferredAt > startAt) return true;
    const endAt =
      start.attemptId === undefined
        ? lastNonDeferredByPath.get(start.path)
        : lastNonDeferredByPathAndAttempt.get(JSON.stringify([start.path, start.attemptId]));
    return endAt !== undefined && endAt > startAt;
  };
  return fold.observations.filter(
    (start, startAt) =>
      start.eventType === 'node_started' &&
      aiObservation(start, fold.observations) &&
      !closedAfter(start, startAt)
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
  if (graph.success) {
    const known = new Set(
      fold.observations.flatMap(observation =>
        observation.nodeKind === undefined ? [] : [observation.path]
      )
    );
    for (const path of graph.data.node_ids)
      if (!known.has(path))
        limitations.push({ runId: run.id, path, reason: 'node_kind_unavailable' });
  }
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
): Pick<MetricEvidence, 'recordedNodes' | 'gaps' | 'partial' | 'limitations'> {
  const result: Pick<MetricEvidence, 'recordedNodes' | 'gaps' | 'partial' | 'limitations'> = {
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
      result.gaps.push({ node, reason: 'measurement_source_absent' });
      result.limitations.push({ runId, path: node.path, reason: 'measurement_source_absent' });
    } else if (measurement.source === 'unavailable') {
      result.gaps.push({ node, reason: measurement.reason });
    } else if (!validUsageAmount(metric, measurementValue(observation, metric))) {
      result.gaps.push({ node, reason: 'record_unreadable' });
      result.limitations.push({ runId, path: node.path, reason: 'record_unreadable' });
    } else {
      result.recordedNodes.push(node);
      if ('partial' in measurement && measurement.partial === true) result.partial.push(node);
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

function attributeAiContribution(
  runId: string,
  contribution: UsageContribution,
  evidence: DagUsageObservation,
  metric: UsageMetric,
  limitations: UsageLimitation[]
): UsageNodeIdentity[] {
  const amount = contributionAmount(contribution, metric);
  const typed = measurementValue(evidence, metric);
  if (amount !== undefined && !validUsageAmount(metric, amount)) {
    limitations.push({ runId, path: contribution.stepName, reason: 'record_unreadable' });
    return [];
  }
  if (!validUsageAmount(metric, amount) || !validUsageAmount(metric, typed)) return [];
  // The row's usage figure and its typed spend record one measurement twice. When they
  // disagree the row does not say which figure is right, so neither is certified.
  if (usageAmountsAgree(metric, amount, typed)) return [identity(runId, evidence)];
  limitations.push({ runId, path: contribution.stepName, reason: 'record_unreadable' });
  return [];
}

function attributedContributors(
  runId: string,
  contributions: readonly UsageContribution[],
  metric: UsageMetric,
  limitations: UsageLimitation[],
  history: readonly DagUsageObservation[],
  reconciled: Set<string>
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
      for (const covered of contribution.coveredContributions) reconciled.add(covered.stepName);
      return attributedContributors(
        runId,
        contribution.coveredContributions,
        metric,
        limitations,
        history,
        reconciled
      );
    }
    if (evidence !== undefined && aiObservation(evidence, history))
      return attributeAiContribution(runId, contribution, evidence, metric, limitations);
    if (evidence?.nodeKind !== 'workflow' && contributionAmount(contribution, metric) !== undefined)
      limitations.push({ runId, path: contribution.stepName, reason: 'scope_unattributed' });
    return [];
  });
}

function metricRecord(observation: DagUsageObservation, metric: UsageMetric): string {
  const measurement = observation.measurement;
  if (measurement === undefined) return '';
  // Only the source and this metric's own figure. A partial-cost or partial-cache flag
  // says the figure is a floor; it does not make two equal figures contradict each other.
  if (metric === 'usd')
    return JSON.stringify([
      measurement.costUsd.source,
      measurement.costUsd.source === 'provider'
        ? measurement.costUsd.value
        : measurement.costUsd.reason,
    ]);
  const tokens = measurement.tokens;
  if (tokens.source !== 'provider') return JSON.stringify([tokens.source, tokens.reason]);
  return JSON.stringify([
    tokens.source,
    metric === 'inputTokens' ? tokens.value.input : tokens.value.output,
  ]);
}

function contradictoryTerminals(fold: DagUsageFold, metric: UsageMetric): UsageLimitation[] {
  const seen = new Map<string, string>();
  const limitations: UsageLimitation[] = [];
  for (const observation of fold.observations) {
    if (
      !observation.attemptId ||
      !executedObservation(observation) ||
      observation.eventType === 'node_suspended' ||
      // An amendment restates an attempt's accounting without measuring it again.
      observation.accounting === 'amendment'
    )
      continue;
    const key = JSON.stringify([observation.path, observation.attemptId]);
    const record = metricRecord(observation, metric);
    const previous = seen.get(key);
    if (previous !== undefined && previous !== record)
      limitations.push({ runId: fold.runId, path: observation.path, reason: 'record_unreadable' });
    seen.set(key, record);
  }
  return limitations;
}

function coverageState(
  total: number | null,
  population: number | null,
  contributors: readonly UsageNodeIdentity[],
  gaps: readonly EvidenceGap[],
  partial: readonly UsageNodeIdentity[],
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
      limitation.reason !== 'unfinished_execution' &&
      // The node is known to have executed; only where its figure came from is not.
      limitation.reason !== 'measurement_source_absent'
  );
}

function childMetricCoverage(
  fold: DagUsageFold,
  children: ReadonlyMap<string, ChildUsageReport>,
  metric: UsageMetric,
  opaqueChildren: ReadonlySet<string> = new Set()
): { reports: MetricEvidence[]; limitations: UsageLimitation[] } {
  const result: Pick<MetricEvidence, 'recordedNodes' | 'limitations'> & {
    reports: MetricEvidence[];
  } = { reports: [], limitations: [], recordedNodes: [] };
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
    const opaque = opaqueChildren.has(childId);
    const matches = usageAmountsAgree(metric, expected, child.evidence.totals[metric]);
    const coverage = child.evidence.coverage[metric];
    result.reports.push(matches && !opaque ? coverage : { ...coverage, contributors: [] });
    if (!matches && !opaque)
      result.limitations.push({
        runId: childId,
        path,
        reason: 'child_usage_mismatch',
      });
  }
  for (const path of fold.unattributedChildUsagePaths)
    result.limitations.push({ runId: fold.runId, path, reason: 'scope_unattributed' });
  return result;
}

function wrapperPartial(
  runId: string,
  fold: DagUsageFold,
  metric: UsageMetric,
  partial: UsageNodeIdentity[]
): UsageNodeIdentity[] {
  if (metric !== 'usd') return partial;
  const next = [...partial];
  for (const contribution of allContributions(fold.usageContributions)) {
    if (contribution.costPartial !== true || contribution.evidence === undefined) continue;
    const node = identity(runId, contribution.evidence);
    if (next.some(item => sameNode(item, node))) continue;
    next.push(node);
  }
  return next;
}

function sameNode(left: UsageNodeIdentity, right: UsageNodeIdentity): boolean {
  return (
    left.runId === right.runId &&
    left.path === right.path &&
    left.invocationId === right.invocationId &&
    left.attemptId === right.attemptId
  );
}

function buildMetricEvidence(
  run: ReportRun,
  fold: DagUsageFold,
  totals: UsageTotals,
  metric: UsageMetric,
  children: ReadonlyMap<string, ChildUsageReport>,
  readLimitations: readonly UsageLimitation[],
  unfinished: readonly DagUsageObservation[]
): MetricEvidence {
  const observations = consumedObservations(fold);
  const evidence = observationCoverage(run.id, observations, metric);
  const child = childMetricCoverage(fold, children, metric);
  const limitations: UsageLimitation[] = [
    ...readLimitations,
    ...populationLimitations(run, fold),
    ...contradictoryTerminals(fold, metric),
    ...evidence.limitations,
    ...child.limitations,
  ];
  const reconciled = new Set<string>();
  let contributors = attributedContributors(
    run.id,
    fold.usageContributions,
    metric,
    limitations,
    fold.observations,
    reconciled
  );
  // The fold marks a child opaque when an instance terminal replaces the segment that
  // reported it, before it can know whether the terminal's amount agrees with what it covered.
  // A child under a terminal that agrees still has its own evidence describing that amount.
  const opaque = new Set(
    [...fold.opaqueChildUsagePaths]
      .filter(([, paths]) => ![...paths].every(path => reconciled.has(path)))
      .map(([childId]) => childId)
  );
  const attributedChildren = childMetricCoverage(fold, children, metric, opaque);
  contributors.push(...attributedChildren.reports.flatMap(report => report.contributors));
  const population = uniqueUsageNodes(
    [...observations, ...unfinished].map(observation => identity(run.id, observation))
  );
  population.push(...child.reports.flatMap(report => report.population));
  const gaps: EvidenceGap[] = [
    ...evidence.gaps,
    ...child.reports.flatMap(report => report.gaps),
    ...unfinished.map(observation => ({
      node: identity(run.id, observation),
      reason: 'unfinished_execution' as const,
    })),
  ];
  limitations.push(...child.reports.flatMap(report => report.limitations));
  // A row the reader could not decode may be any node, so it leaves the population unknown. An
  // unreadable or contradicted figure on a node the fold already counted hides no node.
  const aiNodes =
    readLimitations.some(limitation => limitation.reason === 'record_unreadable') ||
    hasUnknownPopulation(
      limitations.filter(limitation => limitation.reason !== 'record_unreadable')
    ) ||
    child.reports.some(report => report.aiNodes === null)
      ? null
      : population.length;
  const totalLimitations = totalLimitation(run, metric, totals[metric]);
  limitations.push(
    ...(aiNodes === 0
      ? totalLimitations.filter(limitation => limitation.reason === 'total_invalid')
      : totalLimitations)
  );
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
  const partial = wrapperPartial(run.id, fold, metric, [
    ...evidence.partial,
    ...child.reports.flatMap(report => report.partial),
  ]);
  const legacyRecorded = allContributions(fold.usageContributions).flatMap(contribution => {
    const observation = contribution.evidence;
    return observation !== undefined &&
      aiObservation(observation, fold.observations) &&
      observation.measurement === undefined &&
      validUsageAmount(metric, contributionAmount(contribution, metric))
      ? [identity(run.id, observation)]
      : [];
  });
  const recordedNodes = uniqueUsageNodes([
    ...evidence.recordedNodes,
    ...legacyRecorded,
    ...child.reports.flatMap(report => report.recordedNodes),
  ]);
  return {
    state: coverageState(totals[metric], aiNodes, uniqueContributors, gaps, partial, limitations),
    aiNodes,
    population,
    contributors: uniqueContributors,
    recordedNodes,
    gaps,
    partial,
    limitations,
  };
}

/** A run's usage evidence, before it is reduced to the report a reader sees. */
export interface UsageEvidence {
  runId: string;
  totals: UsageTotals;
  coverage: Record<UsageMetric, MetricEvidence>;
}

export function unknownRunUsageEvidence(
  run: ReportRun,
  reason: UsageLimitation['reason']
): UsageEvidence {
  const totals = storedTotals(run);
  const metric = (key: UsageMetric): MetricEvidence => ({
    state: 'unknown',
    aiNodes: null,
    population: [],
    contributors: [],
    recordedNodes: [],
    gaps: [],
    partial: [],
    limitations: [{ runId: run.id, reason }, ...totalLimitation(run, key, totals[key])],
  });
  return {
    runId: run.id,
    totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
    },
  };
}

/**
 * Folds the run's rows, with its children's evidence, into what each metric can say. A parent
 * keeps a child's contributors only when the child's own total agrees with the baseline the
 * parent recorded for it.
 */
export function collectRunUsageEvidence(
  run: ReportRun,
  fold: DagUsageFold,
  options: {
    children?: ReadonlyMap<string, ChildUsageReport>;
    limitations?: readonly UsageLimitation[];
  } = {}
): UsageEvidence {
  const totals = storedTotals(run);
  const children = options.children ?? new Map();
  // The same for every metric, so read once rather than once per metric.
  const unfinished = unfinishedObservations(fold);
  const metric = (key: UsageMetric): MetricEvidence =>
    buildMetricEvidence(run, fold, totals, key, children, options.limitations ?? [], unfinished);
  return {
    runId: run.id,
    totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
    },
  };
}

/**
 * Reduces one metric's evidence to what a reader needs: the state, how many executed AI
 * nodes should have recorded the metric and how many did, and the gaps. A node appears once
 * per reason, not once per row that mentioned it. A partial measurement is only a gap when
 * nothing else explains the node: it says why the figure is a floor, and a node with no
 * figure has a more specific reason already.
 */
function reportedCoverage(runId: string, evidence: MetricEvidence): MetricCoverage {
  const recorded = new Set([...evidence.recordedNodes, ...evidence.contributors].map(nodeKey));
  const populationKeys = new Set(evidence.population.map(nodeKey));
  const gaps: UsageGap[] = [];
  const seen = new Set<string>();
  const addGap = (gap: UsageGap, onlyIfNewNode = false): void => {
    const key = JSON.stringify([gap.runId ?? '', gap.path ?? null, gap.reason]);
    if (seen.has(key)) return;
    if (onlyIfNewNode && gaps.some(item => item.path === gap.path && item.runId === gap.runId))
      return;
    seen.add(key);
    gaps.push(gap);
  };
  // The report's own run is known to the reader, so its gaps carry no run id.
  const childRunId = (nodeRunId: string | undefined): string | undefined =>
    nodeRunId === undefined || nodeRunId === runId ? undefined : nodeRunId;
  const inRun = (nodeRunId: string | undefined): { runId?: string } => {
    const id = childRunId(nodeRunId);
    return id === undefined ? {} : { runId: id };
  };
  // Limitations are added to the gaps after the partial nodes, so a node one of them already
  // explains is looked up in the evidence here.
  const explained = (node: UsageNodeIdentity): boolean =>
    evidence.limitations.some(
      limitation =>
        limitation.path === node.path && childRunId(limitation.runId) === childRunId(node.runId)
    );
  for (const gap of evidence.gaps)
    addGap({ path: gap.node.path, reason: gap.reason, ...inRun(gap.node.runId) });
  for (const node of evidence.partial)
    if (!explained(node))
      addGap({ path: node.path, reason: 'partial_measurement', ...inRun(node.runId) }, true);
  for (const limitation of evidence.limitations)
    addGap({
      ...inRun(limitation.runId),
      reason: limitation.reason,
      ...(limitation.path === undefined ? {} : { path: limitation.path }),
    });
  return {
    state: evidence.state,
    // A node outside the counted population (an instance wrapper) can be recorded without
    // being one of the nodes the count is over.
    recordedNodes: [...recorded].filter(key => populationKeys.has(key)).length,
    expectedNodes: evidence.aiNodes,
    gaps,
  };
}

function nodeKey(node: UsageNodeIdentity): string {
  return JSON.stringify([node.runId, node.path]);
}

/** The reader's view of a run's usage: stored totals and what each metric can claim. */
export function toRunUsageReport(evidence: UsageEvidence): RunUsageReport {
  const metric = (key: UsageMetric): MetricCoverage =>
    reportedCoverage(evidence.runId, evidence.coverage[key]);
  return {
    totals: evidence.totals,
    coverage: {
      usd: metric('usd'),
      inputTokens: metric('inputTokens'),
      outputTokens: metric('outputTokens'),
    },
  };
}

export function unknownRunUsageReport(
  run: ReportRun,
  reason: UsageLimitation['reason']
): RunUsageReport {
  return toRunUsageReport(unknownRunUsageEvidence(run, reason));
}

export function buildRunUsageReport(
  run: ReportRun,
  fold: DagUsageFold,
  options: Parameters<typeof collectRunUsageEvidence>[2] = {}
): RunUsageReport {
  return toRunUsageReport(collectRunUsageEvidence(run, fold, options));
}
