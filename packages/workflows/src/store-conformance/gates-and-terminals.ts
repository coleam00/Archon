import { beforeEach, describe, expect, test } from 'bun:test';
import {
  FAN_OUT_CANCEL_REASONS,
  DETACHED_LAUNCH_METADATA_KEY,
  executionClaim,
  type IWorkflowStore,
} from '../store';
import { TERMINAL_WORKFLOW_STATUSES, isTerminalRunStatus } from '../schemas/workflow-run';
import { terminalRecordSchema } from '../schemas/terminal-record';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  CONFORMANCE_CONVERSATION_ID,
  approval,
  eight,
  create,
  running,
  types,
  rejection,
  gateEvents,
} from './fixtures';
import { assertWorkflowGateRace } from './races';

export function describeGatesAndTerminalsConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('gates and terminal writes', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
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
          IWorkflowStore['completeWorkflowRun' | 'failWorkflowRun' | 'cancelWorkflowRun']
        > =>
          mode === 'complete'
            ? store.completeWorkflowRun(run.id, { duration_ms: 5 })
            : mode === 'fail'
              ? store.failWorkflowRun(run.id, 'failed')
              : mode === 'cancel'
                ? store.cancelWorkflowRun(run.id)
                : store.cancelFanOutRun(run.id, 'fan_out_sibling');
        const results = await Promise.allSettled(Array.from({ length: 8 }, write));
        if (mode === 'complete') {
          expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter(result => result.status === 'rejected')).toHaveLength(7);
        } else {
          for (const result of results) expect(result.status).toBe('fulfilled');
          const won = results.filter(
            result =>
              result.status === 'fulfilled' &&
              result.value !== undefined &&
              ('failed' in result.value ? result.value.failed : result.value.cancelled)
          );
          expect(won).toHaveLength(1);
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
    test.each(['complete', 'fail', 'cancel', 'fan-out', 'reject', 'reset'] as const)(
      '%s publishes terminal status together with its event',
      async mode => {
        const run = await running(store, {
          origin: { conversationId: CONFORMANCE_CONVERSATION_ID },
        });
        if (mode === 'reject' || mode === 'reset') await store.pauseWorkflowRun(run.id, approval);
        const writers: Record<typeof mode, () => Promise<unknown>> = {
          complete: () => store.completeWorkflowRun(run.id, { duration_ms: 1 }),
          fail: () => store.failWorkflowRun(run.id, 'failed'),
          cancel: () => store.cancelWorkflowRun(run.id),
          'fan-out': () => store.cancelFanOutRun(run.id, 'fan_out_sibling'),
          reject: () =>
            store.resolveAndCancelApprovalGate(run.id, gateEvents(0), {
              step_name: 'review',
            }),
          reset: () => store.cancelResumableRunsForConversation(CONFORMANCE_CONVERSATION_ID),
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
      }
    );
    test('a racing resume follows the failure event when it succeeds', async () => {
      const run = await running(store);
      const pending = store.failWorkflowRun(run.id, 'failed');
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
    test.each([...TERMINAL_WORKFLOW_STATUSES])(
      'failure acknowledges an already %s run without another terminal write',
      async status => {
        const run = await running(store);
        if (status === 'completed') await store.completeWorkflowRun(run.id, { duration_ms: 1 });
        else if (status === 'failed') await store.failWorkflowRun(run.id, 'first failure');
        else await store.cancelWorkflowRun(run.id);
        const before = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        const reports = harness.terminalReports();

        expect(
          await store.failWorkflowRun(run.id, 'late failure', { exitReason: 'node_error' })
        ).toEqual({ failed: false });

        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
        expect(harness.terminalReports()).toEqual(reports);
      }
    );
    test.each([
      'pending',
      'wrong token',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'missing',
    ] as const)('detached startup failure condition preserves ownership: %s', async state => {
      const run = await store.createWorkflowRun({
        workflow_name: 'startup',
        user_message: '',
        metadata: { [DETACHED_LAUNCH_METADATA_KEY]: 'launch-token' },
      });
      if (state !== 'pending' && state !== 'wrong token' && state !== 'missing') {
        await store.claimPendingWorkflowRun(run.id);
        if (state === 'paused') await store.pauseWorkflowRun(run.id, approval);
        if (state === 'completed') await store.completeWorkflowRun(run.id, { duration_ms: 0 });
        if (state === 'failed') await store.failWorkflowRun(run.id, 'first failure');
        if (state === 'cancelled') await store.cancelWorkflowRun(run.id);
      }
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      const reports = harness.terminalReports();
      expect(
        await store.failWorkflowRun(
          state === 'missing' ? crypto.randomUUID() : run.id,
          'startup failed',
          {
            exitReason: 'launch_failed',
            pendingLaunchToken: state === 'wrong token' ? 'stale-token' : 'launch-token',
          }
        )
      ).toEqual({ failed: state === 'pending' });
      if (state === 'pending') {
        expect(await store.getWorkflowRun(run.id)).toMatchObject({
          status: 'failed',
          metadata: { error: 'startup failed', stop_reason: { reason: 'launch_failed' } },
        });
        expect(
          (await store.listWorkflowEvents(run.id)).filter(
            event => event.event_type === 'workflow_failed'
          )
        ).toHaveLength(1);
        expect(harness.terminalReports()).toEqual([...reports, run.id]);
      } else {
        expect(await store.getWorkflowRun(run.id)).toEqual(before);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
        expect(harness.terminalReports()).toEqual(reports);
      }
    });
    test('failure rejects a missing run', async () => {
      expect(await rejection(store.failWorkflowRun('missing-run', 'failure'))).toBeInstanceOf(
        Error
      );
    });
    test('terminal writer start-state predicates preserve losers', async () => {
      const pending = await create(store);
      expect(
        await rejection(store.completeWorkflowRun(pending.id, { duration_ms: 0 }))
      ).toBeInstanceOf(Error);
      expect(await types(store, pending.id)).toEqual([]);
      expect(await store.failWorkflowRun(pending.id, 'setup failed')).toEqual({ failed: true });
      expect(await store.cancelWorkflowRun(pending.id)).toEqual({ cancelled: true });
      const paused = await running(store);
      await store.pauseWorkflowRun(paused.id, approval);
      expect(await rejection(store.failWorkflowRun(paused.id, 'bad'))).toBeInstanceOf(Error);
      expect(await types(store, paused.id)).toEqual([]);
      expect(await store.cancelWorkflowRun(paused.id)).toEqual({ cancelled: true });
      const completed = await running(store);
      await store.completeWorkflowRun(completed.id, { duration_ms: 1 });
      expect(await store.cancelWorkflowRun(completed.id)).toEqual({ cancelled: false });
      expect(await store.cancelFanOutRun(completed.id, 'fan_out_orphan')).toEqual({
        cancelled: false,
      });
      expect(harness.terminalReports()).toEqual([pending.id, pending.id, paused.id, completed.id]);
    });
    test.each(['operator', 'fan_out'] as const)(
      '%s cancellation preserves settled runs and cancels eligible runs',
      async mode => {
        const cancel = (id: string) =>
          mode === 'operator'
            ? store.cancelWorkflowRun(id)
            : store.cancelFanOutRun(id, 'fan_out_orphan');
        for (const status of [
          'pending',
          'running',
          'paused',
          'failed',
          'completed',
          'cancelled',
        ] as const) {
          const run = await create(store);
          if (status === 'completed') {
            await store.updateWorkflowRun(run.id, { status: 'running' });
            await store.completeWorkflowRun(run.id, { duration_ms: 1 });
          } else if (status === 'failed') await store.failWorkflowRun(run.id, 'failure');
          else if (status === 'cancelled') await store.cancelWorkflowRun(run.id);
          else if (status !== 'pending') await store.updateWorkflowRun(run.id, { status });
          const before = await store.getWorkflowRun(run.id);
          const events = await store.listWorkflowEvents(run.id);
          const reports = harness.terminalReports();
          const settled = status === 'completed' || status === 'cancelled';
          expect(await cancel(run.id)).toEqual({ cancelled: !settled });
          if (settled) {
            expect(await store.getWorkflowRun(run.id)).toEqual(before);
            expect(await store.listWorkflowEvents(run.id)).toEqual(events);
            expect(harness.terminalReports()).toEqual(reports);
          } else {
            expect((await store.getWorkflowRun(run.id))?.status).toBe('cancelled');
            expect((await store.listWorkflowEvents(run.id)).at(-1)?.event_type).toBe(
              'workflow_cancelled'
            );
          }
        }
        expect(await cancel(crypto.randomUUID())).toEqual({ cancelled: false });
      }
    );
    test('fan-out recovery retracts only engine cancellations', async () => {
      for (const reason of FAN_OUT_CANCEL_REASONS) {
        const recovered = await running(store);
        const release = {
          claimId: executionClaim((await store.getWorkflowRun(recovered.id))?.metadata ?? {}),
          nodeId: 'check',
          error: 'EACCES',
          retryAt: new Date().toISOString(),
        };
        await store.cancelFanOutRun(recovered.id, reason);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => store.recoverCancelledFanOutRun(recovered.id))
        );
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(await store.releaseRunForUnreadableSource(recovered.id, release)).toEqual({
          released: false,
        });
        const resumed = await store.getWorkflowRun(recovered.id);
        expect(resumed?.status).toBe('running');
        expect(await types(store, recovered.id)).toEqual(['workflow_resumed']);
        expect(
          await store.releaseRunForUnreadableSource(recovered.id, {
            ...release,
            claimId: executionClaim(resumed?.metadata ?? {}),
          })
        ).toEqual({ released: true });
        expect(await types(store, recovered.id)).toEqual(['workflow_resumed', 'source_released']);
      }
      const run = await running(store);
      await store.cancelFanOutRun(run.id, 'fan_out_orphan');
      expect((await store.recoverCancelledFanOutRun(run.id)).status).toBe('running');
      await store.cancelWorkflowRun(run.id);
      expect(await rejection(store.recoverCancelledFanOutRun(run.id))).toBeInstanceOf(Error);
      expect(await types(store, run.id)).toEqual(['workflow_resumed', 'workflow_cancelled']);
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
  });
}
