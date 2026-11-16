// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { readItem } from '@archon/workflows/item-read';
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

    // The item read names the run each start is held behind.
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
        heldBehind: { runId: holder, workflow: 'build', status: 'running', owner: null },
      },
      {
        requestId: skipped.runId,
        workflow: 'build',
        resource: 'builds',
        status: 'skipped',
        heldBehind: { runId: holder, workflow: 'build', status: 'running', owner: null },
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
});
