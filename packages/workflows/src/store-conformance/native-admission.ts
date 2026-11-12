import { beforeEach, describe, expect, test } from 'bun:test';
import { awaitResourceStartAdmission } from '../resource-start-admission';
import { resourceStartFixtures } from '../resource-start-conformance';
import type { IWorkflowStore } from '../store';
import type { WorkflowStoreHarness } from '../store-conformance';
import { CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID } from './fixtures';

export function describeNativeAdmissionConformance(getHarness: () => WorkflowStoreHarness): void {
  describe('native resource admission', () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(() => {
      harness = getHarness();
      store = harness.store;
    });
    const { start } = resourceStartFixtures(CONFORMANCE_CODEBASE_ID, CONFORMANCE_CONVERSATION_ID);
    test('native pending starts attach once, retain provenance and claim only after admission', async () => {
      const holder = start();
      await store.admitResourceStart(holder);
      const native = start('queue', 'native');
      native.launch.run.metadata = { native_option: 'retained', parent_node_id: 'launch' };
      native.launch.run.origin = { conversationId: CONFORMANCE_CONVERSATION_ID };
      const predecessor = await store.createWorkflowRun(start().launch.run);
      await store.failWorkflowRun(predecessor.id, 'adopted');
      const parent = await store.createWorkflowRun(start().launch.run);
      const pending = await store.createWorkflowRun({
        ...native.launch.run,
        working_path: native.launch.execution.cwd,
        parent_run_id: parent.id,
        adopted_from_run_id: predecessor.id,
      });
      const queued = await store.admitPendingResourceStart(native);
      expect(queued.status).toBe('queued');
      expect(await store.admitPendingResourceStart(native)).toEqual(queued);
      expect(await store.claimPendingWorkflowRun(pending.id)).toBeNull();
      expect(await store.getActiveWorkflowRunByPath(native.launch.execution.cwd)).toBeNull();
      expect(await store.getWorkflowRun(pending.id)).toEqual({ ...pending, working_path: null });
      const other = {
        ...start('queue', 'other', 2, { cwd: native.launch.execution.cwd }),
        resource: 'other',
      };
      expect((await store.admitResourceStart(other)).status).toBe('admitted');
      await store.cancelWorkflowRun(other.launch.run.id);
      await store.cancelWorkflowRun(holder.launch.run.id);
      store = await harness.reopenStore();
      expect(
        await store.drainResourceStarts({ resource: native.resource, hostId: 'binding' })
      ).toEqual([]);
      const drains = await Promise.all([
        store.drainResourceStarts({ resource: native.resource, hostId: 'native' }),
        store.drainResourceStarts({ resource: native.resource, hostId: 'native' }),
      ]);
      expect(drains.flat()).toMatchObject([{ status: 'admitted', runId: pending.id }]);
      expect(await store.getWorkflowRun(pending.id)).toEqual({ ...pending, working_path: null });
      const claims = await Promise.all([
        store.claimPendingWorkflowRun(pending.id, native.launch.execution.cwd),
        store.claimPendingWorkflowRun(pending.id, native.launch.execution.cwd),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await store.getWorkflowRun(pending.id))?.parent_run_id).toBe(parent.id);
    });
    test('native pending admission does not block itself on its precreated checkout', async () => {
      const native = start();
      await store.createWorkflowRun({
        ...native.launch.run,
        working_path: native.launch.execution.cwd,
      });
      expect((await store.admitPendingResourceStart(native)).status).toBe('admitted');
      expect(await store.claimPendingWorkflowRun(native.launch.run.id)).not.toBeNull();
    });
    test('native attachment rolls back the pending path when current policy is invalid', async () => {
      const native = start();
      const pending = await store.createWorkflowRun({
        ...native.launch.run,
        working_path: native.launch.execution.cwd,
      });
      harness.resourceCaps.set(native.resource, 0);
      await expect(store.admitPendingResourceStart(native)).rejects.toThrow();
      expect(await store.getResourceStartRequest(pending.id)).toBeNull();
      expect(await store.getWorkflowRun(pending.id)).toEqual(pending);
    });
    test('native skipped and withdrawn pending starts remain unclaimable without holding a checkout', async () => {
      await store.admitResourceStart(start());
      for (const overlap of ['skip', 'queue'] as const) {
        const native = start(overlap);
        await store.createWorkflowRun({
          ...native.launch.run,
          working_path: native.launch.execution.cwd,
        });
        expect((await store.admitPendingResourceStart(native)).status).toBe(
          overlap === 'skip' ? 'skipped' : 'queued'
        );
        if (overlap === 'queue')
          expect(await store.withdrawQueuedResourceStart(native.launch.run.id)).not.toBeNull();
        expect(await store.claimPendingWorkflowRun(native.launch.run.id)).toBeNull();
        expect(await store.getActiveWorkflowRunByPath(native.launch.execution.cwd)).toBeNull();
        expect((await store.getWorkflowRun(native.launch.run.id))?.status).toBe('pending');
        expect(
          (
            await store.admitResourceStart({
              ...start('queue', 'other', 2, { cwd: native.launch.execution.cwd }),
              resource: 'other',
            })
          ).status
        ).toBe('admitted');
      }
    });
    test('native attachment rejects absent, executing and mismatched pending rows without writes', async () => {
      const absent = start();
      await expect(store.admitPendingResourceStart(absent)).rejects.toThrow('pending');
      for (const field of [
        'workflow_name',
        'codebase_id',
        'user_message',
        'origin',
        'metadata',
        'status',
      ] as const) {
        const native = start();
        const row = await store.createWorkflowRun(native.launch.run);
        if (field === 'status') await store.claimPendingWorkflowRun(row.id);
        else if (field === 'origin') native.launch.run.origin = { userId: 'another' };
        else if (field === 'metadata') native.launch.run.metadata = { native_option: 'changed' };
        else native.launch.run[field] = 'another';
        const before = await store.getWorkflowRun(row.id);
        await expect(store.admitPendingResourceStart(native)).rejects.toThrow();
        expect(await store.getResourceStartRequest(row.id)).toBeNull();
        expect(await store.getWorkflowRun(row.id)).toEqual(before);
      }
    });
    test('native replay rejects a changed request without changing its queue position', async () => {
      await store.admitResourceStart(start());
      const native = start();
      await store.createWorkflowRun(native.launch.run);
      await store.admitPendingResourceStart(native);
      const before = await store.getResourceStartRequest(native.launch.run.id);
      for (const changed of [
        { ...native, resource: 'other' },
        { ...native, capacity: 3 },
        { ...native, hostId: 'other' },
        { ...native, overlap: 'skip' as const },
        {
          ...native,
          launch: { ...native.launch, execution: { ...native.launch.execution, cwd: '/other' } },
        },
      ]) {
        await expect(store.admitPendingResourceStart(changed)).rejects.toThrow('retained request');
        expect(await store.getResourceStartRequest(native.launch.run.id)).toEqual(before);
      }
    });
    test('native admission helper waits visibly and drains its own request after release', async () => {
      const holder = start();
      await store.admitResourceStart(holder);
      const native = start();
      await store.createWorkflowRun(native.launch.run);
      const notifications: string[] = [];
      let wakes = 0;
      expect(
        await awaitResourceStartAdmission(store, { name: 'resource', capacity: 1 }, native.launch, {
          onWaiting: async (resource, id) => {
            notifications.push(`${resource}:${id}`);
          },
          wait: async () => {
            expect(await store.claimPendingWorkflowRun(native.launch.run.id)).toBeNull();
            expect((await store.getResourceStartRequest(native.launch.run.id))?.hostId).toBe(
              `native:${native.launch.run.id}`
            );
            wakes++;
            await store.cancelWorkflowRun(holder.launch.run.id);
          },
        })
      ).toEqual({
        status: 'admitted',
        requestId: native.launch.run.id,
        runId: native.launch.run.id,
      });
      expect(notifications).toEqual([`resource:${native.launch.run.id}`]);
      expect(wakes).toBe(1);
      expect((await store.getWorkflowRun(native.launch.run.id))?.status).toBe('pending');
    });
    test('native admission helper refuses without waiting and withdraws only queued work on abort', async () => {
      await store.admitResourceStart(start());
      const refused = start();
      await store.createWorkflowRun(refused.launch.run);
      const resource = { name: 'resource', capacity: 1 };
      expect(
        (await awaitResourceStartAdmission(store, resource, refused.launch, { noWait: true }))
          .status
      ).toBe('skipped');
      const native = start();
      await store.createWorkflowRun(native.launch.run);
      const controller = new AbortController();
      await expect(
        awaitResourceStartAdmission(store, resource, native.launch, {
          signal: controller.signal,
          wait: async () => {
            controller.abort(new Error('stop waiting'));
          },
        })
      ).rejects.toThrow('stop waiting');
      expect((await store.getResourceStartRequest(native.launch.run.id))?.status).toBe('withdrawn');
      expect((await store.getWorkflowRun(native.launch.run.id))?.status).toBe('pending');
    });
    test('native abort losing to admission leaves the admitted run owned and executable', async () => {
      const holder = start();
      await store.admitResourceStart(holder);
      const native = start();
      await store.createWorkflowRun(native.launch.run);
      const controller = new AbortController();
      expect(
        (
          await awaitResourceStartAdmission(
            store,
            { name: 'resource', capacity: 1 },
            native.launch,
            {
              signal: controller.signal,
              wait: async () => {
                await store.cancelWorkflowRun(holder.launch.run.id);
                await store.drainResourceStarts({
                  resource: 'resource',
                  hostId: `native:${native.launch.run.id}`,
                });
                controller.abort(new Error('stop waiting'));
              },
            }
          )
        ).status
      ).toBe('admitted');
      expect((await store.getResourceStartRequest(native.launch.run.id))?.status).toBe('admitted');
      expect(await store.claimPendingWorkflowRun(native.launch.run.id)).not.toBeNull();
    });
  });
}
