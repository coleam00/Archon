import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  WorkflowNotResumableError,
  WorkflowRunPauseConflictError,
  type GateResolutionEvent,
  type IWorkflowStore,
} from './store';
import {
  TERMINAL_WORKFLOW_STATUSES,
  isTerminalRunStatus,
  type ApprovalContext,
  type WorkflowWaitContext,
  type WorkflowRun,
} from './schemas/workflow-run';
import { workflowNodeSessionSchema } from './schemas/workflow-node-session';
import { workflowRunNodeSessionSchema } from './schemas/workflow-run-node-session';
import { terminalRecordSchema } from './schemas/terminal-record';

export interface WorkflowStoreHarness {
  store: IWorkflowStore;
  backdate(runId: string, dates: { started_at?: Date; last_activity_at?: Date }): Promise<void>;
  terminalReports(): string[];
  close(): Promise<void>;
}

// Host records referenced by the port's inputs must exist in relational targets.
export const CONFORMANCE_CODEBASE_ID = '00000000-0000-4000-8000-000000003643';
export const CONFORMANCE_CONVERSATION_ID = '00000000-0000-4000-8001-000000003643';
const approval: ApprovalContext = {
  nodeId: 'review',
  message: 'Choose',
  type: 'approval',
  pauseId: 'first',
};
const wait: Extract<WorkflowWaitContext, { kind: 'time' }> = {
  owner: 'node',
  nodeId: 'wait',
  kind: 'time',
  waitingSince: '2026-01-01T00:00:00.000Z',
  resumeAt: '2026-01-02T00:00:00.000Z',
};
const schedule = {
  reason: 'quota' as const,
  attempt: 1,
  maxAttempts: 3,
  resumeAt: wait.resumeAt,
  deadlineAt: '2026-01-03T00:00:00.000Z',
};
const eight = <T>(call: (index: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: 8 }, (_, index) => call(index)));
const create = (
  store: Pick<IWorkflowStore, 'createWorkflowRun'>,
  input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {}
): Promise<WorkflowRun> =>
  store.createWorkflowRun({ workflow_name: 'conformance', user_message: 'test', ...input });
async function running(
  store: Pick<IWorkflowStore, 'createWorkflowRun' | 'claimPendingWorkflowRun'>,
  input: Partial<Parameters<IWorkflowStore['createWorkflowRun']>[0]> = {}
): Promise<WorkflowRun> {
  const run = await create(store, input);
  const claimed = await store.claimPendingWorkflowRun(run.id);
  expect(claimed?.status).toBe('running');
  return run;
}
const types = async (
  store: Pick<IWorkflowStore, 'listWorkflowEvents'>,
  id: string
): Promise<string[]> => (await store.listWorkflowEvents(id)).map(event => event.event_type);
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the store operation to reject');
}
const gateEvents = (index: number): GateResolutionEvent[] => [
  {
    event_type: 'approval_received',
    step_name: 'review',
    data: { winner: index },
  },
  { event_type: 'node_completed', step_name: 'review', data: { node_output: String(index) } },
];

export async function assertWorkflowClaimRace(
  store: Pick<
    IWorkflowStore,
    'createWorkflowRun' | 'claimPendingWorkflowRun' | 'getWorkflowRun' | 'listWorkflowEvents'
  >
): Promise<void> {
  const run = await create(store);
  const results = await eight(() => store.claimPendingWorkflowRun(run.id, '/checkout'));
  expect(results.filter(result => result !== null)).toHaveLength(1);
  expect(results.filter(result => result === null)).toHaveLength(7);
  expect(await store.getWorkflowRun(run.id)).toMatchObject({
    status: 'running',
    working_path: '/checkout',
  });
  expect(await store.claimPendingWorkflowRun(run.id)).toBeNull();
  expect(await types(store, run.id)).toEqual([]);
}

export async function assertWorkflowGateRace(
  store: Pick<
    IWorkflowStore,
    | 'createWorkflowRun'
    | 'claimPendingWorkflowRun'
    | 'getWorkflowRun'
    | 'listWorkflowEvents'
    | 'pauseWorkflowRun'
    | 'resolveApprovalGate'
  >
): Promise<void> {
  const run = await running(store);
  await store.pauseWorkflowRun(run.id, approval);
  const results = await eight(index =>
    store.resolveApprovalGate(
      run.id,
      {
        approval: { ...approval, resolved: 'approved' },
        winner: index,
      },
      gateEvents(index),
      { nodeId: approval.nodeId, pauseId: 'first' }
    )
  );
  expect(results.filter(result => result.resolved)).toHaveLength(1);
  expect(results.filter(result => !result.resolved)).toHaveLength(7);
  const winner = results.findIndex(result => result.resolved);
  expect(await store.getWorkflowRun(run.id)).toMatchObject({
    status: 'paused',
    metadata: { winner },
  });
  const rows = await store.listWorkflowEvents(run.id);
  expect(rows.map(event => event.event_type)).toEqual(['approval_received', 'node_completed']);
  expect(rows[0]?.data).toEqual({ winner });
  expect(rows[1]?.data).toEqual({ node_output: String(winner) });
}

export function describeWorkflowStoreConformance(
  label: string,
  makeHarness: () => Promise<WorkflowStoreHarness>
): void {
  describe(`workflow store conformance: ${label}`, () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(async () => {
      harness = await makeHarness();
      store = harness.store;
    });
    afterEach(async () => {
      await harness?.close();
    });

    test('pending claim has exactly one winner and stamps the checkout', async () => {
      await assertWorkflowClaimRace(store);
    });
    test.each(['failed', 'paused'] as const)(
      'resume from %s has one winner and preserves cleared failure evidence',
      async status => {
        const run = await running(store, { metadata: { keep: true } });
        if (status === 'failed')
          await store.failWorkflowRun(run.id, 'original error', { exitReason: 'node_error' });
        else await store.pauseWorkflowRun(run.id, approval);
        const before = await types(store, run.id);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => store.resumeWorkflowRun(run.id))
        );
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        for (const result of results)
          if (result.status === 'rejected')
            expect(result.reason).toBeInstanceOf(WorkflowNotResumableError);
        expect(await store.getWorkflowRun(run.id)).toMatchObject({
          status: 'running',
          completed_at: null,
          metadata: { keep: true },
        });
        const metadata = (await store.getWorkflowRun(run.id))?.metadata;
        expect(metadata).not.toHaveProperty('error');
        expect(metadata).not.toHaveProperty('stop_reason');
        expect(await types(store, run.id)).toEqual([
          ...before,
          ...(status === 'failed' ? ['workflow_resumed'] : []),
        ]);
        if (status === 'failed') {
          const resumed = (await store.listWorkflowEvents(run.id)).find(
            event => event.event_type === 'workflow_resumed'
          );
          expect(resumed?.data).toEqual({ error: 'original error' });
        }
      }
    );
    test('resume audits a legacy metadata-only error and ignores empty errors', async () => {
      for (const error of ['legacy failure', '', null]) {
        const run = await running(store, { metadata: { error } });
        await store.pauseWorkflowRun(run.id, approval);
        await store.resumeWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        expect(events.map(event => event.event_type)).toEqual(error ? ['workflow_resumed'] : []);
        if (error) expect(events[0]?.data).toEqual({ error });
        expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('error');
      }
    });
    test('resume refuses stale cursors and consumes a quota schedule once', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'wait',
            nodeId: 'other',
            resumeAt: wait.resumeAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'wait',
            nodeId: wait.nodeId,
            resumeAt: schedule.deadlineAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      await store.resumeWorkflowRun(run.id, {
        kind: 'wait',
        nodeId: wait.nodeId,
        resumeAt: wait.resumeAt,
      });
      await store.failWorkflowRun(run.id, 'quota', { scheduledResume: schedule });
      expect(
        await rejection(
          store.resumeWorkflowRun(run.id, {
            kind: 'quota',
            attempt: 2,
            resumeAt: schedule.resumeAt,
          })
        )
      ).toBeInstanceOf(WorkflowNotResumableError);
      const result = await store.resumeWorkflowRun(run.id, {
        kind: 'quota',
        attempt: 1,
        resumeAt: schedule.resumeAt,
      });
      expect(result.metadata.scheduled_resume).toMatchObject({
        ...schedule,
        triggeredAt: expect.any(String),
      });
      expect(await types(store, run.id)).toEqual([
        'wait_started',
        'quota_resume_scheduled',
        'workflow_failed',
        'workflow_resumed',
        'quota_resume_triggered',
      ]);
    });
    test('only stale running runs can resume; completed and cancelled runs refuse', async () => {
      const run = await running(store);
      expect(await rejection(store.resumeWorkflowRun(run.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      await harness.backdate(run.id, { last_activity_at: new Date(Date.now() - 2 * 86_400_000) });
      expect((await store.resumeWorkflowRun(run.id)).status).toBe('running');
      await store.completeWorkflowRun(run.id, { duration_ms: 1 });
      expect(await rejection(store.resumeWorkflowRun(run.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      const cancelled = await create(store);
      await store.cancelWorkflowRun(cancelled.id);
      expect(await rejection(store.resumeWorkflowRun(cancelled.id))).toBeInstanceOf(
        WorkflowNotResumableError
      );
    });
    test('pause requires running, replaces the whole approval and commits suspension once', async () => {
      const run = await running(store, { metadata: { keep: true } });
      await store.pauseWorkflowRun(run.id, { ...approval, resolved: 'rejected' });
      expect(await rejection(store.pauseWorkflowRun(run.id, approval))).toBeInstanceOf(
        WorkflowRunPauseConflictError
      );
      await store.resumeWorkflowRun(run.id);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          store.pauseWorkflowRun(
            run.id,
            approval,
            { extra: true },
            {
              workflow_run_id: run.id,
              event_type: 'node_suspended',
              step_name: 'review',
              data: {},
            }
          )
        )
      );
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toBeInstanceOf(WorkflowRunPauseConflictError);
      expect((await store.getWorkflowRun(run.id))?.metadata).toEqual({
        keep: true,
        extra: true,
        approval,
      });
      expect(await types(store, run.id)).toEqual(['node_suspended']);
    });
    test('continued waits do not duplicate the start; consumption matches the exact running cursor', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      const completion = {
        stepName: 'wait',
        result: { status: 'satisfied' as const, waited_ms: 12 },
      };
      expect(await store.clearWorkflowWaitContext(run.id, wait, completion)).toEqual({
        cleared: false,
      });
      await store.resumeWorkflowRun(run.id);
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'continued' });
      expect(await types(store, run.id)).toEqual(['wait_started']);
      await store.resumeWorkflowRun(run.id);
      expect(
        await store.clearWorkflowWaitContext(
          run.id,
          { ...wait, resumeAt: schedule.deadlineAt },
          completion
        )
      ).toEqual({ cleared: false });
      const results = await eight(() => store.clearWorkflowWaitContext(run.id, wait, completion));
      expect(results.filter(result => result.cleared)).toHaveLength(1);
      const winner = results.find(result => result.cleared);
      const rows = await store.listWorkflowEvents(run.id);
      expect(rows.map(row => row.event_type)).toEqual([
        'wait_started',
        'wait_completed',
        'node_completed',
      ]);
      if (!winner?.cleared) throw new Error('No wait winner');
      expect(rows[2]).toMatchObject(winner.nodeEvent);
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('wait');
    });
    test('continuation scans honor exact-cursor deferral and an event signal has one winner', async () => {
      const due = async (now: Date): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(now, 10)).map(run => run.id);
      const afterWait = new Date(Date.parse(wait.resumeAt) + 1000);
      const timed = await running(store);
      await store.pauseWorkflowRunForWait(timed.id, wait, { kind: 'started', stepName: 'wait' });
      expect(await due(new Date(Date.parse(wait.resumeAt) - 1000))).not.toContain(timed.id);
      expect(await due(afterWait)).toContain(timed.id);
      const retryAt = schedule.deadlineAt;
      await store.deferWorkflowContinuation(timed.id, retryAt, {
        kind: 'wait',
        nodeId: 'other',
        resumeAt: wait.resumeAt,
      });
      expect(await due(afterWait)).toContain(timed.id);
      await store.deferWorkflowContinuation(timed.id, retryAt, {
        kind: 'wait',
        nodeId: wait.nodeId,
        resumeAt: wait.resumeAt,
      });
      expect(await due(afterWait)).not.toContain(timed.id);
      expect(await due(new Date(Date.parse(retryAt) + 1000))).toContain(timed.id);

      const event: Extract<WorkflowWaitContext, { kind: 'event' }> = {
        owner: 'node',
        nodeId: 'gate',
        kind: 'event',
        event: 'ready',
        waitingSince: new Date().toISOString(),
        resumeAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      const signaled = await running(store);
      await store.pauseWorkflowRunForWait(signaled.id, event, {
        kind: 'started',
        stepName: 'gate',
      });
      expect(await due(new Date())).not.toContain(signaled.id);
      expect(
        await store.signalWorkflowWait(signaled.id, { ...event, event: 'other' }, { n: -1 })
      ).toEqual({ signaled: false });
      const results = await eight(index =>
        store.signalWorkflowWait(signaled.id, event, { n: index })
      );
      expect(results.filter(result => result.signaled)).toHaveLength(1);
      const winner = results.findIndex(result => result.signaled);
      expect((await store.getWorkflowRun(signaled.id))?.metadata.wait).toMatchObject({
        signaledAt: expect.any(String),
        payload: { n: winner },
      });
      expect(await types(store, signaled.id)).toEqual(['wait_started', 'wait_signaled']);
      expect(await due(new Date())).toContain(signaled.id);
    });
    test('attention failure matches its exact owner and reports only the winner', async () => {
      const run = await running(store);
      const attention = {
        owner: 'loop_group' as const,
        nodeId: 'loop',
        bodyWaitId: 'wait',
        iteration: 2,
        sessionId: null,
        sessionProvider: null,
        kind: 'attention' as const,
        waitingSince: wait.waitingSince,
        message: 'Act',
      };
      await store.pauseWorkflowRunForWait(run.id, attention, {
        kind: 'started',
        stepName: 'loop.wait',
      });
      for (const mismatch of [
        { ...attention, iteration: 1 },
        { ...attention, nodeId: 'other' },
        { ...attention, bodyWaitId: 'other' },
        { ...attention, waitingSince: wait.resumeAt },
      ]) {
        expect(await store.failPausedAttentionWait(run.id, mismatch, 'undelivered')).toEqual({
          failed: false,
        });
      }
      const results = await eight(() =>
        store.failPausedAttentionWait(run.id, attention, 'undelivered')
      );
      expect(results.filter(result => result.failed)).toHaveLength(1);
      expect(await types(store, run.id)).toEqual(['wait_started', 'workflow_failed']);
      expect(harness.terminalReports()).toEqual([run.id]);
      expect((await store.getWorkflowRun(run.id))?.status).toBe('failed');
    });
    test('an undelivered approval cannot fail a different or already resolved gate', async () => {
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval);
      expect(
        await store.failPausedApproval(run.id, { ...approval, pauseId: 'stale' }, 'lost')
      ).toEqual({ failed: false });
      const results = await eight(() => store.failPausedApproval(run.id, approval, 'lost'));
      expect(results.filter(result => result.failed)).toHaveLength(1);
      expect(await types(store, run.id)).toEqual(['workflow_failed']);
      expect(harness.terminalReports()).toEqual([run.id]);
    });
    test('gate resolution has one winner and no loser events', async () => {
      await assertWorkflowGateRace(store);
    });
    test.each(['resolve', 'cancel'] as const)('%s refuses another gate occurrence', async mode => {
      const run = await running(store, { metadata: { approval } });
      const resolve = (
        expected: string | { nodeId: string; pauseId: string }
      ): Promise<{ resolved: boolean }> =>
        mode === 'resolve'
          ? store.resolveApprovalGate(
              run.id,
              { approval: { ...approval, resolved: 'approved' } },
              gateEvents(0),
              expected
            )
          : store.resolveAndCancelApprovalGate(
              run.id,
              gateEvents(0),
              { reason: 'rejected' },
              expected
            );
      expect(await resolve({ nodeId: 'review', pauseId: 'first' })).toEqual({ resolved: false });
      await store.pauseWorkflowRun(run.id, approval);
      for (const expected of [
        'review',
        { nodeId: 'other', pauseId: 'first' },
        { nodeId: 'review', pauseId: 'stale' },
      ])
        expect(await resolve(expected)).toEqual({ resolved: false });
      expect(await types(store, run.id)).toEqual([]);
      expect(await resolve({ nodeId: 'review', pauseId: 'first' })).toEqual({ resolved: true });
      expect(await resolve({ nodeId: 'review', pauseId: 'first' })).toEqual({ resolved: false });
      expect(await types(store, run.id)).toEqual([
        'approval_received',
        'node_completed',
        ...(mode === 'cancel' ? ['workflow_cancelled'] : []),
      ]);
      expect(harness.terminalReports()).toEqual(mode === 'cancel' ? [run.id] : []);
    });
    test('reject and cancel has one winner and writes decision before terminal', async () => {
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval);
      const results = await eight(index =>
        store.resolveAndCancelApprovalGate(run.id, gateEvents(index), { step_name: 'review' })
      );
      expect(results.filter(result => result.resolved)).toHaveLength(1);
      expect(await types(store, run.id)).toEqual([
        'approval_received',
        'node_completed',
        'workflow_cancelled',
      ]);
      expect(harness.terminalReports()).toEqual([run.id]);
    });
    test.each(['complete', 'fail', 'cancel', 'fan-out'] as const)(
      '%s writes one terminal record and reports only a winning commit',
      async mode => {
        const run = await running(store);
        const write = (): ReturnType<
          IWorkflowStore['completeWorkflowRun' | 'cancelWorkflowRun']
        > =>
          mode === 'complete'
            ? store.completeWorkflowRun(run.id, { duration_ms: 5 })
            : mode === 'fail'
              ? store.failWorkflowRun(run.id, 'failed')
              : mode === 'cancel'
                ? store.cancelWorkflowRun(run.id)
                : store.cancelFanOutRun(run.id, 'fan_out_sibling');
        const results = await Promise.allSettled(Array.from({ length: 8 }, write));
        if (mode === 'complete' || mode === 'fail') {
          expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter(result => result.status === 'rejected')).toHaveLength(7);
        } else {
          for (const result of results) expect(result.status).toBe('fulfilled');
          expect(
            results.filter(result => result.status === 'fulfilled' && result.value?.cancelled)
          ).toHaveLength(1);
        }
        const events = await store.listWorkflowEvents(run.id);
        expect(events).toHaveLength(1);
        const status = mode === 'complete' ? 'completed' : mode === 'fail' ? 'failed' : 'cancelled';
        expect(events[0]?.event_type).toBe(`workflow_${status}`);
        expect(terminalRecordSchema.parse(events[0]?.data.terminal_record)).toMatchObject({
          run_id: run.id,
          status,
        });
        expect(harness.terminalReports()).toEqual([run.id]);
      }
    );
    test.each([
      'complete',
      'fail',
      'cancel',
      'fan-out',
      'reject',
      'reset',
      'attention',
      'approval',
    ] as const)('%s publishes terminal status together with its event', async mode => {
      const run = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      const attention = {
        owner: 'node' as const,
        nodeId: 'attention',
        kind: 'attention' as const,
        waitingSince: wait.waitingSince,
        message: 'Act',
      };
      if (mode === 'reject' || mode === 'reset' || mode === 'approval')
        await store.pauseWorkflowRun(run.id, approval);
      if (mode === 'attention')
        await store.pauseWorkflowRunForWait(run.id, attention, {
          kind: 'started',
          stepName: 'attention',
        });
      const writers: Record<typeof mode, () => Promise<unknown>> = {
        complete: () => store.completeWorkflowRun(run.id, { duration_ms: 1 }),
        fail: () => store.failWorkflowRun(run.id, 'failed', { scheduledResume: schedule }),
        cancel: () => store.cancelWorkflowRun(run.id),
        'fan-out': () => store.cancelFanOutRun(run.id, 'fan_out_sibling'),
        reject: () =>
          store.resolveAndCancelApprovalGate(run.id, gateEvents(0), {
            step_name: 'review',
          }),
        reset: () => store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID),
        attention: () => store.failPausedAttentionWait(run.id, attention, 'lost'),
        approval: () => store.failPausedApproval(run.id, approval, 'lost'),
      };
      let settled = false;
      const pending = writers[mode]().finally(() => {
        settled = true;
      });
      try {
        do {
          // Bracket the row read so a commit between port reads cannot look non-atomic.
          const priorEvents = await store.listWorkflowEvents(run.id);
          const observed = await store.getWorkflowRun(run.id);
          const events = await store.listWorkflowEvents(run.id);
          for (const status of TERMINAL_WORKFLOW_STATUSES) {
            if (priorEvents.some(event => event.event_type === `workflow_${status}`))
              expect(observed?.status).toBe(status);
          }
          if (observed && isTerminalRunStatus(observed.status)) {
            const terminal = events.find(
              event => event.event_type === `workflow_${observed.status}`
            );
            expect(terminal).toBeDefined();
            expect(terminalRecordSchema.parse(terminal?.data.terminal_record).status).toBe(
              observed.status
            );
          }
          if (!settled) await new Promise<void>(resolve => setImmediate(resolve));
        } while (!settled);
      } finally {
        await pending;
      }
      expect(
        (await types(store, run.id)).filter(type =>
          TERMINAL_WORKFLOW_STATUSES.some(status => type === `workflow_${status}`)
        )
      ).toHaveLength(1);
    });
    test('a racing resume follows the failure event when it succeeds', async () => {
      const run = await running(store);
      const pending = store.failWorkflowRun(run.id, 'failed', { scheduledResume: schedule });
      try {
        await store.getWorkflowRun(run.id);
        await store.listWorkflowEvents(run.id);
        const resumed = await Promise.allSettled([store.resumeWorkflowRun(run.id)]);
        if (resumed[0]?.status === 'fulfilled') {
          const ordered = await types(store, run.id);
          expect(ordered.indexOf('workflow_failed')).toBeGreaterThanOrEqual(0);
          expect(ordered.indexOf('workflow_resumed')).toBeGreaterThan(
            ordered.indexOf('workflow_failed')
          );
        }
      } finally {
        await pending;
      }
    });
    test('terminal writer start-state predicates preserve losers', async () => {
      const pending = await create(store);
      expect(
        await rejection(store.completeWorkflowRun(pending.id, { duration_ms: 0 }))
      ).toBeInstanceOf(Error);
      expect(await types(store, pending.id)).toEqual([]);
      await store.failWorkflowRun(pending.id, 'setup failed');
      expect(await store.cancelWorkflowRun(pending.id)).toEqual({ cancelled: true });
      const paused = await running(store);
      await store.pauseWorkflowRun(paused.id, approval);
      expect(await rejection(store.failWorkflowRun(paused.id, 'bad'))).toBeInstanceOf(Error);
      expect(await types(store, paused.id)).toEqual([]);
      expect(await store.cancelWorkflowRun(paused.id)).toEqual({ cancelled: true });
      const completed = await running(store);
      await store.completeWorkflowRun(completed.id, { duration_ms: 1 });
      expect(await store.cancelWorkflowRun(completed.id)).toEqual({ cancelled: false });
      expect(await store.cancelFanOutRun(completed.id, 'fan_out_gate')).toEqual({
        cancelled: false,
      });
      expect(harness.terminalReports()).toEqual([pending.id, pending.id, paused.id, completed.id]);
    });
    test('fan-out recovery retracts only engine cancellations', async () => {
      const run = await running(store);
      await store.cancelFanOutRun(run.id, 'fan_out_gate');
      expect((await store.recoverCancelledFanOutRun(run.id)).status).toBe('running');
      expect(await types(store, run.id)).toEqual([]);
      await store.cancelWorkflowRun(run.id);
      expect(await rejection(store.recoverCancelledFanOutRun(run.id))).toBeInstanceOf(Error);
      expect(await types(store, run.id)).toEqual(['workflow_cancelled']);
    });
    test('running-only event writes explicitly allow paused runs and refuse terminal runs', async () => {
      const run = await create(store);
      const event = {
        workflow_run_id: run.id,
        event_type: 'node_completed' as const,
        step_name: 'build',
        data: { node_output: 'ok' },
      };
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: false });
      await store.claimPendingWorkflowRun(run.id);
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: true });
      await store.pauseWorkflowRun(run.id, approval);
      expect(await store.persistWorkflowEventIfRunning(event)).toEqual({ persisted: false });
      expect(await store.persistWorkflowEventIfRunning(event, { allowPaused: true })).toEqual({
        persisted: true,
      });
      await store.cancelWorkflowRun(run.id);
      expect(await store.persistWorkflowEventIfRunning(event, { allowPaused: true })).toEqual({
        persisted: false,
      });
      expect((await types(store, run.id)).filter(type => type === 'node_completed')).toHaveLength(
        2
      );
    });
    test('write-once checkout fields keep their first value and generic updates refuse terminal status', async () => {
      const run = await create(store);
      const baseline = { kind: 'not_git' as const, sampledAt: wait.waitingSince };
      expect(await store.recordWorkflowRunCheckoutBaseline(run.id, baseline)).toEqual(baseline);
      expect(
        await store.recordWorkflowRunCheckoutBaseline(run.id, {
          ...baseline,
          sampledAt: wait.resumeAt,
        })
      ).toEqual(baseline);
      await store.updateWorkflowRun(run.id, {
        output_root: '/first',
        working_path: '/first',
        metadata: { keep: true },
      });
      await store.updateWorkflowRun(run.id, {
        output_root: '/second',
        working_path: '/second',
        metadata: { extra: true },
      });
      expect(await store.getWorkflowRun(run.id)).toMatchObject({
        output_root: '/first',
        working_path: '/first',
        metadata: { keep: true, extra: true },
      });
      // Exercise the runtime boundary used by untyped SDK consumers.
      for (const status of TERMINAL_WORKFLOW_STATUSES) {
        const terminalUpdate = JSON.parse(JSON.stringify({ status })) as Parameters<
          IWorkflowStore['updateWorkflowRun']
        >[1];
        expect(await rejection(store.updateWorkflowRun(run.id, terminalUpdate))).toMatchObject({
          message: expect.stringContaining('lifecycle writer'),
        });
      }
      expect(await store.getWorkflowRunStatus(run.id)).toBe('pending');
    });
    test('write-back has one winner and release permits another claim', async () => {
      const run = await running(store);
      const results = await eight(() => store.claimWriteback(run.id));
      expect(results.filter(result => result.claimed)).toHaveLength(1);
      await store.releaseWritebackClaim(run.id);
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty(
        'writeback_apply_claimed'
      );
      expect(await store.claimWriteback(run.id)).toEqual({ claimed: true });
    });
    test('path holders exclude stale pending, self and ancestors and agree on the id tiebreak', async () => {
      const path = '/locked';
      const first = await create(store, {
        id: '00000000-0000-4000-8000-000000000001',
        working_path: path,
      });
      const second = await create(store, {
        id: '00000000-0000-4000-8000-000000000002',
        working_path: path,
      });
      const tie = new Date(Date.now() - 60_000);
      for (const run of [first, second]) await harness.backdate(run.id, { started_at: tie });
      expect(
        await store.getActiveWorkflowRunByPath(path, { id: first.id, startedAt: tie })
      ).toBeNull();
      expect(
        (await store.getActiveWorkflowRunByPath(path, { id: second.id, startedAt: tie }))?.id
      ).toBe(first.id);
      expect(
        await store.getActiveWorkflowRunByPath(path, {
          id: second.id,
          startedAt: tie,
          excludeRunIds: [first.id],
        })
      ).toBeNull();
      for (const run of [first, second])
        await harness.backdate(run.id, { started_at: new Date(Date.now() - 600_000) });
      expect(await store.getActiveWorkflowRunByPath(path)).toBeNull();
      await store.claimPendingWorkflowRun(first.id);
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first.id);
      await store.pauseWorkflowRun(first.id, approval);
      expect((await store.getActiveWorkflowRunByPath(path))?.id).toBe(first.id);
      await store.cancelWorkflowRun(first.id);
      expect(await store.getActiveWorkflowRunByPath(path)).toBeNull();
    });
    test('resumable lookup chooses newest matching run and includes stale running', async () => {
      const first = await running(store, { working_path: '/resume' });
      await store.failWorkflowRun(first.id, 'old');
      await harness.backdate(first.id, { started_at: new Date(Date.now() - 600_000) });
      const second = await running(store, { working_path: '/resume' });
      await store.pauseWorkflowRun(second.id, approval);
      await running(store, { workflow_name: 'other', working_path: '/resume' });
      await running(store, { working_path: '/other' });
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(second.id);
      await store.cancelWorkflowRun(second.id);
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(first.id);
      await store.resumeWorkflowRun(first.id);
      expect(await store.findResumableRun('conformance', '/resume')).toBeNull();
      await harness.backdate(first.id, { last_activity_at: new Date(Date.now() - 2 * 86_400_000) });
      expect((await store.findResumableRun('conformance', '/resume'))?.id).toBe(first.id);
    });
    test('events retain commit order, support exclusion and group requested runs', async () => {
      const first = await create(store);
      const second = await create(store);
      for (let index = 0; index < 20; index++)
        await store.persistWorkflowEvent({
          workflow_run_id: index % 2 === 0 ? first.id : second.id,
          event_type: 'workflow_artifact',
          data: { index },
        });
      const rows = await store.listWorkflowEvents(first.id);
      expect(rows.map(row => row.data.index)).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 2)
      );
      expect(new Set(rows.map(row => row.id)).size).toBe(10);
      for (const row of rows) expect(row.created_at).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
      expect(
        await store.listWorkflowEvents(first.id, { excludeEventTypes: ['workflow_artifact'] })
      ).toEqual([]);
      const grouped = await store.listEventsForRuns([second.id, first.id], ['workflow_artifact']);
      expect(grouped.get(first.id)).toEqual(rows);
      expect(grouped.get(second.id)?.map(row => row.data.index)).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 2 + 1)
      );
      expect(await store.listEventsForRuns([], ['workflow_artifact'])).toEqual(new Map());
      expect(await store.listEventsForRuns([first.id], [])).toEqual(new Map([[first.id, []]]));
    });
    test('resume reduction preserves durable fan-out, starts and usage from failed attempts', async () => {
      const run = await create(store);
      const snapshots = [{ ordinal: 0, identity: 'one', item: 1, inputs: { value: 1 } }];
      const rows = [
        {
          event_type: 'node_completed' as const,
          step_name: 'success',
          data: {
            node_output: 'ok',
            structured_output: { ok: true },
            tokens: { input: 2, output: 3 },
            cost_usd: 0.25,
          },
        },
        {
          event_type: 'node_skipped_prior_success' as const,
          step_name: 'success',
          data: {
            node_output: 'ok',
            structured_output: { ok: true },
            tokens: { input: 2, output: 3 },
            cost_usd: 0.25,
          },
        },
        {
          event_type: 'node_completed' as const,
          step_name: 'invalidated',
          data: { node_output: 'stale' },
        },
        { event_type: 'node_prior_cache_invalidated' as const, step_name: 'invalidated', data: {} },
        { event_type: 'node_started' as const, step_name: 'unfinished', data: {} },
        {
          event_type: 'node_failed' as const,
          step_name: 'failed',
          data: { error: 'boom', tokens: { input: 5, output: 7 }, cost_usd: 0.5 },
        },
        {
          event_type: 'fan_out_instances' as const,
          step_name: 'fan',
          data: { instances: snapshots },
        },
        { event_type: 'fan_out_instances' as const, step_name: 'fan', data: { instances: [] } },
      ];
      for (const row of rows) await store.persistWorkflowEvent({ ...row, workflow_run_id: run.id });
      const snapshot = await store.getDagResumeSnapshot(run.id);
      expect(snapshot.completedNodeOutputs).toEqual(
        new Map([['success', { output: 'ok', structuredOutput: { ok: true } }]])
      );
      expect(snapshot.fanOutSnapshots).toEqual(new Map([['fan', snapshots]]));
      expect(snapshot.unresolvedNodeStarts).toEqual(new Set(['unfinished']));
      expect(snapshot.tokens).toMatchObject({ input: 7, output: 10 });
      expect(snapshot.costUsd).toBe(0.75);
    });
    test('provider events follow emission order within attempts and honor the node cursor', async () => {
      const run = await create(store);
      for (const [stepName, attemptId, seq] of [
        ['build', 'first', 1],
        ['build', 'first', 0],
        ['other', 'other', 0],
        ['build', 'second', 0],
      ] as const) {
        await store.persistWorkflowEvent({
          workflow_run_id: run.id,
          event_type: 'provider_event',
          step_name: stepName,
          data: {
            attemptId,
            seq,
            observedAt: wait.waitingSince,
            event: { type: 'agent_message_chunk', text: 'hello' },
          },
        });
      }
      const records = await store.listProviderEvents(run.id, { stepName: 'build' });
      expect(records.map(row => [row.attemptId, row.seq])).toEqual([
        ['first', 0],
        ['first', 1],
        ['second', 0],
      ]);
      expect(
        await store.listProviderEvents(run.id, {
          stepName: 'build',
          after: { attemptId: 'first', seq: 0 },
        })
      ).toEqual(records.slice(1));
      expect(
        await store.listProviderEvents(run.id, {
          stepName: 'build',
          after: { attemptId: 'absent', seq: 0 },
        })
      ).toEqual([]);
      expect(await store.listProviderEvents(run.id)).toHaveLength(4);
    });
    test('run tree orders children and caps nearest-first ancestry', async () => {
      const root = await create(store);
      const first = await create(store, { parent_run_id: root.id });
      await harness.backdate(first.id, { started_at: new Date(Date.now() - 60_000) });
      const second = await create(store, { parent_run_id: root.id });
      expect((await store.findChildRuns(root.id)).map(run => run.id)).toEqual([
        first.id,
        second.id,
      ]);
      let leaf = first;
      const lineage = [root, first];
      for (let index = 0; index < 35; index++) {
        leaf = await create(store, { parent_run_id: leaf.id });
        lineage.push(leaf);
      }
      expect((await store.getRunAncestry(leaf.id)).map(run => run.id)).toEqual(
        lineage
          .slice(0, -1)
          .reverse()
          .slice(0, 32)
          .map(run => run.id)
      );
      expect(await store.getRunAncestry(root.id)).toEqual([]);
    });
    test('both session kinds upsert without replacing created_at; scope deletion honors every filter', async () => {
      const run = await create(store);
      const key = {
        workflow_name: 'conformance',
        node_id: 'build',
        scope_key: 'scope',
        provider: 'claude',
      };
      await store.upsertWorkflowNodeSession({
        ...key,
        provider_session_id: 'first',
        last_run_id: run.id,
      });
      const initial = await store.listWorkflowNodeSessions(key);
      expect(workflowNodeSessionSchema.safeParse(initial[0]).success).toBe(true);
      await store.upsertWorkflowRunNodeSession({
        workflow_run_id: run.id,
        node_id: 'build',
        provider: 'claude',
        provider_session_id: 'first',
      });
      const runInitial = await store.listWorkflowRunNodeSessions(run.id);
      expect(workflowRunNodeSessionSchema.safeParse(runInitial[0]).success).toBe(true);
      // SQLite's session clock resolves seconds; cross a tick so resetting created_at cannot pass.
      await Bun.sleep(1100);
      await store.upsertWorkflowNodeSession({
        ...key,
        provider_session_id: 'second',
        last_run_id: null,
      });
      const changed = await store.listWorkflowNodeSessions(key);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        provider_session_id: 'second',
        last_run_id: null,
        created_at: initial[0]?.created_at,
      });
      await store.upsertWorkflowNodeSession({
        ...key,
        scope_key: 'other',
        provider_session_id: 'other',
        last_run_id: run.id,
      });
      await store.upsertWorkflowNodeSession({
        ...key,
        node_id: 'other',
        provider_session_id: 'other',
        last_run_id: run.id,
      });
      await store.upsertWorkflowRunNodeSession({
        workflow_run_id: run.id,
        node_id: 'build',
        provider: 'codex',
        provider_session_id: 'second',
      });
      expect(await store.listWorkflowRunNodeSessions(run.id)).toEqual([
        expect.objectContaining({
          provider: 'codex',
          provider_session_id: 'second',
          created_at: runInitial[0]?.created_at,
        }),
      ]);
      expect(
        await store.deleteWorkflowNodeSessions({
          workflow_name: 'conformance',
          scope_key: 'scope',
          node_id: 'build',
        })
      ).toEqual({ deleted: 1 });
      expect(await store.listWorkflowNodeSessions(key)).toHaveLength(1);
      expect(
        await store.deleteWorkflowNodeSessions({ workflow_name: 'conformance', scope_key: 'scope' })
      ).toEqual({ deleted: 1 });
      expect(await store.listWorkflowNodeSessions({ ...key, scope_key: 'other' })).toHaveLength(1);
      expect(await store.deleteWorkflowNodeSessions({ workflow_name: 'conformance' })).toEqual({
        deleted: 1,
      });
    });
    test('conversation cancellation includes parent-conversation matches, leaves live and unrelated descendants alone', async () => {
      const origin = { conversationId: CONFORMANCE_CONVERSATION_ID };
      const paused = await running(store, { origin });
      await store.pauseWorkflowRun(paused.id, approval);
      const failed = await create(store, {
        origin: { parentConversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.failWorkflowRun(failed.id, 'failed');
      const live = await running(store, { origin });
      const child = await running(store, { parent_run_id: paused.id });
      await store.pauseWorkflowRun(child.id, approval);
      const results = await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID);
      expect(results.map(run => run.id).sort()).toEqual([paused.id, failed.id].sort());
      for (const id of [paused.id, failed.id]) {
        expect(await store.getWorkflowRunStatus(id)).toBe('cancelled');
        expect((await types(store, id)).filter(type => type === 'workflow_cancelled')).toHaveLength(
          1
        );
      }
      expect(await store.getWorkflowRunStatus(live.id)).toBe('running');
      expect(await store.getWorkflowRunStatus(child.id)).toBe('paused');
      expect(await store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID)).toEqual(
        []
      );
    });
    test('a conversation-cancellation refusal sees the resumable snapshot and writes nothing', async () => {
      const paused = await running(store, {
        origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
      });
      await store.pauseWorkflowRun(paused.id, approval);
      const refusal = new Error('not permitted');
      let seen: string[] = [];
      const outcome = await store
        .cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID, runs => {
          seen = runs.map(run => run.id);
          throw refusal;
        })
        .catch((error: unknown) => error);
      expect(outcome).toBe(refusal);
      expect(seen).toEqual([paused.id]);
      expect(await store.getWorkflowRunStatus(paused.id)).toBe('paused');
      expect(await types(store, paused.id)).not.toContain('workflow_cancelled');
    });
    test('listing filters, counts, pagination and UUID prefixes agree', async () => {
      const first = await create(store, {
        id: 'abcdef00-0000-4000-8000-000000000001',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        workflow_name: 'needle',
      });
      await harness.backdate(first.id, { started_at: new Date('2026-01-01T00:00:00.000Z') });
      const second = await running(store, {
        id: 'abcdef00-0000-4000-8000-000000000002',
        codebase_id: CONFORMANCE_CODEBASE_ID,
        workflow_name: 'needle',
      });
      await harness.backdate(second.id, { started_at: new Date('2026-01-02T00:00:00.000Z') });
      await store.pauseWorkflowRun(second.id, approval);
      await create(store, { workflow_name: 'other' });
      const listed = await store.listWorkflowRuns({
        codebaseId: CONFORMANCE_CODEBASE_ID,
        status: ['paused', 'pending'],
        search: 'needle',
        limit: 1,
      });
      expect(listed.runs.map(run => run.id)).toEqual([second.id]);
      expect(listed.total).toBe(2);
      expect(listed.counts).toMatchObject({ all: 2, pending: 1, paused: 1 });
      expect(
        (await store.listWorkflowRuns({ codebaseId: CONFORMANCE_CODEBASE_ID, status: 'paused' }))
          .total
      ).toBe(1);
      expect(
        (
          await store.listWorkflowRuns({ codebaseId: CONFORMANCE_CODEBASE_ID, limit: 1, offset: 1 })
        ).runs.map(run => run.id)
      ).toEqual([first.id]);
      expect(
        (
          await store.listWorkflowRuns({
            codebaseId: CONFORMANCE_CODEBASE_ID,
            after: '2026-01-01T12:00:00.000Z',
            before: '2026-01-03T00:00:00.000Z',
          })
        ).runs.map(run => run.id)
      ).toEqual([second.id]);
      expect(
        (await store.findWorkflowRunsByIdPrefix('ABCDEF00', CONFORMANCE_CODEBASE_ID))
          .map(run => run.id)
          .sort()
      ).toEqual([first.id, second.id]);
      await create(store, {
        id: 'abcdef00-0000-4000-8000-000000000003',
        codebase_id: CONFORMANCE_CODEBASE_ID,
      });
      expect(
        await store.findWorkflowRunsByIdPrefix('abcdef00', CONFORMANCE_CODEBASE_ID)
      ).toHaveLength(2);
      expect(await store.findWorkflowRunsByIdPrefix('abcdef00', crypto.randomUUID())).toEqual([]);
      for (const prefix of ['', '%', '_', 'not-a-uuid'])
        expect(await store.findWorkflowRunsByIdPrefix(prefix, CONFORMANCE_CODEBASE_ID)).toEqual([]);
    });
    test('open work excludes adopted failures, adopters are newest first, cleanup deletes only old terminals', async () => {
      const failed = await create(store, { codebase_id: CONFORMANCE_CODEBASE_ID });
      await store.failWorkflowRun(failed.id, 'failed');
      const old = new Date(Date.now() - 4 * 86_400_000);
      await harness.backdate(failed.id, { started_at: old });
      expect(
        (await store.findOpenWorkRuns({ codebaseId: CONFORMANCE_CODEBASE_ID })).map(run => run.id)
      ).toEqual([failed.id]);
      const first = await create(store, { adopted_from_run_id: failed.id });
      await harness.backdate(first.id, { started_at: old });
      const second = await create(store, { adopted_from_run_id: failed.id });
      expect((await store.findAdoptingRuns(failed.id)).map(run => run.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(await store.findOpenWorkRuns()).toEqual([]);
      const scope = { workflow_name: 'conformance', scope_key: 'cleanup' };
      await store.upsertWorkflowNodeSession({
        ...scope,
        node_id: 'build',
        provider: 'claude',
        provider_session_id: 'keep',
        last_run_id: failed.id,
      });
      expect(await store.deleteOldWorkflowRuns(2)).toEqual({ count: 1 });
      expect(await store.listWorkflowNodeSessions(scope)).toEqual([
        expect.objectContaining({ provider_session_id: 'keep', last_run_id: null }),
      ]);

      expect(await store.getWorkflowRun(failed.id)).toBeNull();
      expect(await store.listWorkflowEvents(failed.id)).toEqual([]);
      expect(await store.getWorkflowRunStatus(first.id)).toBe('pending');
      expect(await rejection(store.deleteOldWorkflowRuns(-1))).toBeInstanceOf(Error);
    });
    test('origin-free and chat runs round-trip the supplied provenance', async () => {
      const free = await create(store);
      expect(await store.getWorkflowRun(free.id)).toMatchObject({
        origin: null,
        conversation_id: null,
        parent_conversation_id: null,
        user_id: null,
      });
      const origin = { conversationId: CONFORMANCE_CONVERSATION_ID };
      const chat = await create(store, { origin });
      expect((await store.getWorkflowRun(chat.id))?.origin).toEqual(origin);
    });
  });
}
