import { createInMemoryStateDocumentStore } from './state-document-store';
import { createInMemoryResourceStartStore } from './resource-start-store';
import { resumeRefusal } from '@archon/workflows/resource-start-store';
import { releaseRunScratch } from '@archon/workflows/run-scratch';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { isPathInside } from '@archon/paths';
import {
  WorkflowEventCursorError,
  WorkflowResourceBusyError,
  pauseCursorMatches,
  type IWorkflowStore,
  type WorkflowEventCursor,
  type WorkflowNodeSession,
  type WorkflowRunNodeSession,
} from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';
import {
  createTransactionView,
  TERMINAL_RUN_EVENT_TYPES,
  type TransactionView,
} from '@archon/workflows/file-store';
import type { IWorkflowHostStore } from '@archon/core/workflows/host-store';
import type { User } from '@archon/core/schemas/user';
import type { Codebase } from '@archon/core/schemas/codebase';

const unsupported = async (): Promise<never> => {
  throw new Error('Unsupported test-store operation');
};

export function createInMemoryWorkflowHostStore(): IWorkflowHostStore {
  const codebases = new Map<string, Codebase>();
  const users = new Map<string, User>();
  const identities = new Map<string, string>();
  return {
    codebases: {
      getCodebase: async id => codebases.get(id) ?? null,
      listCodebases: async () => [...codebases.values()],
      listCodebaseClaims: async () => [...codebases.values()],
      findCodebaseByDefaultCwd: async cwd =>
        [...codebases.values()].find(row => row.default_cwd === cwd) ?? null,
      findCodebaseByPathPrefix: async cwd =>
        [...codebases.values()]
          .filter(row => isPathInside(row.default_cwd, cwd, { includeRoot: true, lexical: true }))
          .sort((a, b) => resolve(b.default_cwd).length - resolve(a.default_cwd).length)[0] ?? null,
      findCodebaseByName: async name =>
        [...codebases.values()].find(row => row.name === name) ?? null,
      findCodebaseByRepoUrl: async url =>
        [...codebases.values()].find(row => row.repository_url === url) ?? null,
      removeUnregisteredCheckout: unsupported,
      createCodebase: async (
        input
      ): ReturnType<IWorkflowHostStore['codebases']['createCodebase']> => {
        const row: Codebase = {
          id: randomUUID(),
          name: input.name,
          default_cwd: input.default_cwd,
          repository_url: input.repository_url ?? null,
          default_branch: input.default_branch ?? null,
          ai_assistant_type: input.ai_assistant_type ?? null,
          kind: input.kind ?? 'repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        codebases.set(row.id, row);
        return structuredClone(row);
      },
      updateCodebase: async (
        target,
        input
      ): ReturnType<IWorkflowHostStore['codebases']['updateCodebase']> => {
        Object.assign(codebases.get(target.id) ?? {}, input);
      },
      getCodebaseCommands: async id => structuredClone(codebases.get(id)?.commands ?? {}),
      updateCodebaseCommands: async (
        id,
        commands
      ): ReturnType<IWorkflowHostStore['codebases']['updateCodebaseCommands']> => {
        const row = codebases.get(id);
        if (!row) throw new Error('Codebase missing');
        row.commands = structuredClone(commands);
      },
    },
    users: {
      getUserById: async id => structuredClone(users.get(id) ?? null),
      findOrCreateUserByPlatformIdentity: async (
        platform,
        id,
        displayName
      ): ReturnType<IWorkflowHostStore['users']['findOrCreateUserByPlatformIdentity']> => {
        const key = JSON.stringify([platform, id]);
        const existing = identities.get(key);
        if (existing) {
          const user = users.get(existing);
          if (!user) throw new Error('Identity names a missing user');
          return structuredClone(user);
        }
        const user: User = {
          id: randomUUID(),
          display_name: displayName ?? null,
          email: null,
          role: 'member',
          created_at: new Date(),
          updated_at: new Date(),
        };
        identities.set(key, user.id);
        users.set(user.id, user);
        return structuredClone(user);
      },
    },
    conversations: { getConversationById: unsupported, updateConversation: unsupported },
    messages: { addMessage: unsupported },
    isolation: {
      getById: unsupported,
      create: unsupported,
      updateStatus: unsupported,
      withWorktreeRegistration: unsupported,
      markWorktreeDestroyed: unsupported,
      updateMetadata: unsupported,
      countActiveByCodebase: unsupported,
      findActiveByWorkflow: unsupported,
      listByCodebase: async () => [],
      listActive: async () => [],
      findLatestByCodebaseAndWorkingPath: async () => null,
    },
  };
}

type InMemoryWorkflowStore = IWorkflowStore &
  Pick<WorkflowStoreHarness, 'backdate' | 'seedPersistedWait'>;

/**
 * The file store's transaction view over in-memory maps. Every operation runs on a copy and
 * replaces the state only when it succeeds, so a throwing CAS writes nothing, as in the file
 * store. One queue serializes them, standing in for the file-store lock.
 */
export function createInMemoryWorkflowStore(
  records: IWorkflowHostStore,
  onTerminal: (id: string) => void = () => undefined
): InMemoryWorkflowStore {
  let runs = new Map<string, WorkflowRun>();
  let events: WorkflowEventRow[] = [];
  let eventOrder = 0;
  const feed: { cursor: WorkflowEventCursor; event: WorkflowEventRow }[] = [];
  const cursor = (order: number): WorkflowEventCursor => `memory:${order}` as WorkflowEventCursor;
  const sessions = new Map<string, WorkflowNodeSession>();
  const runSessions = new Map<string, WorkflowRunNodeSession>();
  const getCodebase: IWorkflowStore['getCodebase'] = id => records.codebases.getCodebase(id);
  const afterTerminal = async (id: string): Promise<void> => {
    const run = runs.get(id);
    if (run) await releaseRunScratch(run);
    onTerminal(id);
  };
  // Unqueued: admission calls it from inside its own queued operation.
  const apply = async <T>(call: (view: TransactionView) => Promise<T>): Promise<T> => {
    const nextRuns = structuredClone(runs);
    const nextEvents = structuredClone(events);
    const result = await call(createTransactionView(nextRuns, nextEvents, getCodebase));
    const priorIds = new Set(events.map(event => event.id));
    for (const id of runs.keys()) {
      if (nextRuns.has(id)) continue;
      for (const [key, session] of runSessions)
        if (session.workflow_run_id === id) runSessions.delete(key);
      for (const session of sessions.values())
        if (session.last_run_id === id) session.last_run_id = null;
    }
    for (const event of nextEvents) {
      if (!priorIds.has(event.id))
        feed.push({ cursor: cursor(++eventOrder), event: structuredClone(event) });
    }
    runs = nextRuns;
    events = nextEvents;
    for (const event of nextEvents)
      if (
        !priorIds.has(event.id) &&
        TERMINAL_RUN_EVENT_TYPES.some(type => type === event.event_type)
      )
        await afterTerminal(event.workflow_run_id);
    return result;
  };
  let queue: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const write = <T>(call: (view: TransactionView) => Promise<T>): Promise<T> =>
    serialize(() => apply(call));
  const admission = createInMemoryResourceStartStore(
    input => apply(view => view.createWorkflowRun(input)),
    async id => structuredClone(runs.get(id) ?? null)
  );
  const admit =
    <Args extends unknown[], Result>(
      operation: (...args: Args) => Promise<Result>
    ): ((...args: Args) => Promise<Result>) =>
    (...args) =>
      serialize(() => operation(...args));
  return {
    ...createInMemoryStateDocumentStore(),
    admitResourceStart: admit(admission.admitResourceStart.bind(admission)),
    drainResourceStarts: admit(admission.drainResourceStarts.bind(admission)),
    hasStartReceiptForDelivery: admit(admission.hasStartReceiptForDelivery.bind(admission)),
    acceptStartReceipt: admit(admission.acceptStartReceipt.bind(admission)),
    getStartReceipt: admit(admission.getStartReceipt.bind(admission)),
    listStartReceipts: admit(admission.listStartReceipts.bind(admission)),
    listPendingStartBindings: admit(admission.listPendingStartBindings.bind(admission)),
    getResourceStartRequest: admit(admission.getResourceStartRequest.bind(admission)),
    listQueuedResourceStartsForHost: admit(
      admission.listQueuedResourceStartsForHost.bind(admission)
    ),
    withdrawQueuedResourceStart: admit(admission.withdrawQueuedResourceStart.bind(admission)),
    claimStartBindingPreparation: admit(admission.claimStartBindingPreparation.bind(admission)),
    completeStartBindingPreparation: admit(
      admission.completeStartBindingPreparation.bind(admission)
    ),
    failStartBindingPreparation: admit(admission.failStartBindingPreparation.bind(admission)),
    resetStartBindingPreparation: admit(admission.resetStartBindingPreparation.bind(admission)),
    backdate: (id, dates) =>
      serialize(async () => {
        const run = runs.get(id);
        if (!run) throw new Error(`Run missing: ${id}`);
        Object.assign(run, structuredClone(dates));
      }),
    seedPersistedWait: (id, wait) =>
      serialize(async () => {
        const run = runs.get(id);
        if (!run) throw new Error(`Run missing: ${id}`);
        run.metadata.wait = structuredClone(wait);
      }),
    getCodebase,
    getCodebaseEnvVars: async () => ({}),
    createWorkflowRun: input => write(view => view.createWorkflowRun(input)),
    getWorkflowRun: id => write(view => view.getWorkflowRun(id)),
    getWorkflowRunStatus: id => write(view => view.getWorkflowRunStatus(id)),
    claimPendingWorkflowRun: (id, path) => write(view => view.claimPendingWorkflowRun(id, path)),
    updateWorkflowRun: (id, updates) => write(view => view.updateWorkflowRun(id, updates)),
    updateWorkflowRunMetadataIfRunning: (id, metadata) =>
      write(view => view.updateWorkflowRunMetadataIfRunning(id, metadata)),
    updateWorkflowActivity: id => write(view => view.updateWorkflowActivity(id)),
    recordWorkflowRunCheckoutBaseline: (id, baseline) =>
      write(view => view.recordWorkflowRunCheckoutBaseline(id, baseline)),
    resumeWorkflowRun: async (id, cursor) => {
      // A paused run's first refusal commits its capacity wait, so it is thrown after the write.
      const outcome = await write(async view => {
        const run = view.resumableRun(id, cursor);
        const blocker = await admission.resume(run);
        if (!blocker) return view.resumeWorkflowRun(id, cursor);
        const busy = new WorkflowResourceBusyError(id, blocker, resumeRefusal(run, cursor));
        if (busy.refusal !== 'waiting' || !view.recordCapacityWait(id)) throw busy;
        return busy;
      });
      if (outcome instanceof WorkflowResourceBusyError) throw outcome;
      return outcome;
    },
    releasePausedRunSlot: (id, cursor) =>
      write(async view => {
        const run = await view.getWorkflowRun(id);
        if (!run || !pauseCursorMatches(run, cursor)) return { released: false };
        const released = await admission.release(id);
        if (released) view.clearCapacityWait(id);
        return { released };
      }),
    recoverCancelledFanOutRun: id => write(view => view.recoverCancelledFanOutRun(id)),
    pauseWorkflowRun: (id, approval, extra, event) =>
      write(view => view.pauseWorkflowRun(id, approval, extra, event)),
    pauseWorkflowRunForWait: (id, wait, pause) =>
      write(view => view.pauseWorkflowRunForWait(id, wait, pause)),
    releaseRunForUnreadableSource: (id, release, beforePublish) =>
      write(view => view.releaseRunForUnreadableSource(id, release, beforePublish)),
    clearWorkflowWaitContext: (id, wait, completion) =>
      write(view => view.clearWorkflowWaitContext(id, wait, completion)),
    resolveApprovalGate: (id, metadata, gateEvents, expected) =>
      write(view => view.resolveApprovalGate(id, metadata, gateEvents, expected)),
    resolveAndCancelApprovalGate: (id, gateEvents, cancellation, expected) =>
      write(view => view.resolveAndCancelApprovalGate(id, gateEvents, cancellation, expected)),
    completeWorkflowRun: (id, completion, metadata) =>
      write(view => view.completeWorkflowRun(id, completion, metadata)),
    failWorkflowRun: (id, error, options) =>
      write(view => view.failWorkflowRun(id, error, options)),
    cancelWorkflowRun: (id, details) => write(view => view.cancelWorkflowRun(id, details)),
    cancelFanOutRun: (id, reason) => write(view => view.cancelFanOutRun(id, reason)),
    cancelResumableRunsForConversation: (id, assertMayCancel) =>
      write(view => view.cancelResumableRunsForConversation(id, assertMayCancel)),
    claimWriteback: id => write(view => view.claimWriteback(id)),
    releaseWritebackClaim: id => write(view => view.releaseWritebackClaim(id)),
    setToolCallAttention: (id, streamId, calls) =>
      write(view => view.setToolCallAttention(id, streamId, calls)),
    // The port forbids throwing here; a missing run drops the observability event.
    createWorkflowEvent: input =>
      write(view => view.createWorkflowEvent(input)).catch(() => undefined),
    persistWorkflowEvent: input => write(view => view.persistWorkflowEvent(input)),
    persistWorkflowEventIfRunning: (input, options) =>
      write(view => view.persistWorkflowEventIfRunning(input, options)),
    getWorkflowEventHead: () => serialize(async () => cursor(eventOrder)),
    readWorkflowEventsAfter: (after, { limit, eventTypes }) =>
      serialize(async () => {
        if (!/^memory:(0|[1-9][0-9]*)$/.test(after)) throw new WorkflowEventCursorError();
        const order = Number(after.slice(7));
        if (!Number.isSafeInteger(order) || order > eventOrder)
          throw new WorkflowEventCursorError();
        if (!Number.isSafeInteger(limit) || limit <= 0)
          throw new RangeError('limit must be a positive integer');
        const scanned = feed.slice(order, order + limit);
        return {
          events: structuredClone(
            scanned.filter(
              ({ event }) =>
                eventTypes === undefined || eventTypes.some(type => type === event.event_type)
            )
          ),
          next: scanned.at(-1)?.cursor ?? after,
        };
      }),
    listWorkflowEvents: (id, options) => write(view => view.listWorkflowEvents(id, options)),
    listEventsForRuns: (ids, types) => write(view => view.listEventsForRuns(ids, types)),
    getDagResumeSnapshot: id => write(view => view.getDagResumeSnapshot(id)),
    listProviderEvents: (id, query) => write(view => view.listProviderEvents(id, query)),
    findChildRuns: id => write(view => view.findChildRuns(id)),
    getRunAncestry: id => write(view => view.getRunAncestry(id)),
    getActiveWorkflowRunByPath: (path, self) =>
      write(view => view.getActiveWorkflowRunByPath(path, self)),
    findResumableRun: (name, path) => write(view => view.findResumableRun(name, path)),
    findWorkflowRunsByIdPrefix: (prefix, codebase) =>
      write(view => view.findWorkflowRunsByIdPrefix(prefix, codebase)),
    findAdoptingRuns: id => write(view => view.findAdoptingRuns(id)),
    findOpenWorkRuns: options => write(view => view.findOpenWorkRuns(options)),
    listWorkflowRuns: options => write(view => view.listWorkflowRuns(options)),
    listDueWorkflowContinuations: (now, limit) =>
      write(view => view.listDueWorkflowContinuations(now, limit)),
    deferWorkflowContinuation: (id, retry, cursor) =>
      write(view => view.deferWorkflowContinuation(id, retry, cursor)),
    answerAttentionWait: (id, answered) => write(view => view.answerAttentionWait(id, answered)),
    labelAttentionWait: (id, labelWrite) => write(view => view.labelAttentionWait(id, labelWrite)),
    listAttentionQueueRows: () => write(view => view.listAttentionQueueRows()),
    signalWorkflowWait: (id, wait, payload) =>
      write(view => view.signalWorkflowWait(id, wait, payload)),
    deleteOldWorkflowRuns: days => write(view => view.deleteOldWorkflowRuns(days)),
    listWorkflowNodeSessions: async scope =>
      structuredClone(
        [...sessions.values()].filter(
          session =>
            session.workflow_name === scope.workflow_name && session.scope_key === scope.scope_key
        )
      ),
    listWorkflowRunNodeSessions: async id =>
      structuredClone(
        [...runSessions.values()]
          .filter(session => session.workflow_run_id === id)
          .sort((a, b) => a.node_id.localeCompare(b.node_id))
      ),
    upsertWorkflowRunNodeSession: input =>
      serialize(async () => {
        const key = JSON.stringify([input.workflow_run_id, input.node_id]);
        const prior = runSessions.get(key);
        runSessions.set(key, {
          ...input,
          created_at: prior?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }),
    upsertWorkflowNodeSession: input =>
      serialize(async () => {
        const key = JSON.stringify([
          input.workflow_name,
          input.node_id,
          input.scope_key,
          input.provider,
        ]);
        const prior = sessions.get(key);
        sessions.set(key, {
          ...input,
          created_at: prior?.created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }),
    deleteWorkflowNodeSessions: filter =>
      serialize(async () => {
        let deleted = 0;
        for (const [key, session] of sessions)
          if (
            session.workflow_name === filter.workflow_name &&
            (filter.scope_key === undefined || session.scope_key === filter.scope_key) &&
            (filter.node_id === undefined || session.node_id === filter.node_id)
          ) {
            sessions.delete(key);
            deleted++;
          }
        return { deleted };
      }),
  };
}
