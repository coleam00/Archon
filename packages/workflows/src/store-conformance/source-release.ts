import { beforeEach, describe, expect, test } from 'bun:test';
import { executionClaim, type IWorkflowStore } from '../store';
import { readSourceRelease } from '../schemas';
import { approval, types } from './fixtures';

/** The claimed row, whose metadata carries the execution claim the release must match. */
async function running(store: IWorkflowStore) {
  const run = await store.createWorkflowRun({ workflow_name: 'source-release', user_message: '' });
  const claimed = await store.claimPendingWorkflowRun(run.id);
  if (!claimed) throw new Error('run was not claimed');
  return claimed;
}

export function describeSourceReleaseConformance(getStore: () => IWorkflowStore): void {
  describe('source release', () => {
    let store: IWorkflowStore;
    beforeEach(() => {
      store = getStore();
    });
    test('a source release never overrides another transition', async () => {
      const release = {
        claimId: null,
        nodeId: 'check',
        error: 'EACCES',
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const cancelled = await running(store);
      await store.cancelWorkflowRun(cancelled.id);
      expect(await store.releaseRunForUnreadableSource(cancelled.id, release)).toEqual({
        released: false,
      });
      expect((await store.getWorkflowRun(cancelled.id))?.status).toBe('cancelled');
      const gated = await running(store);
      await store.pauseWorkflowRun(gated.id, approval);
      expect(await store.releaseRunForUnreadableSource(gated.id, release)).toEqual({
        released: false,
      });
      const row = await store.getWorkflowRun(gated.id);
      expect(row?.status).toBe('paused');
      expect(readSourceRelease(row?.metadata)).toBeUndefined();
      expect(await types(store, gated.id)).not.toContain('source_released');
    });
    for (const resumed of [false, true]) {
      test(`source release holds resume until its action finishes (${resumed ? 'resumed claim' : 'initial claim'})`, async () => {
        let run = await running(store);
        if (resumed) {
          await store.pauseWorkflowRun(run.id, approval);
          run = await store.resumeWorkflowRun(run.id);
        }
        const claimId = executionClaim(run.metadata);
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const order: string[] = [];
        const releasing = store.releaseRunForUnreadableSource(
          run.id,
          {
            claimId,
            nodeId: 'check',
            error: 'EACCES',
            retryAt: new Date().toISOString(),
          },
          async () => {
            entered.resolve();
            await finish.promise;
            order.push('stopped');
          }
        );
        await entered.promise;
        const resuming = store.resumeWorkflowRun(run.id).then(next => {
          order.push('resumed');
          return next;
        });
        finish.resolve();
        expect(await releasing).toEqual({ released: true });
        const successor = await resuming;
        expect(order).toEqual(['stopped', 'resumed']);
        expect(successor.status).toBe('running');
        expect(executionClaim(successor.metadata)).not.toBe(claimId);
      });
    }
    test('a rejected source release action publishes neither pause nor event', async () => {
      const run = await running(store);
      const before = await store.getWorkflowRun(run.id);
      await expect(
        store.releaseRunForUnreadableSource(
          run.id,
          {
            claimId: executionClaim(run.metadata),
            nodeId: 'check',
            error: 'EACCES',
            retryAt: new Date().toISOString(),
          },
          async () => {
            throw new Error('action refused');
          }
        )
      ).rejects.toThrow('action refused');
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await types(store, run.id)).not.toContain('source_released');
    });
    test('source release status and claim losers never enter the action', async () => {
      const run = await running(store);
      let calls = 0;
      const action = async () => {
        calls++;
      };
      const release = {
        claimId: 'another-owner',
        nodeId: 'check',
        error: 'EACCES',
        retryAt: new Date().toISOString(),
      };
      expect(await store.releaseRunForUnreadableSource(run.id, release, action)).toEqual({
        released: false,
      });
      await store.pauseWorkflowRun(run.id, approval);
      const resumed = await store.resumeWorkflowRun(run.id);
      expect(
        await store.releaseRunForUnreadableSource(run.id, { ...release, claimId: null }, action)
      ).toEqual({ released: false });
      const matching = { ...release, claimId: executionClaim(resumed.metadata) };
      await store.pauseWorkflowRun(run.id, approval);
      expect(await store.releaseRunForUnreadableSource(run.id, matching, action)).toEqual({
        released: false,
      });
      await store.cancelWorkflowRun(run.id);
      expect(await store.releaseRunForUnreadableSource(run.id, matching, action)).toEqual({
        released: false,
      });
      const completed = await running(store);
      await store.completeWorkflowRun(completed.id, { duration_ms: 1 });
      expect(
        await store.releaseRunForUnreadableSource(
          completed.id,
          { ...release, claimId: executionClaim(completed.metadata) },
          action
        )
      ).toEqual({ released: false });
      expect(calls).toBe(0);
    });
  });
}
