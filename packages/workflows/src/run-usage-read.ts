import {
  foldDagUsageRecord,
  foldDeferredUsage,
  newDagUsageFold,
  type DagUsageFold,
} from './dag-usage-fold';
import { readNodeRecordEvent } from './node-record-reader';
import { DEFERRED_NODE_USAGE_EVENT_TYPE } from './node-record-serialization';
import {
  buildRunUsageReport,
  unknownRunUsageReport,
  type ChildUsageReport,
} from './run-usage-report';
import type { RunUsageReport, UsageLimitation } from './schemas/run-usage-report';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';

export const USAGE_REPORT_EVENT_TYPES = [
  ...NODE_STATE_EVENT_TYPES,
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  'workflow_completed',
] as const;
export type RunUsageReadStore = Pick<IWorkflowStore, 'getWorkflowRunsByIds' | 'listEventsForRuns'>;

interface UsageHistory {
  run: WorkflowRun;
  fold: DagUsageFold;
  limitations: UsageLimitation[];
}

function readHistory(run: WorkflowRun, events: readonly WorkflowEventRow[]): UsageHistory {
  const fold = newDagUsageFold(run.id);
  const limitations: UsageLimitation[] = [];
  for (const event of events) {
    if (!event.step_name) continue;
    const row = { ...event, step_name: event.step_name };
    try {
      if (row.event_type === DEFERRED_NODE_USAGE_EVENT_TYPE) foldDeferredUsage(fold, row);
      else {
        const record = readNodeRecordEvent(row);
        if (record !== undefined) foldDagUsageRecord(fold, row, record);
      }
    } catch {
      limitations.push({ runId: run.id, path: row.step_name, reason: 'record_unreadable' });
    }
  }
  return { run, fold, limitations };
}

async function loadHistories(
  store: RunUsageReadStore,
  runs: readonly WorkflowRun[],
  histories: Map<string, UsageHistory>,
  unavailable: Map<string, RunUsageReport>
): Promise<void> {
  if (runs.length === 0) return;
  let events: Map<string, WorkflowEventRow[]>;
  try {
    events = await store.listEventsForRuns(
      runs.map(run => run.id),
      USAGE_REPORT_EVENT_TYPES,
      { strict: true }
    );
  } catch {
    for (const run of runs)
      unavailable.set(run.id, unknownRunUsageReport(run, 'history_unavailable'));
    return;
  }
  for (const run of runs) histories.set(run.id, readHistory(run, events.get(run.id) ?? []));
}

async function loadReferencedChildren(
  store: RunUsageReadStore,
  roots: readonly WorkflowRun[],
  histories: Map<string, UsageHistory>,
  unavailable: Map<string, RunUsageReport>
): Promise<void> {
  const attempted = new Set(roots.map(run => run.id));
  let level = roots.map(run => run.id);
  while (level.length > 0) {
    const childIds = [
      ...new Set(
        level.flatMap(id => [...(histories.get(id)?.fold.reportedChildUsage.keys() ?? [])])
      ),
    ].filter(id => !attempted.has(id));
    for (const id of childIds) attempted.add(id);
    if (childIds.length === 0) return;
    let children: WorkflowRun[];
    try {
      children = await store.getWorkflowRunsByIds(childIds);
    } catch {
      return;
    }
    await loadHistories(store, children, histories, unavailable);
    level = children.map(child => child.id);
  }
}

function resolveReport(
  runId: string,
  histories: ReadonlyMap<string, UsageHistory>,
  unavailable: ReadonlyMap<string, RunUsageReport>,
  cache: Map<string, RunUsageReport>,
  ancestors: ReadonlySet<string>
): ChildUsageReport {
  if (ancestors.has(runId)) return { reason: 'child_cycle' };
  const cached = cache.get(runId) ?? unavailable.get(runId);
  if (cached !== undefined) return { report: cached };
  const history = histories.get(runId);
  if (history === undefined) return { reason: 'child_unavailable' };
  const next = new Set([...ancestors, runId]);
  const children = new Map<string, ChildUsageReport>();
  for (const id of history.fold.reportedChildUsage.keys())
    children.set(id, resolveReport(id, histories, unavailable, cache, next));
  const report = buildRunUsageReport(history.run, history.fold, {
    children,
    limitations: history.limitations,
  });
  // A cycle cut depends on the ancestor set. Caching it would make a later root
  // in the same request reuse a report that was built for a different cut.
  const cut = [...children.values()].some(
    child => 'reason' in child && child.reason === 'child_cycle'
  );
  if (!cut) cache.set(runId, report);
  return { report };
}

export async function readRunUsageReports(
  store: RunUsageReadStore,
  roots: readonly WorkflowRun[]
): Promise<Map<string, RunUsageReport>> {
  const histories = new Map<string, UsageHistory>();
  const unavailable = new Map<string, RunUsageReport>();
  await loadHistories(store, roots, histories, unavailable);
  await loadReferencedChildren(store, roots, histories, unavailable);
  const cache = new Map<string, RunUsageReport>();
  const result = new Map<string, RunUsageReport>();
  for (const root of roots) {
    const resolved = resolveReport(root.id, histories, unavailable, cache, new Set());
    result.set(
      root.id,
      'report' in resolved ? resolved.report : unknownRunUsageReport(root, 'history_unavailable')
    );
  }
  return result;
}

export async function readRunUsageReport(
  store: RunUsageReadStore,
  run: WorkflowRun
): Promise<RunUsageReport> {
  const reports = await readRunUsageReports(store, [run]);
  return reports.get(run.id) ?? unknownRunUsageReport(run, 'history_unavailable');
}
