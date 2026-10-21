import { describe, expect, test } from 'bun:test';
import {
  executionClaim,
  WorkflowNotResumableError,
  WorkflowResourceBusyError,
  type IWorkflowStore,
} from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import type { WorkflowRun } from '../schemas/workflow-run';
import { resourceStartFixtures } from '../resource-start-conformance';

const approval = {
  nodeId: 'review',
  message: 'Choose',
  type: 'approval' as const,
  pauseId: 'first',
};
const cursor = { kind: 'pause' as const, nodeId: 'review', pauseId: 'first' };

async function paused(store: IWorkflowStore): Promise<WorkflowRun> {
  const run = await store.createWorkflowRun({ workflow_name: 'prepare', user_message: '' });
  await store.claimPendingWorkflowRun(run.id);
  await store.pauseWorkflowRun(
    run.id,
    approval,
    {
      pending_writeback: { envId: 'overlay', decision: 'apply' },
      keep: { nested: true },
      error: 'prior evidence',
      stop_reason: { kind: 'operator' },
      continuation_retry_at: '2026-01-01T00:00:00Z',
      capacity_wait: { since: '2026-01-01T00:00:00Z' },
    },
    { workflow_run_id: run.id, event_type: 'node_suspended', step_name: 'review', data: {} }
  );
  const result = await store.getWorkflowRun(run.id);
  if (!result) throw new Error('Missing paused run');
  return result;
}

const types = async (store: IWorkflowStore, id: string) =>
  (await store.listWorkflowEvents(id)).map(event => event.event_type);

export function describeResumePreparationConformance(
  getHarness: () => WorkflowStoreHarness,
  codebaseId: string,
  conversationId: string
): void {
  describe('resume preparation', () => {
    test.each([
      { status: 'failed', error: 'original error' },
      { status: 'failed', error: '' },
      { status: 'failed', error: null },
      { status: 'failed', error: undefined },
      { status: 'failed', error: 42 },
      { status: 'paused', error: undefined },
    ] as const)(
      'resume from %j has one winner and preserves cleared failure evidence',
      async ({ status, error }) => {
        const { store } = getHarness();
        const run = await store.createWorkflowRun({
          workflow_name: 'prepare',
          user_message: '',
          metadata: { keep: true },
        });
        await store.claimPendingWorkflowRun(run.id);
        if (status === 'failed')
          await store.failWorkflowRun(run.id, typeof error === 'string' ? error : '', {
            exitReason: 'node_error',
          });
        else await store.pauseWorkflowRun(run.id, approval);
        await store.updateWorkflowRun(run.id, { metadata: { error } });
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
        // Only the winning resume writes, and a resumed pause is in the feed.
        expect(await types(store, run.id)).toEqual([
          ...before,
          ...(status === 'failed' ? ['workflow_resumed'] : ['workflow_unpaused']),
        ]);
        if (status === 'failed') {
          const resumed = (await store.listWorkflowEvents(run.id)).find(
            event => event.event_type === 'workflow_resumed'
          );
          expect(resumed?.data).toEqual(typeof error === 'string' && error !== '' ? { error } : {});
        }
      }
    );

    test('only the admitted attempt prepares, outside store exclusion', async () => {
      const { store } = getHarness();
      const candidate = await paused(store);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let calls = 0;
      const prepare = async (admitted: WorkflowRun) => {
        calls++;
        expect(admitted.status).toBe('running');
        expect(executionClaim(admitted.metadata)).not.toBe(executionClaim(candidate.metadata));
        expect(await store.getWorkflowRun(candidate.id)).toEqual(admitted);
        await store.updateWorkflowRun(candidate.id, { metadata: { during_setup: true } });
        entered.resolve();
        await finish.promise;
      };
      const winner = store.resumeWorkflowRun(candidate.id, undefined, prepare);
      try {
        await entered.promise;
        await expect(
          store.resumeWorkflowRun(candidate.id, undefined, prepare)
        ).rejects.toBeInstanceOf(WorkflowNotResumableError);
        expect(calls).toBe(1);
      } finally {
        finish.resolve();
        await winner;
      }
      // A stale candidate cannot enter setup even after the winner returned.
      await expect(
        store.resumeWorkflowRun(candidate.id, undefined, prepare)
      ).rejects.toBeInstanceOf(WorkflowNotResumableError);
      expect(calls).toBe(1);
    });

    test.each(['gate', 'usage-limit', 'source-release', 'failed-schedule'] as const)(
      'setup rejection restores the authoritative %s and retracts only its admission events',
      async kind => {
        const harness = getHarness();
        const { store } = harness;
        const candidate = await paused(store);
        if (kind === 'usage-limit') {
          await store.resumeWorkflowRun(candidate.id);
          await store.pauseWorkflowRunForWait(
            candidate.id,
            {
              owner: 'node',
              nodeId: 'retry',
              kind: 'quota',
              pauseId: 'quota-1',
              waitingSince: '2026-01-01T00:00:00Z',
              resumeAt: '2026-01-02T00:00:00Z',
            },
            { kind: 'started', stepName: 'retry' }
          );
        } else if (kind === 'source-release') {
          const admitted = await store.resumeWorkflowRun(candidate.id);
          await store.releaseRunForUnreadableSource(candidate.id, {
            claimId: executionClaim(admitted.metadata),
            nodeId: 'check',
            error: 'EACCES',
            retryAt: '2026-01-02T00:00:00Z',
          });
        } else if (kind === 'failed-schedule') {
          await store.resumeWorkflowRun(candidate.id);
          await store.failWorkflowRun(candidate.id, 'quota');
          await store.updateWorkflowRun(candidate.id, {
            metadata: {
              scheduled_resume: {
                reason: 'quota',
                attempt: 1,
                maxAttempts: 3,
                resumeAt: '2026-01-02T00:00:00Z',
                deadlineAt: '2026-01-03T00:00:00Z',
              },
            },
          });
        }
        await harness.backdate(candidate.id, {
          started_at: new Date('2025-01-01T00:00:00Z'),
          last_activity_at: null,
        });
        const before = await store.getWorkflowRun(candidate.id);
        if (!before) throw new Error('Missing run');
        const beforeEvents = await store.listWorkflowEvents(candidate.id);
        const reports = harness.terminalReports();
        const failure = new Error('Docker or credential setup failed');
        let duringSetupEvent: Awaited<ReturnType<IWorkflowStore['listWorkflowEvents']>> = [];
        await expect(
          store.resumeWorkflowRun(candidate.id, undefined, async () => {
            await store.updateWorkflowRun(candidate.id, {
              metadata: { during_setup: { keep: true } },
            });
            await store.persistWorkflowEvent({
              workflow_run_id: candidate.id,
              event_type: 'workflow_unpaused',
              data: { independent: true },
            });
            duringSetupEvent = (await store.listWorkflowEvents(candidate.id)).filter(
              event => event.data.independent === true
            );
            throw failure;
          })
        ).rejects.toBe(failure);
        expect(await store.getWorkflowRun(candidate.id)).toEqual({
          ...before,
          metadata: { ...before.metadata, during_setup: { keep: true } },
        });
        expect(await store.listWorkflowEvents(candidate.id)).toEqual([
          ...beforeEvents,
          ...duringSetupEvent,
        ]);
        expect(harness.terminalReports()).toEqual(reports);
        let retried = false;
        await store.resumeWorkflowRun(candidate.id, undefined, async () => {
          retried = true;
        });
        expect(retried).toBe(true);
      }
    );

    test.each(['cancelled', 'completed', 'failed', 'successor', 'paused'] as const)(
      'stale undo preserves the entire %s transition and surfaces ownership loss',
      async transition => {
        const { store } = getHarness();
        const { start } = resourceStartFixtures(codebaseId, conversationId);
        const first = start();
        await store.admitResourceStart(first);
        await store.claimPendingWorkflowRun(first.launch.run.id);
        await store.pauseWorkflowRun(first.launch.run.id, approval);
        await store.releasePausedRunSlot(first.launch.run.id, cursor);
        const candidate = first.launch.run;
        const request = await store.getResourceStartRequest(candidate.id);
        if (!request) throw new Error('Missing resource request');
        const failure = new Error('late setup failure');
        let before: WorkflowRun | null = null;
        let events: Awaited<ReturnType<IWorkflowStore['listWorkflowEvents']>> = [];
        let received: unknown;
        try {
          await store.resumeWorkflowRun(candidate.id, undefined, async () => {
            if (transition === 'cancelled') await store.cancelWorkflowRun(candidate.id);
            else if (transition === 'completed')
              await store.completeWorkflowRun(candidate.id, { duration_ms: 1 });
            else if (transition === 'failed')
              await store.failWorkflowRun(candidate.id, 'new failure');
            else {
              await store.pauseWorkflowRun(candidate.id, { ...approval, pauseId: 'successor' });
              if (transition === 'successor') await store.resumeWorkflowRun(candidate.id);
            }
            await store.updateWorkflowRun(candidate.id, { metadata: { other_owner: true } });
            before = await store.getWorkflowRun(candidate.id);
            events = await store.listWorkflowEvents(candidate.id);
            throw failure;
          });
        } catch (error) {
          received = error;
        }
        expect(await store.getWorkflowRun(candidate.id)).toEqual(before);
        expect(await store.listWorkflowEvents(candidate.id)).toEqual(events);
        expect(received).toBeInstanceOf(Error);
        expect(received).toMatchObject({ cause: failure });
        if (!(received instanceof Error)) throw new Error('Missing setup error');
        expect(received.message).toContain('lost execution ownership');
        expect(await store.getResourceStartRequest(candidate.id)).toEqual({
          ...request,
          runStatus: transition === 'successor' ? 'running' : transition,
        });
        expect(await store.admitResourceStart(start())).toMatchObject({
          status: transition === 'successor' || transition === 'paused' ? 'queued' : 'admitted',
        });
      }
    );

    test.each([false, true])(
      'setup failure preserves pre-held slots and releases only newly acquired slots (released=%j)',
      async released => {
        const { store } = getHarness();
        const { start } = resourceStartFixtures(codebaseId, conversationId);
        const first = start('queue', 'host', 2);
        const other = start('queue', 'host', 2);
        const queued = start('queue', 'host', 2);
        expect(await store.admitResourceStart(first)).toMatchObject({ status: 'admitted' });
        expect(await store.admitResourceStart(other)).toMatchObject({ status: 'admitted' });
        const otherRequest = await store.getResourceStartRequest(other.launch.run.id);
        const id = first.launch.run.id;
        await store.claimPendingWorkflowRun(id);
        await store.pauseWorkflowRun(id, approval);
        if (released)
          expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: true });
        const before = await store.getWorkflowRun(id);
        const events = await store.listWorkflowEvents(id);
        await expect(
          store.resumeWorkflowRun(id, undefined, async () => {
            expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
            throw new Error('setup');
          })
        ).rejects.toThrow('setup');
        expect(await store.getWorkflowRun(id)).toEqual(before);
        expect(await store.listWorkflowEvents(id)).toEqual(events);
        expect((await store.getResourceStartRequest(queued.launch.run.id))?.status).toBe('queued');
        expect(await store.getResourceStartRequest(other.launch.run.id)).toEqual(otherRequest);
        // Draining proves the holder and queue semantics through the deciding primitive.
        expect(
          await store.drainResourceStarts({ resource: first.resource, hostId: 'host' })
        ).toEqual(
          released
            ? [{ status: 'admitted', requestId: queued.launch.run.id, runId: queued.launch.run.id }]
            : []
        );
        expect(await store.admitResourceStart(start('queue', 'host', 2))).toMatchObject({
          status: 'queued',
        });
        expect((await store.getResourceStartRequest(id))?.status).toBe('admitted');
      }
    );

    test('no preparation on cursor mismatch, terminal state, missing row or capacity refusal', async () => {
      const { store } = getHarness();
      let calls = 0;
      const prepare = async () => {
        calls++;
      };
      const candidate = await paused(store);
      await expect(
        store.resumeWorkflowRun(
          candidate.id,
          { kind: 'answered', nodeId: 'review', pauseId: 'wrong' },
          prepare
        )
      ).rejects.toBeInstanceOf(WorkflowNotResumableError);
      await store.cancelWorkflowRun(candidate.id);
      await expect(
        store.resumeWorkflowRun(candidate.id, undefined, prepare)
      ).rejects.toBeInstanceOf(WorkflowNotResumableError);
      await expect(
        store.resumeWorkflowRun(crypto.randomUUID(), undefined, prepare)
      ).rejects.toThrow();
      const { start } = resourceStartFixtures(codebaseId, conversationId);
      const first = start();
      await store.admitResourceStart(first);
      await store.claimPendingWorkflowRun(first.launch.run.id);
      await store.pauseWorkflowRun(first.launch.run.id, approval);
      await store.releasePausedRunSlot(first.launch.run.id, cursor);
      expect(await store.admitResourceStart(start())).toMatchObject({ status: 'admitted' });
      await expect(
        store.resumeWorkflowRun(first.launch.run.id, undefined, prepare)
      ).rejects.toBeInstanceOf(WorkflowResourceBusyError);
      expect(calls).toBe(0);
    });
  });
}
