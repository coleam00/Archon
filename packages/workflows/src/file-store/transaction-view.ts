import { prepareWorkflowRunFailure } from '../workflow-run-failure';
import { resumeRun } from './run-resume';
import {
  createTransactionReads,
  isResumable,
  listRunEvents,
  newestFirst,
} from './transaction-reads';
import {
  TERMINAL_RUN_EVENT_TYPE,
  CANCELLATION_NOOP_WORKFLOW_STATUSES,
  CAPACITY_WAIT_METADATA_KEY,
  TOOL_CALL_ATTENTION_METADATA_KEY,
  readCapacityWait,
  toolCallAttentionArraySchema,
} from '../schemas/workflow-run';
import { randomUUID } from 'node:crypto';
import {
  WorkflowNotResumableError,
  WorkflowRunPauseConflictError,
  type IWorkflowStore,
  type WorkflowEventInput,
  type WorkflowResumeCursor,
  waitCompletionEvents,
  FAN_OUT_CANCEL_REASONS,
  resumeCursorMatches,
  waitAnsweredEvent,
  labeledAttentionWait,
  answeredAttentionWait,
  attentionLabeledEvent,
  waitContinuedEvent,
  sourceReleaseMetadata,
  executionClaim,
  EXECUTION_CLAIM_METADATA_KEY,
  sourceReleasedEvent,
} from '../store';
import {
  isTerminalRunStatus,
  isWorkflowWaitContext,
  readWorkflowWaitContext,
  workflowWaitStepName,
  workflowWaitContextSchema,
  validateWorkflowWaitMetadata,
  type WorkflowRun,
} from '../schemas/workflow-run';
import type { WorkflowEventRow } from '../schemas/workflow-event';
import {
  PAUSE_CAUSE_METADATA_KEY,
  pauseCauseOfApproval,
  pauseCauseOfWait,
} from '../schemas/pause-cause';
import { buildTerminalRecord, observeRunArtifacts } from '../terminal-record';
import { isDeepStrictEqual } from 'node:util';

export type TransactionView = Omit<
  IWorkflowStore,
  | keyof import('../store').IWorkflowEventFeed
  | keyof import('../resource-start-store').IResourceStartStore
  | keyof import('../state-document-store').IStateDocumentStore
  | 'listWorkflowNodeSessions'
  | 'listWorkflowRunNodeSessions'
  | 'upsertWorkflowRunNodeSession'
  | 'upsertWorkflowNodeSession'
  | 'deleteWorkflowNodeSessions'
  | 'releasePausedRunSlot'
> & {
  /**
   * The run `resumeWorkflowRun(id, cursor)` would continue; throws what it would throw
   * otherwise. Lets a store decide slot admission before the resume changes anything.
   */
  resumableRun(id: string, cursor?: WorkflowResumeCursor): WorkflowRun;
  recordCapacityWait(id: string): void;
  clearCapacityWait(id: string): void;
};

export { TERMINAL_RUN_EVENT_TYPES } from '../schemas/workflow-run';

export function createTransactionView(
  runs: Map<string, WorkflowRun>,
  events: WorkflowEventRow[],
  getCodebase: IWorkflowStore['getCodebase']
): TransactionView {
  const row = (id: string): WorkflowRun => {
    const run = runs.get(id);
    if (!run) throw new Error(`Run missing: ${id}`);
    return run;
  };
  let eventOrder = events.reduce((max, event) => Math.max(max, event.event_order ?? 0), 0);
  const record = (input: WorkflowEventInput): void => {
    row(input.workflow_run_id);
    events.push({
      id: randomUUID(),
      workflow_run_id: input.workflow_run_id,
      event_type: input.event_type,
      step_name: input.step_name ?? null,
      step_index: input.step_index ?? null,
      data: structuredClone(input.data ?? {}),
      created_at: new Date().toISOString(),
      event_order: ++eventOrder,
    });
  };
  const resumableRun = (id: string, cursor?: WorkflowResumeCursor): WorkflowRun => {
    const run = row(id);
    if (!isResumable(run) || (cursor !== undefined && !resumeCursorMatches(run, cursor)))
      throw new WorkflowNotResumableError(id, run.status);
    return run;
  };
  const gateOpen = (
    run: WorkflowRun | undefined,
    expected: Parameters<IWorkflowStore['resolveApprovalGate']>[3]
  ): boolean => {
    if (!run) return false;
    // Same rule as the SQL `unresolvedGateClause`: a paused run is open unless its recorded
    // gate is resolved, so a run with no readable gate can still be rejected. Only an
    // `expected` gate needs a gate to compare against.
    if (run.status !== 'paused') return false;
    const gate: unknown = run.metadata.approval;
    const record: Record<string, unknown> =
      typeof gate === 'object' && gate !== null ? Object.fromEntries(Object.entries(gate)) : {};
    if (record.resolved != null) return false;
    if (expected === undefined) return true;
    return (
      record.nodeId === (typeof expected === 'string' ? expected : expected.nodeId) &&
      (record.pauseId ?? null) === (typeof expected === 'string' ? null : expected.pauseId)
    );
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
        const terminalRecord = buildTerminalRecord({
          run,
          events: [
            ...listRunEvents(events, run.id),
            ...precedingEvents.map(event => ({ ...event, data: event.data ?? {} })),
          ],
          artifacts: await observeRunArtifacts(run),
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
  };
  const terminal = async (
    run: WorkflowRun,
    event: WorkflowEventInput,
    precedingEvents: WorkflowEventInput[] = []
  ): Promise<void> => terminalBatch([{ run, event, precedingEvents }]);
  const createRun: IWorkflowStore['createWorkflowRun'] = async (
    input
  ): ReturnType<IWorkflowStore['createWorkflowRun']> => {
    validateWorkflowWaitMetadata(input.metadata);
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
  };
  const store: TransactionView = {
    ...createTransactionReads(runs, events, getCodebase),
    deferWorkflowContinuation: async (id, retryAt, cursor) => {
      const run = runs.get(id);
      if (run && resumeCursorMatches(run, cursor)) run.metadata.continuation_retry_at = retryAt;
    },
    answerAttentionWait: async (id, write) => {
      const run = runs.get(id);
      const answered = run && answeredAttentionWait(run, write);
      if (!run || !answered) return { answered: false };
      const stored = workflowWaitContextSchema.parse(answered);
      run.metadata.wait = stored;
      record(waitAnsweredEvent(id, answered));
      return { answered: true };
    },
    labelAttentionWait: async (id, write) => {
      const run = runs.get(id);
      const labeled = run && labeledAttentionWait(run, write);
      if (!run || !labeled) return { labeled: false };
      run.metadata.wait = workflowWaitContextSchema.parse(labeled);
      record(attentionLabeledEvent(id, labeled, write));
      return { labeled: true, wait: structuredClone(labeled) };
    },
    signalWorkflowWait: async (id, expected, payload) => {
      const run = runs.get(id);
      if (!run) return { signaled: false };
      const wait = readWorkflowWaitContext(run.metadata.wait);
      if (
        run.status !== 'paused' ||
        !wait ||
        wait.kind !== 'event' ||
        wait.signaledAt ||
        wait.event !== expected.event ||
        wait.nodeId !== expected.nodeId ||
        wait.resumeAt !== expected.resumeAt ||
        wait.pauseId !== expected.pauseId ||
        Date.parse(wait.resumeAt) <= Date.now()
      )
        return { signaled: false };
      run.metadata.wait = workflowWaitContextSchema.parse({
        ...wait,
        signaledAt: new Date().toISOString(),
        ...(payload === undefined ? {} : { payload: structuredClone(payload) }),
      });
      record({
        workflow_run_id: id,
        event_type: 'wait_signaled',
        step_name: workflowWaitStepName(wait),
        data: { event: wait.event, payload },
      });
      return { signaled: true };
    },
    createWorkflowRun: createRun,
    claimPendingWorkflowRun: async (
      id,
      workingPath
    ): ReturnType<IWorkflowStore['claimPendingWorkflowRun']> => {
      const run = runs.get(id);
      if (run?.status !== 'pending') return null;
      run.status = 'running';
      run.working_path ??= workingPath ?? null;
      run.last_activity_at = new Date();
      return structuredClone(run);
    },
    updateWorkflowRun: async (id, updates): ReturnType<IWorkflowStore['updateWorkflowRun']> => {
      validateWorkflowWaitMetadata(updates.metadata);
      const run = row(id);
      if (updates.status !== undefined && isTerminalRunStatus(updates.status))
        throw new Error('Terminal workflow status requires a lifecycle writer');
      Object.assign(run, updates, {
        metadata: { ...run.metadata, ...updates.metadata },
        output_root: run.output_root ?? updates.output_root ?? null,
        working_path: run.working_path ?? updates.working_path ?? null,
      });
    },
    updateWorkflowRunMetadataIfRunning: async (id, metadata) => {
      validateWorkflowWaitMetadata(metadata);
      const run = runs.get(id);
      if (run?.status !== 'running') return false;
      Object.assign(run.metadata, structuredClone(metadata));
      return true;
    },
    updateWorkflowActivity: async (id): ReturnType<IWorkflowStore['updateWorkflowActivity']> => {
      const run = runs.get(id);
      if (run) run.last_activity_at = new Date();
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
      validateWorkflowWaitMetadata(metadata);
      const run = structuredClone(row(id));
      if (run.status !== 'running') throw new Error('Run not in running state');
      run.status = 'completed';
      Object.assign(run.metadata, metadata);
      await terminal(run, {
        workflow_run_id: id,
        event_type: TERMINAL_RUN_EVENT_TYPE.completed,
        data: completion,
      });
    },
    failWorkflowRun: async (id, error, options): ReturnType<IWorkflowStore['failWorkflowRun']> => {
      const run = prepareWorkflowRunFailure(id, runs.get(id), error, options);
      if (!run) return { failed: false };
      await terminal(run, {
        workflow_run_id: id,
        event_type: TERMINAL_RUN_EVENT_TYPE.failed,
        data: { error, ...(options?.exitReason ? { exit_reason: options.exitReason } : {}) },
      });
      return { failed: true };
    },
    pauseWorkflowRun: async (
      id,
      approval,
      metadata,
      event
    ): ReturnType<IWorkflowStore['pauseWorkflowRun']> => {
      const run = row(id);
      if (run.status !== 'running') throw new WorkflowRunPauseConflictError(id);
      run.status = 'paused';
      run.metadata = { ...run.metadata, ...metadata, approval: structuredClone(approval) };
      run.metadata[PAUSE_CAUSE_METADATA_KEY] = pauseCauseOfApproval(approval);
      // A gate replaces a finished wait's context, exactly as the SQL store does.
      delete run.metadata.wait;
      if (event) record(event);
    },
    resolveApprovalGate: async (
      id,
      metadata,
      gateEvents,
      expected
    ): ReturnType<IWorkflowStore['resolveApprovalGate']> => {
      validateWorkflowWaitMetadata(metadata);
      const run = runs.get(id);
      if (!run || !gateOpen(run, expected)) return { resolved: false };
      Object.assign(run.metadata, structuredClone(metadata));
      for (const event of gateEvents) record({ ...event, workflow_run_id: id });
      return { resolved: true };
    },
    resumableRun: (id, cursor) => structuredClone(resumableRun(id, cursor)),
    recordCapacityWait: id => {
      const run = row(id);
      if (run.status !== 'paused' || readCapacityWait(run.metadata) !== undefined) return;
      run.metadata[CAPACITY_WAIT_METADATA_KEY] = { since: new Date().toISOString() };
    },
    clearCapacityWait: id => {
      Reflect.deleteProperty(row(id).metadata, CAPACITY_WAIT_METADATA_KEY);
    },
    resumeWorkflowRun: async (id, cursor) => resumeRun(resumableRun(id, cursor), record),
    setToolCallAttention: async (id, streamId, calls) => {
      const snapshot = toolCallAttentionArraySchema.parse(calls);
      if (snapshot.some(call => call.streamId !== streamId))
        throw new Error('Tool attention stream mismatch');
      const run = runs.get(id);
      if (run?.status !== 'running') return false;
      const previous = toolCallAttentionArraySchema.parse(
        run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY] ?? []
      );
      if (
        isDeepStrictEqual(
          previous.filter(call => call.streamId === streamId),
          snapshot
        )
      )
        return false;
      const combined = [...previous.filter(call => call.streamId !== streamId), ...snapshot];
      if (combined.length) run.metadata[TOOL_CALL_ATTENTION_METADATA_KEY] = combined;
      else Reflect.deleteProperty(run.metadata, TOOL_CALL_ATTENTION_METADATA_KEY);
      record({
        workflow_run_id: id,
        event_type: 'run_attention_changed',
        data: { streamId, hasAttention: snapshot.length > 0 },
      });
      return true;
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
      const status = runs.get(input.workflow_run_id)?.status;
      if (status !== 'running' && !(options?.allowPaused && status === 'paused'))
        return { persisted: false };
      record(input);
      return { persisted: true };
    },
    deleteOldWorkflowRuns: async days => {
      if (!Number.isInteger(days) || days < 0) throw new Error('Invalid olderThanDays');
      const ids = [...runs.values()]
        .filter(
          run =>
            isTerminalRunStatus(run.status) &&
            run.started_at.getTime() < Date.now() - days * 86_400_000
        )
        .map(run => run.id);
      const deleted = new Set(ids);
      for (const id of deleted) runs.delete(id);
      const kept = events.filter(event => !deleted.has(event.workflow_run_id));
      events.splice(0, events.length, ...kept);
      for (const run of runs.values()) {
        if (run.parent_run_id !== null && deleted.has(run.parent_run_id)) run.parent_run_id = null;
        if (run.adopted_from_run_id !== null && deleted.has(run.adopted_from_run_id))
          run.adopted_from_run_id = null;
      }
      return { count: ids.length };
    },
    resolveAndCancelApprovalGate: async (id, gateEvents, cancellation, expected) => {
      const run = structuredClone(runs.get(id));
      if (!run || !gateOpen(run, expected)) return { resolved: false };
      run.status = 'cancelled';
      const { step_name, ...data } = cancellation;
      await terminal(
        run,
        {
          workflow_run_id: id,
          event_type: TERMINAL_RUN_EVENT_TYPE.cancelled,
          step_name,
          data: { ...data, cancel_reason: 'approval_rejected' },
        },
        gateEvents.map(event => ({ ...event, workflow_run_id: id }))
      );
      return { resolved: true };
    },
    cancelResumableRunsForConversation: async (id, assertMayCancel) => {
      const targets = newestFirst(
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
            event_type: TERMINAL_RUN_EVENT_TYPE.cancelled,
            data: { cancel_reason: 'conversation_reset' },
          },
        }))
      );
      return prior;
    },
    cancelWorkflowRun: async (id, details) => {
      const run = structuredClone(runs.get(id));
      if (!run || CANCELLATION_NOOP_WORKFLOW_STATUSES.includes(run.status))
        return { cancelled: false };
      run.status = 'cancelled';
      const { step_name, ...data } = details ?? {};
      await terminal(run, {
        workflow_run_id: id,
        event_type: TERMINAL_RUN_EVENT_TYPE.cancelled,
        step_name,
        data,
      });
      return { cancelled: true };
    },
    cancelFanOutRun: async (id, reason) => {
      const run = structuredClone(runs.get(id));
      if (!run || CANCELLATION_NOOP_WORKFLOW_STATUSES.includes(run.status))
        return { cancelled: false };
      run.status = 'cancelled';
      run.metadata.cancelled_reason = reason;
      await terminal(run, {
        workflow_run_id: id,
        event_type: TERMINAL_RUN_EVENT_TYPE.cancelled,
        data: { reason, cancel_reason: 'fan_out' },
      });
      return { cancelled: true };
    },
    recoverCancelledFanOutRun: async id => {
      const run = row(id);
      if (
        run.status !== 'cancelled' ||
        !FAN_OUT_CANCEL_REASONS.some(reason => reason === run.metadata.cancelled_reason)
      )
        throw new Error('Not an engine-cancelled fan-out child');
      run.status = 'running';
      run.completed_at = null;
      run.started_at = new Date();
      run.metadata[EXECUTION_CLAIM_METADATA_KEY] = crypto.randomUUID();
      run.last_activity_at = new Date();
      delete run.metadata.cancelled_reason;
      Reflect.deleteProperty(run.metadata, TOOL_CALL_ATTENTION_METADATA_KEY);
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (
          event?.workflow_run_id === id &&
          event.event_type === TERMINAL_RUN_EVENT_TYPE.cancelled &&
          FAN_OUT_CANCEL_REASONS.some(reason => reason === event.data.reason)
        )
          events.splice(index, 1);
      }
      record({ workflow_run_id: id, event_type: 'workflow_resumed' });
      return structuredClone(run);
    },
    releaseRunForUnreadableSource: async (id, release, beforePublish) => {
      const run = row(id);
      if (run.status !== 'running' || executionClaim(run.metadata) !== release.claimId)
        return { released: false };
      await beforePublish?.();
      run.status = 'paused';
      run.last_activity_at = new Date();
      Object.assign(run.metadata, sourceReleaseMetadata(release, new Date().toISOString()));
      record(sourceReleasedEvent(id, release));
      return { released: true };
    },
    pauseWorkflowRunForWait: async (id, wait, pause) => {
      const run = row(id);
      if (run.status !== 'running') throw new WorkflowRunPauseConflictError(id);
      run.status = 'paused';
      // A wait replaces the previous gate's context, exactly as the SQL store does: a
      // stale answered gate left beside the wait would read as a gate awaiting continuation.
      delete run.metadata.approval;
      run.metadata.wait = workflowWaitContextSchema.parse(wait);
      run.metadata[PAUSE_CAUSE_METADATA_KEY] = pauseCauseOfWait(wait);
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
      else record(waitContinuedEvent(id, wait));
    },
    clearWorkflowWaitContext: async (id, wait, completion) => {
      const run = runs.get(id);
      if (!run) return { cleared: false };
      const current = run.metadata.wait;
      if (
        run.status !== 'running' ||
        !isWorkflowWaitContext(current) ||
        current.nodeId !== wait.nodeId ||
        current.pauseId !== wait.pauseId ||
        (current.kind === 'attention' ? current.waitingSince : current.resumeAt) !==
          (wait.kind === 'attention' ? wait.waitingSince : wait.resumeAt)
      )
        return { cleared: false };
      delete run.metadata.wait;
      const rows = waitCompletionEvents(id, completion);
      record(rows.outcome);
      record(rows.node);
      return { cleared: true, nodeEvent: rows.node };
    },
    claimWriteback: async id => {
      const run = runs.get(id);
      if (!run || run.metadata.writeback_apply_claimed != null) return { claimed: false };
      run.metadata.writeback_apply_claimed = true;
      return { claimed: true };
    },
    releaseWritebackClaim: async id => {
      const run = runs.get(id);
      if (run) delete run.metadata.writeback_apply_claimed;
    },
  };
  return store;
}
