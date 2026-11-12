import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { withRunSlotReleaseScope } from '@archon/workflows/run-slot-release';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
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

test.each(
  (['cancel', 'abandon'] as const).flatMap(action =>
    (
      ['safe', 'owner-warning', 'advisory', 'image-inventory-warning', 'resource-error'] as const
    ).map(ending => [action, ending] as const)
  )
)('stopped-owner %s drains only after confirmed cleanup: %s', async (action, ending) => {
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
      run: {
        id,
        workflow_name: 'test',
        codebase_id: 'project',
        user_message: '',
        metadata:
          ending === 'advisory'
            ? {
                owned_worktree: { envId: 'retained', creationId: crypto.randomUUID() },
              }
            : {},
      },
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
    store: Object.assign(store, {
      deleteWorkflowRun: async () => {
        throw new Error('unused');
      },
    }),
    hostStore: host.records,
    getUserRole: async () => undefined,
    isRunOwnedByThisProcess: () => false,
    isRunOwnerAnswering: async () => false,
    requestDetachedRunStop: async () => ({
      pid: 123,
      stop: async () => {
        order.push('stop');
        return {
          warnings: ending === 'owner-warning' ? ['output holder remains'] : [],
          advisories: ending === 'advisory' ? ['historical commands'] : [],
        };
      },
      release: () => {},
    }),
    reclaimContainerEnv: async () => {
      throw new Error('unused');
    },
    reclaimRunWorktree: async run => {
      if (run.metadata.owned_worktree) order.push('worktree');
      return { warnings: [] };
    },
    releaseRunResources: async () => {
      expect(order).toEqual(['stop']);
      order.push('cleanup');
      if (ending === 'resource-error') throw new Error('image cleanup failed');
      return ending === 'image-inventory-warning' ? ['retained image inventory'] : [];
    },
  });
  try {
    const result =
      action === 'cancel'
        ? await operations.cancelWorkflow(id, { kind: 'operator' })
        : await operations.abandonWorkflow(id, { kind: 'operator' });
    if ('kind' in result) expect(result.kind).toBe('stopped');
    expect((await store.getWorkflowRun(id))?.status).toBe('cancelled');
    expect(order).toEqual(
      ending === 'safe' || ending === 'image-inventory-warning'
        ? ['stop', 'cleanup', 'drain']
        : ending === 'advisory'
          ? ['stop', 'drain']
          : ending === 'owner-warning'
            ? ['stop']
            : ['stop', 'cleanup']
    );
    if (ending !== 'safe') expect(result.cleanupWarnings?.length).toBeGreaterThan(0);
  } finally {
    dispose();
  }
});

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

test.each(['owner', 'container', 'resource', 'shared-checkout'] as const)(
  'reset defers only affected releases after %s cleanup refuses',
  async failure => {
    const { hostname } = await import('node:os');
    const { DetachedRunOwnerUnavailableError } = await import('../services/run-owner-stop');
    const { createWorkflowOperations } = await import('../operations/workflow-operations');
    const host = await createFileWorkflowHost(
      roots(await mkdtemp(join(tmpdir(), 'reset-release-')))
    );
    const store = host.deps.store;
    const proof = { envId: 'unsafe-env', creationId: crypto.randomUUID() };
    const runs = [];
    for (const name of ['unsafe', 'safe']) {
      const launch: PreparedWorkflowLaunch = {
        version: 2,
        run: {
          id: crypto.randomUUID(),
          workflow_name: 'test',
          codebase_id: 'project',
          user_message: '',
          origin: { conversationId: 'reset' },
          metadata: {
            owned_worktree:
              name === 'unsafe' || failure === 'shared-checkout'
                ? proof
                : { envId: 'safe-env', creationId: crypto.randomUUID() },
            execution_owner: {
              host: hostname(),
              pid: process.pid,
              ...(process.getuid ? { uid: process.getuid() } : {}),
            },
            ...(failure === 'container' && name === 'unsafe'
              ? { isolation: 'container', isolation_env_id: 'container' }
              : {}),
          },
        },
        execution: {
          cwd: `/project/${name}`,
          conversationId: 'reset',
          isolation: { kind: 'in-place' as const },
        },
      };
      await store.admitResourceStart({
        resource: name,
        capacity: 1,
        hostId: name,
        overlap: 'queue',
        launch,
      });
      await store.claimPendingWorkflowRun(launch.run.id);
      await store.pauseWorkflowRun(launch.run.id, {
        nodeId: 'review',
        pauseId: 'pause',
        message: 'Choose',
      });
      const next = {
        ...launch,
        run: { ...launch.run, id: crypto.randomUUID(), origin: undefined, metadata: {} },
      };
      expect(
        (
          await store.admitResourceStart({
            resource: name,
            capacity: 1,
            hostId: name,
            overlap: 'queue',
            launch: next,
          })
        ).status
      ).toBe('queued');
      runs.push({ id: launch.run.id, nextId: next.run.id, name });
    }
    const unsafe = runs[0];
    const safe = runs[1];
    const cleaned: string[] = [];
    const operations = createWorkflowOperations({
      store: Object.assign(store, { deleteWorkflowRun: async () => {} }),
      hostStore: host.records,
      getUserRole: async () => undefined,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      requestDetachedRunStop: async id => {
        if (id === unsafe.id && (failure === 'owner' || failure === 'shared-checkout'))
          throw new Error('cannot inspect owner');
        throw new DetachedRunOwnerUnavailableError(id, 'ENOENT', 'unreachable');
      },
      reclaimContainerEnv: async () => {
        throw new Error('container still running');
      },
      reclaimRunWorktree: async run => {
        cleaned.push(run.id);
        return { warnings: [] };
      },
      releaseRunResources: async id => {
        if (failure === 'resource' && id === unsafe.id) throw new Error('cleanup failed');
        return [];
      },
    });
    const drained: string[] = [];
    const dispose = subscribeResourceStartReleases(host, async hostId => {
      drained.push(hostId);
      expect((await store.getWorkflowRun(safe.id))?.status).toBe('cancelled');
      await store.drainResourceStarts({ hostId, resource: hostId });
    });
    try {
      const result = await operations.abandonResumableRunsForConversation('reset', {
        kind: 'operator',
      });
      expect(result.abandoned).toBe(2);
      expect(result.cleanupWarnings?.length).toBeGreaterThan(0);
      expect(drained).toEqual(failure === 'shared-checkout' ? [] : ['safe']);
      expect((await store.getResourceStartRequest(unsafe.nextId))?.status).toBe('queued');
      expect((await store.getResourceStartRequest(safe.nextId))?.status).toBe(
        failure === 'shared-checkout' ? 'queued' : 'admitted'
      );
      if (failure === 'shared-checkout') expect(cleaned).toEqual([]);
      else expect(cleaned).toContain(safe.id);
    } finally {
      dispose();
    }
  }
);
