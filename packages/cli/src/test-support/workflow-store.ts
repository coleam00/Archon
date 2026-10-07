import { randomUUID } from 'node:crypto';
import {
  WorkflowNotResumableError,
  WorkflowRunPauseConflictError,
  type IWorkflowStore,
  type WorkflowEventInput,
  waitCompletionEvents,
  FAN_OUT_CANCEL_REASONS,
} from '@archon/workflows/store';
import {
  isApprovalContext,
  isTerminalRunStatus,
  workflowRunStatusSchema,
  isWorkflowWaitContext,
  isScheduledWorkflowResume,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowStoreHarness } from '@archon/workflows/store-conformance';
import { foldDagResumeSnapshot } from '@archon/workflows/dag-resume-snapshot';
import { buildTerminalRecord } from '@archon/workflows/terminal-record';
import { isDeepStrictEqual } from 'node:util';
import {
  orderProviderEventRecords,
  providerEventRecordsAfter,
  providerEventEnvelopeSchema,
  type ProviderEventRecord,
} from '@archon/workflows/schemas/provider-event';
import type { WorkflowNodeSession, WorkflowRunNodeSession } from '@archon/workflows/store';
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

type InMemoryWorkflowStore = IWorkflowStore & Pick<WorkflowStoreHarness, 'backdate'>;

export function createInMemoryWorkflowStore(
  records: IWorkflowHostStore,
  onTerminal: (id: string) => void = () => undefined
): InMemoryWorkflowStore {
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
  const sessions = new Map<string, WorkflowNodeSession>();
  const runSessions = new Map<string, WorkflowRunNodeSession>();
  const newest = (rows: WorkflowRun[]): WorkflowRun[] =>
    rows.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
  const resumable = (run: WorkflowRun): boolean =>
    run.status === 'paused' ||
    run.status === 'failed' ||
    (run.status === 'running' &&
      (run.last_activity_at === null || run.last_activity_at.getTime() < Date.now() - 86_400_000));
  const gateOpen = (
    run: WorkflowRun,
    expected: Parameters<IWorkflowStore['resolveApprovalGate']>[3]
  ): boolean => {
    const gate = run.metadata.approval;
    if (run.status !== 'paused' || !isApprovalContext(gate) || gate.resolved != null) return false;
    if (expected === undefined) return true;
    return (
      gate.nodeId === (typeof expected === 'string' ? expected : expected.nodeId) &&
      (gate.pauseId ?? null) === (typeof expected === 'string' ? null : expected.pauseId)
    );
  };
  // All writers share the queue: resume and event writes must not overtake terminal projection.
  let writes: Promise<void> = Promise.resolve();
  const serialize =
    <Args extends unknown[], Result>(
      write: (...args: Args) => Promise<Result>
    ): ((...args: Args) => Promise<Result>) =>
    (...args) => {
      const result = writes.then(() => write(...args));
      writes = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    };
  interface TerminalChange {
    run: WorkflowRun;
    event: WorkflowEventInput;
    precedingEvents?: WorkflowEventInput[];
  }
  const terminalBatch = async (changes: TerminalChange[]): Promise<void> => {
    const prepared = await Promise.all(
      changes.map(async ({ run, event, precedingEvents = [] }) => {
        run.completed_at = new Date();
        const terminalRecord = await buildTerminalRecord({
          run,
          events: [
            ...listEvents(run.id),
            ...precedingEvents.map(event => ({ ...event, data: event.data ?? {} })),
          ],
        });
        return {
          run,
          precedingEvents,
          event: {
            ...event,
            data: { ...event.data, terminal_record: terminalRecord },
          },
        };
      })
    );
    for (const { run, precedingEvents, event } of prepared) {
      runs.set(run.id, run);
      for (const preceding of precedingEvents) record(preceding);
      record(event);
    }
    for (const { run } of prepared) onTerminal(run.id);
  };
  const terminal = async (
    run: WorkflowRun,
    event: WorkflowEventInput,
    precedingEvents: WorkflowEventInput[] = []
  ): Promise<void> => terminalBatch([{ run, event, precedingEvents }]);
  const store: InMemoryWorkflowStore = {
    backdate: serialize(async (id, dates) => {
      Object.assign(row(id), structuredClone(dates));
    }),
    createWorkflowRun: serialize(async (input): ReturnType<IWorkflowStore['createWorkflowRun']> => {
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
    }),
    getWorkflowRun: async id => structuredClone(runs.get(id) ?? null),
    getWorkflowRunStatus: async id => runs.get(id)?.status ?? null,
    claimPendingWorkflowRun: serialize(
      async (id, workingPath): ReturnType<IWorkflowStore['claimPendingWorkflowRun']> => {
        const run = row(id);
        if (run.status !== 'pending') return null;
        run.status = 'running';
        run.working_path ??= workingPath ?? null;
        run.last_activity_at = new Date();
        return structuredClone(run);
      }
    ),
    updateWorkflowRun: serialize(
      async (id, updates): ReturnType<IWorkflowStore['updateWorkflowRun']> => {
        const run = row(id);
        if (updates.status !== undefined && isTerminalRunStatus(updates.status))
          throw new Error('Terminal workflow status requires a lifecycle writer');
        Object.assign(run, updates, {
          metadata: { ...run.metadata, ...updates.metadata },
          output_root: run.output_root ?? updates.output_root ?? null,
          working_path: run.working_path ?? updates.working_path ?? null,
        });
      }
    ),
    updateWorkflowActivity: serialize(
      async (id): ReturnType<IWorkflowStore['updateWorkflowActivity']> => {
        row(id).last_activity_at = new Date();
      }
    ),
    recordWorkflowRunCheckoutBaseline: serialize(
      async (id, baseline): ReturnType<IWorkflowStore['recordWorkflowRunCheckoutBaseline']> => {
        const run = row(id);
        run.checkout_baseline ??= structuredClone(baseline);
        return structuredClone(run.checkout_baseline);
      }
    ),
    completeWorkflowRun: serialize(
      async (id, completion, metadata): ReturnType<IWorkflowStore['completeWorkflowRun']> => {
        const run = structuredClone(row(id));
        if (run.status !== 'running') throw new Error('Run not in running state');
        run.status = 'completed';
        Object.assign(run.metadata, metadata);
        await terminal(run, {
          workflow_run_id: id,
          event_type: 'workflow_completed',
          data: completion,
        });
      }
    ),
    failWorkflowRun: serialize(
      async (id, error, options): ReturnType<IWorkflowStore['failWorkflowRun']> => {
        const run = structuredClone(row(id));
        if (run.status !== 'running' && run.status !== 'pending')
          throw new Error('Run already terminal');
        run.status = 'failed';
        delete run.metadata.scheduled_resume;
        delete run.metadata.stop_reason;
        run.metadata.error = error;
        if (options?.exitReason)
          run.metadata.stop_reason = {
            reason: options.exitReason,
            ...(options.signal ? { signal: options.signal } : {}),
          };
        const precedingEvents: WorkflowEventInput[] = [];
        if (options?.scheduledResume) {
          run.metadata.scheduled_resume = structuredClone(options.scheduledResume);
          precedingEvents.push({
            workflow_run_id: id,
            event_type: 'quota_resume_scheduled',
            data: {
              resume_at: options.scheduledResume.resumeAt,
              deadline_at: options.scheduledResume.deadlineAt,
              attempt: options.scheduledResume.attempt,
              max_attempts: options.scheduledResume.maxAttempts,
            },
          });
        }
        await terminal(
          run,
          {
            workflow_run_id: id,
            event_type: 'workflow_failed',
            data: { error, ...(options?.exitReason ? { exit_reason: options.exitReason } : {}) },
          },
          precedingEvents
        );
      }
    ),
    pauseWorkflowRun: serialize(
      async (
        id,
        approval,
        metadata,
        suspension
      ): ReturnType<IWorkflowStore['pauseWorkflowRun']> => {
        const run = row(id);
        if (run.status !== 'running') throw new WorkflowRunPauseConflictError(id);
        run.status = 'paused';
        delete run.metadata.wait;
        run.metadata = { ...run.metadata, ...metadata, approval: structuredClone(approval) };
        if (suspension) record(suspension);
      }
    ),
    resolveApprovalGate: serialize(
      async (
        id,
        metadata,
        gateEvents,
        expected
      ): ReturnType<IWorkflowStore['resolveApprovalGate']> => {
        const run = row(id);
        if (!gateOpen(run, expected)) return { resolved: false };
        Object.assign(run.metadata, structuredClone(metadata));
        for (const event of gateEvents) record({ ...event, workflow_run_id: id });
        return { resolved: true };
      }
    ),
    resumeWorkflowRun: serialize(async (id, cursor) => {
      const run = row(id);
      const wait = run.metadata.wait;
      const scheduled = run.metadata.scheduled_resume;
      const matches =
        cursor === undefined ||
        (cursor.kind === 'wait'
          ? run.status === 'paused' &&
            isWorkflowWaitContext(wait) &&
            wait.kind !== 'attention' &&
            wait.nodeId === cursor.nodeId &&
            wait.resumeAt === cursor.resumeAt
          : run.status === 'failed' &&
            isScheduledWorkflowResume(scheduled) &&
            scheduled.triggeredAt === undefined &&
            scheduled.attempt === cursor.attempt &&
            scheduled.resumeAt === cursor.resumeAt);
      if (!resumable(run) || !matches) throw new WorkflowNotResumableError(id, run.status);
      if (typeof run.metadata.error === 'string' && run.metadata.error !== '')
        record({
          workflow_run_id: id,
          event_type: 'workflow_resumed',
          data: { error: run.metadata.error },
        });
      if (
        run.status === 'failed' &&
        isScheduledWorkflowResume(scheduled) &&
        scheduled.triggeredAt === undefined
      ) {
        run.metadata.scheduled_resume = { ...scheduled, triggeredAt: new Date().toISOString() };
        record({
          workflow_run_id: id,
          event_type: 'quota_resume_triggered',
          data: { attempt: scheduled.attempt, resume_at: scheduled.resumeAt },
        });
      }
      delete run.metadata.error;
      delete run.metadata.stop_reason;
      delete run.metadata.continuation_retry_at;
      run.status = 'running';
      run.completed_at = null;
      run.started_at = new Date();
      run.last_activity_at = new Date();
      return structuredClone(run);
    }),
    createWorkflowEvent: serialize(
      async (input): ReturnType<IWorkflowStore['createWorkflowEvent']> => {
        record(input);
      }
    ),
    persistWorkflowEvent: serialize(
      async (input): ReturnType<IWorkflowStore['persistWorkflowEvent']> => {
        record(input);
      }
    ),
    persistWorkflowEventIfRunning: serialize(
      async (input, options): ReturnType<IWorkflowStore['persistWorkflowEventIfRunning']> => {
        const status = row(input.workflow_run_id).status;
        if (status !== 'running' && !(options?.allowPaused && status === 'paused'))
          return { persisted: false };
        record(input);
        return { persisted: true };
      }
    ),
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
      let parent = row(id).parent_run_id;
      const seen = new Set([id]);
      while (parent && ancestors.length < 32 && !seen.has(parent)) {
        seen.add(parent);
        const run = row(parent);
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
              (run.status === 'running' ||
                run.status === 'paused' ||
                (run.status === 'pending' && run.started_at.getTime() > Date.now() - 300_000)) &&
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
        newest(
          [...runs.values()].filter(
            run => run.workflow_name === name && run.working_path === path && resumable(run)
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
      structuredClone(newest([...runs.values()].filter(run => run.adopted_from_run_id === id))),
    findOpenWorkRuns: async options =>
      structuredClone(
        newest(
          [...runs.values()].filter(
            run =>
              (!options?.codebaseId || run.codebase_id === options.codebaseId) &&
              run.status === 'failed' &&
              ![...runs.values()].some(other => other.adopted_from_run_id === run.id)
          )
        ).slice(0, options?.limit ?? 50)
      ),
    listWorkflowRuns: async (options): ReturnType<IWorkflowStore['listWorkflowRuns']> => {
      const scoped = [...runs.values()].filter(
        run =>
          (!options?.codebaseId || run.codebase_id === options.codebaseId) &&
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
    listProviderEvents: async (id, query = {}) => {
      const grouped = new Map<string, ProviderEventRecord[]>();
      for (const event of listEvents(id)) {
        if (
          event.event_type !== 'provider_event' ||
          !event.step_name ||
          (query.stepName !== undefined && event.step_name !== query.stepName)
        )
          continue;
        const envelope = providerEventEnvelopeSchema.parse(event.data);
        const rows = grouped.get(event.step_name) ?? [];
        rows.push({ ...envelope, stepName: event.step_name, runId: id });
        grouped.set(event.step_name, rows);
      }
      const ordered = [...grouped.values()].flatMap(rows => orderProviderEventRecords(rows));
      return query.after === undefined ? ordered : providerEventRecordsAfter(ordered, query.after);
    },
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
    upsertWorkflowRunNodeSession: serialize(async input => {
      const key = JSON.stringify([input.workflow_run_id, input.node_id]);
      const prior = runSessions.get(key);
      runSessions.set(key, {
        ...input,
        created_at: prior?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }),
    upsertWorkflowNodeSession: serialize(async input => {
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
    deleteWorkflowNodeSessions: serialize(async filter => {
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
    deleteOldWorkflowRuns: serialize(async days => {
      if (!Number.isInteger(days) || days < 0) throw new Error('Invalid olderThanDays');
      const ids = [...runs.values()]
        .filter(
          run =>
            isTerminalRunStatus(run.status) &&
            run.started_at.getTime() < Date.now() - days * 86_400_000
        )
        .map(run => run.id);
      for (const id of ids) {
        runs.delete(id);
        for (let i = events.length - 1; i >= 0; i--)
          if (events[i]?.workflow_run_id === id) events.splice(i, 1);
        for (const [key, session] of runSessions)
          if (session.workflow_run_id === id) runSessions.delete(key);
        for (const session of sessions.values())
          if (session.last_run_id === id) session.last_run_id = null;
        for (const run of runs.values()) {
          if (run.parent_run_id === id) run.parent_run_id = null;
          if (run.adopted_from_run_id === id) run.adopted_from_run_id = null;
        }
      }
      return { count: ids.length };
    }),
    resolveAndCancelApprovalGate: serialize(async (id, gateEvents, cancellation, expected) => {
      const run = structuredClone(row(id));
      if (!gateOpen(run, expected)) return { resolved: false };
      run.status = 'cancelled';
      await terminal(
        run,
        {
          workflow_run_id: id,
          event_type: 'workflow_cancelled',
          step_name: cancellation.step_name,
          data: {
            cancel_reason: 'approval_rejected',
            ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
          },
        },
        gateEvents.map(event => ({ ...event, workflow_run_id: id }))
      );
      return { resolved: true };
    }),
    cancelResumableRunsForConversation: serialize(async (id, assertMayCancel) => {
      const targets = newest(
        [...runs.values()].filter(
          run =>
            (run.conversation_id === id || run.parent_conversation_id === id) &&
            (run.status === 'paused' || run.status === 'failed')
        )
      );
      const prior = structuredClone(targets);
      assertMayCancel?.(structuredClone(prior));
      await terminalBatch(
        targets.map(target => ({
          run: { ...structuredClone(target), status: 'cancelled' },
          event: {
            workflow_run_id: target.id,
            event_type: 'workflow_cancelled',
            data: { cancel_reason: 'conversation_reset' },
          },
        }))
      );
      return prior;
    }),
    cancelWorkflowRun: serialize(async (id, details) => {
      const run = structuredClone(row(id));
      if (run.status === 'completed' || run.status === 'cancelled') return { cancelled: false };
      run.status = 'cancelled';
      await terminal(run, {
        workflow_run_id: id,
        event_type: 'workflow_cancelled',
        step_name: details?.step_name,
        data: {
          ...(details?.reason === undefined ? {} : { reason: details.reason }),
          ...(details?.cancel_reason === undefined ? {} : { cancel_reason: details.cancel_reason }),
        },
      });
      return { cancelled: true };
    }),
    cancelFanOutRun: serialize(async (id, reason) => {
      const run = structuredClone(row(id));
      if (run.status === 'completed' || run.status === 'cancelled') return { cancelled: false };
      run.status = 'cancelled';
      run.metadata.cancelled_reason = reason;
      await terminal(run, {
        workflow_run_id: id,
        event_type: 'workflow_cancelled',
        data: { reason, cancel_reason: 'fan_out' },
      });
      return { cancelled: true };
    }),
    recoverCancelledFanOutRun: serialize(async id => {
      const run = row(id);
      if (
        run.status !== 'cancelled' ||
        !FAN_OUT_CANCEL_REASONS.some(reason => reason === run.metadata.cancelled_reason)
      )
        throw new Error('Not an engine-cancelled fan-out child');
      run.status = 'running';
      run.completed_at = null;
      run.started_at = new Date();
      run.last_activity_at = new Date();
      delete run.metadata.cancelled_reason;
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (
          event?.workflow_run_id === id &&
          event.event_type === 'workflow_cancelled' &&
          FAN_OUT_CANCEL_REASONS.some(reason => reason === event.data.reason)
        )
          events.splice(index, 1);
      }
      return structuredClone(run);
    }),
    pauseWorkflowRunForWait: serialize(async (id, wait, pause) => {
      const run = row(id);
      if (run.status !== 'running') throw new WorkflowRunPauseConflictError(id);
      run.status = 'paused';
      delete run.metadata.approval;
      run.metadata.wait = structuredClone(wait);
      if (pause.kind === 'started')
        record({
          workflow_run_id: id,
          event_type: 'wait_started',
          step_name: pause.stepName,
          data: {
            kind: wait.kind,
            ...(wait.kind !== 'attention' ? { resume_at: wait.resumeAt } : {}),
            ...(wait.kind === 'event' ? { event: wait.event } : {}),
          },
        });
    }),
    failPausedAttentionWait: serialize(async (id, wait, error) => {
      const run = structuredClone(row(id));
      const current = run.metadata.wait;
      if (
        run.status !== 'paused' ||
        !isWorkflowWaitContext(current) ||
        current.kind !== 'attention' ||
        current.owner !== wait.owner ||
        current.nodeId !== wait.nodeId ||
        current.waitingSince !== wait.waitingSince ||
        (current.owner === 'loop_group' &&
          (wait.owner !== 'loop_group' ||
            current.bodyWaitId !== wait.bodyWaitId ||
            current.iteration !== wait.iteration))
      )
        return { failed: false };
      run.status = 'failed';
      run.metadata.error = error;
      delete run.metadata.scheduled_resume;
      await terminal(run, { workflow_run_id: id, event_type: 'workflow_failed', data: { error } });
      return { failed: true };
    }),
    clearWorkflowWaitContext: serialize(async (id, wait, completion) => {
      const run = row(id);
      const current = run.metadata.wait;
      if (
        run.status !== 'running' ||
        !isWorkflowWaitContext(current) ||
        current.nodeId !== wait.nodeId ||
        (current.kind === 'attention' ? current.waitingSince : current.resumeAt) !==
          (wait.kind === 'attention' ? wait.waitingSince : wait.resumeAt)
      )
        return { cleared: false };
      delete run.metadata.wait;
      const rows = waitCompletionEvents(id, completion);
      record(rows.outcome);
      record(rows.node);
      return { cleared: true, nodeEvent: rows.node };
    }),
    failPausedApproval: serialize(async (id, approval, error) => {
      const run = structuredClone(row(id));
      if (run.status !== 'paused' || !isDeepStrictEqual(run.metadata.approval, approval))
        return { failed: false };
      run.status = 'failed';
      run.metadata.error = error;
      run.metadata.stop_reason = { reason: 'node_error' };
      await terminal(run, {
        workflow_run_id: id,
        event_type: 'workflow_failed',
        data: { error, exit_reason: 'node_error' },
      });
      return { failed: true };
    }),
    claimWriteback: serialize(async id => {
      const run = row(id);
      if (run.metadata.writeback_apply_claimed === true) return { claimed: false };
      run.metadata.writeback_apply_claimed = true;
      return { claimed: true };
    }),
    releaseWritebackClaim: serialize(async id => {
      delete row(id).metadata.writeback_apply_claimed;
    }),
  };
  return store;
}
