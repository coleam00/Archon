import { beforeEach, describe, expect, test } from 'bun:test';
import {
  executionClaim,
  WorkflowNotResumableError,
  continuablePauseCursor,
  deadlineWaitCursor,
  WorkflowRunPauseConflictError,
  type IWorkflowStore,
} from '../store';
import {
  approvalContextSchema,
  continuablePause,
  pausedAttentionWait,
  pendingWorkflowWaitDeadline,
  workflowWaitContextSchema,
  type ApprovalContext,
  type WorkflowWaitContext,
  type WorkflowRun,
} from '../schemas/workflow-run';
import { PAUSE_CAUSE_METADATA_KEY } from '../schemas/pause-cause';
import { listAttentionQueue } from '../attention-queue';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  approval,
  wait,
  attentionWait,
  answeredAttention,
  attentionAnswer,
  schedule,
  failWithSchedule,
  eight,
  create,
  running,
  types,
  rejection,
  gateEvents,
} from './fixtures';

export function describePausesAndWaitsConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('pauses and waits', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });

    test('preserves private loop owner cursors through durable pause storage', async () => {
      const bodySessionCursors = { owner: { sessionId: 'O', provider: 'codex' } };
      const bodySessionCursorAncestry = {
        '["outer",[]]': { owner: { sessionId: 'A', provider: 'codex' } },
        '["outer.inner",[{"groupId":"outer","iteration":2}]]': bodySessionCursors,
      };
      const gateRun = await running(store);
      await store.pauseWorkflowRun(gateRun.id, {
        ...approval,
        bodySessionCursors,
        bodySessionCursorAncestry,
      });
      const storedGate = await store.getWorkflowRun(gateRun.id);
      expect(
        approvalContextSchema.parse(storedGate?.metadata?.approval).bodySessionCursors
      ).toEqual(bodySessionCursors);
      expect(
        approvalContextSchema.parse(storedGate?.metadata?.approval).bodySessionCursorAncestry
      ).toEqual(bodySessionCursorAncestry);
      const waitRun = await running(store);
      await store.pauseWorkflowRunForWait(
        waitRun.id,
        {
          ...wait,
          owner: 'loop_group',
          nodeId: 'group',
          bodyWaitId: 'wait',
          iteration: 2,
          sessionId: 'review-session',
          sessionProvider: 'codex',
          bodySessionCursors,
          bodySessionCursorAncestry,
        },
        { kind: 'started', stepName: 'group.wait' }
      );
      const storedWait = workflowWaitContextSchema.parse(
        (await store.getWorkflowRun(waitRun.id))?.metadata?.wait
      );
      expect(storedWait.owner).toBe('loop_group');
      if (storedWait.owner !== 'loop_group') throw new Error('wrong wait owner');
      expect(storedWait.bodySessionCursors).toEqual(bodySessionCursors);
      expect(storedWait.bodySessionCursorAncestry).toEqual(bodySessionCursorAncestry);
    });

    test('pause requires running, replaces the whole approval and commits suspension once', async () => {
      const run = await running(store, { metadata: { keep: true } });
      await store.pauseWorkflowRun(run.id, { ...approval, resolved: 'rejected' });
      expect(await rejection(store.pauseWorkflowRun(run.id, approval))).toBeInstanceOf(
        WorkflowRunPauseConflictError
      );
      const resumed = await store.resumeWorkflowRun(run.id);
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
        execution_claim: executionClaim(resumed.metadata),
        keep: true,
        extra: true,
        approval,
        [PAUSE_CAUSE_METADATA_KEY]: 'gate',
      });
      expect(await types(store, run.id)).toEqual(['workflow_unpaused', 'node_suspended']);
    });
    test('refuses unknown wait fields without changing the run or events', async () => {
      const run = await running(store);
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      const future = { ...wait, futureField: true };
      await expect(
        store.pauseWorkflowRunForWait(run.id, future, {
          kind: 'started',
          stepName: 'wait',
        })
      ).rejects.toThrow();
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
    });

    test.each(['create', 'update', 'complete', 'resolve'] as const)(
      '%s validates waits in generic metadata before changing rows or events',
      async operation => {
        const run = await running(store);
        if (operation === 'update')
          await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
        if (operation === 'resolve') await store.pauseWorkflowRun(run.id, approval);
        const id = operation === 'create' ? crypto.randomUUID() : run.id;
        const write = (value: unknown): Promise<unknown> => {
          const metadata = { wait: value, extra: true };
          switch (operation) {
            case 'create':
              return create(store, { id, metadata });
            case 'update':
              return store.updateWorkflowRun(id, { metadata });
            case 'complete':
              return store.completeWorkflowRun(id, { duration_ms: 1 }, metadata);
            case 'resolve':
              return store.resolveApprovalGate(id, metadata, gateEvents(0));
          }
        };
        const before = await store.getWorkflowRun(id);
        const events = await store.listWorkflowEvents(id);
        for (const invalid of [
          { ...wait, futureField: true },
          { ...wait, resumeAt: 42 },
        ]) {
          await expect(write(invalid)).rejects.toThrow();
          expect(await store.getWorkflowRun(id)).toEqual(before);
          expect(await store.listWorkflowEvents(id)).toEqual(events);
        }
        await write(wait);
        expect((await store.getWorkflowRun(id))?.metadata).toMatchObject({ wait, extra: true });
      }
    );

    test('approval pauses discard caller-supplied wait metadata', async () => {
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval, { wait: { ...wait, futureField: true } });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toBeUndefined();
    });

    test('future wait fields preserve attention actions, continuations and event signals', async () => {
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, attentionWait, {
        kind: 'started',
        stepName: 'ask',
      });
      const currentRun = async (): Promise<WorkflowRun> => {
        const current = await store.getWorkflowRun(run.id);
        if (!current) throw new Error('Expected paused run');
        return current;
      };
      const seedFuture = (context: WorkflowWaitContext): Promise<void> =>
        harness.seedPersistedWait(run.id, { ...context, futureField: true });
      await seedFuture(attentionWait);
      expect(pausedAttentionWait(await currentRun())).toEqual(attentionWait);
      expect(
        (await listAttentionQueue({ store, branchOf: async () => null })).map(item => item.runId)
      ).toContain(run.id);
      const labeled = await store.labelAttentionWait(run.id, {
        pauseId: 'ask-1',
        set: { ci: 'pr' },
        unset: [],
        via: 'cli',
      });
      expect(labeled).toMatchObject({ labeled: true, wait: { revision: 2, labels: { ci: 'pr' } } });
      const stored = workflowWaitContextSchema.parse(
        (await store.getWorkflowRun(run.id))?.metadata.wait
      );
      expect(stored).not.toHaveProperty('futureField');
      await seedFuture(stored);
      expect(await store.answerAttentionWait(run.id, attentionAnswer('use-main'))).toEqual({
        answered: true,
      });
      const answered = workflowWaitContextSchema.parse(
        (await store.getWorkflowRun(run.id))?.metadata.wait
      );
      expect(answered).toMatchObject({
        answer: { decision: 'use-main' },
        revision: 2,
        labels: { ci: 'pr' },
      });
      expect((await store.listDueWorkflowContinuations(new Date())).map(row => row.id)).toContain(
        run.id
      );
      await store.resumeWorkflowRun(run.id);
      const event = {
        ...wait,
        kind: 'event' as const,
        event: 'ready',
        pauseId: 'event-1',
        resumeAt: '2099-01-01T00:00:00.000Z',
      };
      await store.pauseWorkflowRunForWait(run.id, event, { kind: 'started', stepName: 'wait' });
      await seedFuture(event);
      const deadline = pendingWorkflowWaitDeadline(await currentRun());
      expect(deadline).toEqual(event);
      if (!deadline || deadline.kind !== 'event') throw new Error('Expected event wait');
      await store.resumeWorkflowRun(run.id);
      await store.pauseWorkflowRunForWait(run.id, deadline, { kind: 'continued' });
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toEqual(event);
      await seedFuture(event);
      expect(await store.signalWorkflowWait(run.id, deadline, { ready: true })).toEqual({
        signaled: true,
      });
      const signaled = pendingWorkflowWaitDeadline(await currentRun());
      expect(workflowWaitContextSchema.safeParse(signaled).success).toBe(true);
      expect(signaled).toMatchObject({
        ...event,
        signaledAt: expect.any(String),
        payload: { ready: true },
      });
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
      expect(await types(store, run.id)).toEqual([
        'wait_started',
        'workflow_unpaused',
        'wait_continued',
      ]);
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
        'workflow_unpaused',
        'wait_continued',
        'workflow_unpaused',
        'wait_completed',
        'node_completed',
      ]);
      if (!winner?.cleared) throw new Error('No wait winner');
      expect(rows[5]).toMatchObject(winner.nodeEvent);
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('wait');
    });
    test.each([undefined, { value: 'signal' }])(
      'a stale signal cannot satisfy a later event occurrence with the same deadline (payload %j)',
      async payload => {
        const first: Extract<WorkflowWaitContext, { kind: 'event' }> = {
          owner: 'node',
          nodeId: 'gate',
          kind: 'event',
          event: 'ready',
          waitingSince: new Date().toISOString(),
          resumeAt: new Date(Date.now() + 86_400_000).toISOString(),
          pauseId: 'first',
        };
        const run = await running(store);
        await store.pauseWorkflowRunForWait(run.id, first, { kind: 'started', stepName: 'gate' });
        expect(await store.signalWorkflowWait(run.id, first, payload)).toEqual({ signaled: true });
        await store.resumeWorkflowRun(run.id);
        await store.clearWorkflowWaitContext(run.id, first, {
          stepName: 'gate',
          result: { status: 'satisfied', waited_ms: 0 },
        });
        const second = { ...first, pauseId: 'second' };
        await store.pauseWorkflowRunForWait(run.id, second, { kind: 'started', stepName: 'gate' });
        const before = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        expect(
          await store.signalWorkflowWait(run.id, { ...first, pauseId: undefined }, payload)
        ).toEqual({ signaled: false });
        expect(await store.signalWorkflowWait(run.id, first, payload)).toEqual({ signaled: false });
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
        expect(
          (await store.listDueWorkflowContinuations(new Date(), 10)).map(row => row.id)
        ).not.toContain(run.id);
        expect(await store.signalWorkflowWait(run.id, second, payload)).toEqual({ signaled: true });
        expect((await store.getWorkflowRun(run.id))?.metadata.wait).toMatchObject({
          pauseId: 'second',
          ...(payload === undefined ? {} : { payload }),
        });
      }
    );
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
      expect(
        await store.signalWorkflowWait(signaled.id, { ...event, pauseId: 'not-legacy' })
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
    test('a usage-limit wait is due at its reset, and its claim clears it', async () => {
      const limit: Extract<WorkflowWaitContext, { kind: 'quota' }> = {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'limit-1',
        waitingSince: wait.waitingSince,
        resumeAt: wait.resumeAt,
      };
      const run = await running(store);
      await store.pauseWorkflowRunForWait(run.id, limit, {
        kind: 'started',
        stepName: limit.nodeId,
      });
      await harness.seedPersistedWait(run.id, { ...limit, futureField: true });
      const paused = await store.getWorkflowRun(run.id);
      expect(paused?.status).toBe('paused');
      expect(paused && continuablePauseCursor(paused)).toEqual(deadlineWaitCursor(limit));
      const due = async (now: Date): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(now, 10)).map(row => row.id);
      expect(await due(new Date(Date.parse(limit.resumeAt) - 1000))).not.toContain(run.id);
      expect(await due(new Date(Date.parse(limit.resumeAt) + 1000))).toContain(run.id);
      const resumed = await store.resumeWorkflowRun(run.id, deadlineWaitCursor(limit));
      expect(resumed.status).toBe('running');
      expect(resumed.metadata.wait).toBeUndefined();
      expect((await store.getWorkflowRun(run.id))?.metadata.wait).toBeUndefined();
      expect(await types(store, run.id)).toEqual(['wait_started', 'workflow_unpaused']);

      const cancelled = await running(store);
      await store.pauseWorkflowRunForWait(cancelled.id, limit, {
        kind: 'started',
        stepName: limit.nodeId,
      });
      expect(await store.cancelWorkflowRun(cancelled.id)).toEqual({ cancelled: true });
      expect(await due(new Date(Date.parse(limit.resumeAt) + 1000))).not.toContain(cancelled.id);
    });
    test('due continuations come earliest first, so a limit keeps the most overdue', async () => {
      const later = await running(store);
      await store.pauseWorkflowRunForWait(
        later.id,
        { ...wait, resumeAt: new Date(Date.parse(wait.resumeAt) + 60_000).toISOString() },
        { kind: 'started', stepName: 'wait' }
      );
      const earlier = await running(store);
      await store.pauseWorkflowRunForWait(earlier.id, wait, { kind: 'started', stepName: 'wait' });
      const now = new Date(Date.parse(wait.resumeAt) + 120_000);
      expect((await store.listDueWorkflowContinuations(now, 1)).map(run => run.id)).toEqual([
        earlier.id,
      ]);
      expect((await store.listDueWorkflowContinuations(now, 10)).map(run => run.id)).toEqual([
        earlier.id,
        later.id,
      ]);
    });
    test('an answered gate is due once, at its exact occurrence, and an open one never is', async () => {
      const due = async (): Promise<string[]> =>
        (await store.listDueWorkflowContinuations(new Date(), 10)).map(run => run.id);
      const answer = (id: string, gate: ApprovalContext): Promise<{ resolved: boolean }> =>
        store.resolveApprovalGate(id, { approval: { ...gate, resolved: 'approved' } }, []);
      const cursor = { kind: 'answered' as const, nodeId: approval.nodeId, pauseId: 'first' };
      const run = await running(store);
      await store.pauseWorkflowRun(run.id, approval);
      expect(await due()).not.toContain(run.id);
      expect(await answer(run.id, approval)).toEqual({ resolved: true });
      expect(await due()).toContain(run.id);

      const retryAt = new Date(Date.now() + 3_600_000).toISOString();
      await store.deferWorkflowContinuation(run.id, retryAt, { ...cursor, pauseId: 'other' });
      expect(await due()).toContain(run.id);
      await store.deferWorkflowContinuation(run.id, retryAt, cursor);
      expect(await due()).not.toContain(run.id);
      const afterRetry = new Date(Date.parse(retryAt) + 1000);
      expect(
        (await store.listDueWorkflowContinuations(afterRetry, 10)).map(due => due.id)
      ).toContain(run.id);

      expect(
        await rejection(store.resumeWorkflowRun(run.id, { ...cursor, pauseId: 'other' }))
      ).toBeInstanceOf(WorkflowNotResumableError);
      expect((await store.resumeWorkflowRun(run.id, cursor)).status).toBe('running');
      expect(await rejection(store.resumeWorkflowRun(run.id, cursor))).toBeInstanceOf(
        WorkflowNotResumableError
      );

      // A wait replaces the answered gate, so the run is due only when its wait is.
      await store.pauseWorkflowRunForWait(run.id, wait, { kind: 'started', stepName: 'wait' });
      expect((await store.getWorkflowRun(run.id))?.metadata).not.toHaveProperty('approval');
      expect(
        (
          await store.listDueWorkflowContinuations(new Date(Date.parse(wait.resumeAt) - 1000), 10)
        ).map(due => due.id)
      ).not.toContain(run.id);
    });
    test('answered gates the host cannot continue are never due', async () => {
      const cases: [ApprovalContext, Record<string, unknown>][] = [
        [{ ...approval, type: 'child_workflow', childRunId: 'child' }, {}],
        [{ ...approval, type: 'fan_out', childRunIds: ['child'], unspawnedItems: 0 }, {}],
        [{ ...approval, type: 'writeback', nodeId: '__writeback__' }, {}],
        [{ nodeId: approval.nodeId, message: approval.message, type: 'approval' }, {}],
        [approval, { isolation: 'container' }],
      ];
      const ids: string[] = [];
      for (const [gate, metadata] of cases) {
        const run = await running(store, { metadata });
        await store.pauseWorkflowRun(run.id, gate);
        expect(
          await store.resolveApprovalGate(
            run.id,
            { approval: { ...gate, resolved: 'approved' } },
            []
          )
        ).toEqual({
          resolved: true,
        });
        ids.push(run.id);
      }
      const due = (await store.listDueWorkflowContinuations(new Date(), 10)).map(run => run.id);
      for (const id of ids) expect(due).not.toContain(id);
    });
    test('answered gates are listed after every timed continuation', async () => {
      // This gate's run was resumed from a quota schedule first; the triggered schedule it
      // keeps must not sort it among the timed rows.
      const gate = await running(store);
      await failWithSchedule(store, gate.id);
      await store.resumeWorkflowRun(gate.id, {
        kind: 'quota',
        attempt: schedule.attempt,
        resumeAt: schedule.resumeAt,
      });
      await store.pauseWorkflowRun(gate.id, approval);
      await store.resolveApprovalGate(
        gate.id,
        { approval: { ...approval, resolved: 'rejected' } },
        []
      );
      // Due later than that stale schedule, so only the gate rule puts it first.
      const timedAt = new Date(Date.parse(schedule.resumeAt) + 60_000).toISOString();
      const timed = await running(store);
      await store.pauseWorkflowRunForWait(
        timed.id,
        { ...wait, resumeAt: timedAt },
        { kind: 'started', stepName: 'wait' }
      );
      const now = new Date(Date.parse(timedAt) + 1000);
      expect((await store.listDueWorkflowContinuations(now, 10)).map(run => run.id)).toEqual([
        timed.id,
        gate.id,
      ]);
    });
    test('a pause is due and gives back its slot exactly when the host continues it', async () => {
      const gate = (
        extra: Partial<Pick<ApprovalContext, 'type' | 'childRunId' | 'nodeId' | 'resolved'>>
      ): ApprovalContext => ({ ...approval, ...extra });
      const shapes: {
        name: string;
        metadata?: Record<string, unknown>;
        pause: (id: string) => Promise<unknown>;
      }[] = [
        {
          name: 'time wait',
          pause: id =>
            store.pauseWorkflowRunForWait(id, wait, { kind: 'started', stepName: 'wait' }),
        },
        {
          name: 'gate with a pauseId',
          pause: id => store.pauseWorkflowRun(id, gate({ resolved: 'approved' })),
        },
        {
          name: 'child_workflow gate',
          pause: id =>
            store.pauseWorkflowRun(
              id,
              gate({ type: 'child_workflow', childRunId: 'child', resolved: 'approved' })
            ),
        },
        {
          name: 'fan_out gate',
          pause: id =>
            store.pauseWorkflowRun(id, {
              ...approval,
              type: 'fan_out',
              childRunIds: ['child'],
              unspawnedItems: 0,
              resolved: 'approved',
            }),
        },
        {
          name: 'writeback gate',
          pause: id =>
            store.pauseWorkflowRun(
              id,
              gate({ type: 'writeback', nodeId: '__writeback__', resolved: 'approved' })
            ),
        },
        {
          name: 'container gate',
          metadata: { isolation: 'container' },
          pause: id => store.pauseWorkflowRun(id, gate({ resolved: 'approved' })),
        },
        {
          name: 'attention wait',
          pause: id =>
            store.pauseWorkflowRunForWait(id, answeredAttention('use-main'), {
              kind: 'started',
              stepName: 'ask',
            }),
        },
        {
          name: 'attention wait from before pause identities',
          pause: id =>
            store.pauseWorkflowRunForWait(
              id,
              { ...answeredAttention('use-main'), pauseId: undefined },
              { kind: 'started', stepName: 'ask' }
            ),
        },
        {
          name: 'container attention wait',
          metadata: { isolation: 'container' },
          pause: id =>
            store.pauseWorkflowRunForWait(id, answeredAttention('use-main'), {
              kind: 'started',
              stepName: 'ask',
            }),
        },
      ];
      for (const shape of shapes) {
        const run = await running(store, { metadata: shape.metadata ?? {} });
        await shape.pause(run.id);
        const stored = await store.getWorkflowRun(run.id);
        if (!stored) throw new Error(`missing run for ${shape.name}`);
        const listed = (await store.listDueWorkflowContinuations(new Date(), 50)).some(
          due => due.id === run.id
        );
        // A pause gives back its slot exactly when the host continues it by itself; a
        // released pause the host never continues would strand its run.
        expect({
          shape: shape.name,
          listed,
          releases: continuablePauseCursor(stored) !== undefined,
        }).toEqual({
          shape: shape.name,
          listed:
            continuablePause(stored) !== undefined ||
            pendingWorkflowWaitDeadline(stored) !== undefined,
          releases: listed,
        });
      }
    });
    test('every pause records its cause, and failing the run removes it', async () => {
      const since = new Date().toISOString();
      const later = new Date(Date.now() + 3_600_000).toISOString();
      const cause = async (id: string): Promise<unknown> =>
        (await store.getWorkflowRun(id))?.metadata[PAUSE_CAUSE_METADATA_KEY];
      const gated = await running(store);
      await store.pauseWorkflowRun(gated.id, approval);
      expect(await cause(gated.id)).toBe('gate');
      const parent = await running(store);
      await store.pauseWorkflowRun(parent.id, {
        type: 'child_workflow',
        nodeId: 'sub',
        message: 'child',
        childRunId: 'child-1',
      });
      expect(await cause(parent.id)).toBe('child');
      const waiting = await running(store);
      await store.pauseWorkflowRunForWait(
        waiting.id,
        { owner: 'node', nodeId: 'ask', kind: 'attention', waitingSince: since, message: 'Ok?' },
        { kind: 'started', stepName: 'ask' }
      );
      expect(await cause(waiting.id)).toBe('wait');
      const released = await running(store);
      await store.releaseRunForUnreadableSource(released.id, {
        claimId: executionClaim((await store.getWorkflowRun(released.id))?.metadata ?? {}),
        nodeId: 'check',
        error: 'EACCES',
        retryAt: later,
      });
      expect(await cause(released.id)).toBe('source_release');
      const limited = await running(store);
      const limit: Extract<WorkflowWaitContext, { kind: 'quota' }> = {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'limit-1',
        waitingSince: since,
        resumeAt: later,
      };
      await store.pauseWorkflowRunForWait(limited.id, limit, {
        kind: 'started',
        stepName: 'implement',
      });
      expect(await cause(limited.id)).toBe('quota');
      // The cause survives the resume that consumes it, and a failure clears it.
      const resumed = await store.resumeWorkflowRun(limited.id, deadlineWaitCursor(limit));
      expect(resumed.metadata[PAUSE_CAUSE_METADATA_KEY]).toBe('quota');
      await store.failWorkflowRun(limited.id, 'boom');
      expect(await cause(limited.id)).toBeUndefined();
    });
  });
}
