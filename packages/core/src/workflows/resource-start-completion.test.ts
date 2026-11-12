import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { withRunSlotReleaseScope } from '@archon/workflows/run-slot-release';
import { createFileWorkflowHost } from './file-host';
import { subscribeResourceStartReleases } from './resource-start-completion';

const roots = trackTempRoots();
test('committed releases resolve recorded ancestry and coalesce hosts; disposal stops delivery', async () => {
  const host = await createFileWorkflowHost(roots(await mkdtemp(join(tmpdir(), 'release-host-'))));
  const store = host.deps.store;
  const launch = {
    version: 2 as const,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'test',
      codebase_id: 'project',
      user_message: '',
      metadata: {},
    },
    execution: {
      cwd: '/project',
      conversationId: 'test',
      isolation: { kind: 'in-place' as const },
    },
  };
  await store.admitResourceStart({
    resource: 'one',
    capacity: 1,
    hostId: 'recorded-host',
    overlap: 'queue',
    launch,
  });
  const child = await store.createWorkflowRun({
    workflow_name: 'child',
    user_message: '',
    parent_run_id: launch.run.id,
  });
  const hosts: string[] = [];
  const lookupFailures: string[] = [];
  const dispose = subscribeResourceStartReleases(
    host,
    async id => {
      hosts.push(id);
    },
    runId => {
      lookupFailures.push(runId);
    }
  );
  try {
    const ordinary = await store.createWorkflowRun({ workflow_name: 'ordinary', user_message: '' });
    await store.cancelWorkflowRun(ordinary.id);
    expect(hosts).toEqual([]);
    await withRunSlotReleaseScope(async () => {
      await store.cancelWorkflowRun(child.id);
      await store.cancelWorkflowRun(launch.run.id);
      expect(hosts).toEqual([]);
    });
    expect(hosts).toEqual(['recorded-host']);
    const bad = await store.createWorkflowRun({
      workflow_name: 'bad',
      user_message: '',
      parent_run_id: launch.run.id,
    });
    const healthy = await store.createWorkflowRun({
      workflow_name: 'healthy',
      user_message: '',
      parent_run_id: launch.run.id,
    });
    const lookup = spyOn(store, 'getResourceStartRequest').mockRejectedValueOnce(
      new Error('unreadable admission')
    );
    try {
      await withRunSlotReleaseScope(async () => {
        await store.cancelWorkflowRun(bad.id);
        await store.cancelWorkflowRun(healthy.id);
      });
      expect(lookupFailures).toEqual([bad.id]);
      expect(hosts).toEqual(['recorded-host', 'recorded-host']);
    } finally {
      lookup.mockRestore();
    }
    dispose();
    const next = await store.createWorkflowRun({
      workflow_name: 'child',
      user_message: '',
      parent_run_id: launch.run.id,
    });
    await store.cancelWorkflowRun(next.id);
    expect(hosts).toEqual(['recorded-host', 'recorded-host']);
  } finally {
    dispose();
  }
});

test.each(['safe', 'owner-warning', 'image-inventory-warning', 'resource-error'] as const)(
  'stopped-owner cancellation drains only after confirmed cleanup: %s',
  async ending => {
    const { createWorkflowOperations } = await import('../operations/workflow-operations');
    const host = await createFileWorkflowHost(
      roots(await mkdtemp(join(tmpdir(), 'cancel-release-')))
    );
    const store = host.deps.store;
    const id = crypto.randomUUID();
    await store.admitResourceStart({
      resource: 'cancel',
      capacity: 1,
      hostId: 'cancel-host',
      overlap: 'queue',
      launch: {
        version: 2,
        run: { id, workflow_name: 'test', codebase_id: 'project', user_message: '', metadata: {} },
        execution: { cwd: '/project', conversationId: 'test', isolation: { kind: 'in-place' } },
      },
    });
    await store.claimPendingWorkflowRun(id);
    const order: string[] = [];
    const dispose = subscribeResourceStartReleases(host, async hostId => {
      expect(hostId).toBe('cancel-host');
      expect((await store.getWorkflowRun(id))?.status).toBe('cancelled');
      order.push('drain');
    });
    const operations = createWorkflowOperations({
      store: {
        ...store,
        deleteWorkflowRun: async () => {
          throw new Error('unused');
        },
      },
      hostStore: host.records,
      getUserRole: async () => undefined,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      requestDetachedRunStop: async () => ({
        pid: 123,
        stop: async () => {
          order.push('stop');
          return { warnings: ending === 'owner-warning' ? ['output holder remains'] : [] };
        },
        release: () => {},
      }),
      reclaimContainerEnv: async () => {
        throw new Error('unused');
      },
      reclaimRunWorktree: async () => {
        throw new Error('unused');
      },
      releaseRunResources: async () => {
        expect(order).toEqual(['stop']);
        order.push('cleanup');
        if (ending === 'resource-error') throw new Error('image cleanup failed');
        return ending === 'image-inventory-warning' ? ['retained image inventory'] : [];
      },
    });
    try {
      const result = await operations.cancelWorkflow(id, { kind: 'operator' });
      expect(result.kind).toBe('stopped');
      expect((await store.getWorkflowRun(id))?.status).toBe('cancelled');
      expect(order).toEqual(
        ending === 'safe' || ending === 'image-inventory-warning'
          ? ['stop', 'cleanup', 'drain']
          : ending === 'owner-warning'
            ? ['stop']
            : ['stop', 'cleanup']
      );
      if (ending !== 'safe') expect(result.cleanupWarnings?.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  }
);

test('a pending pack-settings refusal advances an eligible queue before any execution claim', async () => {
  const { registerBuiltinProviders } = await import('@archon/providers/in-process');
  registerBuiltinProviders();
  const { setPlatformPolicies } = await import('../platforms/registry');
  setPlatformPolicies([]);
  const { makeTestWorkflow } = await import('@archon/workflows/test-utils');
  const { resolveWorkflow } = await import('@archon/workflows/graph-plan');
  const { HeadlessPlatform } = await import('./headless-platform');
  const root = roots(await mkdtemp(join(tmpdir(), 'preclaim-release-')));
  const host = await createFileWorkflowHost(root);
  const store = host.deps.store;
  const launch = {
    version: 2 as const,
    run: {
      id: crypto.randomUUID(),
      workflow_name: 'refused',
      codebase_id: 'project',
      user_message: '',
      metadata: {},
    },
    execution: { cwd: root, conversationId: 'test', isolation: { kind: 'in-place' as const } },
  };
  const intent = {
    resource: 'preclaim',
    capacity: 1,
    hostId: 'recorded-host',
    overlap: 'queue' as const,
  };
  await store.admitResourceStart({ ...intent, launch });
  const next = { ...launch, run: { ...launch.run, id: crypto.randomUUID() } };
  expect((await store.admitResourceStart({ ...intent, launch: next })).status).toBe('queued');
  const run = await store.getWorkflowRun(launch.run.id);
  if (!run) throw new Error('Missing admitted run');
  let claimed = false;
  const dispose = subscribeResourceStartReleases(host, async hostId => {
    expect(hostId).toBe(intent.hostId);
    expect(claimed).toBe(false);
    await store.drainResourceStarts({ hostId, resource: intent.resource });
  });
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  try {
    await expect(
      host.engine.submit({
        platform: new HeadlessPlatform(),
        conversationId: 'test',
        cwd: root,
        workflow: resolveWorkflow({
          ...makeTestWorkflow({ name: 'refused', nodes: [] }),
          pack: {
            key: 'required',
            source: 'project',
            settings: { required_setting: { type: 'string', required: true } },
          },
        }),
        userMessage: '',
        options: {
          preCreatedRun: run,
          baseBranch: 'main',
          onExecutionClaimed: () => {
            claimed = true;
          },
        },
      })
    ).rejects.toThrow('requires setting');
    expect((await store.getWorkflowRun(run.id))?.status).toBe('failed');
    expect((await store.getResourceStartRequest(next.run.id))?.status).toBe('admitted');
    expect(claimed).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    dispose();
  }
});
