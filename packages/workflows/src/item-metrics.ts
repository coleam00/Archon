/**
 * Evaluate the item metrics packs declare (`schemas/item-metric.ts`) over the window read
 * of a project's items. The semantics are fixed here; what a figure means is the pack's.
 */
import type { ItemRead, ItemRun } from './item-read';
import {
  ITEM_WINDOW_MAX_LIMIT,
  readItemWindow,
  type ItemWindowQuery,
  type ItemWindowSource,
} from './item-window';
import { discoverItemMetrics } from './metric-views';
import type {
  ItemMetricCondition,
  ItemMetricDefinition,
  ItemMetricFigures,
  ItemMetricResult,
  ItemMetricRunFilter,
  ItemMetricsReport,
  ItemMetricTimePoint,
} from './schemas/item-metric';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

const HOUR_MS = 3_600_000;

function runMatches(run: ItemRun, filter: ItemMetricRunFilter | undefined): boolean {
  if (filter === undefined) return true;
  return (
    (filter.workflow === undefined || filter.workflow.includes(run.workflow)) &&
    (filter.status === undefined || filter.status.includes(run.status)) &&
    (filter.outcome === undefined || (run.outcome !== null && filter.outcome.includes(run.outcome)))
  );
}

function itemMatches(read: ItemRead, condition: ItemMetricCondition | undefined): boolean {
  if (condition === undefined) return true;
  const last = read.runs.at(-1);
  return (
    (condition.merged === undefined || condition.merged === (read.merged !== null)) &&
    (condition.has_run === undefined ||
      read.runs.some(run => runMatches(run, condition.has_run))) &&
    (condition.last_run === undefined ||
      (last !== undefined && runMatches(last, condition.last_run)))
  );
}

function timeOf(read: ItemRead, point: ItemMetricTimePoint): number | null {
  if (point === 'merged') return read.merged === null ? null : Date.parse(read.merged.at);
  const runs = read.runs.filter(run => runMatches(run, point.of));
  const run = point.run === 'first' ? runs[0] : runs.at(-1);
  const at = point.at === 'started' ? run?.startedAt : run?.completedAt;
  return at === undefined || at === null ? null : Date.parse(at);
}

function perItemCount(
  read: ItemRead,
  definition: Extract<ItemMetricDefinition, { op: 'count' }>
): number {
  if (definition.of === 'runs')
    return read.runs.filter(run => runMatches(run, definition.runs)).length;
  return read.answers.filter(
    answer => definition.kinds === undefined || definition.kinds.includes(answer.kind)
  ).length;
}

const mean = (sum: number, n: number): number | null => (n === 0 ? null : sum / n);

function figures(definition: ItemMetricDefinition, population: ItemRead[]): ItemMetricFigures {
  if (definition.op === 'share') {
    const numerator = population.filter(read => itemMatches(read, definition.where)).length;
    return {
      op: 'share',
      value: mean(numerator, population.length),
      numerator,
      denominator: population.length,
    };
  }
  if (definition.op === 'count') {
    const total = population.reduce((sum, read) => sum + perItemCount(read, definition), 0);
    return { op: 'count', value: mean(total, population.length), total, n: population.length };
  }
  const hours = population.flatMap(read => {
    const from = timeOf(read, definition.from);
    const to = timeOf(read, definition.to);
    return from === null || to === null ? [] : [(to - from) / HOUR_MS];
  });
  return {
    op: 'duration',
    value: mean(
      hours.reduce((sum, value) => sum + value, 0),
      hours.length
    ),
    unit: 'hours',
    n: hours.length,
    missing: population.length - hours.length,
  };
}

function groupOf(read: ItemRead, groupBy: NonNullable<ItemMetricDefinition['group_by']>) {
  if (groupBy === 'first_run.workflow') return read.runs[0]?.workflow ?? null;
  const last = read.runs.at(-1);
  return (groupBy === 'last_run.workflow' ? last?.workflow : last?.outcome) ?? null;
}

/** Evaluate each definition over `reads`: the population is the reads that match `items`. */
export function evaluateItemMetrics(
  definitions: readonly ItemMetricDefinition[],
  reads: readonly ItemRead[]
): ItemMetricResult[] {
  return definitions.map(definition => {
    const population = reads.filter(read => itemMatches(read, definition.items));
    const result: ItemMetricResult = { name: definition.name, ...figures(definition, population) };
    const groupBy = definition.group_by;
    if (groupBy === undefined) return result;
    const groups = new Map<string | null, ItemRead[]>();
    for (const read of population) {
      const key = groupOf(read, groupBy);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [read]);
      else group.push(read);
    }
    const keys = [...groups.keys()].sort((a, b) =>
      a === null ? 1 : b === null ? -1 : a.localeCompare(b)
    );
    return {
      ...result,
      groups: keys.map(group => ({ group, ...figures(definition, groups.get(group) ?? []) })),
    };
  });
}

/**
 * Every pack's item metrics under `roots`, over every item of the project with a run in
 * the window. Pages the window read to the end: an aggregate has no output cap.
 */
export async function reportItemMetrics(
  source: ItemWindowSource,
  roots: LiveWorkflowSourceRoots,
  projectKey: string,
  window: Pick<ItemWindowQuery, 'since' | 'until'>,
  options: { name?: string; now?: Date } = {}
): Promise<ItemMetricsReport> {
  const listing = await discoverItemMetrics(roots);
  let page = await readItemWindow(
    source,
    projectKey,
    { ...window, limit: ITEM_WINDOW_MAX_LIMIT },
    options.now
  );
  const reads = [...page.items];
  while (page.next !== null) {
    page = await readItemWindow(source, projectKey, {
      after: page.next,
      limit: ITEM_WINDOW_MAX_LIMIT,
    });
    reads.push(...page.items);
  }
  return {
    project: projectKey,
    window: page.window,
    items: reads.length,
    degraded_items: reads.filter(read => read.degraded.length > 0).map(read => read.item.key),
    packs: listing.packs.map(({ pack, source: from, metrics }) => ({
      pack,
      source: from,
      metrics: evaluateItemMetrics(
        metrics.filter(metric => options.name === undefined || metric.name === options.name),
        reads
      ),
    })),
    errors: listing.errors,
  };
}
