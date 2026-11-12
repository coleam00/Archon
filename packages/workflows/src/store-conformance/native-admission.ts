import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
    test.each(['local', 'foreign'] as const)(
      'native child shares ancestor checkouts in %s resources on admission and drain',
      async kind => {
        const parent = start('queue', 'parent', 3, { cwd: '/shared' });
        if (kind === 'foreign') parent.resource = 'parent-resource';
        await store.createWorkflowRun(parent.launch.run);
        await store.admitPendingResourceStart(parent);
        await store.claimPendingWorkflowRun(parent.launch.run.id, '/shared');
        const middle = await store.createWorkflowRun({
          ...start().launch.run,
          parent_run_id: parent.launch.run.id,
        });
        const child = start('queue', 'child', 3, { cwd: '/shared' });
        await store.createWorkflowRun({ ...child.launch.run, parent_run_id: middle.id });
        expect((await store.admitPendingResourceStart(child)).status).toBe('admitted');
        const sibling = start('queue', 'sibling', 3, { cwd: '/shared' });
        await store.createWorkflowRun({ ...sibling.launch.run, parent_run_id: middle.id });
        expect(await store.admitPendingResourceStart(sibling)).toMatchObject({
          status: 'queued',
          blocker: { kind: 'run', id: child.launch.run.id },
        });
        await store.cancelWorkflowRun(child.launch.run.id);
        expect(
          await store.drainResourceStarts({ resource: 'resource', hostId: 'sibling' })
        ).toMatchObject([{ runId: sibling.launch.run.id }]);
        expect((await store.getWorkflowRun(parent.launch.run.id))?.status).toBe('running');
      }
    );
    test.each(['cancelled', 'failed'] as const)(
      'terminal %s native requests cannot block another host',
      async status => {
        const holder = start();
        await store.admitResourceStart(holder);
        const native = start('queue', 'dead-native');
        await store.createWorkflowRun(native.launch.run);
        await store.admitPendingResourceStart(native);
        const next = start('queue', 'successor');
        await store.admitResourceStart(next);
        if (status === 'cancelled') await store.cancelWorkflowRun(native.launch.run.id);
        else await store.failWorkflowRun(native.launch.run.id, 'explicit failure');
        await store.cancelWorkflowRun(holder.launch.run.id);
        expect(
          await store.drainResourceStarts({ resource: 'resource', hostId: 'successor' })
        ).toMatchObject([{ runId: next.launch.run.id }]);
        expect((await store.getResourceStartRequest(native.launch.run.id))?.status).toBe(
          'withdrawn'
        );
        expect((await store.getWorkflowRun(native.launch.run.id))?.status).toBe(status);
      }
    );
    test('native children still count their parent resource holder', async () => {
      const parent = start('queue', 'parent', 1, { cwd: '/shared' });
      await store.admitResourceStart(parent);
      const child = start('queue', 'child', 1, { cwd: '/shared' });
      await store.createWorkflowRun({ ...child.launch.run, parent_run_id: parent.launch.run.id });
      expect((await store.admitPendingResourceStart(child)).status).toBe('queued');
      expect(await store.drainResourceStarts({ resource: 'resource', hostId: 'child' })).toEqual(
        []
      );
      harness.resourceCaps.set('resource', 2);
      expect(
        await store.drainResourceStarts({ resource: 'resource', hostId: 'child' })
      ).toMatchObject([{ runId: child.launch.run.id }]);
      expect((await store.getWorkflowRun(parent.launch.run.id))?.status).toBe('pending');
    });
    test.each(['notice', 'drain', 'read', 'wait'] as const)(
      'native waiter %s failure withdraws queued work',
      async site => {
        const holder = start();
        await store.admitResourceStart(holder);
        const native = start();
        await store.createWorkflowRun(native.launch.run);
        const fail = async () => {
          throw new Error('waiter failed');
        };
        const fault =
          site === 'drain'
            ? spyOn(store, 'drainResourceStarts').mockImplementationOnce(fail)
            : site === 'read'
              ? spyOn(store, 'getResourceStartRequest').mockImplementationOnce(fail)
              : undefined;
        try {
          await expect(
            awaitResourceStartAdmission(store, { name: 'resource', capacity: 1 }, native.launch, {
              ...(site === 'notice' ? { onWaiting: fail } : { wait: fail }),
            })
          ).rejects.toThrow('waiter failed');
        } finally {
          fault?.mockRestore();
        }
        expect((await store.getResourceStartRequest(native.launch.run.id))?.status).toBe(
          'withdrawn'
        );
        await store.cancelWorkflowRun(holder.launch.run.id);
        expect((await store.admitResourceStart(start('queue', 'successor'))).status).toBe(
          'admitted'
        );
      }
    );
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
    test.each(['abort', 'error'] as const)(
      'native %s losing to admission leaves the admitted run owned and executable',
      async failure => {
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
                  if (failure === 'abort') controller.abort(new Error('stop waiting'));
                  else throw new Error('poll failed after admission');
                },
              }
            )
          ).status
        ).toBe('admitted');
        expect((await store.getResourceStartRequest(native.launch.run.id))?.status).toBe(
          'admitted'
        );
        expect(await store.claimPendingWorkflowRun(native.launch.run.id)).not.toBeNull();
      }
    );
  });
}
