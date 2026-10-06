import { randomUUID } from 'node:crypto';
import {
  waitCompletionEvents,
  WorkflowNotResumableError,
  WorkflowRunPauseConflictError,
  type IWorkflowStore,
  type WorkflowEventInput,
} from '@archon/workflows/store';
import {
  isApprovalContext,
  isWorkflowWaitContext,
  isScheduledWorkflowResume,
  pendingWorkflowWaitDeadline,
  workflowRunStatusSchema,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { inMemoryDagResumeSnapshot } from '@archon/workflows/test-utils';
import type { IWorkflowHostStore } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';

const unsupported = async (): Promise<never> => {
  throw new Error('Unsupported test-store operation');
};

export function createInMemoryWorkflowHostStore(): IWorkflowHostStore {
  const codebases = new Map<string, Codebase>();
  return {
    codebases: {
      getCodebase: async id => codebases.get(id) ?? null,
      listCodebases: async () => [...codebases.values()],
      findCodebaseByDefaultCwd: async cwd =>
        [...codebases.values()].find(row => row.default_cwd === cwd) ?? null,
      findCodebaseByPathPrefix: async cwd =>
        [...codebases.values()]
          .filter(row => cwd.startsWith(`${row.default_cwd}/`))
          .sort((a, b) => b.default_cwd.length - a.default_cwd.length)[0] ?? null,
      findCodebaseByName: async name =>
        [...codebases.values()].find(row => row.name === name) ?? null,
      findCodebaseByRepoUrl: async url =>
        [...codebases.values()].find(row => row.repository_url === url) ?? null,
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
    users: { getUserById: unsupported, findOrCreateUserByPlatformIdentity: unsupported },
    conversations: { getConversationById: unsupported, updateConversation: unsupported },
    messages: { addMessage: unsupported },
    isolation: {
      getById: unsupported,
      create: unsupported,
      updateStatus: unsupported,
      countActiveByCodebase: unsupported,
      findActiveByWorkflow: unsupported,
      listByCodebase: async () => [],
      findLatestByCodebaseAndWorkingPath: async () => null,
    },
  };
}

export function createInMemoryWorkflowStore(records: IWorkflowHostStore): IWorkflowStore {
  const runs = new Map<string, WorkflowRun>();
  const events: WorkflowEventRow[] = [];
  const row = (id: string): WorkflowRun => {
    const run = runs.get(id);
    if (!run) throw new Error(`Run missing: ${id}`);
    return run;
  };
  const record = (input: WorkflowEventInput): void => {
    events.push({
      id: randomUUID(),
      workflow_run_id: input.workflow_run_id,
      event_type: input.event_type,
      step_name: input.step_name ?? null,
      step_index: input.step_index ?? null,
      data: structuredClone(input.data ?? {}),
      created_at: new Date().toISOString(),
      event_order: events.length,
    });
  };
  const listEvents = (id: string): WorkflowEventRow[] =>
    structuredClone(events.filter(event => event.workflow_run_id === id));
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
            if (wait)
              return (
                Date.parse(wait.resumeAt) <= now.getTime() ||
                (wait.kind === 'event' && wait.signaledAt !== undefined)
              );
            const scheduled = run.metadata.scheduled_resume;
            return (
              run.status === 'failed' &&
              isScheduledWorkflowResume(scheduled) &&
              !scheduled.triggeredAt &&
              Date.parse(scheduled.resumeAt) <= now.getTime()
            );
          })
          .slice(0, limit)
      ),
    deferWorkflowContinuation: async (
      id,
      retryAt,
      cursor
    ): ReturnType<IWorkflowStore['deferWorkflowContinuation']> => {
      const run = row(id);
      const wait = pendingWorkflowWaitDeadline(run);
      const scheduled = run.metadata.scheduled_resume;
      if (
        cursor.kind === 'wait'
          ? wait?.nodeId === cursor.nodeId && wait.resumeAt === cursor.resumeAt
          : run.status === 'failed' &&
            isScheduledWorkflowResume(scheduled) &&
            !scheduled.triggeredAt &&
            scheduled.attempt === cursor.attempt &&
            scheduled.resumeAt === cursor.resumeAt
      ) {
        run.metadata.continuation_retry_at = retryAt;
      }
    },
    signalWorkflowWait: async (
      id,
      expected,
      payload
    ): ReturnType<IWorkflowStore['signalWorkflowWait']> => {
      const run = row(id);
      const wait = run.metadata.wait;
      if (
        run.status !== 'paused' ||
        !isWorkflowWaitContext(wait) ||
        wait.kind !== 'event' ||
        wait.signaledAt ||
        wait.event !== expected.event ||
        wait.nodeId !== expected.nodeId ||
        wait.resumeAt !== expected.resumeAt ||
        Date.parse(wait.resumeAt) <= Date.now()
      )
        return { signaled: false };
      run.metadata.wait = {
        ...wait,
        signaledAt: new Date().toISOString(),
        ...(payload === undefined ? {} : { payload: structuredClone(payload) }),
      };
      record({
        workflow_run_id: id,
        event_type: 'wait_signaled',
        step_name: wait.nodeId,
        data: { event: wait.event, payload },
      });
      return { signaled: true };
    },
    createWorkflowRun: async (input): ReturnType<IWorkflowStore['createWorkflowRun']> => {
      const origin =
        input.origin && Object.values(input.origin).some(value => value !== undefined)
          ? structuredClone(input.origin)
          : null;
      const run: WorkflowRun = {
        id: input.id ?? randomUUID(),
        workflow_name: input.workflow_name,
        origin,
        conversation_id: origin?.conversationId ?? null,
        parent_conversation_id: origin?.parentConversationId ?? null,
        user_id: origin?.userId ?? null,
        user_message: input.user_message,
        metadata: structuredClone(input.metadata ?? {}),
        codebase_id: input.codebase_id ?? null,
        status: 'pending',
        outcome: null,
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: input.working_path ?? null,
        output_root: null,
        checkout_baseline: null,
        parent_run_id: input.parent_run_id ?? null,
        adopted_from_run_id: input.adopted_from_run_id ?? null,
      };
      if (runs.has(run.id)) throw new Error('Duplicate run');
      runs.set(run.id, run);
      return structuredClone(run);
    },
    getWorkflowRun: async id => structuredClone(runs.get(id) ?? null),
    getWorkflowRunStatus: async id => runs.get(id)?.status ?? null,
    claimPendingWorkflowRun: async (id): ReturnType<IWorkflowStore['claimPendingWorkflowRun']> => {
      const run = row(id);
      if (run.status !== 'pending') return null;
      run.status = 'running';
      return structuredClone(run);
    },
    updateWorkflowRun: async (id, updates): ReturnType<IWorkflowStore['updateWorkflowRun']> => {
      const run = row(id);
      Object.assign(run, updates, {
        metadata: { ...run.metadata, ...updates.metadata },
        output_root: run.output_root ?? updates.output_root ?? null,
        working_path: run.working_path ?? updates.working_path ?? null,
      });
    },
    updateWorkflowActivity: async (id): ReturnType<IWorkflowStore['updateWorkflowActivity']> => {
      row(id).last_activity_at = new Date();
    },
    recordWorkflowRunCheckoutBaseline: async (
      id,
      baseline
    ): ReturnType<IWorkflowStore['recordWorkflowRunCheckoutBaseline']> => {
      const run = row(id);
      run.checkout_baseline ??= structuredClone(baseline);
      return structuredClone(run.checkout_baseline);
    },
    completeWorkflowRun: async (
      id,
      completion,
      metadata
    ): ReturnType<IWorkflowStore['completeWorkflowRun']> => {
      const run = row(id);
      if (run.status !== 'running') return;
      run.status = 'completed';
      run.completed_at = new Date();
      Object.assign(run.metadata, metadata);
      record({ workflow_run_id: id, event_type: 'workflow_completed', data: completion });
    },
    failWorkflowRun: async (id, error, options): ReturnType<IWorkflowStore['failWorkflowRun']> => {
      const run = row(id);
      if (run.status !== 'running' && run.status !== 'pending') return;
      run.status = 'failed';
      run.completed_at = new Date();
      record({ workflow_run_id: id, event_type: 'workflow_failed', data: { error, ...options } });
    },
    pauseWorkflowRun: async (
      id,
      approval,
      metadata,
      suspension
    ): ReturnType<IWorkflowStore['pauseWorkflowRun']> => {
      const run = row(id);
      if (run.status !== 'running') throw new WorkflowRunPauseConflictError(id);
      run.status = 'paused';
      run.metadata = { ...run.metadata, ...metadata, approval: structuredClone(approval) };
      if (suspension) record(suspension);
    },
    resolveApprovalGate: async (
      id,
      metadata,
      gateEvents
    ): ReturnType<IWorkflowStore['resolveApprovalGate']> => {
      const run = row(id);
      const approval = run.metadata.approval;
      if (run.status !== 'paused' || !isApprovalContext(approval) || approval.resolved)
        return { resolved: false };
      Object.assign(run.metadata, structuredClone(metadata));
      for (const event of gateEvents) record({ ...event, workflow_run_id: id });
      return { resolved: true };
    },
    resumeWorkflowRun: async (id, cursor): ReturnType<IWorkflowStore['resumeWorkflowRun']> => {
      const run = row(id);
      if (run.status !== 'paused' && run.status !== 'failed')
        throw new WorkflowNotResumableError(id, run.status);
      if (cursor) {
        const wait = pendingWorkflowWaitDeadline(run);
        const scheduled = run.metadata.scheduled_resume;
        const matches =
          cursor.kind === 'wait'
            ? wait?.nodeId === cursor.nodeId && wait.resumeAt === cursor.resumeAt
            : run.status === 'failed' &&
              isScheduledWorkflowResume(scheduled) &&
              !scheduled.triggeredAt &&
              scheduled.attempt === cursor.attempt &&
              scheduled.resumeAt === cursor.resumeAt;
        if (!matches) throw new WorkflowNotResumableError(id, run.status);
      }
      delete run.metadata.continuation_retry_at;
      run.status = 'running';
      run.completed_at = null;
      return structuredClone(run);
    },
    createWorkflowEvent: async (input): ReturnType<IWorkflowStore['createWorkflowEvent']> => {
      record(input);
    },
    persistWorkflowEvent: async (input): ReturnType<IWorkflowStore['persistWorkflowEvent']> => {
      record(input);
    },
    persistWorkflowEventIfRunning: async (
      input,
      options
    ): ReturnType<IWorkflowStore['persistWorkflowEventIfRunning']> => {
      const status = row(input.workflow_run_id).status;
      if (status !== 'running' && !(options?.allowPaused && status === 'paused'))
        return { persisted: false };
      record(input);
      return { persisted: true };
    },
    listWorkflowEvents: async (id, options) =>
      listEvents(id).filter(event => !options?.excludeEventTypes?.includes(event.event_type)),
    listEventsForRuns: async (ids, types) =>
      new Map(
        ids.map(id => [
          id,
          listEvents(id).filter(event => types.some(type => type === event.event_type)),
        ])
      ),
    getDagResumeSnapshot: async id =>
      inMemoryDagResumeSnapshot(
        events.map(event => ({ ...event, step_name: event.step_name ?? undefined })),
        id
      ),
    findChildRuns: async id =>
      structuredClone([...runs.values()].filter(run => run.parent_run_id === id)),
    getRunAncestry: async (id): ReturnType<IWorkflowStore['getRunAncestry']> => {
      const ancestors: WorkflowRun[] = [];
      let parent = row(id).parent_run_id;
      while (parent) {
        const run = row(parent);
        ancestors.push(structuredClone(run));
        parent = run.parent_run_id;
      }
      return ancestors;
    },
    getActiveWorkflowRunByPath: async (path, self) =>
      structuredClone(
        [...runs.values()].find(
          run =>
            run.working_path === path &&
            run.id !== self?.id &&
            ['pending', 'running', 'paused'].includes(run.status)
        ) ?? null
      ),
    findResumableRun: async (name, path) =>
      structuredClone(
        [...runs.values()].find(
          run =>
            run.workflow_name === name &&
            run.working_path === path &&
            ['paused', 'failed'].includes(run.status)
        ) ?? null
      ),
    findWorkflowRunsByIdPrefix: async (prefix, codebaseId) =>
      structuredClone(
        [...runs.values()].filter(
          run => run.id.startsWith(prefix) && run.codebase_id === codebaseId
        )
      ),
    findAdoptingRuns: async id =>
      structuredClone([...runs.values()].filter(run => run.adopted_from_run_id === id)),
    findOpenWorkRuns: async options =>
      structuredClone(
        [...runs.values()]
          .filter(
            run =>
              (!options?.codebaseId || run.codebase_id === options.codebaseId) &&
              ['paused', 'failed', 'cancelled'].includes(run.status)
          )
          .slice(0, options?.limit ?? 50)
      ),
    listWorkflowRuns: async (options): ReturnType<IWorkflowStore['listWorkflowRuns']> => {
      const scoped = [...runs.values()].filter(
        run => !options?.codebaseId || run.codebase_id === options.codebaseId
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
        const codebase = run.codebase_id
          ? await records.codebases.getCodebase(run.codebase_id)
          : null;
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
    getCodebase: id => records.codebases.getCodebase(id),
    getCodebaseEnvVars: async () => ({}),
    listProviderEvents: async () => [],
    listWorkflowNodeSessions: async () => [],
    listWorkflowRunNodeSessions: async () => [],
    upsertWorkflowRunNodeSession: unsupported,
    upsertWorkflowNodeSession: unsupported,
    deleteWorkflowNodeSessions: unsupported,
    deleteOldWorkflowRuns: unsupported,
    resolveAndCancelApprovalGate: unsupported,
    cancelResumableRunsForConversation: unsupported,
    cancelWorkflowRun: unsupported,
    cancelFanOutRun: unsupported,
    recoverCancelledFanOutRun: unsupported,
    pauseWorkflowRunForWait: async (
      id,
      wait,
      pause
    ): ReturnType<IWorkflowStore['pauseWorkflowRunForWait']> => {
      const run = row(id);
      if (run.status !== 'running') throw new WorkflowRunPauseConflictError(id);
      run.status = 'paused';
      run.metadata.wait = structuredClone(wait);
      if (pause.kind === 'started')
        record({
          workflow_run_id: id,
          event_type: 'wait_started',
          step_name: pause.stepName,
          data: { wait },
        });
    },
    failPausedAttentionWait: unsupported,
    clearWorkflowWaitContext: async (
      id,
      wait,
      completion
    ): ReturnType<IWorkflowStore['clearWorkflowWaitContext']> => {
      const run = row(id);
      if (run.status !== 'running' || JSON.stringify(run.metadata.wait) !== JSON.stringify(wait))
        return { cleared: false };
      delete run.metadata.wait;
      const rows = waitCompletionEvents(id, completion);
      record(rows.outcome);
      record(rows.node);
      return { cleared: true, nodeEvent: rows.node };
    },
    failPausedApproval: unsupported,
    claimWriteback: unsupported,
    releaseWritebackClaim: unsupported,
  };
}
