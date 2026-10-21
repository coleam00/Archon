import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PreparedWorkflowLaunch, ResourceStartIntent } from './schemas/resource-start';
import type { IWorkflowStore } from './store';
import type { WorkflowStoreHarness } from './store-conformance';

export function resourceStartFixtures(codebaseId: string, conversationId: string) {
  type Lane = PreparedWorkflowLaunch['execution']['isolation'];
  /** Each launch runs in a checkout of its own unless `checkout` names a shared one. */
  const launch = (
    id = crypto.randomUUID(),
    checkout: { cwd?: string; isolation?: Lane } = {}
  ): PreparedWorkflowLaunch => ({
    version: 2,
    run: {
      id,
      workflow_name: 'conformance',
      codebase_id: codebaseId,
      user_message: '',
      metadata: {},
    },
    execution: {
      cwd: checkout.cwd ?? `/conformance/${id}`,
      conversationId: conversationId,
      isolation: checkout.isolation ?? { kind: 'in-place' },
    },
  });
  const start = (
    overlap: 'queue' | 'skip' = 'queue',
    hostId = 'host',
    capacity = 1,
    checkout?: { cwd?: string; isolation?: Lane }
  ): ResourceStartIntent => ({
    resource: 'resource',
    capacity,
    hostId,
    overlap,
    launch: launch(undefined, checkout),
  });
  return { launch, start };
}

export function describeForeignCheckoutAdmission(
  label: string,
  makeHarness: () => Promise<WorkflowStoreHarness>,
  codebaseId: string,
  conversationId: string
): void {
  describe(`foreign checkout admission: ${label}`, () => {
    let harness: WorkflowStoreHarness;
    let store: IWorkflowStore;
    beforeEach(async () => {
      harness = await makeHarness();
      store = harness.store;
    });
    afterEach(async () => {
      await harness?.close();
    });
    const { launch, start } = resourceStartFixtures(codebaseId, conversationId);
    const drain = () => store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
    const end = async (id: string) => {
      await store.completeWorkflowRun(id, { duration_ms: 1 });
    };
    const approval = {
      nodeId: 'review',
      message: 'Choose',
      type: 'approval' as const,
      pauseId: 'first',
    };
    for (const foreign of ['manual', 'other-resource'] as const) {
      test(`guarded starts queue and skip behind a ${foreign} checkout holder until it ends`, async () => {
        const shared = { cwd: '/conformance/foreign' };
        const holder = start('queue', 'host', 3, shared);
        if (foreign === 'manual') await store.createWorkflowRun(holder.launch.run);
        else await store.admitResourceStart({ ...holder, resource: 'foreign' });
        const id = holder.launch.run.id;
        await store.claimPendingWorkflowRun(id, shared.cwd);
        const before = await store.getWorkflowRun(id);
        const queued = start('queue', 'host', 3, shared);
        for (const intent of [queued, start('skip', 'host', 3, shared)]) {
          expect(await store.admitResourceStart(intent)).toMatchObject({
            status: intent.overlap === 'skip' ? 'skipped' : 'queued',
            blocker: { kind: 'run', id },
          });
          expect(await store.getWorkflowRun(intent.launch.run.id)).toBeNull();
        }
        expect(await drain()).toEqual([]);
        expect(await store.getWorkflowRun(id)).toEqual(before);
        await end(id);
        expect(await drain()).toMatchObject([{ status: 'admitted', runId: queued.launch.run.id }]);
      });
    }
    test('malformed guards are rejected before queueing, even behind a local holder', async () => {
      const holder = start('queue', 'host', 3, { cwd: '/shared' });
      await store.admitResourceStart(holder);
      for (const isolation of [
        { kind: 'in-place' as const },
        { kind: 'worktree' as const },
        { kind: 'worktree' as const, branch: 'lane' },
      ]) {
        const incoming = start('queue', 'host', 3, { cwd: '/shared', isolation });
        incoming.launch.run.metadata.admission_checkout_guard = 'false';
        await expect(store.admitResourceStart(incoming)).rejects.toThrow('expected a boolean');
        expect(await store.getResourceStartRequest(incoming.launch.run.id)).toBeNull();
      }
    });
    test('an unclaimed manual run with a known checkout remains an explicit blocker', async () => {
      const shared = { cwd: '/conformance/pending' };
      const manual = await store.createWorkflowRun({
        ...launch(undefined, shared).run,
        working_path: shared.cwd,
      });
      const incoming = start('queue', 'host', 2, shared);
      expect(await store.admitResourceStart(incoming)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: manual.id },
      });
      expect((await store.getResourceStartRequest(incoming.launch.run.id))?.blockerRunStatus).toBe(
        'pending'
      );
      expect(await drain()).toEqual([]);
      expect((await store.getWorkflowRun(manual.id))?.status).toBe('pending');
      await store.cancelWorkflowRun(manual.id);
      expect(await drain()).toMatchObject([{ runId: incoming.launch.run.id }]);
    });
    for (const foreign of ['manual', 'other-resource'] as const) {
      test(`expired pending ${foreign} holders release foreign admission without changing state`, async () => {
        const shared = { cwd: '/conformance/expired' };
        const holder = start('queue', 'host', 3, shared);
        if (foreign === 'manual')
          await store.createWorkflowRun({ ...holder.launch.run, working_path: shared.cwd });
        else {
          await store.admitResourceStart({ ...holder, resource: 'foreign' });
          await store.updateWorkflowRun(holder.launch.run.id, { working_path: shared.cwd });
        }
        const id = holder.launch.run.id;
        const queued = start('queue', 'host', 3, shared);
        expect(await store.admitResourceStart(queued)).toMatchObject({
          status: 'queued',
          blocker: { kind: 'run', id },
        });
        expect(await drain()).toEqual([]);
        await harness.backdate(id, { started_at: new Date(Date.now() - 600_000) });
        const before = await store.getWorkflowRun(id);
        expect(await store.getActiveWorkflowRunByPath(shared.cwd)).toBeNull();
        expect(await drain()).toMatchObject([{ runId: queued.launch.run.id }]);
        await store.cancelWorkflowRun(queued.launch.run.id);
        for (const overlap of ['queue', 'skip'] as const) {
          const incoming = start(overlap, 'host', 3, shared);
          expect(await store.admitResourceStart(incoming)).toMatchObject({ status: 'admitted' });
          await store.cancelWorkflowRun(incoming.launch.run.id);
        }
        expect(await store.getWorkflowRun(id)).toEqual(before);
      });
    }
    test('expired local pending admissions retain same-resource checkout serialization', async () => {
      const shared = { cwd: '/conformance/local-pending' };
      const holder = start('queue', 'host', 2, shared);
      await store.admitResourceStart(holder);
      await harness.backdate(holder.launch.run.id, { started_at: new Date(Date.now() - 600_000) });
      const incoming = start('queue', 'host', 2, shared);
      incoming.launch.run.metadata.admission_checkout_guard = false;
      expect(await store.admitResourceStart(incoming)).toMatchObject({
        status: 'queued',
        blocker: { kind: 'run', id: holder.launch.run.id },
      });
      expect(await drain()).toEqual([]);
    });
    for (const guard of [true, false, undefined, null]) {
      test(`incoming guard ${String(guard)} applies only to foreign checkout occupancy`, async () => {
        const shared = { cwd: '/conformance/foreign' };
        const manual = await store.createWorkflowRun(launch(undefined, shared).run);
        await store.claimPendingWorkflowRun(manual.id, shared.cwd);
        await store.pauseWorkflowRun(manual.id, approval);
        const incoming = start('queue', 'host', 3, shared);
        if (guard !== undefined) incoming.launch.run.metadata.admission_checkout_guard = guard;
        expect(await store.admitResourceStart(incoming)).toMatchObject({
          status: guard === false ? 'admitted' : 'queued',
        });
        if (guard === false) {
          const local = start('queue', 'host', 3, shared);
          local.launch.run.metadata.admission_checkout_guard = false;
          expect(await store.admitResourceStart(local)).toMatchObject({
            status: 'queued',
            blocker: { kind: 'run', id: incoming.launch.run.id },
          });
        }
        await store.cancelWorkflowRun(manual.id);
        if (guard !== false)
          expect(await drain()).toMatchObject([{ runId: incoming.launch.run.id }]);
      });
    }
    test('foreign held requests keep per-checkout order while independent work passes over', async () => {
      const shared = { cwd: '/conformance/foreign' };
      const manual = await store.createWorkflowRun(launch(undefined, shared).run);
      await store.claimPendingWorkflowRun(manual.id, shared.cwd);
      const first = start('queue', 'host', 3, shared),
        second = start('queue', 'host', 3, shared);
      for (const incoming of [first, second]) await store.admitResourceStart(incoming);
      expect(await store.admitResourceStart(start('queue', 'host', 3))).toMatchObject({
        status: 'admitted',
      });
      expect(await drain()).toEqual([]);
      await store.cancelWorkflowRun(manual.id);
      expect(await drain()).toMatchObject([{ runId: first.launch.run.id }]);
      expect(await store.getWorkflowRun(second.launch.run.id)).toBeNull();
    });
    test('a foreign explicit branch holds its launch identity and physical path, not other lanes', async () => {
      const lane = { isolation: { kind: 'worktree' as const, branch: 'lane' } };
      const holder = start('queue', 'host', 4, lane);
      holder.launch.run.metadata.admission_checkout_guard = false;
      await store.admitResourceStart({ ...holder, resource: 'foreign' });
      await store.claimPendingWorkflowRun(holder.launch.run.id, '/conformance/worktree');
      for (const checkout of [lane, { cwd: '/conformance/worktree' }]) {
        expect(await store.admitResourceStart(start('queue', 'host', 4, checkout))).toMatchObject({
          status: 'queued',
          blocker: { kind: 'run', id: holder.launch.run.id },
        });
      }
      for (const isolation of [
        { kind: 'worktree' as const },
        { kind: 'worktree' as const, branch: 'other' },
      ])
        expect(
          await store.admitResourceStart(start('queue', 'host', 4, { isolation }))
        ).toMatchObject({ status: 'admitted' });
    });
  });
}
