// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { InstallHeldError } from '@archon/workflows/store';
import type {
  PreparedWorkflowLaunch,
  ResourceStartBindingIntent,
} from '@archon/workflows/schemas/resource-start';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { createWorkflowStore } from '../workflows/store-adapter';
import { createSqlWorkflowHost } from '../workflows/sql-host';
import { drainResourceStartHost } from '../workflows/resource-start-host';
import { registerFolder } from '../handlers/clone';
import { setPlatformPolicies } from '../platforms/registry';
import { readItem } from '@archon/workflows/item-read';
import { attentionQueueSource } from '../operations/attention-queue';
import { ensureItem } from './items';
import { executeWorkflow } from '@archon/workflows/executor';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { providerRegistry } from '@archon/providers';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CODEBASE_ID = '33333333-3333-4333-8333-333333333333';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;
let root = '';

function launch(): PreparedWorkflowLaunch {
  const id = crypto.randomUUID();
  return {
    version: 2,
    run: { id, workflow_name: 'test', codebase_id: CODEBASE_ID, user_message: '', metadata: {} },
    execution: { cwd: `/tmp/test/${id}`, conversationId: id, isolation: { kind: 'in-place' } },
  };
}

function binding(
  cwd: string,
  overrides: Partial<ResourceStartBindingIntent> = {}
): ResourceStartBindingIntent {
  return {
    bindingId: 'binding',
    bindingRevision: null,
    hostId: 'host',
    runAsUserId: USER_ID,
    resource: 'pool',
    capacity: 1,
    overlap: 'queue',
    launch: { cwd, workflowName: 'held', inputs: {}, isolation: { kind: 'in-place' } },
    ...overrides,
  };
}

async function accept(
  store: ReturnType<typeof createWorkflowStore>,
  intent: ResourceStartBindingIntent,
  itemKey?: string
): Promise<string> {
  const id = crypto.randomUUID();
  await store.acceptStartReceipt({
    receipt: {
      id,
      sourceInstanceId: 'held',
      deliveryId: null,
      contentDigest: id,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
      ...(itemKey === undefined ? {} : { itemKey }),
    },
    outcome: 'matched',
    bindings: [intent],
  });
  return id;
}

async function bindingStatus(receiptId: string) {
  const rows = await getDatabase().query<{ status: string; owner: string | null }>(
    'SELECT preparation_status AS status, preparation_owner AS owner FROM remote_agent_start_receipt_bindings WHERE receipt_id = $1',
    [receiptId]
  );
  return rows.rows[0];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-install-hold-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  await getDatabase().query(
    `INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')`,
    [USER_ID]
  );
  await getDatabase().query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, ai_assistant_type) VALUES ($1, 'test', '/tmp/test', 'claude')`,
    [CODEBASE_ID]
  );
});

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

describe('install hold', () => {
  test('is kept as first set until lifted, and outlives the connection that set it', async () => {
    const store = createWorkflowStore();
    const { hold, alreadySet } = await store.setInstallHold({ setBy: 'first' });
    expect(alreadySet).toBe(false);
    expect(await store.setInstallHold({ setBy: 'second' })).toEqual({ hold, alreadySet: true });

    await closeDatabase();
    resetDatabase();
    expect(await store.getInstallHold()).toEqual(hold);

    expect(await store.liftInstallHold()).toEqual(hold);
    expect(await store.getInstallHold()).toBeNull();
    expect(await store.liftInstallHold()).toBeNull();
  });

  test('a binding prepared under the hold is pending again, and is admitted once after the lift', async () => {
    const store = createWorkflowStore();
    const receiptId = await accept(store, binding('/tmp/test'));
    const identity = { receiptId, bindingId: 'binding', ownerId: 'owner' };
    expect(await store.claimStartBindingPreparation(identity)).toBe(true);
    const { hold } = await store.setInstallHold({ setBy: 'operator' });

    const held = launch();
    expect(await store.completeStartBindingPreparation({ ...identity, launch: held })).toEqual({
      status: 'held',
      hold,
    });
    expect(await bindingStatus(receiptId)).toEqual({ status: 'pending', owner: null });
    expect(await store.getResourceStartRequest(held.run.id)).toBeNull();
    expect(await store.getWorkflowRun(held.run.id)).toBeNull();
    expect(await store.listHeldStarts()).toMatchObject([
      { kind: 'trigger', receiptId, bindingId: 'binding', hostId: 'host', workflow: 'held' },
    ]);

    await store.liftInstallHold();
    const again = { ...identity, ownerId: 'after-lift' };
    expect(await store.claimStartBindingPreparation(again)).toBe(true);
    const admitted = launch();
    expect(await store.completeStartBindingPreparation({ ...again, launch: admitted })).toEqual({
      status: 'admitted',
      requestId: admitted.run.id,
      runId: admitted.run.id,
    });
    expect(await store.claimStartBindingPreparation(again)).toBe(false);
  });

  test('a queued request is not drained under the hold, and is after the lift', async () => {
    const store = createWorkflowStore();
    const start = (prepared: PreparedWorkflowLaunch) =>
      store.admitResourceStart({
        resource: 'pool',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: prepared,
      });
    const holder = launch();
    const queued = launch();
    await start(holder);
    expect(await start(queued)).toMatchObject({ status: 'queued' });
    await store.setInstallHold({ setBy: 'operator' });
    // Admitted before the hold, so its claim is not new work.
    expect(await store.claimPendingWorkflowRun(holder.run.id)).toMatchObject({
      status: 'running',
    });
    await store.completeWorkflowRun(holder.run.id, { duration_ms: 1 });

    expect(await store.drainResourceStarts({ resource: 'pool', hostId: 'host' })).toEqual([]);
    expect(await store.listHeldStarts()).toMatchObject([
      { kind: 'queued', requestId: queued.run.id, resource: 'pool', workflow: 'test' },
    ]);
    await store.liftInstallHold();
    expect(await store.drainResourceStarts({ resource: 'pool', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: queued.run.id, runId: queued.run.id },
    ]);
  });

  test('a hand start is refused while held; a child run and an admitted run are not', async () => {
    const store = createWorkflowStore();
    const admittedBefore = launch();
    await store.admitResourceStart({
      resource: 'pool',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: admittedBefore,
    });
    const hand = await store.createWorkflowRun({
      id: crypto.randomUUID(),
      workflow_name: 'test',
      user_message: '',
    });
    const parent = await store.createWorkflowRun({ workflow_name: 'test', user_message: '' });
    expect(await store.claimPendingWorkflowRun(parent.id)).toMatchObject({ status: 'running' });
    const child = await store.createWorkflowRun({
      workflow_name: 'test',
      user_message: '',
      parent_run_id: parent.id,
    });
    const { hold } = await store.setInstallHold({ setBy: 'operator' });

    const refused = await store.claimPendingWorkflowRun(hand.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InstallHeldError);
    expect((refused as InstallHeldError).hold).toEqual(hold);
    expect((await store.getWorkflowRun(hand.id))?.status).toBe('pending');
    const waiting = launch();
    waiting.run.id = hand.id;
    expect(
      await store
        .admitPendingRun({ resource: 'other', capacity: 1, launch: waiting })
        .catch((error: unknown) => error)
    ).toBeInstanceOf(InstallHeldError);
    expect(await store.getResourceStartRequest(hand.id)).toBeNull();

    expect(await store.claimPendingWorkflowRun(child.id)).toMatchObject({ status: 'running' });
    expect(await store.claimPendingWorkflowRun(admittedBefore.run.id)).toMatchObject({
      status: 'running',
    });

    await store.liftInstallHold();
    expect(await store.claimPendingWorkflowRun(hand.id)).toMatchObject({ status: 'running' });
  });

  test('a hand start cancelled under the hold is told it is no longer pending', async () => {
    const store = createWorkflowStore();
    const hand = await store.createWorkflowRun({
      id: crypto.randomUUID(),
      workflow_name: 'test',
      user_message: '',
    });
    await store.setInstallHold({ setBy: 'operator' });
    await store.cancelWorkflowRun(hand.id);
    const waiting = launch();
    waiting.run.id = hand.id;

    const refused = await store
      .admitPendingRun({ resource: 'other', capacity: 1, launch: waiting })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(InstallHeldError);
  });

  test('a hand start waits at its claim for the lift, or is refused under --no-wait', async () => {
    registerBuiltinProviders();
    const store = createWorkflowStore();
    const messages: string[] = [];
    const platform: IWorkflowPlatform = {
      sendMessage: async (_conversation, message) => {
        messages.push(message);
      },
      getPlatformType: () => 'test',
      getStreamingMode: () => 'batch',
    };
    const deps: WorkflowDeps = {
      store,
      providers: providerRegistry,
      getAgentProvider: () => {
        throw new Error('Unexpected agent work');
      },
      loadConfig: async () => ({
        assistant: 'claude',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      }),
    };
    const start = (noWait: boolean) =>
      executeWorkflow(
        deps,
        platform,
        'conversation',
        root,
        makeTestResolvedWorkflow({
          name: 'hand',
          mutates_checkout: false,
          nodes: [{ id: 'work', bash: 'true' }],
        }),
        '',
        undefined,
        { codebaseId: CODEBASE_ID, noWait }
      );
    await store.setInstallHold({ setBy: 'operator' });

    const refused = await start(true);
    if (refused.success) throw new Error('the start was not refused');
    expect(refused.error).toContain('New runs are held on this install (set by operator');
    expect((await store.getWorkflowRun(String(refused.workflowRunId)))?.status).toBe('cancelled');

    const waited = start(false);
    try {
      for (let tries = 0; !messages.some(m => m.includes('the install hold')); tries++) {
        if (tries > 100) throw new Error('the start did not wait for the hold');
        await Bun.sleep(50);
      }
    } finally {
      await store.liftInstallHold();
    }
    expect(await waited).toMatchObject({ success: true });
  });

  test.each([
    [2, 'admitted'],
    [1, 'skipped'],
  ] as const)(
    'after the lift a held overlap: skip start on capacity %i beside an older queued request is %s',
    async (capacity, outcome) => {
      registerBuiltinProviders();
      setPlatformPolicies([]);
      const project = join(await realpath(root), 'project');
      await mkdir(join(project, '.archon/workflows'), { recursive: true });
      await writeFile(
        join(project, '.archon/workflows/held.yaml'),
        'name: held\ndescription: Held start\nworktree:\n  enabled: false\nnodes:\n  - id: a\n    bash: echo held\n'
      );
      const host = createSqlWorkflowHost();
      const store = host.deps.store;
      await registerFolder(host.records.codebases, project, 'project');
      const direct = (prepared: PreparedWorkflowLaunch) =>
        store.admitResourceStart({
          resource: 'pool',
          capacity,
          hostId: 'host',
          overlap: 'queue',
          launch: prepared,
        });
      const holders = Array.from({ length: capacity }, launch);
      for (const holder of holders) await direct(holder);
      const older = launch();
      expect(await direct(older)).toMatchObject({ status: 'queued' });

      const { hold } = await store.setInstallHold({ setBy: 'operator' });
      const receiptId = await accept(
        store,
        binding(project, { overlap: 'skip', capacity }),
        'issue-1'
      );
      for (const holder of holders) {
        await store.claimPendingWorkflowRun(holder.run.id);
        await store.completeWorkflowRun(holder.run.id, { duration_ms: 1 });
      }
      const started: string[] = [];
      const pass = () =>
        drainResourceStartHost({
          ...host,
          hostId: 'host',
          startAdmitted: async id => {
            started.push(id);
          },
        });
      await pass();
      expect(started).toEqual([]);
      expect(await bindingStatus(receiptId)).toEqual({ status: 'pending', owner: null });
      const codebase = await host.records.codebases.findCodebaseByDefaultCwd(project);
      await getDatabase().withTransaction(query => ensureItem(query, codebase?.id, 'issue-1'));
      const item = async () => {
        const projectKey = (
          await getDatabase().query<{ project_key: string }>(
            'SELECT project_key FROM remote_agent_items WHERE key = $1',
            ['issue-1']
          )
        ).rows[0]?.project_key;
        return readItem(
          attentionQueueSource(store, { findLatestByCodebaseAndWorkingPath: async () => null }),
          String(projectKey),
          'issue-1'
        );
      };
      expect(await item()).toMatchObject({
        hold,
        held: [{ receiptId, bindingId: 'binding', workflow: 'held' }],
      });

      await store.liftInstallHold();
      await pass();
      await pass();
      const disposition = (await store.getStartReceipt(receiptId))?.bindings[0]?.disposition;
      expect(disposition?.status).toBe(outcome);
      expect(await item()).toMatchObject({ hold: null, held: [] });
      expect(started).toEqual(
        outcome === 'admitted' && disposition
          ? [older.run.id, disposition.requestId]
          : [older.run.id]
      );
    }
  );
});
