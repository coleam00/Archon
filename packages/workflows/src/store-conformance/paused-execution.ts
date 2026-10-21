import { describe, expect, test } from 'bun:test';
import { executionClaim, WorkflowRunExecutionClaimLostError, type IWorkflowStore } from '../store';

const approval = { nodeId: 'review', type: 'approval' as const, message: 'Review' };

export function describePausedExecutionConformance(getStore: () => IWorkflowStore): void {
  describe('paused execution exclusion', () => {
    async function running() {
      const store = getStore();
      const run = await store.createWorkflowRun({
        workflow_name: 'paused-owner',
        user_message: '',
      });
      const claimed = await store.claimPendingWorkflowRun(run.id);
      if (!claimed) throw new Error('run was not claimed');
      return claimed;
    }
    test.each([false, true])(
      'accounting compares the segment claim atomically (resumed=%s)',
      async resumed => {
        const store = getStore();
        let run = await running();
        if (resumed) {
          await store.pauseWorkflowRun(run.id, approval);
          run = await store.resumeWorkflowRun(run.id);
        }
        const claim = executionClaim(run.metadata);
        await expect(
          store.updateWorkflowRun(crypto.randomUUID(), { outcome: 'succeeded' }, claim)
        ).rejects.toBeInstanceOf(WorkflowRunExecutionClaimLostError);
        await store.updateWorkflowRun(
          run.id,
          { outcome: 'succeeded', metadata: { total_cost_usd: 0.25 } },
          claim
        );
        await store.pauseWorkflowRun(run.id, approval);
        await store.updateWorkflowRun(run.id, { metadata: { total_tokens_in: 100 } }, claim);
        const next = await store.resumeWorkflowRun(run.id);
        await store.updateWorkflowRun(
          run.id,
          { outcome: 'failed', metadata: { total_cost_usd: 9 } },
          executionClaim(next.metadata)
        );
        const before = await store.getWorkflowRun(run.id);
        for (const patch of [
          { outcome: 'succeeded' as const },
          { metadata: { total_cost_usd: 0.25 } },
          { status: 'paused' as const },
          { output_root: '/stale' },
          { working_path: '/stale' },
        ]) {
          await expect(store.updateWorkflowRun(run.id, patch, claim)).rejects.toBeInstanceOf(
            WorkflowRunExecutionClaimLostError
          );
          expect(await store.getWorkflowRun(run.id)).toEqual(before);
        }
      }
    );
    test.each([false, true])('holds resume until cleanup settles (resumed=%s)', async resumed => {
      const store = getStore();
      let run = await running();
      if (resumed) {
        await store.pauseWorkflowRun(run.id, approval);
        run = await store.resumeWorkflowRun(run.id);
      }
      await store.pauseWorkflowRun(run.id, approval);
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      const claim = executionClaim(run.metadata);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const order: string[] = [];
      const cleanup = store.withPausedExecution(run.id, claim, async () => {
        entered.resolve();
        await finish.promise;
        order.push('stopped');
      });
      await entered.promise;
      const resume = store.resumeWorkflowRun(run.id).then(next => {
        order.push('resumed');
        return next;
      });
      finish.resolve();
      expect(await cleanup).toEqual({ executed: true });
      const next = await resume;
      expect(order).toEqual(['stopped', 'resumed']);
      expect(executionClaim(next.metadata)).not.toBe(claim);
      // Resume alone accounts for the subsequent row/event changes.
      expect(next.metadata.approval).toEqual(before?.metadata.approval);
      expect((await store.listWorkflowEvents(run.id)).slice(0, events.length)).toEqual(events);
    });
    test('matching actions and action rejection leave row and events unchanged', async () => {
      const store = getStore();
      const run = await running();
      await store.pauseWorkflowRun(run.id, approval);
      const before = await store.getWorkflowRun(run.id);
      const events = await store.listWorkflowEvents(run.id);
      let calls = 0;
      expect(
        await store.withPausedExecution(run.id, executionClaim(run.metadata), async () => {
          calls++;
        })
      ).toEqual({ executed: true });
      expect(calls).toBe(1);
      await expect(
        store.withPausedExecution(run.id, executionClaim(run.metadata), async () => {
          throw new Error('stop refused');
        })
      ).rejects.toThrow('stop refused');
      expect(await store.getWorkflowRun(run.id)).toEqual(before);
      expect(await store.listWorkflowEvents(run.id)).toEqual(events);
    });
    test('missing, nonpaused and stale claims never enter the action, including a paused successor', async () => {
      const store = getStore();
      let calls = 0;
      const action = async () => {
        calls++;
      };
      const run = await running();
      const oldClaim = executionClaim(run.metadata);
      const refused = async (id: string, claim = oldClaim) => {
        const before = await store.getWorkflowRun(id);
        const events = await store.listWorkflowEvents(id);
        expect(await store.withPausedExecution(id, claim, action)).toEqual({ executed: false });
        expect(await store.getWorkflowRun(id)).toEqual(before);
        expect(await store.listWorkflowEvents(id)).toEqual(events);
      };
      await refused(crypto.randomUUID());
      await refused(run.id);
      await store.pauseWorkflowRun(run.id, approval);
      await refused(run.id, 'wrong-claim');
      const next = await store.resumeWorkflowRun(run.id);
      await refused(run.id);
      await refused(run.id, executionClaim(next.metadata));
      await store.pauseWorkflowRun(run.id, approval);
      await refused(run.id);
      expect(
        await store.withPausedExecution(run.id, executionClaim(next.metadata), action)
      ).toEqual({ executed: true });
      await store.cancelWorkflowRun(run.id);
      await refused(run.id, executionClaim(next.metadata));
      const complete = await running();
      await store.completeWorkflowRun(complete.id, { duration_ms: 1 });
      await refused(complete.id, executionClaim(complete.metadata));
      const failed = await running();
      await store.failWorkflowRun(failed.id, 'failed');
      await refused(failed.id, executionClaim(failed.metadata));
      const pending = await store.createWorkflowRun({ workflow_name: 'pending', user_message: '' });
      await refused(pending.id, executionClaim(pending.metadata));
      expect(calls).toBe(1);
    });
  });
}
