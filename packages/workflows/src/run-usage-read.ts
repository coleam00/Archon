import { createLogger } from '@archon/paths';
import {
  foldDagUsageRecord,
  foldDeferredUsage,
  newDagUsageFold,
  type DagUsageFold,
} from './dag-usage-fold';
import { readNodeRecordEvent } from './node-record-reader';
import { DEFERRED_NODE_USAGE_EVENT_TYPE } from './node-record-serialization';
import {
  collectRunUsageEvidence,
  toRunUsageReport,
  unknownRunUsageEvidence,
  unknownRunUsageReport,
  type ChildUsageReport,
  type UsageEvidence,
} from './run-usage-report';
import type { RunUsageReport, UsageLimitation } from './schemas/run-usage-report';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('workflow.run-usage-read'));
}

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

/** A read keeps each run's evidence, so a parent folds its children in before any report exists. */
type EvidenceReport = { evidence: UsageEvidence };

function readHistory(run: WorkflowRun, events: readonly WorkflowEventRow[]): UsageHistory {
  const fold = newDagUsageFold(run.id);
  const limitations: UsageLimitation[] = [];
  for (const event of events) {
    if (!event.step_name) {
      if (event.event_type !== 'workflow_completed')
        limitations.push({ runId: run.id, reason: 'record_unreadable' });
      continue;
    }
    const row = { ...event, step_name: event.step_name };
    try {
      if (row.event_type === DEFERRED_NODE_USAGE_EVENT_TYPE) foldDeferredUsage(fold, row);
      else {
        const record = readNodeRecordEvent(row);
        if (record !== undefined) foldDagUsageRecord(fold, row, record);
      }
    } catch (error) {
      getLog().warn(
        { err: error, workflowRunId: run.id, path: row.step_name },
        'run_usage.record_unreadable'
      );
      limitations.push({ runId: run.id, path: row.step_name, reason: 'record_unreadable' });
    }
  }
  return { run, fold, limitations };
}

async function loadHistories(
  store: RunUsageReadStore,
  runs: readonly WorkflowRun[],
  histories: Map<string, UsageHistory>,
  unavailable: Map<string, UsageEvidence>
): Promise<void> {
  if (runs.length === 0) return;
  let events: Map<string, WorkflowEventRow[]>;
  try {
    events = await store.listEventsForRuns(
      runs.map(run => run.id),
      USAGE_REPORT_EVENT_TYPES,
      { strict: true }
    );
  } catch (batchError) {
    getLog().warn(
      { err: batchError, workflowRunIds: runs.map(run => run.id) },
      'run_usage.history_batch_unavailable'
    );
    for (const run of runs) {
      try {
        const events = await store.listEventsForRuns([run.id], USAGE_REPORT_EVENT_TYPES, {
          strict: true,
        });
        histories.set(run.id, readHistory(run, events.get(run.id) ?? []));
      } catch (error) {
        getLog().warn({ err: error, workflowRunId: run.id }, 'run_usage.history_unavailable');
        unavailable.set(run.id, unknownRunUsageEvidence(run, 'history_unavailable'));
      }
    }
    return;
  }
  for (const run of runs) histories.set(run.id, readHistory(run, events.get(run.id) ?? []));
}

async function loadReferencedChildren(
  store: RunUsageReadStore,
  roots: readonly WorkflowRun[],
  histories: Map<string, UsageHistory>,
  unavailable: Map<string, UsageEvidence>
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
    } catch (error) {
      getLog().warn(
        { err: error, childRunIds: childIds },
        'run_usage.child_lookup_batch_unavailable'
      );
      // One malformed row rejects the combined lookup. Read each child on its
      // own so a readable sibling keeps its usage and only the bad row is
      // reported as unavailable.
      children = [];
      for (const id of childIds) {
        try {
          const rows = await store.getWorkflowRunsByIds([id]);
          children.push(...rows.filter(row => row.id === id));
        } catch (childError) {
          getLog().warn({ err: childError, childRunId: id }, 'run_usage.child_lookup_unavailable');
        }
      }
    }
    await loadHistories(store, children, histories, unavailable);
    level = children.map(child => child.id);
  }
}

interface ResolvedEvidence {
  result: EvidenceReport | ChildUsageReport;
  cycleCut: boolean;
}

function resolveEvidence(
  runId: string,
  histories: ReadonlyMap<string, UsageHistory>,
  unavailable: ReadonlyMap<string, UsageEvidence>,
  cache: Map<string, UsageEvidence>,
  ancestors: ReadonlySet<string>
): ResolvedEvidence {
  if (ancestors.has(runId)) return { result: { reason: 'child_cycle' }, cycleCut: true };
  const cached = cache.get(runId) ?? unavailable.get(runId);
  if (cached !== undefined) return { result: { evidence: cached }, cycleCut: false };
  const history = histories.get(runId);
  if (history === undefined) return { result: { reason: 'child_unavailable' }, cycleCut: false };
  const next = new Set([...ancestors, runId]);
  const children = new Map<string, ChildUsageReport>();
  let cycleCut = false;
  for (const id of history.fold.reportedChildUsage.keys()) {
    const child = resolveEvidence(id, histories, unavailable, cache, next);
    children.set(id, child.result);
    cycleCut ||= child.cycleCut;
  }
  const evidence = collectRunUsageEvidence(history.run, history.fold, {
    children,
    limitations: history.limitations,
  });
  // A cycle cut depends on the ancestor set. Caching it would make a later root
  // in the same request reuse evidence that was collected for a different cut.
  if (!cycleCut) cache.set(runId, evidence);
  return { result: { evidence }, cycleCut };
}

export async function readRunUsageReports(
  store: RunUsageReadStore,
  roots: readonly WorkflowRun[]
): Promise<Map<string, RunUsageReport>> {
  const histories = new Map<string, UsageHistory>();
  const unavailable = new Map<string, UsageEvidence>();
  await loadHistories(store, roots, histories, unavailable);
  await loadReferencedChildren(store, roots, histories, unavailable);
  const cache = new Map<string, UsageEvidence>();
  const result = new Map<string, RunUsageReport>();
  for (const root of roots) {
    const resolved = resolveEvidence(root.id, histories, unavailable, cache, new Set());
    result.set(
      root.id,
      'evidence' in resolved.result
        ? toRunUsageReport(resolved.result.evidence)
        : unknownRunUsageReport(root, 'history_unavailable')
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
