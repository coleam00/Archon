import { resourceStartFixtures } from '../resource-start-conformance';
import { ResourceSlotCapacityConflictError } from '../resource-start-store';
import type { ResourceStartIntent } from '../schemas/resource-start';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  WorkflowNotResumableError,
  WorkflowResourceBusyError,
  deadlineWaitCursor,
  type PauseCursor,
  type IWorkflowStore,
} from '../store';
import {
  readCapacityWait,
  type WorkflowWaitContext,
  type WorkflowRun,
} from '../schemas/workflow-run';
import type { WorkflowStoreHarness } from '../store-conformance';
import {
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
  approval,
  wait,
  schedule,
  running,
  rejection,
} from './fixtures';

export function describeAdmissionConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('admission and capacity', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });

    const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
    test('admission races keep capacity and persist only admitted runs', async () => {
      const intents = Array.from({ length: 8 }, () => start());
      const decisions = await Promise.all(
        intents.map(intent => harness.store.admitResourceStart(intent))
      );
      expect(decisions.filter(row => row.status === 'admitted')).toHaveLength(1);
      expect(decisions.filter(row => row.status === 'queued')).toHaveLength(7);
      for (const [index, intent] of intents.entries()) {
        expect((await harness.store.getWorkflowRun(intent.launch.run.id))?.status ?? null).toBe(
          decisions[index]?.status === 'admitted' ? 'pending' : null
        );
        expect(await harness.store.admitResourceStart(intent)).toEqual(decisions[index]);
      }
      expect(
        await rejection(harness.store.admitResourceStart(start('queue', 'host', 2)))
      ).toBeInstanceOf(ResourceSlotCapacityConflictError);
    });
    for (const activity of ['null', 'stale'] as const) {
      test(`admitted running runs cannot resume with ${activity} activity`, async () => {
        const intent = start();
        const id = intent.launch.run.id;
        await store.admitResourceStart(intent);
        await store.updateWorkflowRun(id, { status: 'running' });
        await harness.backdate(id, {
          last_activity_at: activity === 'null' ? null : new Date('2020-01-01T00:00:00Z'),
        });
        const before = await store.getWorkflowRun(id);
        expect(before?.last_activity_at).toEqual(
          activity === 'null' ? null : new Date('2020-01-01T00:00:00Z')
        );
        const events = await store.listWorkflowEvents(id);
        expect(await rejection(store.resumeWorkflowRun(id))).toBeInstanceOf(
          WorkflowNotResumableError
        );
        expect(await store.getWorkflowRun(id)).toEqual(before);
        expect(await store.listWorkflowEvents(id)).toEqual(events);
      });
    }
    test('a failed admitted run cannot resume past a new holder or a queued promise', async () => {
      const first = start(),
        holder = start(),
        queued = start();
      const id = first.launch.run.id;
      await store.admitResourceStart(first);
      await store.updateWorkflowRun(id, { status: 'running' });
      await store.failWorkflowRun(id, 'failed');
      // The failed run released its slot; a queued promise is ahead of its resume.
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
      expect(await rejection(store.resumeWorkflowRun(id))).toMatchObject({
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      await store.updateWorkflowRun(holder.launch.run.id, { status: 'running' });
      await store.failWorkflowRun(holder.launch.run.id, 'failed');
      expect(await rejection(store.resumeWorkflowRun(id))).toMatchObject({
        blocker: { kind: 'request', id: queued.launch.run.id },
      });
      expect((await store.getWorkflowRun(id))?.status).toBe('failed');
    });
    const gateCursor: PauseCursor = { kind: 'pause', nodeId: 'review', pauseId: 'first' };
    const admitPaused = async (intent: ResourceStartIntent): Promise<string> => {
      expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
      const id = intent.launch.run.id;
      await store.claimPendingWorkflowRun(id);
      await store.pauseWorkflowRun(id, approval);
      return id;
    };
    const end = async (id: string): Promise<void> => {
      await store.claimPendingWorkflowRun(id);
      await store.completeWorkflowRun(id, { duration_ms: 1 });
    };
    const drain = (): ReturnType<IWorkflowStore['drainResourceStarts']> =>
      store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
    const answeredCursor = {
      kind: 'answered' as const,
      nodeId: approval.nodeId,
      pauseId: 'first',
    };
    /** Answers the gate and makes the continuation host's claim of the answered pause. */
    const claimAnswered = async (id: string): Promise<WorkflowRun> => {
      await store.resolveApprovalGate(id, { approval: { ...approval, resolved: 'approved' } }, []);
      return store.resumeWorkflowRun(id, answeredCursor);
    };
    test('a released paused run waits for capacity ahead of queued new starts', async () => {
      const a = await admitPaused(start());
      const b = start(),
        c = start();
      expect(await store.admitResourceStart(b)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: a },
      });
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: true });
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: false });
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: b.launch.run.id, runId: b.launch.run.id },
      ]);
      const refusal = await rejection(claimAnswered(a));
      expect(refusal).toBeInstanceOf(WorkflowResourceBusyError);
      expect(refusal).toMatchObject({
        blocker: { kind: 'run', id: b.launch.run.id },
        refusal: 'waiting',
      });
      const waiting = await store.getWorkflowRun(a);
      expect(waiting?.status).toBe('paused');
      const since = readCapacityWait(waiting?.metadata);
      expect(since).toBeDefined();
      await rejection(store.resumeWorkflowRun(a, answeredCursor));
      expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata)).toEqual(since);
      // A release that removes nothing leaves the waiter's place intact.
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: false });
      expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata)).toEqual(since);
      // The waiter counts against capacity, so the new start queues behind the holder.
      expect(await store.admitResourceStart(c)).toMatchObject({ status: 'queued' });
      await end(b.launch.run.id);
      expect(await drain()).toEqual([]);
      expect((await store.resumeWorkflowRun(a, answeredCursor)).status).toBe('running');
      expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata)).toBeUndefined();
      expect(await drain()).toEqual([]);
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: false });
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: c.launch.run.id },
      ]);
    });
    test('an early resume of a released pause does not hold capacity', async () => {
      const a = await admitPaused(start());
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: true });
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(store.resumeWorkflowRun(a))).toMatchObject({
        blocker: { kind: 'run', id: holder.launch.run.id },
        refusal: 'paused',
      });
      const refused = await store.getWorkflowRun(a);
      expect(refused?.status).toBe('paused');
      expect(readCapacityWait(refused?.metadata)).toBeUndefined();
      await end(holder.launch.run.id);
      expect(await store.admitResourceStart(start())).toMatchObject({ status: 'admitted' });
      expect(await drain()).toEqual([]);
    });
    test('a refused resume of a ready pause keeps its place without a cursor', async () => {
      const notDue = { ...wait, resumeAt: '2999-01-01T00:00:00.000Z' };
      const event: Extract<WorkflowWaitContext, { kind: 'event' }> = {
        ...notDue,
        kind: 'event',
        event: 'ready',
      };
      const pauseAt = async (
        pause: 'answered' | 'due' | 'signaled' | 'not-due'
      ): Promise<string> => {
        const intent = start();
        expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
        const id = intent.launch.run.id;
        await store.claimPendingWorkflowRun(id);
        if (pause === 'answered') {
          await store.pauseWorkflowRun(id, approval);
          await store.releasePausedRunSlot(id, gateCursor);
          await store.resolveApprovalGate(
            id,
            { approval: { ...approval, resolved: 'approved' } },
            []
          );
          return id;
        }
        const pending = pause === 'due' ? wait : pause === 'signaled' ? event : notDue;
        await store.pauseWorkflowRunForWait(id, pending, { kind: 'started', stepName: 'wait' });
        await store.releasePausedRunSlot(id, {
          kind: 'wait',
          nodeId: pending.nodeId,
          resumeAt: pending.resumeAt,
        });
        // A signal leaves the deadline in the future; the run is ready all the same.
        if (pause === 'signaled')
          expect(await store.signalWorkflowWait(id, event, {})).toEqual({ signaled: true });
        return id;
      };
      for (const pause of ['answered', 'due', 'signaled', 'not-due'] as const) {
        const a = await pauseAt(pause);
        const holder = start();
        expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
        const ready = pause !== 'not-due';
        // Answer surfaces (API, CLI, chat) resume without the host's cursor.
        expect(await rejection(store.resumeWorkflowRun(a))).toMatchObject({
          refusal: ready ? 'waiting' : 'paused',
        });
        expect(readCapacityWait((await store.getWorkflowRun(a))?.metadata) !== undefined).toBe(
          ready
        );
        const later = start();
        expect(await store.admitResourceStart(later)).toMatchObject({ status: 'queued' });
        await end(holder.launch.run.id);
        expect(await drain()).toHaveLength(ready ? 0 : 1);
        if (ready) {
          expect((await store.resumeWorkflowRun(a)).status).toBe('running');
          await store.completeWorkflowRun(a, { duration_ms: 1 });
          expect(await drain()).toHaveLength(1);
        } else await store.cancelWorkflowRun(a);
        await end(later.launch.run.id);
      }
    });
    test('a cancelled capacity waiter stops counting against capacity', async () => {
      const a = await admitPaused(start());
      expect(await store.releasePausedRunSlot(a, gateCursor)).toEqual({ released: true });
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(claimAnswered(a))).toMatchObject({ refusal: 'waiting' });
      await end(holder.launch.run.id);
      expect(await store.cancelWorkflowRun(a)).toEqual({ cancelled: true });
      expect(await store.admitResourceStart(start())).toMatchObject({ status: 'admitted' });
      expect(await drain()).toEqual([]);
    });
    test('a start on a checkout a paused run holds keeps its place while the slot goes on', async () => {
      const shared = { cwd: '/conformance/shared' };
      const paused = await admitPaused(start('queue', 'host', 1, shared));
      const first = start('queue', 'host', 1, shared),
        other = start(),
        later = start('queue', 'host', 1, shared);
      for (const intent of [first, other, later])
        expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'queued' });
      expect(await store.releasePausedRunSlot(paused, gateCursor)).toEqual({ released: true });
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: other.launch.run.id, runId: other.launch.run.id },
      ]);
      expect(await store.getWorkflowRun(first.launch.run.id)).toBeNull();
      await end(other.launch.run.id);
      // A new start that would fail the path lock is skipped behind the paused run.
      expect(await store.admitResourceStart(start('skip', 'host', 1, shared))).toMatchObject({
        status: 'skipped',
        blocker: { kind: 'run', id: paused },
      });
      // The free slot still passes over the held checkout.
      expect(await drain()).toEqual([]);
      expect(await store.cancelWorkflowRun(paused)).toEqual({ cancelled: true });
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: first.launch.run.id, runId: first.launch.run.id },
      ]);
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: later.launch.run.id },
      ]);
    });
    test('a start waits for its checkout until the run holding it ends, at any capacity', async () => {
      const shared = { cwd: '/conformance/shared' };
      const paused = await admitPaused(start('queue', 'host', 2, shared));
      expect(await store.releasePausedRunSlot(paused, gateCursor)).toEqual({ released: true });
      const first = start('queue', 'host', 2, shared);
      expect(await store.admitResourceStart(first)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: paused },
      });
      expect((await claimAnswered(paused)).status).toBe('running');
      const second = start('queue', 'host', 2, shared);
      expect(await store.admitResourceStart(second)).toMatchObject({ status: 'queued' });
      // A slot is free, but the continued run still holds the checkout.
      expect(await drain()).toEqual([]);
      await end(paused);
      // One drain admits one start per checkout.
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: first.launch.run.id, runId: first.launch.run.id },
      ]);
      await end(first.launch.run.id);
      expect(await drain()).toEqual([
        { status: 'admitted', requestId: second.launch.run.id, runId: second.launch.run.id },
      ]);
    });
    test('an explicit worktree branch is one checkout; a lane without one never shares', async () => {
      const lane = { isolation: { kind: 'worktree' as const, branch: 'lane' } };
      const paused = await admitPaused(start('queue', 'host', 1, lane));
      expect(await store.releasePausedRunSlot(paused, gateCursor)).toEqual({ released: true });
      expect(await store.admitResourceStart(start('queue', 'host', 1, lane))).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: paused },
      });
      expect(
        await store.admitResourceStart(
          start('queue', 'host', 1, { isolation: { kind: 'worktree' } })
        )
      ).toMatchObject({ status: 'admitted' });
    });
    test('capacity waiters keep their refusal order and block a failed run resume', async () => {
      const first = await admitPaused(start());
      await store.releasePausedRunSlot(first, gateCursor);
      const second = await admitPaused(start());
      await store.releasePausedRunSlot(second, gateCursor);
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      const holderId = holder.launch.run.id;
      for (const id of [first, second]) {
        expect(await rejection(claimAnswered(id))).toMatchObject({
          blocker: { kind: 'run', id: holderId },
        });
        await Bun.sleep(2);
      }
      await store.claimPendingWorkflowRun(holderId);
      await store.failWorkflowRun(holderId, 'failed');
      expect(await rejection(store.resumeWorkflowRun(second, answeredCursor))).toMatchObject({
        blocker: { kind: 'run', id: first },
      });
      expect(await rejection(store.resumeWorkflowRun(holderId))).toMatchObject({
        blocker: { kind: 'run', id: first },
        refusal: 'failed',
      });
      expect((await store.resumeWorkflowRun(first, answeredCursor)).status).toBe('running');
      expect(await rejection(store.resumeWorkflowRun(second, answeredCursor))).toMatchObject({
        blocker: { kind: 'run', id: first },
      });
    });
    test('a failed run resumes beside a capacity waiter while a slot is free', async () => {
      const failed = start('queue', 'host', 3);
      const failedId = failed.launch.run.id;
      await store.admitResourceStart(failed);
      await store.updateWorkflowRun(failedId, { status: 'running' });
      await store.failWorkflowRun(failedId, 'failed');
      const waiter = await admitPaused(start('queue', 'host', 3));
      await store.releasePausedRunSlot(waiter, gateCursor);
      const holders = Array.from({ length: 3 }, () => start('queue', 'host', 3));
      for (const holder of holders)
        expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(claimAnswered(waiter))).toMatchObject({ refusal: 'waiting' });
      for (const holder of holders) await end(holder.launch.run.id);
      // No holders and one waiter leave two of three slots free.
      expect((await store.resumeWorkflowRun(failedId)).status).toBe('running');
      expect(await store.admitResourceStart(start('queue', 'host', 3))).toMatchObject({
        status: 'admitted',
      });
    });
    test('a failed run does not resume into the slot a capacity waiter fills', async () => {
      const failed = start();
      const failedId = failed.launch.run.id;
      await store.admitResourceStart(failed);
      await store.updateWorkflowRun(failedId, { status: 'running' });
      await store.failWorkflowRun(failedId, 'failed');
      const waiter = await admitPaused(start());
      await store.releasePausedRunSlot(waiter, gateCursor);
      const holder = start();
      expect(await store.admitResourceStart(holder)).toMatchObject({ status: 'admitted' });
      expect(await rejection(claimAnswered(waiter))).toMatchObject({ refusal: 'waiting' });
      await end(holder.launch.run.id);
      // No holders and one waiter fill the only slot.
      expect(await rejection(store.resumeWorkflowRun(failedId))).toMatchObject({
        blocker: { kind: 'run', id: waiter },
        refusal: 'failed',
      });
      expect((await claimAnswered(waiter)).status).toBe('running');
    });
    for (const kind of ['time', 'event'] as const) {
      for (const owner of ['node', 'loop_group'] as const) {
        for (const legacy of [false, true]) {
          test(`a delayed deadline release cannot remove a later occurrence with the same deadline (${kind}, ${owner}, legacy=${legacy})`, async () => {
            const intent = start();
            expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
            const id = intent.launch.run.id;
            await store.claimPendingWorkflowRun(id);
            const owned =
              owner === 'loop_group'
                ? {
                    ...wait,
                    owner,
                    bodyWaitId: 'body-wait',
                    iteration: 1,
                    sessionId: null,
                    sessionProvider: null,
                  }
                : wait;
            const context = kind === 'event' ? { ...owned, kind, event: 'ready' } : owned;
            const first = { ...context, ...(legacy ? {} : { pauseId: 'first-wait' }) };
            const second = { ...context, pauseId: 'second-wait' };
            const cursor = {
              kind: 'wait' as const,
              nodeId: first.nodeId,
              resumeAt: first.resumeAt,
              pauseId: first.pauseId,
            };
            await store.pauseWorkflowRunForWait(id, first, { kind: 'started', stepName: 'wait' });
            expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: true });
            await store.resumeWorkflowRun(id, cursor);
            await store.clearWorkflowWaitContext(id, first, {
              stepName: 'wait',
              result: { status: 'satisfied', waited_ms: 0 },
            });
            await store.pauseWorkflowRunForWait(id, second, { kind: 'started', stepName: 'wait' });
            expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
            expect(await rejection(store.resumeWorkflowRun(id, cursor))).toBeInstanceOf(
              WorkflowNotResumableError
            );
            const legacyCursor = {
              kind: 'wait' as const,
              nodeId: wait.nodeId,
              resumeAt: wait.resumeAt,
            };
            expect(await store.releasePausedRunSlot(id, legacyCursor)).toEqual({ released: false });
            expect(await rejection(store.resumeWorkflowRun(id, legacyCursor))).toBeInstanceOf(
              WorkflowNotResumableError
            );
            await store.deferWorkflowContinuation(id, schedule.deadlineAt, cursor);
            expect(
              (await store.getWorkflowRun(id))?.metadata.continuation_retry_at
            ).toBeUndefined();
            expect(await store.admitResourceStart(start())).toMatchObject({
              status: 'queued',
              blocker: { kind: 'run', id },
            });
            const secondCursor = { ...cursor, pauseId: second.pauseId };
            await store.deferWorkflowContinuation(id, schedule.deadlineAt, secondCursor);
            expect((await store.getWorkflowRun(id))?.metadata.continuation_retry_at).toBe(
              schedule.deadlineAt
            );
            await store.resumeWorkflowRun(id, secondCursor);
            const completion = {
              stepName: 'wait',
              result: { status: 'satisfied' as const, waited_ms: 0 },
            };
            expect(await store.clearWorkflowWaitContext(id, first, completion)).toEqual({
              cleared: false,
            });
            expect(await store.clearWorkflowWaitContext(id, wait, completion)).toEqual({
              cleared: false,
            });
            expect(await store.clearWorkflowWaitContext(id, second, completion)).toMatchObject({
              cleared: true,
            });
            await store.pauseWorkflowRunForWait(id, second, { kind: 'continued' });
            expect(await store.releasePausedRunSlot(id, secondCursor)).toEqual({ released: true });
          });
        }
      }
    }
    test('a delayed release cannot remove a later usage-limit wait with the same reset', async () => {
      const intent = start();
      expect(await store.admitResourceStart(intent)).toMatchObject({ status: 'admitted' });
      const id = intent.launch.run.id;
      await store.claimPendingWorkflowRun(id);
      const limit: Extract<WorkflowWaitContext, { kind: 'quota' }> = {
        owner: 'node',
        nodeId: 'implement',
        kind: 'quota',
        pauseId: 'first-limit',
        waitingSince: wait.waitingSince,
        resumeAt: wait.resumeAt,
      };
      const cursor = deadlineWaitCursor(limit);
      await store.pauseWorkflowRunForWait(id, limit, { kind: 'started', stepName: limit.nodeId });
      expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: true });
      await store.resumeWorkflowRun(id, cursor);
      const again = { ...limit, pauseId: 'second-limit' };
      await store.pauseWorkflowRunForWait(id, again, { kind: 'started', stepName: again.nodeId });
      expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
      expect(await rejection(store.resumeWorkflowRun(id, cursor))).toBeInstanceOf(
        WorkflowNotResumableError
      );
      expect(await store.releasePausedRunSlot(id, deadlineWaitCursor(again))).toEqual({
        released: true,
      });
    });
    test('release refuses another pause and a run that holds no slot', async () => {
      const id = await admitPaused(start());
      for (const cursor of [
        { ...gateCursor, pauseId: 'other' },
        { ...gateCursor, nodeId: 'other' },
        { kind: 'wait' as const, nodeId: 'review', resumeAt: wait.resumeAt },
      ])
        expect(await store.releasePausedRunSlot(id, cursor)).toEqual({ released: false });
      expect(await store.admitResourceStart(start())).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id },
      });
      const plain = await running(store);
      await store.pauseWorkflowRun(plain.id, approval);
      expect(await store.releasePausedRunSlot(plain.id, gateCursor)).toEqual({ released: false });
      expect((await store.getWorkflowRun(plain.id))?.status).toBe('paused');
    });
    test('a paused run that kept its slot resumes ahead of queued new starts', async () => {
      const id = await admitPaused(start());
      const queued = start();
      expect(await store.admitResourceStart(queued)).toMatchObject({ status: 'queued' });
      expect((await store.resumeWorkflowRun(id)).status).toBe('running');
      expect(await drain()).toEqual([]);
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: queued.launch.run.id },
      ]);
    });
    test('capacity admits multiple holders and drain fills every released slot in FIFO order', async () => {
      const intents = Array.from({ length: 5 }, () => start('queue', 'host', 2));
      const decisions = [];
      for (const intent of intents) decisions.push(await store.admitResourceStart(intent));
      expect(decisions.map(row => row.status)).toEqual([
        'admitted',
        'admitted',
        'queued',
        'queued',
        'queued',
      ]);
      for (const input of intents.slice(0, 2)) await store.cancelWorkflowRun(input.launch.run.id);
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual(
        intents.slice(2, 4).map(input => ({
          status: 'admitted',
          requestId: input.launch.run.id,
          runId: input.launch.run.id,
        }))
      );
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
      expect(await store.listQueuedResourceStartsForHost('host')).toMatchObject([
        { id: intents[4].launch.run.id },
      ]);
    });
    test('admission keeps FIFO across hosts, skips overlap and withdraws queued work', async () => {
      const store = harness.store;
      const owner = start(),
        queued = start('queue', 'other'),
        later = start(),
        skipped = start('skip');
      await store.admitResourceStart(owner);
      expect(await store.admitResourceStart(queued)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: owner.launch.run.id },
      });
      expect(await store.admitResourceStart(later)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'request', id: queued.launch.run.id },
      });
      expect(await store.admitResourceStart(skipped)).toMatchObject({
        status: 'skipped',
        blocker: { kind: 'request', id: queued.launch.run.id },
      });
      expect(await store.getWorkflowRun(skipped.launch.run.id)).toBeNull();
      await store.claimPendingWorkflowRun(owner.launch.run.id);
      await store.completeWorkflowRun(owner.launch.run.id, { duration_ms: 1 });
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([]);
      expect(await store.withdrawQueuedResourceStart(queued.launch.run.id)).toEqual(queued.launch);
      expect(await store.withdrawQueuedResourceStart(queued.launch.run.id)).toBeNull();
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'host' })).toEqual([
        { status: 'admitted', requestId: later.launch.run.id, runId: later.launch.run.id },
      ]);
      expect(await store.listQueuedResourceStartsForHost('host')).toEqual([]);
    });
  });
}
