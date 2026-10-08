import { NODE_LIFECYCLE_EVENT_TYPES, foldActiveNodeIds } from '../store';
import { FileStoreUnsupportedError } from './errors';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from '../store';
import type { WorkflowRun } from '../schemas/workflow-run';
import type { WorkflowEventRow } from '../schemas/workflow-event';
import {
  workflowNodeSessionSchema,
  type WorkflowNodeSession,
} from '../schemas/workflow-node-session';
import { workflowRunNodeSessionSchema } from '../schemas/workflow-run-node-session';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { reportRunTerminalTelemetry } from '../run-terminal-telemetry';
import { getWorkflowEventEmitter } from '../event-emitter';
import { createTransactionView, type TransactionView } from './transaction-view';
import {
  commit,
  openFileStore,
  readJson,
  readRun,
  readRunState,
  listRuns,
  recoverBeforeRead,
  runPath,
} from './commit';

const log = createLogger('file-store');
const unsupportedTriggerAdmission = async (): Promise<never> => {
  throw new FileStoreUnsupportedError('trigger admission');
};
export interface FileWorkflowStoreOptions {
  root: string;
  getCodebase?: IWorkflowStore['getCodebase'];
  getCodebaseEnvVars?: IWorkflowStore['getCodebaseEnvVars'];
  isCheckoutReleased?: (run: WorkflowRun, workingPath?: string) => Promise<boolean>;
}
export async function createFileWorkflowStore(
  options: FileWorkflowStoreOptions
): Promise<IWorkflowStore & { deleteWorkflowRun(id: string): Promise<void> }> {
  const { root } = options;
  await openFileStore(root);
  const getCodebase = options.getCodebase ?? (async (): Promise<null> => null);
  const getCodebaseEnvVars =
    options.getCodebaseEnvVars ?? (async (): Promise<Record<string, string>> => ({}));
  async function eventsFor(ids: readonly string[]): Promise<WorkflowEventRow[]> {
    const states = await Promise.all(ids.map(id => readRunState(root, id)));
    return states.flatMap(state => state?.events ?? []);
  }
  async function query<T>(
    ids: readonly string[] | 'all',
    call: (view: TransactionView) => Promise<T>,
    events = false
  ): Promise<T> {
    await recoverBeforeRead(root);
    const rows =
      ids === 'all' ? await listRuns(root) : await Promise.all(ids.map(id => readRun(root, id)));
    const runs = new Map(rows.flatMap(run => (run ? [[run.id, run] as const] : [])));
    return call(
      createTransactionView(runs, events ? await eventsFor([...runs.keys()]) : [], getCodebase)
    );
  }
  async function write<T>(
    ids: readonly string[] | 'all',
    call: (view: TransactionView) => Promise<T>
  ): Promise<T> {
    const reports: { run: WorkflowRun; events: WorkflowEventRow[] }[] = [];
    const result = await commit(root, ids, async runs => {
      const before = structuredClone(runs);
      const events = await eventsFor([...runs.keys()]);
      const priorEvents = structuredClone(events);
      const result = await call(createTransactionView(runs, events, getCodebase));
      const changes = [];
      for (const [id, run] of runs) {
        const added = events.filter(
          event => event.workflow_run_id === id && !priorEvents.some(prior => prior.id === event.id)
        );
        const retract = priorEvents
          .filter(
            event => event.workflow_run_id === id && !events.some(next => next.id === event.id)
          )
          .map(event => event.id);
        if (!isDeepStrictEqual(before.get(id), run) || added.length || retract.length)
          changes.push({ run, events: added, retract });
        if (
          added.some(event =>
            ['workflow_completed', 'workflow_failed', 'workflow_cancelled'].includes(
              event.event_type
            )
          )
        )
          reports.push({
            run: structuredClone(run),
            events: structuredClone(events.filter(event => event.workflow_run_id === id)),
          });
      }
      const deleted = [...before.keys()].filter(id => !runs.has(id));
      return {
        result,
        changes: {
          runs: changes,
          deleteRuns: deleted,
          documents: await clearDeletedSessionReferences(deleted),
        },
      };
    });
    for (const report of reports) {
      try {
        const usage = await foldDagResumeSnapshot(report.events, report.run.id);
        reportRunTerminalTelemetry(report.run, report.events, usage);
      } catch (err) {
        log.warn({ err, runId: report.run.id }, 'file_store.terminal_telemetry_failed');
      }
    }
    return result;
  }
  function sessionPath(scope: { workflow_name: string; scope_key: string }): string {
    return `node-sessions/${createHash('sha256')
      .update(JSON.stringify([scope.workflow_name, scope.scope_key]))
      .digest('hex')}.json`;
  }
  async function readSessions(path: string): Promise<WorkflowNodeSession[]> {
    return z.array(workflowNodeSessionSchema).parse((await readJson(join(root, path))) ?? []);
  }
  async function clearDeletedSessionReferences(ids: string[]): Promise<Record<string, unknown>> {
    const documents: Record<string, unknown> = {};
    if (!ids.length) return documents;
    let paths: string[];
    try {
      paths = await readdir(join(root, 'node-sessions'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return documents;
      throw error;
    }
    for (const name of paths.filter(name => name.endsWith('.json'))) {
      const path = `node-sessions/${name}`;
      const rows = await readSessions(path);
      if (!rows.some(row => row.last_run_id !== null && ids.includes(row.last_run_id))) continue;
      documents[path] = rows.map(row =>
        row.last_run_id !== null && ids.includes(row.last_run_id)
          ? { ...row, last_run_id: null }
          : row
      );
    }
    return documents;
  }
  const store: IWorkflowStore & { deleteWorkflowRun(id: string): Promise<void> } = {
    getCodebase,
    getCodebaseEnvVars,
    createWorkflowRun: data => {
      const input = { ...data, id: data.id ?? crypto.randomUUID() };
      return write([input.id], view => view.createWorkflowRun(input));
    },
    getWorkflowRun: id => readRun(root, id),
    getWorkflowRunStatus: async id => (await readRun(root, id))?.status ?? null,
    claimPendingWorkflowRun: (id, path) =>
      write([id], async view => {
        const run = await view.getWorkflowRun(id);
        if (!run || (await options.isCheckoutReleased?.(run, path))) return null;
        return view.claimPendingWorkflowRun(id, path);
      }),
    updateWorkflowRun: (id, updates) => write([id], view => view.updateWorkflowRun(id, updates)),
    updateWorkflowActivity: id => write([id], view => view.updateWorkflowActivity(id)),
    recordWorkflowRunCheckoutBaseline: (id, baseline) =>
      write([id], view => view.recordWorkflowRunCheckoutBaseline(id, baseline)),
    resumeWorkflowRun: (id, cursor) => write([id], view => view.resumeWorkflowRun(id, cursor)),
    recoverCancelledFanOutRun: id => write([id], view => view.recoverCancelledFanOutRun(id)),
    pauseWorkflowRun: (id, approval, extra, suspension) =>
      write([id], view => view.pauseWorkflowRun(id, approval, extra, suspension)),
    pauseWorkflowRunForWait: (id, wait, pause) =>
      write([id], view => view.pauseWorkflowRunForWait(id, wait, pause)),
    clearWorkflowWaitContext: (id, wait, completion) =>
      write([id], view => view.clearWorkflowWaitContext(id, wait, completion)),
    failPausedAttentionWait: (id, wait, error) =>
      write([id], view => view.failPausedAttentionWait(id, wait, error)),
    failPausedApproval: (id, approval, error) =>
      write([id], view => view.failPausedApproval(id, approval, error)),
    resolveApprovalGate: (id, metadata, events, expected) =>
      write([id], view => view.resolveApprovalGate(id, metadata, events, expected)),
    resolveAndCancelApprovalGate: (id, events, cancellation, expected) =>
      write([id], view => view.resolveAndCancelApprovalGate(id, events, cancellation, expected)),
    completeWorkflowRun: (id, completion, metadata) =>
      write([id], view => view.completeWorkflowRun(id, completion, metadata)),
    failWorkflowRun: (id, error, options) =>
      write([id], view => view.failWorkflowRun(id, error, options)),
    cancelWorkflowRun: (id, event) => write([id], view => view.cancelWorkflowRun(id, event)),
    cancelFanOutRun: (id, reason) => write([id], view => view.cancelFanOutRun(id, reason)),
    cancelResumableRunsForConversation: (id, assertMayCancel) =>
      write('all', view => view.cancelResumableRunsForConversation(id, assertMayCancel)),
    claimWriteback: id => write([id], view => view.claimWriteback(id)),
    releaseWritebackClaim: async id => {
      try {
        await write([id], view => view.releaseWritebackClaim(id));
      } catch (err) {
        log.warn({ err, runId: id }, 'file_store.writeback_release_failed');
      }
    },
    setToolCallAttention: async (id, streamId, calls) => {
      const changed = await write([id], view => view.setToolCallAttention(id, streamId, calls));
      if (changed)
        getWorkflowEventEmitter().emit({
          type: 'run_attention_changed',
          runId: id,
          streamId,
          hasAttention: calls.length > 0,
        });
      return changed;
    },
    createWorkflowEvent: async input => {
      try {
        await store.persistWorkflowEvent(input);
      } catch (err) {
        log.error(
          { err, runId: input.workflow_run_id, eventType: input.event_type },
          'file_store.event_dropped'
        );
      }
    },
    persistWorkflowEvent: input =>
      write([input.workflow_run_id], view => view.persistWorkflowEvent(input)),
    persistWorkflowEventIfRunning: (input, options) =>
      write([input.workflow_run_id], view => view.persistWorkflowEventIfRunning(input, options)),
    listWorkflowEvents: (id, options) =>
      query([id], view => view.listWorkflowEvents(id, options), true),
    listEventsForRuns: (ids, types) => query(ids, view => view.listEventsForRuns(ids, types), true),
    getDagResumeSnapshot: id => query([id], view => view.getDagResumeSnapshot(id), true),
    listProviderEvents: (id, queryOptions) =>
      query([id], view => view.listProviderEvents(id, queryOptions), true),
    findChildRuns: id => query('all', view => view.findChildRuns(id)),
    getRunAncestry: id => query('all', view => view.getRunAncestry(id)),
    getActiveWorkflowRunByPath: (path, self) =>
      query('all', view => view.getActiveWorkflowRunByPath(path, self)),
    findResumableRun: (name, path) => query('all', view => view.findResumableRun(name, path)),
    findWorkflowRunsByIdPrefix: (prefix, codebase) =>
      query('all', view => view.findWorkflowRunsByIdPrefix(prefix, codebase)),
    findAdoptingRuns: id => query('all', view => view.findAdoptingRuns(id)),
    findOpenWorkRuns: options => query('all', view => view.findOpenWorkRuns(options)),
    listWorkflowRuns: async options => {
      const result = await query('all', view => view.listWorkflowRuns(options));
      result.runs = await Promise.all(
        result.runs.map(async run => {
          const events = await eventsFor([run.id]);
          const active = new Set<string>();
          for (const event of events) {
            const type = NODE_LIFECYCLE_EVENT_TYPES.find(type => type === event.event_type);
            if (type) foldActiveNodeIds(active, event.step_name, type);
          }
          const activeNodes = [...active];
          const parallel = events
            .filter(event => event.event_type === 'parallel_agent_started')
            .at(-1);
          return {
            ...run,
            active_nodes: activeNodes,
            current_step_name: activeNodes.length === 1 ? (activeNodes[0] ?? null) : null,
            current_step_status: activeNodes.length === 1 ? ('running' as const) : null,
            agents_completed: events.filter(
              event => event.event_type === 'parallel_agent_completed'
            ).length,
            agents_failed: events.filter(event => event.event_type === 'parallel_agent_failed')
              .length,
            agents_total:
              typeof parallel?.data.totalAgents === 'number' ? parallel.data.totalAgents : null,
          };
        })
      );
      return result;
    },
    listDueWorkflowContinuations: (now, limit) =>
      query('all', view => view.listDueWorkflowContinuations(now, limit)),
    deferWorkflowContinuation: (id, retry, cursor) =>
      write([id], view => view.deferWorkflowContinuation(id, retry, cursor)),
    signalWorkflowWait: (id, wait, payload) =>
      write([id], view => view.signalWorkflowWait(id, wait, payload)),
    deleteOldWorkflowRuns: days => write('all', view => view.deleteOldWorkflowRuns(days)),
    deleteWorkflowRun: id =>
      commit(root, 'all', async runs => {
        const run = runs.get(id);
        if (!run) return { result: undefined, changes: {} };
        if (!['completed', 'failed', 'cancelled'].includes(run.status))
          throw new Error('Only terminal runs can be deleted');
        const changed = [...runs.values()]
          .filter(row => row.parent_run_id === id || row.adopted_from_run_id === id)
          .map(row => ({
            run: {
              ...row,
              parent_run_id: row.parent_run_id === id ? null : row.parent_run_id,
              adopted_from_run_id: row.adopted_from_run_id === id ? null : row.adopted_from_run_id,
            },
          }));
        return {
          result: undefined,
          changes: {
            deleteRuns: [id],
            runs: changed,
            documents: await clearDeletedSessionReferences([id]),
          },
        };
      }),
    listWorkflowNodeSessions: async scope => {
      await recoverBeforeRead(root);
      return readSessions(sessionPath(scope));
    },
    upsertWorkflowNodeSession: input =>
      commit(root, [], async () => {
        const path = sessionPath(input);
        const rows = await readSessions(path);
        const prior = rows.find(
          row => row.node_id === input.node_id && row.provider === input.provider
        );
        const next = {
          ...input,
          created_at: prior?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        return {
          result: undefined,
          changes: { documents: { [path]: [...rows.filter(row => row !== prior), next] } },
        };
      }),
    deleteWorkflowNodeSessions: filter =>
      commit(root, [], async () => {
        let paths: string[];
        try {
          paths = await readdir(join(root, 'node-sessions'));
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') paths = [];
          else throw error;
        }
        let deleted = 0;
        const documents: Record<string, unknown> = {};
        for (const name of paths.filter(name => name.endsWith('.json'))) {
          const path = `node-sessions/${name}`;
          const rows = await readSessions(path);
          const kept = rows.filter(
            row =>
              !(
                row.workflow_name === filter.workflow_name &&
                (filter.scope_key === undefined || row.scope_key === filter.scope_key) &&
                (filter.node_id === undefined || row.node_id === filter.node_id)
              )
          );
          if (kept.length !== rows.length) {
            deleted += rows.length - kept.length;
            documents[path] = kept;
          }
        }
        return { result: { deleted }, changes: { documents } };
      }),
    listWorkflowRunNodeSessions: async id => {
      await recoverBeforeRead(root);
      return z
        .array(workflowRunNodeSessionSchema)
        .parse((await readJson(join(runPath(root, id), 'node-sessions.json'))) ?? []);
    },
    upsertWorkflowRunNodeSession: input =>
      commit(root, [input.workflow_run_id], async runs => {
        if (!runs.has(input.workflow_run_id)) throw new Error('Run missing');
        const path = `runs/${input.workflow_run_id}/node-sessions.json`;
        const rows = z
          .array(workflowRunNodeSessionSchema)
          .parse((await readJson(join(root, path))) ?? []);
        const prior = rows.find(row => row.node_id === input.node_id);
        const next = {
          ...input,
          created_at: prior?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        return {
          result: undefined,
          changes: { documents: { [path]: [...rows.filter(row => row !== prior), next] } },
        };
      }),
    admitResourceStart: unsupportedTriggerAdmission,
    drainResourceStarts: unsupportedTriggerAdmission,
    acceptStartReceipt: unsupportedTriggerAdmission,
    getStartReceipt: unsupportedTriggerAdmission,
    listStartReceipts: unsupportedTriggerAdmission,
    listPendingStartBindings: unsupportedTriggerAdmission,
    getResourceStartRequest: unsupportedTriggerAdmission,
    listQueuedResourceStartsForHost: unsupportedTriggerAdmission,
    withdrawQueuedResourceStart: unsupportedTriggerAdmission,
    claimStartBindingPreparation: unsupportedTriggerAdmission,
    completeStartBindingPreparation: unsupportedTriggerAdmission,
    failStartBindingPreparation: unsupportedTriggerAdmission,
    resetStartBindingPreparation: unsupportedTriggerAdmission,
  };
  return store;
}
