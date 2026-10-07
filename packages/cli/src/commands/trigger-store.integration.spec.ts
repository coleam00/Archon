import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry, registerBuiltinProviders } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import * as connection from '@archon/core/db/connection';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { PostgresAdapter } from '@archon/core/db/adapters/postgres';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import {
  drainResourceStartHost,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type {
  ResourceStartBindingIntent,
  SourceReceiptAcceptance,
  PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';
import { triggerCommand } from './trigger';

const tempRoots = trackTempRoots();

function hostForTest(): WorkflowHost {
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const deps = {
    store,
    providers: providerRegistry,
    loadConfig,
    getAgentProvider: (): never => {
      throw new Error('No AI provider');
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Unexpected host effect');
  };
  return {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
    operations: createWorkflowOperations({
      store: { ...store, deleteWorkflowRun: unsupported },
      hostStore: records,
      getUserRole: async id => (await records.users.getUserById(id))?.role,
      requestDetachedRunStop: unsupported,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      reclaimRunWorktree: unsupported,
      reclaimContainerEnv: unsupported,
    }),
  };
}

function acceptance(
  binding: ResourceStartBindingIntent,
  deliveryId: string
): SourceReceiptAcceptance {
  return {
    receipt: {
      id: randomUUID(),
      sourceInstanceId: 'portable',
      deliveryId,
      contentDigest: deliveryId,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'matched',
    bindings: [binding],
  };
}

function launch(codebaseId: string): PreparedWorkflowLaunch {
  const id = randomUUID();
  return {
    version: 2,
    run: { id, workflow_name: 'portable', codebase_id: codebaseId, user_message: '', metadata: {} },
    execution: { cwd: '/portable', conversationId: id, isolation: { kind: 'in-place' } },
  };
}

test('admission preserves FIFO, skips overlap, deduplicates receipts and fences preparation', async () => {
  const host = hostForTest();
  const store = host.deps.store;
  const codebase = await host.records.codebases.createCodebase({
    name: 'portable',
    default_cwd: '/portable',
  });
  const first = launch(codebase.id),
    second = launch(codebase.id),
    third = launch(codebase.id),
    skip = launch(codebase.id);
  const intent = (
    prepared: PreparedWorkflowLaunch,
    overlap: 'queue' | 'skip' = 'queue'
  ): import('@archon/workflows/schemas/resource-start').ResourceStartIntent => ({
    resource: 'one',
    capacity: 1,
    hostId: 'host',
    overlap,
    launch: prepared,
  });
  const decisions = await Promise.all([
    store.admitResourceStart(intent(first)),
    store.admitResourceStart(intent(second)),
    store.admitResourceStart(intent(third)),
  ]);
  expect(decisions.map(item => item.status)).toEqual(['admitted', 'queued', 'queued']);
  expect(await store.admitResourceStart(intent(skip, 'skip'))).toMatchObject({ status: 'skipped' });
  expect(await store.getWorkflowRun(second.run.id)).toBeNull();
  expect(await store.getWorkflowRun(skip.run.id)).toBeNull();
  await store.claimPendingWorkflowRun(first.run.id);
  await store.completeWorkflowRun(first.run.id, { duration_ms: 1 });
  expect(await store.drainResourceStarts({ hostId: 'another', resource: 'one' })).toEqual([]);
  expect(await store.drainResourceStarts({ hostId: 'host', resource: 'one' })).toEqual([
    { status: 'admitted', requestId: second.run.id, runId: second.run.id },
  ]);
  expect((await store.withdrawQueuedResourceStart(third.run.id))?.run.id).toBe(third.run.id);
  expect(await store.withdrawQueuedResourceStart(third.run.id)).toBeNull();
  expect(await store.withdrawQueuedResourceStart(second.run.id)).toBeNull();
  const binding: ResourceStartBindingIntent = {
    bindingId: 'binding',
    bindingRevision: 'frozen',
    hostId: 'host',
    runAsUserId: randomUUID(),
    resource: 'two',
    capacity: 1,
    overlap: 'queue',
    launch: {
      cwd: '/portable',
      workflowName: 'portable',
      inputs: {},
      isolation: { kind: 'in-place' },
    },
  };
  const receipt = acceptance(binding, 'delivery');
  expect(await store.acceptStartReceipt(receipt)).toEqual({
    receiptId: receipt.receipt.id,
    replay: false,
  });
  expect(
    await store.acceptStartReceipt({
      ...receipt,
      receipt: { ...receipt.receipt, id: randomUUID() },
    })
  ).toEqual({ receiptId: receipt.receipt.id, replay: true });
  expect(
    store.acceptStartReceipt({
      ...receipt,
      receipt: { ...receipt.receipt, contentDigest: 'conflict' },
    })
  ).rejects.toBeInstanceOf(SourceReceiptDigestConflictError);
  const owner = { receiptId: receipt.receipt.id, bindingId: binding.bindingId, ownerId: 'owner' };
  expect(
    await Promise.all([
      store.claimStartBindingPreparation(owner),
      store.claimStartBindingPreparation({ ...owner, ownerId: 'loser' }),
    ])
  ).toEqual([true, false]);
  expect(
    await store.completeStartBindingPreparation({
      ...owner,
      ownerId: 'loser',
      launch: launch(codebase.id),
    })
  ).toBeNull();
  expect(await store.resetStartBindingPreparation({ ...owner, ownerId: 'loser' })).toBe(false);
  expect(await store.resetStartBindingPreparation(owner)).toBe(true);
  expect(await store.claimStartBindingPreparation(owner)).toBe(true);
  expect(
    await store.failStartBindingPreparation({ ...owner, error: 'retry', retryable: true })
  ).toBe(true);
  expect(await store.claimStartBindingPreparation(owner)).toBe(true);
  const prepared = launch(codebase.id);
  expect(await store.completeStartBindingPreparation({ ...owner, launch: prepared })).toEqual({
    status: 'admitted',
    requestId: prepared.run.id,
    runId: prepared.run.id,
  });
  expect((await store.getStartReceipt(owner.receiptId))?.bindings[0]).toMatchObject({
    status: 'complete',
    intent: binding,
    requestStatus: 'admitted',
  });
});

test('receipt preparation and real engine execution use supplied ports without SQL or chat', async () => {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-store-')));
  const project = join(root, 'project');
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  registerBuiltinProviders();
  setPlatformPolicies([]);
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon/workflows/portable.yaml'),
    'name: portable\ndescription: Portable trigger\nworktree:\n  enabled: false\nnodes:\n  - id: result\n    bash: echo executed >> count; echo done\n'
  );
  const host = hostForTest();
  await host.records.codebases.createCodebase({
    name: 'portable',
    kind: 'folder',
    default_cwd: project,
  });
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  let accesses = 0;
  const failSql = (): never => {
    accesses++;
    throw new Error('Trigger reached SQL');
  };
  const traps = [
    spyOn(connection, 'getDatabase').mockImplementation(failSql),
    spyOn(connection.pool, 'query').mockImplementation(failSql),
    spyOn(SqliteAdapter.prototype, 'query').mockImplementation(failSql),
    spyOn(PostgresAdapter.prototype, 'query').mockImplementation(failSql),
  ];
  const stdout = spyOn(process.stdout, 'write').mockImplementation(
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void
    ): boolean => {
      void chunk;
      if (typeof encodingOrCallback === 'function') encodingOrCallback();
      else callback?.();
      return true;
    }
  );
  try {
    expect(() => connection.getDatabase()).toThrow('Trigger reached SQL');
    accesses = 0;
    const receipt = acceptance(
      {
        bindingId: 'binding',
        bindingRevision: '1',
        hostId: 'host',
        runAsUserId: user.id,
        resource: 'portable',
        capacity: 1,
        overlap: 'queue',
        launch: {
          cwd: project,
          workflowName: 'portable',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
      'delivery'
    );
    await host.deps.store.acceptStartReceipt(receipt);
    const admitted: string[] = [];
    await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        admitted.push(id);
      },
    });
    const [id] = admitted;
    expect(id).toBeDefined();
    const prepared = await host.deps.store.getResourceStartRequest(id);
    expect(prepared?.launch.run.origin).toEqual({ userId: user.id });
    expect(prepared?.launch.version).toBe(2);
    await triggerCommand(host, 'inspect', [id], {});
    await triggerCommand(host, 'list', [], {});
    const execute = (): ReturnType<typeof startAdmittedResourceStart> =>
      startAdmittedResourceStart({
        host,
        hostId: 'host',
        requestId: id,
        createPlatform: ({ runId, origin, conversationId }) => {
          expect(runId).toBe(id);
          expect(origin).toEqual({ userId: user.id });
          expect(conversationId).toBe(`trigger-${id}`);
          return new HeadlessPlatform();
        },
      });
    const results = await Promise.allSettled([execute(), execute()]);
    expect(
      results.filter(result => result.status === 'fulfilled' && result.value.success)
    ).toHaveLength(1);
    expect(await readFile(join(project, 'count'), 'utf8')).toBe('executed\n');
    expect(await host.deps.store.getWorkflowRun(id)).toMatchObject({
      status: 'completed',
      conversation_id: null,
      origin: { userId: user.id },
    });
    expect(
      (await host.deps.store.listWorkflowEvents(id)).filter(
        event => event.event_type === 'workflow_completed'
      )
    ).toHaveLength(1);
    expect(execute()).rejects.toThrow('not pending');
    if (receipt.outcome !== 'matched') throw new Error('Expected a matched receipt');
    const delayedReceipt = acceptance(receipt.bindings[0], 'delayed');
    await host.deps.store.acceptStartReceipt(delayedReceipt);
    const pending: string[] = [];
    await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async requestId => {
        pending.push(requestId);
      },
    });
    const delayedId = pending[0];
    const delayedHost = {
      ...host,
      engine: {
        resume: host.engine.resume.bind(host.engine),
        submit: async (
          input: Parameters<typeof host.engine.submit>[0]
        ): ReturnType<typeof host.engine.submit> => {
          expect((await host.deps.store.claimPendingWorkflowRun(delayedId))?.status).toBe(
            'running'
          );
          return host.engine.submit(input);
        },
      },
    };
    const delayed = await startAdmittedResourceStart({
      host: delayedHost,
      hostId: 'host',
      requestId: delayedId,
      createPlatform: () => new HeadlessPlatform(),
    });
    expect(delayed.success).toBe(false);
    expect(await readFile(join(project, 'count'), 'utf8')).toBe('executed\n');
    expect(
      (await host.deps.store.listWorkflowEvents(delayedId)).filter(
        event => event.event_type === 'node_started'
      )
    ).toEqual([]);
    if (!prepared) throw new Error('Missing prepared launch');
    const queuedLaunch = { ...prepared.launch, run: { ...prepared.launch.run, id: randomUUID() } };
    expect(
      (
        await host.deps.store.admitResourceStart({
          resource: 'portable',
          capacity: 1,
          hostId: 'host',
          overlap: 'queue',
          launch: queuedLaunch,
        })
      ).status
    ).toBe('queued');
    await host.deps.store.completeWorkflowRun(delayedId, { duration_ms: 1 });
    await triggerCommand(host, 'drain', [], { host: 'host' });
    expect((await host.deps.store.getWorkflowRun(queuedLaunch.run.id))?.status).toBe('completed');
    expect(await readFile(join(project, 'count'), 'utf8')).toBe('executed\nexecuted\n');
    const configPath = join(root, 'timer.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        sourceInstanceId: 'timer',
        binding: receipt.bindings[0],
        schedule: { intervalSeconds: 60, runAtLoad: false },
      })
    );
    await triggerCommand(host, 'fire', [], { config: configPath });
    expect(await readFile(join(project, 'count'), 'utf8')).toBe('executed\nexecuted\nexecuted\n');
    expect(accesses).toBe(0);
  } finally {
    for (const trap of traps) trap.mockRestore();
    stdout.mockRestore();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
  }
});

test('receipt inspection rejects invalid limits through the in-memory store', async () => {
  const store = hostForTest().deps.store;
  for (const limit of [NaN, 1.5, 0, 1001]) {
    expect(store.listStartReceipts(limit)).rejects.toThrow(
      'Receipt limit must be an integer from 1 to 1000.'
    );
  }
  expect(await store.listStartReceipts(1)).toEqual([]);
  expect(await store.listStartReceipts(1000)).toEqual([]);
});

test('preparation preserves both failures when rejection cannot be persisted', async () => {
  const host = hostForTest();
  const statusError = new Error('status write unavailable');
  const receipt = acceptance(
    {
      bindingId: 'missing-user',
      bindingRevision: null,
      hostId: 'host',
      runAsUserId: randomUUID(),
      resource: 'portable',
      capacity: 1,
      overlap: 'queue',
      launch: {
        cwd: '/portable',
        workflowName: 'portable',
        inputs: {},
        isolation: { kind: 'in-place' },
      },
    },
    'missing-user'
  );
  await host.deps.store.acceptStartReceipt(receipt);
  const fail = spyOn(host.deps.store, 'failStartBindingPreparation').mockRejectedValue(statusError);
  try {
    let caught: unknown;
    try {
      await drainResourceStartHost({
        ...host,
        hostId: 'host',
        startAdmitted: async () => {
          throw new Error('unexpected start');
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const preparation = (caught as AggregateError).errors[0] as AggregateError;
    expect(preparation).toBeInstanceOf(AggregateError);
    expect(preparation.message).toContain('run_as_user_failed');
    expect(preparation.errors[0].message).toBe('The configured run-as user no longer exists.');
    expect(preparation.errors[1]).toBe(statusError);
    expect((await host.deps.store.getStartReceipt(receipt.receipt.id))?.bindings[0]).toMatchObject({
      status: 'preparing',
      error: null,
    });
  } finally {
    fail.mockRestore();
  }
});
