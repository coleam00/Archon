import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { loadConfig } from '@archon/core/config/config-loader';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import { startAdmittedResourceStart } from '@archon/core/workflows/resource-start-host';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { HeadlessPlatform } from '@archon/core/workflows/headless-platform';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';
import { registerFolder } from '@archon/core/handlers/clone';
import { triggerCommand, type timerTriggerConfigSchema } from './trigger';
import type { z } from '@hono/zod-openapi';

// Poll-style `trigger fire` behavior, run in-process: an external poller re-runs `fire`, and
// each admitted start runs as its detached `trigger execute` owner would.

const tempRoots = trackTempRoots();

type TimerConfig = z.infer<typeof timerTriggerConfigSchema>;

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

const orderWorkflow =
  'name: portable\ndescription: Record a polled order\nworktree:\n  enabled: false\ninputs:\n  order_id: { type: string, required: true }\n  mode: { type: string, required: true }\nnodes:\n  - id: record\n    bash: echo done\n';

const undeclaredWorkflow =
  'name: portable\ndescription: No inputs\nnodes:\n  - id: result\n    bash: echo done\n';

/** A registered project, a user, and a timer config that fires `portable` with `inputs`. */
async function orderFixture(inputs: Record<string, string>): Promise<{
  host: WorkflowHost;
  workflowPath: string;
  config: TimerConfig;
  configPath: string;
  inputsPath: string;
  restore: () => void;
}> {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-trigger-poll-')));
  const project = join(await realpath(root), 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  const workflowPath = join(project, '.archon/workflows/portable.yaml');
  await writeFile(workflowPath, orderWorkflow);
  const previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  registerBuiltinProviders();
  setPlatformPolicies([]);
  const host = hostForTest();
  await registerFolder(host.records.codebases, project, 'portable');
  const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'operator');
  if (!user) throw new Error('Expected test identity');
  const configPath = join(root, 'timer.json');
  const config: TimerConfig = {
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
        inputs,
        isolation: { kind: 'in-place' },
      },
    },
    schedule: { intervalSeconds: 60, runAtLoad: false },
  };
  await writeFile(configPath, JSON.stringify(config));
  return {
    host,
    workflowPath,
    config,
    configPath,
    inputsPath: join(root, 'inputs.json'),
    restore: () => {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    },
  };
}

/**
 * Fires as an external poller re-running `trigger fire` would, then runs each admitted
 * start to completion as its detached `trigger execute` owner would.
 */
async function fireAndExecute(
  host: WorkflowHost,
  options: Parameters<typeof triggerCommand>[3]
): Promise<void> {
  const admitted: string[] = [];
  await triggerCommand(host, 'fire', [], options, async id => {
    admitted.push(id);
  });
  for (const requestId of admitted) {
    const result = await startAdmittedResourceStart({
      host,
      hostId: 'host',
      requestId,
      createPlatform: () => new HeadlessPlatform(),
    });
    if (!result.success) throw new Error(`Admitted start ${requestId} did not complete`);
  }
}

/** `fire` awaits the write callback of the receipt it prints. */
function silenceStdout(): { mockRestore: () => void } {
  return spyOn(process.stdout, 'write').mockImplementation(((
    _chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: () => void
  ) => {
    (typeof encodingOrCallback === 'function' ? (encodingOrCallback as () => void) : callback)?.();
    return true;
  }) as typeof process.stdout.write);
}

test('poll-style fires deduplicate keyed event inputs and reject bad ones', async () => {
  const { host, config, configPath, inputsPath, restore } = await orderFixture({
    order_id: 'literal-order',
    mode: 'poll',
  });
  const stdout = silenceStdout();
  const runs = async () => (await host.deps.store.listWorkflowRuns()).runs;
  const receipts = () => host.deps.store.listStartReceipts(10);
  const fire = { config: configPath, inputs: inputsPath };
  const keyed = { ...fire, deliveryId: 'order-123@1' };
  try {
    await writeFile(inputsPath, JSON.stringify({ order_id: 'order-123' }));
    for (let tick = 0; tick < 2; tick++) {
      await fireAndExecute(host, keyed);
      config.binding.launch.inputs.mode = 'edited-after-acceptance';
      await writeFile(configPath, JSON.stringify(config));
    }
    const [completed, ...extra] = await runs();
    expect(extra).toEqual([]);
    expect(completed).toMatchObject({
      status: 'completed',
      metadata: { inputs: { order_id: 'order-123', mode: 'poll' } },
    });
    expect(await receipts()).toHaveLength(1);

    for (const invalid of ['[]', 'null', '{bad json', '{"":1}']) {
      await writeFile(inputsPath, invalid);
      await expect(fireAndExecute(host, fire)).rejects.toThrow('--inputs');
    }
    expect(await receipts()).toHaveLength(1);

    await writeFile(inputsPath, JSON.stringify({ undeclared: 'event' }));
    await expect(fireAndExecute(host, { ...fire, deliveryId: 'undeclared@1' })).rejects.toThrow(
      "does not declare input 'undeclared'"
    );
    const rejected = (await receipts()).find(receipt => receipt.deliveryId === 'undeclared@1');
    expect(
      rejected ? (await host.deps.store.getStartReceipt(rejected.id))?.bindings[0]?.status : null
    ).toBe('rejected');
    expect(await runs()).toHaveLength(1);

    // A recorded delivery answers replay or conflict even after its run-as user is removed.
    const removed = spyOn(host.records.users, 'getUserById').mockResolvedValue(null);
    try {
      await writeFile(inputsPath, JSON.stringify({ order_id: 'order-124' }));
      await expect(fireAndExecute(host, { ...fire, deliveryId: 'order-124@1' })).rejects.toThrow(
        'Trigger binding names an unknown run-as user.'
      );
      expect(await receipts()).toHaveLength(2);
      await writeFile(inputsPath, JSON.stringify({ order_id: 'order-123' }));
      await fireAndExecute(host, keyed);
      await writeFile(inputsPath, JSON.stringify({ order_id: 'changed-order' }));
      await expect(fireAndExecute(host, keyed)).rejects.toThrow(
        "Delivery ID 'order-123@1' was already used with different inputs"
      );
    } finally {
      removed.mockRestore();
    }
    expect(await receipts()).toHaveLength(2);
    expect(await runs()).toHaveLength(1);
  } finally {
    stdout.mockRestore();
    restore();
  }
});

test('poll-style fires preserve unkeyed starts', async () => {
  const { host, workflowPath, configPath, inputsPath, restore } = await orderFixture({
    order_id: 'literal-order',
    mode: 'poll',
  });
  const stdout = silenceStdout();
  const runs = async () => (await host.deps.store.listWorkflowRuns()).runs;
  try {
    await writeFile(inputsPath, JSON.stringify({ order_id: 'unkeyed-event' }));
    await fireAndExecute(host, { config: configPath, inputs: inputsPath });
    expect(await runs()).toMatchObject([
      { status: 'completed', metadata: { inputs: { order_id: 'unkeyed-event' } } },
    ]);

    await writeFile(workflowPath, undeclaredWorkflow);
    await writeFile(inputsPath, JSON.stringify({ order_id: 'event' }));
    await expect(
      fireAndExecute(host, { config: configPath, inputs: inputsPath, deliveryId: 'undeclared@2' })
    ).rejects.toThrow('declares no inputs');
    expect(await runs()).toHaveLength(1);

    for (let tick = 0; tick < 2; tick++) await fireAndExecute(host, { config: configPath });
    const unkeyed = (await host.deps.store.listStartReceipts(10)).filter(
      receipt => receipt.deliveryId === null
    );
    expect(unkeyed).toHaveLength(3);
    const all = await runs();
    expect(all).toHaveLength(3);
    expect(all.every(run => run.status === 'completed')).toBe(true);
  } finally {
    stdout.mockRestore();
    restore();
  }
});
