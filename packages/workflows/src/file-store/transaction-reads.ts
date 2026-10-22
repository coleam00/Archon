import { holdsWorkflowPath } from '../workflow-path-lock';
import {
  answeredPauseContinuation,
  isAttentionQueueRow,
  isContainerRun,
  isScheduledWorkflowResume,
  pendingWorkflowWaitDeadline,
  readSourceRelease,
  workflowRunStatusSchema,
  workflowWaitDue,
  type WorkflowRun,
} from '../schemas/workflow-run';
import type { IWorkflowStore } from '../store';
import type { WorkflowEventRow } from '../schemas/workflow-event';
import type { DashboardWorkflowRun } from '../schemas/workflow-run-listing';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { readProviderEventRows } from '../provider-event-reader';
import type { TransactionView } from './transaction-view';

type TransactionReads = Pick<
  TransactionView,
  | 'listDueWorkflowContinuations'
  | 'getWorkflowRun'
  | 'getWorkflowRunStatus'
  | 'listWorkflowEvents'
  | 'listEventsForRuns'
  | 'getDagResumeSnapshot'
  | 'findChildRuns'
  | 'getRunAncestry'
  | 'getActiveWorkflowRunByPath'
  | 'findResumableRun'
  | 'findWorkflowRunsByIdPrefix'
  | 'findAdoptingRuns'
  | 'listAttentionQueueRows'
  | 'findOpenWorkRuns'
  | 'listWorkflowRuns'
  | 'getCodebase'
  | 'getCodebaseEnvVars'
  | 'listProviderEvents'
>;

export const listRunEvents = (events: WorkflowEventRow[], id: string): WorkflowEventRow[] =>
  structuredClone(events.filter(event => event.workflow_run_id === id));

export const newestFirst = (rows: WorkflowRun[]): WorkflowRun[] =>
  rows.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());

export const isResumable = (run: WorkflowRun): boolean =>
  run.status === 'paused' ||
  run.status === 'failed' ||
  (run.status === 'running' &&
    (run.last_activity_at === null || run.last_activity_at.getTime() < Date.now() - 86_400_000));

// An answered gate has no time of its own; it sorts after every timed continuation.
function continuationTime(run: WorkflowRun): number {
  const retry = run.metadata.continuation_retry_at;
  const wait = pendingWorkflowWaitDeadline(run);
  const schedule = run.metadata.scheduled_resume;
  const at =
    typeof retry === 'string'
      ? retry
      : wait
        ? wait.resumeAt
        : run.status === 'failed' && isScheduledWorkflowResume(schedule)
          ? schedule.resumeAt
          : undefined;
  return at === undefined ? Number.POSITIVE_INFINITY : Date.parse(at);
}

/** The read side of a transaction view: queries over the transaction's runs and events. */
export function createTransactionReads(
  runs: Map<string, WorkflowRun>,
  events: WorkflowEventRow[],
  getCodebase: IWorkflowStore['getCodebase']
): TransactionReads {
  const listEvents = (id: string): WorkflowEventRow[] => listRunEvents(events, id);
  return {
    listDueWorkflowContinuations: async (
      now,
      limit = 25
    ): ReturnType<IWorkflowStore['listDueWorkflowContinuations']> =>
      structuredClone(
        [...runs.values()]
          .filter(run => {
            const retry = run.metadata.continuation_retry_at;
            if (typeof retry === 'string' && Date.parse(retry) > now.getTime()) return false;
            const wait = pendingWorkflowWaitDeadline(run);
            if (wait) return workflowWaitDue(wait, now.getTime());
            if (answeredPauseContinuation(run)) return true;
            if (run.status === 'paused' && readSourceRelease(run.metadata) && !isContainerRun(run))
              return true;
            const scheduled = run.metadata.scheduled_resume;
            return (
              run.status === 'failed' &&
              isScheduledWorkflowResume(scheduled) &&
              !scheduled.triggeredAt &&
              Date.parse(scheduled.resumeAt) <= now.getTime()
            );
          })
          .sort((a, b) => {
            const [x, y] = [continuationTime(a), continuationTime(b)];
            return x === y ? 0 : x < y ? -1 : 1;
          })
          .slice(0, limit)
      ),
    getWorkflowRun: async id => structuredClone(runs.get(id) ?? null),
    getWorkflowRunStatus: async id => runs.get(id)?.status ?? null,
    listWorkflowEvents: async (id, options) =>
      listEvents(id).filter(event => !options?.excludeEventTypes?.includes(event.event_type)),
    listEventsForRuns: async (ids, types) =>
      new Map(
        ids.map(id => [
          id,
          listEvents(id).filter(event => types.some(type => type === event.event_type)),
        ])
      ),
    getDagResumeSnapshot: async id => foldDagResumeSnapshot(listEvents(id), id),
    findChildRuns: async id =>
      structuredClone(
        [...runs.values()]
          .filter(run => run.parent_run_id === id)
          .sort((a, b) => a.started_at.getTime() - b.started_at.getTime())
      ),
    getRunAncestry: async (id): ReturnType<IWorkflowStore['getRunAncestry']> => {
      const ancestors: WorkflowRun[] = [];
      let parent = runs.get(id)?.parent_run_id;
      const seen = new Set([id]);
      while (parent && ancestors.length < 32 && !seen.has(parent)) {
        seen.add(parent);
        const run = runs.get(parent);
        if (!run) break;
        ancestors.push(structuredClone(run));
        parent = run.parent_run_id;
      }
      return ancestors;
    },
    getActiveWorkflowRunByPath: async (path, self) =>
      structuredClone(
        [...runs.values()]
          .filter(
            run =>
              run.working_path === path &&
              run.id !== self?.id &&
              !self?.excludeRunIds?.includes(run.id) &&
              holdsWorkflowPath(run) &&
              (!self ||
                run.started_at < self.startedAt ||
                (run.started_at.getTime() === self.startedAt.getTime() && run.id < self.id))
          )
          .sort(
            (a, b) => a.started_at.getTime() - b.started_at.getTime() || a.id.localeCompare(b.id)
          )[0] ?? null
      ),
    findResumableRun: async (name, path) =>
      structuredClone(
        newestFirst(
          [...runs.values()].filter(
            run => run.workflow_name === name && run.working_path === path && isResumable(run)
          )
        )[0] ?? null
      ),
    findWorkflowRunsByIdPrefix: async (prefix, codebaseId) =>
      structuredClone(
        prefix.length > 0 && /^[0-9a-f-]+$/i.test(prefix)
          ? [...runs.values()]
              .filter(
                run => run.id.startsWith(prefix.toLowerCase()) && run.codebase_id === codebaseId
              )
              .slice(0, 2)
          : []
      ),
    findAdoptingRuns: async id =>
      structuredClone(
        newestFirst([...runs.values()].filter(run => run.adopted_from_run_id === id))
      ),
    listAttentionQueueRows: async () =>
      structuredClone(newestFirst([...runs.values()].filter(isAttentionQueueRow))),
    findOpenWorkRuns: async options =>
      structuredClone(
        newestFirst(
          [...runs.values()].filter(
            run =>
              (!options?.codebaseId || run.codebase_id === options.codebaseId) &&
              run.status === 'failed' &&
              ![...runs.values()].some(other => other.adopted_from_run_id === run.id)
          )
        ).slice(0, options?.limit ?? 50)
      ),
    listWorkflowRuns: async (options): ReturnType<IWorkflowStore['listWorkflowRuns']> => {
      const parents =
        options?.parentRunIds === undefined ? undefined : new Set(options.parentRunIds);
      const excludedLeafStatuses = new Set(options?.excludeLeafStatuses);
      const nonLeaves = new Set(
        excludedLeafStatuses.size > 0 ? [...runs.values()].map(run => run.parent_run_id) : []
      );
      const scoped = [...runs.values()].filter(
        run =>
          (!options?.codebaseId || run.codebase_id === options.codebaseId) &&
          (parents === undefined ||
            (run.parent_run_id !== null && parents.has(run.parent_run_id))) &&
          (!excludedLeafStatuses.has(run.status) || nonLeaves.has(run.id)) &&
          (!options?.search ||
            run.workflow_name.includes(options.search) ||
            run.user_message.includes(options.search)) &&
          (!options?.after || run.started_at >= new Date(options.after)) &&
          (!options?.before || run.started_at < new Date(options.before))
      );
      const counts = {
        all: scoped.length,
        running: 0,
        pending: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const run of scoped) counts[workflowRunStatusSchema.parse(run.status)]++;
      const filtered = scoped.filter(
        run =>
          !options?.status ||
          (Array.isArray(options.status)
            ? options.status.includes(run.status)
            : run.status === options.status)
      );
      const listed: DashboardWorkflowRun[] = [];
      for (const run of filtered
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        .slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? 50))) {
        const codebase = run.codebase_id ? await getCodebase(run.codebase_id) : null;
        listed.push({
          ...structuredClone(run),
          codebase_name: codebase?.name ?? null,
          platform_type: null,
          worker_platform_id: null,
          parent_platform_id: null,
          active_nodes: [],
          current_step_name: null,
          current_step_status: null,
          total_steps: null,
          agents_completed: null,
          agents_failed: null,
          agents_total: null,
        });
      }
      return { runs: listed, total: filtered.length, counts };
    },
    getCodebase: getCodebase,
    getCodebaseEnvVars: async () => ({}),
    listProviderEvents: async (id, query = {}) =>
      readProviderEventRows(
        id,
        listEvents(id).filter(
          row => query.stepName === undefined || row.step_name === query.stepName
        ),
        query
      ),
  };
}
