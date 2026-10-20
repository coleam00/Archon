import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { loadConfig } from '@archon/core/config/config-loader';
import * as connection from '@archon/core/db/connection';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { PostgresAdapter } from '@archon/core/db/adapters/postgres';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import {
  drainResourceStartHost,
  ResourceStartDrainError,
  startAdmittedResourceStart,
} from '@archon/core/workflows/resource-start-host';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import { SourceReceiptDigestConflictError } from '@archon/workflows/resource-start-store';
import type {
  ResourceStartBindingIntent,
  ResourceStartIntent,
  SourceReceiptAcceptance,
  PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';
import { registerFolder } from '@archon/core/handlers/clone';
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
    await store
      .acceptStartReceipt({
        ...receipt,
        receipt: { ...receipt.receipt, contentDigest: 'conflict' },
      })
      .catch((error: unknown) => error)
  ).toBeInstanceOf(SourceReceiptDigestConflictError);
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

test('trigger withdraw removes queued recorded source and preserves admitted source', async () => {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-withdraw-')));
  const host = hostForTest();
  const store = host.deps.store;
  const codebase = await host.records.codebases.createCodebase({
    name: 'portable',
    default_cwd: root,
  });
  const requests: PreparedWorkflowLaunch[] = [];
  for (const name of ['admitted', 'queued']) {
    const sourceRoot = join(root, name);
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'workflow.yaml'), 'frozen source');
    const prepared = launch(codebase.id);
    prepared.run.metadata = {
      workflow_source: {
        version: 1,
        root: sourceRoot,
        origin: root,
        captured_at: new Date().toISOString(),
        digest: 'frozen',
        file_count: 1,
        byte_count: 13,
      },
    };
    expect(
      await store.admitResourceStart({
        resource: 'one',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: prepared,
      })
    ).toMatchObject({ status: name });
    requests.push(prepared);
  }
  const [admitted, queued] = requests;
  await expect(triggerCommand(host, 'withdraw', [admitted.run.id], {})).rejects.toThrow(
    'Only untouched queued requests can be withdrawn.'
  );
  expect((await store.getResourceStartRequest(admitted.run.id))?.status).toBe('admitted');
  expect(await readFile(join(root, 'admitted', 'workflow.yaml'), 'utf8')).toBe('frozen source');

  await triggerCommand(host, 'withdraw', [queued.run.id], {});
  expect((await store.getResourceStartRequest(queued.run.id))?.status).toBe('withdrawn');
  await expect(stat(join(root, 'queued'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('trigger preparation recovery requires confirmation before releasing the recorded owner', async () => {
  const host = hostForTest();
  const store = host.deps.store;
  const binding: ResourceStartBindingIntent = {
    bindingId: 'binding',
    bindingRevision: 'frozen',
    hostId: 'host',
    runAsUserId: randomUUID(),
    resource: 'one',
    capacity: 1,
    overlap: 'queue',
    launch: {
      cwd: '/portable',
      workflowName: 'portable',
      inputs: {},
      isolation: { kind: 'in-place' },
    },
  };
  const receipt = acceptance(binding, 'recovery');
  await store.acceptStartReceipt(receipt);
  const owner = { receiptId: receipt.receipt.id, bindingId: binding.bindingId, ownerId: 'owner' };
  expect(await store.claimStartBindingPreparation(owner)).toBe(true);
  const claimed = await store.getStartReceipt(owner.receiptId);
  const args = [owner.receiptId, owner.bindingId];
  await expect(
    triggerCommand(host, 'recover-preparation', args, { owner: owner.ownerId })
  ).rejects.toThrow('--yes');
  expect(await store.getStartReceipt(owner.receiptId)).toEqual(claimed);
  const nextOwner = { ...owner, ownerId: 'next-owner' };
  expect(await store.claimStartBindingPreparation(nextOwner)).toBe(false);

  await triggerCommand(host, 'recover-preparation', args, { owner: owner.ownerId, yes: true });
  expect(await store.claimStartBindingPreparation(nextOwner)).toBe(true);
  expect((await store.getStartReceipt(owner.receiptId))?.bindings[0]).toMatchObject({
    status: 'preparing',
    ownerId: nextOwner.ownerId,
  });
});

test('receipt preparation and real engine execution use supplied ports without SQL or chat', async () => {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-store-')));
  // Registration stores canonical paths; the temp dir is a symlink on macOS and an
  // 8.3 short name on Windows.
  const project = join(await realpath(root), 'project');
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
  // Register through the production owner so default_cwd is the canonical path the
  // binding's cwd resolves to (macOS /var -> /private/var, Windows RUNNER~1 short names).
  await registerFolder(host.records.codebases, project, 'portable');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  if (!user) throw new Error('Expected test identity');
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
    expect(await execute().catch((error: unknown) => error)).toMatchObject({
      message: expect.stringContaining('not pending'),
    });
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
        subscribe: host.engine.subscribe.bind(host.engine),
        watchAttention: host.engine.watchAttention.bind(host.engine),
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
    expect(await store.listStartReceipts(limit).catch((error: unknown) => error)).toMatchObject({
      message: 'Receipt limit must be an integer from 1 to 1000.',
    });
  }
  expect(await store.listStartReceipts(1)).toEqual([]);
  expect(await store.listStartReceipts(1000)).toEqual([]);
});

/** Accept one binding for `workflowYaml` and drain it; returns the prepared request or the error. */
async function prepareTriggerInputs(
  workflowYaml: string,
  inputs: ResourceStartBindingIntent['launch']['inputs'],
  eventInputs?: ResourceStartBindingIntent['eventInputs']
): Promise<{
  host: WorkflowHost;
  receiptId: string;
  prepared?: Awaited<ReturnType<WorkflowHost['deps']['store']['getResourceStartRequest']>>;
  error?: unknown;
}> {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-store-')));
  const project = join(await realpath(root), 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  await writeFile(join(project, '.archon/workflows/portable.yaml'), workflowYaml);
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  registerBuiltinProviders();
  setPlatformPolicies([]);
  const host = hostForTest();
  await registerFolder(host.records.codebases, project, 'portable');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  if (!user) throw new Error('Expected test identity');
  const receipt = acceptance(
    {
      bindingId: 'mapped',
      bindingRevision: null,
      hostId: 'host',
      runAsUserId: user.id,
      resource: 'portable',
      capacity: 1,
      overlap: 'queue',
      launch: { cwd: project, workflowName: 'portable', inputs, isolation: { kind: 'in-place' } },
      ...(eventInputs ? { eventInputs } : {}),
    },
    'mapped'
  );
  await host.deps.store.acceptStartReceipt(receipt);
  const admitted: string[] = [];
  try {
    await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        admitted.push(id);
      },
    });
  } catch (error) {
    return { host, receiptId: receipt.receipt.id, error };
  } finally {
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
  }
  const [id] = admitted;
  return {
    host,
    receiptId: receipt.receipt.id,
    prepared: id ? await host.deps.store.getResourceStartRequest(id) : undefined,
  };
}

const undeclaredWorkflow =
  'name: portable\ndescription: No inputs\nnodes:\n  - id: result\n    bash: echo done\n';

test('preparation refuses event-mapped inputs for a workflow that declares none', async () => {
  const { host, receiptId, error } = await prepareTriggerInputs(
    undeclaredWorkflow,
    {},
    { order_id: 'from-the-event' }
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors[0]).toMatchObject({
    message: expect.stringContaining(
      "Workflow 'portable' declares no inputs; a trigger cannot pass event-mapped input 'order_id'"
    ),
  });
  expect((await host.deps.store.getStartReceipt(receiptId))?.bindings[0]).toMatchObject({
    status: 'rejected',
    error: 'launch_preparation_failed',
  });
});

test('preparation passes literal inputs through to a workflow that declares none', async () => {
  const { error, prepared } = await prepareTriggerInputs(undeclaredWorkflow, { mode: 'nightly' });
  expect(error).toBeUndefined();
  expect(prepared?.launch.run.metadata).toMatchObject({ inputs: { mode: 'nightly' } });
});

test('preparation passes event-mapped inputs to a workflow that declares them', async () => {
  const { error, prepared } = await prepareTriggerInputs(
    'name: portable\ndescription: Declared\ninputs:\n  order_id:\n    type: string\n    required: true\nnodes:\n  - id: result\n    bash: echo done\n',
    {},
    { order_id: 'from-the-event' }
  );
  expect(error).toBeUndefined();
  expect(prepared?.launch.run.metadata).toMatchObject({ inputs: { order_id: 'from-the-event' } });
});

/** A registered project, a user, and a timer config that fires `portable` on host `host`. */
async function fireFixture(): Promise<{
  host: WorkflowHost;
  project: string;
  userId: string;
  configPath: string;
  inputsPath: string;
  restore: () => void;
}> {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-store-')));
  const project = join(await realpath(root), 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  await writeFile(join(project, '.archon/workflows/portable.yaml'), undeclaredWorkflow);
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  registerBuiltinProviders();
  setPlatformPolicies([]);
  const host = hostForTest();
  await registerFolder(host.records.codebases, project, 'portable');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  if (!user) throw new Error('Expected test identity');
  const configPath = join(root, 'timer.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      sourceInstanceId: 'timer',
      binding: {
        bindingId: 'fired',
        bindingRevision: null,
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
      schedule: { intervalSeconds: 60, runAtLoad: false },
    })
  );
  return {
    host,
    project,
    userId: user.id,
    configPath,
    inputsPath: join(root, 'inputs.json'),
    restore: () => {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    },
  };
}

const noDispatch = async (): Promise<void> => {};

test('fire reports why preparation refused while the receipt keeps only the stage', async () => {
  const { host, configPath, inputsPath, restore } = await fireFixture();
  await writeFile(inputsPath, JSON.stringify({ order_id: 'from-the-event' }));
  try {
    const failure = await triggerCommand(
      host,
      'fire',
      [],
      { config: configPath, inputs: inputsPath },
      noDispatch
    ).then(
      () => undefined,
      (error: unknown) => error as Error
    );
    expect(failure?.message).toContain(
      "Workflow 'portable' declares no inputs; a trigger cannot pass event-mapped input 'order_id'"
    );
    const [receipt] = await host.deps.store.listStartReceipts(10);
    const stored = await host.deps.store.getStartReceipt(receipt.id);
    expect(stored?.bindings[0]).toMatchObject({
      status: 'rejected',
      error: 'launch_preparation_failed',
    });
    expect(JSON.stringify(stored)).not.toContain('declares no inputs');
  } finally {
    restore();
  }
});

test('fire redacts credential values from the refusal it prints', async () => {
  const { host, configPath, inputsPath, restore } = await fireFixture();
  // The refusal names the offending input, so a credential-valued name reaches the message.
  const secret = 'sk-test-credential-value-123';
  await writeFile(inputsPath, JSON.stringify({ [secret]: 'x' }));
  process.env.TRIGGER_TEST_API_TOKEN = secret;
  try {
    const failure = await triggerCommand(
      host,
      'fire',
      [],
      { config: configPath, inputs: inputsPath },
      noDispatch
    ).then(
      () => undefined,
      (error: unknown) => error as Error
    );
    expect(failure?.message).toContain('declares no inputs');
    expect(failure?.message).not.toContain(secret);
    expect(failure?.message).toContain('[REDACTED]');
  } finally {
    delete process.env.TRIGGER_TEST_API_TOKEN;
    restore();
  }
});

test("fire does not blame its receipt for another binding's preparation failure", async () => {
  const { host, userId, project, configPath, restore } = await fireFixture();
  // A different receipt already pending on the same host whose preparation will fail.
  await host.deps.store.acceptStartReceipt(
    acceptance(
      {
        bindingId: 'other',
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: userId,
        resource: 'other-resource',
        capacity: 1,
        overlap: 'queue',
        launch: {
          cwd: project,
          workflowName: 'portable',
          inputs: {},
          isolation: { kind: 'in-place' },
        },
        eventInputs: { order_id: 'from-the-event' },
      },
      'other'
    )
  );
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = spyOn(process.stdout, 'write').mockImplementation(((
    _chunk: unknown,
    callback?: () => void
  ) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    // The fired binding prepares and admits; only the other one fails.
    await triggerCommand(host, 'fire', [], { config: configPath }, noDispatch);
    const written = stderr.mock.calls.map(call => String(call[0])).join('');
    expect(written).toContain("cannot pass event-mapped input 'order_id'");
    const receipts = await host.deps.store.listStartReceipts(10);
    const fired = receipts.find(receipt => receipt.sourceInstanceId === 'timer');
    const stored = fired ? await host.deps.store.getStartReceipt(fired.id) : undefined;
    expect(stored?.bindings[0]?.status).not.toBe('rejected');
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
    restore();
  }
});

test('a queued start that fails is attributed to the receipt that requested it', async () => {
  const host = hostForTest();
  const store = host.deps.store;
  const codebase = await host.records.codebases.createCodebase({
    name: 'portable',
    default_cwd: '/portable',
  });
  const holder = launch(codebase.id);
  const queued = launch(codebase.id);
  queued.run.metadata = { resource_start: { receiptId: 'receipt-of-queued', bindingId: 'b' } };
  const intent = (prepared: PreparedWorkflowLaunch): ResourceStartIntent => ({
    resource: 'one',
    capacity: 1,
    hostId: 'host',
    overlap: 'queue',
    launch: prepared,
  });
  expect((await store.admitResourceStart(intent(holder))).status).toBe('admitted');
  expect((await store.admitResourceStart(intent(queued))).status).toBe('queued');
  await store.claimPendingWorkflowRun(holder.run.id);
  await store.completeWorkflowRun(holder.run.id, { duration_ms: 1 });

  const error = await drainResourceStartHost({
    ...host,
    hostId: 'host',
    startAdmitted: async () => {
      throw new Error('start refused');
    },
  }).then(
    () => undefined,
    (caught: unknown) => caught
  );

  expect(error).toBeInstanceOf(ResourceStartDrainError);
  expect((error as ResourceStartDrainError).failures).toMatchObject([
    { receiptId: 'receipt-of-queued' },
  ]);
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

test('a triggered run pauses at a gate and an attention wait and continues after each answer', async () => {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-pause-')));
  const project = join(await realpath(root), 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon/workflows/portable.yaml'),
    [
      'name: portable',
      'description: Pauses twice after a trigger start',
      'worktree:',
      '  enabled: false',
      'nodes:',
      '  - id: review',
      '    approval:',
      '      message: Approve the draft?',
      '  - id: ask',
      '    depends_on: [review]',
      '    wait:',
      '      attention: Anything else?',
      '  - id: after',
      '    depends_on: [ask]',
      '    bash: echo after >> after-count',
      '',
    ].join('\n')
  );
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  registerBuiltinProviders();
  setPlatformPolicies([]);
  try {
    const host = hostForTest();
    await registerFolder(host.records.codebases, project, 'portable');
    const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
    if (!user) throw new Error('Expected test identity');
    await host.deps.store.acceptStartReceipt(
      acceptance(
        {
          bindingId: 'pausing',
          bindingRevision: null,
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
        'pausing'
      )
    );
    const admitted: string[] = [];
    await drainResourceStartHost({
      ...host,
      hostId: 'host',
      startAdmitted: async id => {
        admitted.push(id);
      },
    });
    const [runId] = admitted;
    if (!runId) throw new Error('The trigger admitted no run');
    await startAdmittedResourceStart({
      host,
      hostId: 'host',
      requestId: runId,
      createPlatform: () => new HeadlessPlatform(),
    });
    expect(await host.deps.store.getWorkflowRun(runId)).toMatchObject({
      status: 'paused',
      metadata: { approval: { nodeId: 'review' } },
    });

    const answerAndContinue = async (answer: string): Promise<void> => {
      await host.operations.approveWorkflow(runId, answer, { kind: 'operator' }, { via: 'cli' });
      const run = await host.deps.store.getWorkflowRun(runId);
      if (!run) throw new Error('The run disappeared');
      const admission = await host.engine.resume({
        run,
        platform: new HeadlessPlatform(),
        conversationId: `trigger-${runId}`,
        cwd: project,
        userMessage: '',
      });
      if (!admission.accepted) throw new Error('The answered run was not resumed');
      await admission.settled;
    };

    await answerAndContinue('approved');
    expect(await host.deps.store.getWorkflowRun(runId)).toMatchObject({
      status: 'paused',
      metadata: { wait: { kind: 'attention', nodeId: 'ask' } },
    });

    await answerAndContinue('nothing else');
    expect((await host.deps.store.getWorkflowRun(runId))?.status).toBe('completed');
    expect(await readFile(join(project, 'after-count'), 'utf8')).toBe('after\n');
  } finally {
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
  }
});
