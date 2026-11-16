// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { readItem } from '@archon/workflows/item-read';
import { listAttentionQueue, readAttentionQueueItem } from '@archon/workflows/attention-queue';
import { executeWorkflow } from '@archon/workflows/executor';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { createWorkflowStore } from '../workflows/store-adapter';
import { attentionQueueSource } from '../operations/attention-queue';
import { WorkflowItemHeldError } from '@archon/workflows/store';
import {
  claimPendingWorkflowRun,
  completeWorkflowRun,
  createWorkflowRun,
  getWorkflowRun,
  resumeWorkflowRun,
} from './workflows';

/**
 * One item is worked by at most one run of a workflow at a time, on every admission path:
 * a binding start (queue and skip), a hand start's claim, a hand start's resource slot, a
 * failed run's resume, and two claims from separate processes at once.
 */

const store = createWorkflowStore();
const CODEBASE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
let root = '';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-item-hold-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  const db = getDatabase();
  await db.query(`INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')`, [
    USER_ID,
  ]);
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, ai_assistant_type) VALUES ($1, 'test', '/tmp/test', 'claude')`,
    [CODEBASE_ID]
  );
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, user_id)
     VALUES ($1, 'test', 'test', $2)`,
    [CONVERSATION_ID, USER_ID]
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

/** A hand start's pending run of `workflow`, on `item` when one is named. */
async function pending(workflow: string, item?: string): Promise<string> {
  const run = await createWorkflowRun({
    id: crypto.randomUUID(),
    workflow_name: workflow,
    codebase_id: CODEBASE_ID,
    user_message: '',
    origin: { conversationId: CONVERSATION_ID },
    ...(item === undefined ? {} : { item_key: item }),
  });
  return run.id;
}

function launch(id: string, workflow: string): PreparedWorkflowLaunch {
  return {
    version: 2,
    run: {
      id,
      workflow_name: workflow,
      origin: { conversationId: CONVERSATION_ID, userId: USER_ID },
      codebase_id: CODEBASE_ID,
      user_message: '',
      metadata: {},
    },
    execution: {
      cwd: `/tmp/test/${id}`,
      conversationId: 'conversation',
      isolation: { kind: 'in-place' },
    },
  };
}

/** A binding start of `workflow` on `item`, prepared and admitted as a host would. */
async function bindingStart(input: {
  workflow: string;
  item: string;
  resource: string;
  overlap: 'queue' | 'skip';
}) {
  const receiptId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await store.acceptStartReceipt({
    receipt: {
      id: receiptId,
      sourceInstanceId: `source-${receiptId}`,
      deliveryId: null,
      contentDigest: 'digest',
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
      itemKey: input.item,
    },
    outcome: 'matched',
    bindings: [
      {
        bindingId: 'binding',
        bindingRevision: '1',
        hostId: 'host',
        runAsUserId: USER_ID,
        resource: input.resource,
        capacity: 5,
        overlap: input.overlap,
        launch: {
          cwd: '/tmp/test',
          workflowName: input.workflow,
          inputs: {},
          isolation: { kind: 'in-place' },
        },
      },
    ],
  });
  expect(
    await store.claimStartBindingPreparation({ receiptId, bindingId: 'binding', ownerId: 'o' })
  ).toBe(true);
  const disposition = await store.completeStartBindingPreparation({
    receiptId,
    bindingId: 'binding',
    ownerId: 'o',
    launch: launch(runId, input.workflow),
  });
  return { runId, disposition };
}

const end = (id: string): Promise<void> => completeWorkflowRun(id, { duration_ms: 1 });

const source = () =>
  attentionQueueSource(store, { findLatestByCodebaseAndWorkingPath: async () => null });

/** The item reads of a later start of `build` on issue-1 and the attention list. */
async function readsOfHeldItem() {
  const holder = (await getWorkflowRun((await store.listWaitedItemHolders())[0]?.id ?? ''))!;
  const item = await store.getItem(String(holder.item_id));
  return {
    read: await readItem(source(), String(item?.projectKey), 'issue-1'),
    queue: await listAttentionQueue(source()),
    single: await readAttentionQueueItem(source(), holder.id),
  };
}

describe('one run of a workflow per item', () => {
  test('a binding start on a held item queues or is skipped by its overlap, and drains after the holder ends', async () => {
    const holder = await pending('build', 'issue-1');
    expect((await claimPendingWorkflowRun(holder))?.status).toBe('running');

    const queued = await bindingStart({
      workflow: 'build',
      item: 'issue-1',
      resource: 'builds',
      overlap: 'queue',
    });
    expect(queued.disposition).toEqual({
      status: 'queued',
      requestId: queued.runId,
      blocker: { kind: 'run', id: holder },
    });
    const skipped = await bindingStart({
      workflow: 'build',
      item: 'issue-1',
      resource: 'builds',
      overlap: 'skip',
    });
    expect(skipped.disposition).toMatchObject({
      status: 'skipped',
      blocker: { kind: 'run', id: holder },
    });
    // Another item, and another workflow on this item, are admitted alongside it.
    for (const other of [
      { workflow: 'build', item: 'issue-2' },
      { workflow: 'review', item: 'issue-1' },
    ])
      expect(
        (await bindingStart({ ...other, resource: 'builds', overlap: 'queue' })).disposition
      ).toMatchObject({ status: 'admitted' });

    // The item read names the run each start is held behind, and, through the host's
    // source, that its owner is gone: this process claimed it and serves no endpoint.
    const item = await store.getItem(String((await getWorkflowRun(holder))?.item_id));
    const read = await readItem(
      attentionQueueSource(store, { findLatestByCodebaseAndWorkingPath: async () => null }),
      String(item?.projectKey),
      'issue-1'
    );
    expect(read?.starts).toEqual([
      {
        requestId: queued.runId,
        workflow: 'build',
        resource: 'builds',
        status: 'queued',
        heldBehind: { runId: holder, workflow: 'build', status: 'running', owner: 'unreachable' },
      },
      {
        requestId: skipped.runId,
        workflow: 'build',
        resource: 'builds',
        status: 'skipped',
        heldBehind: { runId: holder, workflow: 'build', status: 'running', owner: 'unreachable' },
      },
    ]);

    expect(await store.drainResourceStarts({ resource: 'builds', hostId: 'host' })).toEqual([]);
    await end(holder);
    expect(await store.drainResourceStarts({ resource: 'builds', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: queued.runId, runId: queued.runId },
    ]);
  });

  test('a hand start of a workflow with no resource waits at its claim while another run holds the item', async () => {
    const first = await pending('build', 'issue-1');
    const second = await pending('build', 'issue-1');
    // A pending hand start holds nothing, so neither blocks the other before a claim.
    expect((await claimPendingWorkflowRun(first))?.status).toBe('running');
    const held = await claimPendingWorkflowRun(second).catch((error: unknown) => error);
    expect(held).toBeInstanceOf(WorkflowItemHeldError);
    expect(held).toMatchObject({ holderRunId: first, itemKey: 'issue-1', workflow: 'build' });
    expect((await getWorkflowRun(second))?.status).toBe('pending');

    // Runs with no item, on another item, or of another workflow are claimed as before.
    for (const id of [
      await pending('build'),
      await pending('build', 'issue-2'),
      await pending('review', 'issue-1'),
    ])
      expect((await claimPendingWorkflowRun(id))?.status).toBe('running');

    // A paused run still holds its item.
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused' WHERE id = $1",
      [first]
    );
    await expect(claimPendingWorkflowRun(second)).rejects.toBeInstanceOf(WorkflowItemHeldError);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1",
      [first]
    );
    await end(first);
    expect((await claimPendingWorkflowRun(second))?.status).toBe('running');
  });

  test('a hand start of a workflow with a resource is refused a free slot while another run holds the item', async () => {
    const first = await pending('build', 'issue-1');
    const second = await pending('build', 'issue-1');
    const admit = (id: string) =>
      store.admitPendingRun({ resource: 'builds', capacity: 3, launch: launch(id, 'build') });
    expect(await admit(first)).toBeNull();
    // Admitted but not yet claimed, the first run already holds the item.
    expect(await admit(second)).toEqual({ kind: 'run', id: first });
    expect(await admit(await pending('build', 'issue-2'))).toBeNull();
    expect((await claimPendingWorkflowRun(first))?.status).toBe('running');
    await end(first);
    expect(await admit(second)).toBeNull();
  });

  test('a failed run on an item resumes only while no other run of its workflow holds the item', async () => {
    const failed = await pending('build', 'issue-1');
    await claimPendingWorkflowRun(failed);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1",
      [failed]
    );
    const live = await pending('build', 'issue-1');
    expect((await claimPendingWorkflowRun(live))?.status).toBe('running');
    await expect(resumeWorkflowRun(failed)).rejects.toMatchObject({
      name: 'WorkflowItemHeldError',
      holderRunId: live,
    });
    expect((await getWorkflowRun(failed))?.status).toBe('failed');
    await end(live);
    expect((await resumeWorkflowRun(failed)).status).toBe('running');
  });

  test('two claims of one workflow on one item from separate processes admit exactly one', async () => {
    const ids = [await pending('build', 'issue-1'), await pending('build', 'issue-1')];
    await closeDatabase();
    const script = `
      import { claimPendingWorkflowRun } from './packages/core/src/db/workflows.ts';
      import { closeDatabase } from './packages/core/src/db/connection.ts';
      let result;
      try {
        result = (await claimPendingWorkflowRun(process.env.TEST_RUN_ID))?.status ?? 'lost';
      } catch (error) {
        result = error.name;
      }
      console.log(result);
      await closeDatabase();
    `;
    const outputs = await Promise.all(
      ids.map(async id => {
        const child = Bun.spawn(['bun', '-e', script], {
          cwd: join(import.meta.dir, '../../../..'),
          env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: root, TEST_RUN_ID: id },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        expect(code).toBe(0);
        return stdout.trim().split('\n').at(-1);
      })
    );
    expect(outputs.sort()).toEqual(['WorkflowItemHeldError', 'running']);
    resetDatabase();
  });

  test('a holder whose owner is gone is in the attention list, naming its item, while a start waits behind it', async () => {
    const holder = await pending('build', 'issue-1');
    await claimPendingWorkflowRun(holder);
    // Holding with nothing waiting behind it, it is not listed.
    expect(await store.listWaitedItemHolders()).toEqual([]);
    expect(await listAttentionQueue(source())).toEqual([]);
    await pending('build', 'issue-1');
    const { queue, single } = await readsOfHeldItem();
    expect(queue).toEqual([
      expect.objectContaining({
        kind: 'owner_lost',
        observedStatus: 'running',
        item: expect.objectContaining({ key: 'issue-1' }),
        run: expect.objectContaining({ id: holder, workflow: 'build' }),
      }),
    ]);
    expect(single).toMatchObject({ kind: 'owner_lost', ref: holder });
  });

  test('a paused parent whose sub-run lost its owner reads as a lost owner, not as waiting', async () => {
    const parent = await pending('build', 'issue-1');
    await claimPendingWorkflowRun(parent);
    const child = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflow_name: 'sub',
      codebase_id: CODEBASE_ID,
      user_message: '',
      origin: { conversationId: CONVERSATION_ID },
      parent_run_id: parent,
    });
    await claimPendingWorkflowRun(child.id);
    await getDatabase().query(
      `UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $2 WHERE id = $1`,
      [
        parent,
        JSON.stringify({
          approval: { type: 'child_workflow', nodeId: 'sub', message: '', childRunId: child.id },
        }),
      ]
    );
    await pending('build', 'issue-1');
    const { read, queue } = await readsOfHeldItem();
    expect(read?.runs.at(-1)?.heldBehind).toEqual({
      runId: parent,
      workflow: 'build',
      status: 'paused',
      owner: 'unreachable',
    });
    expect(queue).toEqual([
      expect.objectContaining({ kind: 'owner_lost', observedStatus: 'paused' }),
    ]);
  });

  test('a hand start of a workflow with no resource waits for its item, or is refused under --no-wait', async () => {
    registerBuiltinProviders();
    const holder = await pending('build', 'issue-1');
    await claimPendingWorkflowRun(holder);
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
        CONVERSATION_ID,
        root,
        makeTestResolvedWorkflow({
          name: 'build',
          mutates_checkout: false,
          nodes: [{ id: 'work', bash: 'true' }],
        }),
        '',
        undefined,
        { codebaseId: CODEBASE_ID, item: 'issue-1', noWait }
      );
    const refused = await start(true);
    if (refused.success) throw new Error('the start was not refused');
    expect(refused.error).toContain(`Item 'issue-1' is held by run ${holder}`);
    expect((await getWorkflowRun(String(refused.workflowRunId)))?.status).toBe('cancelled');

    const waited = start(false);
    for (
      let tries = 0;
      !messages.some(text => text.includes("Waiting for item 'issue-1'"));
      tries++
    ) {
      if (tries > 100) throw new Error('the start did not wait for its item');
      await Bun.sleep(50);
    }
    await end(holder);
    expect(await waited).toMatchObject({ success: true });
  });
});
