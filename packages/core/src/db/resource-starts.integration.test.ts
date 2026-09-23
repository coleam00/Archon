import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import {
  acceptStartReceipt,
  admitResourceStart,
  completeStartBindingPreparation,
  drainResourceStarts,
  getResourceStartRequest,
  getStartReceipt,
  SourceReceiptDigestConflictError,
  withdrawQueuedResourceStart,
} from './resource-starts';
import {
  addResourceSlotHolder,
  liveResourceSlotHolders,
  lockResourceSlot,
  ResourceSlotCapacityConflictError,
} from './resource-slots';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { claimPendingWorkflowRun, resumeWorkflowRun, WorkflowResourceBusyError } from './workflows';

let root = '';
const CODEBASE_ID = '33333333-3333-4333-8333-333333333333';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;

function launch(id: string): PreparedWorkflowLaunch {
  return {
    version: 1,
    run: {
      id,
      workflow_name: 'test',
      conversation_id: '11111111-1111-4111-8111-111111111111',
      codebase_id: CODEBASE_ID,
      user_message: '',
      metadata: {},
      user_id: '22222222-2222-4222-8222-222222222222',
    },
    execution: {
      cwd: '/tmp/test',
      conversationId: 'conversation',
      isolation: { kind: 'in-place' },
    },
  };
}

async function holdSqliteWriterLock(): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import { SqliteAdapter } from './packages/core/src/db/adapters/sqlite.ts';
       import { join } from 'node:path';
       const db = new SqliteAdapter(join(process.env.ARCHON_HOME, 'archon.db'));
       await db.query('BEGIN IMMEDIATE');
       console.log('locked');
       await Bun.sleep(200);
       await db.query('COMMIT');
       await db.close();`,
    ],
    {
      cwd: join(import.meta.dir, '../../../..'),
      env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const reader = child.stdout.getReader();
  let output = '';
  while (!output.includes('locked')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  expect(output).toContain('locked');
  return child;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-resource-start-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  const db = getDatabase();
  await db.query(`INSERT INTO remote_agent_users (id, display_name) VALUES ($1, 'Test')`, [
    '22222222-2222-4222-8222-222222222222',
  ]);
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd, ai_assistant_type) VALUES ($1, 'test', '/tmp/test', 'claude')`,
    [CODEBASE_ID]
  );
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, user_id)
     VALUES ($1, 'test', 'test', $2)`,
    ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
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

describe('durable resource starts', () => {
  test('paused ownership skips same-resource requests while unrelated resources progress', async () => {
    const owner = crypto.randomUUID();
    const skipped = crypto.randomUUID();
    const independent = crypto.randomUUID();
    await admitResourceStart({
      resource: 'shared',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(owner),
    });
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused', started_at = '2000-01-01' WHERE id = $1",
      [owner]
    );
    expect(
      await admitResourceStart({
        resource: 'shared',
        capacity: 1,
        hostId: 'other-host',
        overlap: 'skip',
        launch: launch(skipped),
      })
    ).toEqual({ status: 'skipped', requestId: skipped, blocker: { kind: 'run', id: owner } });
    expect(await drainResourceStarts({ resource: 'shared', hostId: 'other-host' })).toEqual([]);
    expect(
      await admitResourceStart({
        resource: 'independent',
        capacity: 1,
        hostId: 'host',
        overlap: 'skip',
        launch: launch(independent),
      })
    ).toEqual({ status: 'admitted', requestId: independent, runId: independent });
    expect(
      (
        await getDatabase().query('SELECT id FROM remote_agent_workflow_runs WHERE id = $1', [
          skipped,
        ])
      ).rowCount
    ).toBe(0);
  });

  test('cold drain retains an admitted pending blocker and abandonment fences a delayed launcher', async () => {
    const stranded = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await admitResourceStart({
      resource: 'crash',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(stranded),
    });
    await admitResourceStart({
      resource: 'crash',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(queued),
    });
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET started_at = '2000-01-01' WHERE id = $1",
      [stranded]
    );
    expect(await drainResourceStarts({ resource: 'crash', hostId: 'host' })).toEqual([]);
    expect((await getResourceStartRequest(stranded))?.runStatus).toBe('pending');
    // The operator's explicit terminal action, not elapsed time, releases ownership.
    const { cancelWorkflowRun } = await import('./workflows');
    await cancelWorkflowRun(stranded);
    expect(await claimPendingWorkflowRun(stranded)).toBeNull();
    expect(await drainResourceStarts({ resource: 'crash', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: queued, runId: queued },
    ]);
    const claims = await Promise.all([
      claimPendingWorkflowRun(queued),
      claimPendingWorkflowRun(queued),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  test('FIFO follows admission order when timestamps tie and UUIDs sort in reverse', async () => {
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const first = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    for (const id of [owner, first, second]) {
      await admitResourceStart({
        resource: 'fifo',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: launch(id),
      });
    }
    await getDatabase().query(
      "UPDATE remote_agent_resource_start_requests SET created_at = '2026-09-22 10:00:00'"
    );
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [owner]
    );
    expect(await drainResourceStarts({ resource: 'fifo', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: first, runId: first },
    ]);
    expect((await getResourceStartRequest(second))?.status).toBe('queued');
  });

  test('admits one run, keeps the next request out of workflow rows, then drains it', async () => {
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(
      await admitResourceStart({
        resource: 'repo:one',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: launch(firstId),
      })
    ).toEqual({ status: 'admitted', requestId: firstId, runId: firstId });
    expect(await getResourceStartRequest(firstId)).toMatchObject({
      status: 'admitted',
      runStatus: 'pending',
    });
    expect(
      await admitResourceStart({
        resource: 'repo:one',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue',
        launch: launch(secondId),
      })
    ).toEqual({ status: 'queued', requestId: secondId, blocker: { kind: 'run', id: firstId } });
    expect(await getResourceStartRequest(secondId)).toMatchObject({
      blocker: { kind: 'run', id: firstId },
      blockerRunStatus: 'pending',
    });
    expect(
      (
        await getDatabase().query('SELECT id FROM remote_agent_workflow_runs WHERE id = $1', [
          secondId,
        ])
      ).rowCount
    ).toBe(0);

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [firstId]
    );
    expect(await drainResourceStarts({ resource: 'repo:one', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: secondId, runId: secondId },
    ]);
  });

  test('deduplicates trusted delivery identity and rejects digest conflicts', async () => {
    const receipt = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sourceInstanceId: 'github:installation:1',
      deliveryId: 'delivery-1',
      contentDigest: 'sha256:first',
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
    };
    expect(await acceptStartReceipt({ receipt, outcome: 'unmatched', bindings: [] })).toEqual({
      receiptId: receipt.id,
      replay: false,
    });
    expect(
      await acceptStartReceipt({
        receipt: { ...receipt, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        outcome: 'unmatched',
        bindings: [],
      })
    ).toEqual({ receiptId: receipt.id, replay: true });
    await expect(
      acceptStartReceipt({
        receipt: { ...receipt, contentDigest: 'sha256:other' },
        outcome: 'unmatched',
        bindings: [],
      })
    ).rejects.toBeInstanceOf(SourceReceiptDigestConflictError);
    expect((await getStartReceipt(receipt.id))?.deliveryId).toBe('delivery-1');
  });

  test('preparation completion and admission share one commit', async () => {
    const receiptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const blockerId = 'abababab-abab-4bab-8bab-abababababab';
    await admitResourceStart({
      resource: 'repo:two',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(blockerId),
    });
    await acceptStartReceipt({
      receipt: {
        id: receiptId,
        sourceInstanceId: 'timer:one',
        deliveryId: null,
        contentDigest: 'local',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [
        {
          bindingId: 'binding',
          bindingRevision: '1',
          hostId: 'host',
          runAsUserId: '22222222-2222-4222-8222-222222222222',
          resource: 'repo:two',
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: '/tmp/test',
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
    const { claimStartBindingPreparation } = await import('./resource-starts');
    expect(
      await claimStartBindingPreparation({ receiptId, bindingId: 'binding', ownerId: 'owner' })
    ).toBe(true);
    expect(
      await completeStartBindingPreparation({
        receiptId,
        bindingId: 'binding',
        ownerId: 'owner',
        launch: launch(runId),
      })
    ).toEqual({
      status: 'queued',
      requestId: runId,
      blocker: { kind: 'run', id: blockerId },
    });
    expect((await getStartReceipt(receiptId))?.bindings[0]).toMatchObject({
      status: 'complete',
      requestStatus: 'queued',
      disposition: {
        status: 'queued',
        requestId: runId,
        blocker: { kind: 'run', id: blockerId },
      },
    });

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [blockerId]
    );
    await drainResourceStarts({ resource: 'repo:two', hostId: 'host' });
    expect((await getStartReceipt(receiptId))?.bindings[0]).toMatchObject({
      requestStatus: 'admitted',
      disposition: { status: 'admitted', requestId: runId, runId },
    });
  });

  test('queued withdrawal waits for a cross-process SQLite writer', async () => {
    const ownerId = 'abababab-abab-4bab-8bab-abababababab';
    const queuedId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    await admitResourceStart({
      resource: 'repo:contended-withdrawal',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(ownerId),
    });
    await admitResourceStart({
      resource: 'repo:contended-withdrawal',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(queuedId),
    });

    const writer = await holdSqliteWriterLock();
    try {
      expect((await withdrawQueuedResourceStart(queuedId))?.run.id).toBe(queuedId);
    } finally {
      expect(await writer.exited).toBe(0);
    }
  });

  test('binding completion waits for a cross-process SQLite writer', async () => {
    const receiptId = 'dededede-dede-4ede-8ede-dededededede';
    const preparedId = 'efefefef-efef-4fef-8fef-efefefefefef';
    await acceptStartReceipt({
      receipt: {
        id: receiptId,
        sourceInstanceId: 'timer:contended',
        deliveryId: null,
        contentDigest: 'local',
        receivedAt: new Date().toISOString(),
        occurredAt: null,
        sourceActor: null,
      },
      outcome: 'matched',
      bindings: [
        {
          bindingId: 'binding',
          bindingRevision: '1',
          hostId: 'host',
          runAsUserId: '22222222-2222-4222-8222-222222222222',
          resource: 'repo:contended-preparation',
          capacity: 1,
          overlap: 'queue',
          launch: {
            cwd: '/tmp/test',
            workflowName: 'test',
            inputs: {},
            isolation: { kind: 'in-place' },
          },
        },
      ],
    });
    const { claimStartBindingPreparation } = await import('./resource-starts');
    expect(
      await claimStartBindingPreparation({ receiptId, bindingId: 'binding', ownerId: 'owner' })
    ).toBe(true);

    const writer = await holdSqliteWriterLock();
    try {
      expect(
        await completeStartBindingPreparation({
          receiptId,
          bindingId: 'binding',
          ownerId: 'owner',
          launch: launch(preparedId),
        })
      ).toEqual({ status: 'admitted', requestId: preparedId, runId: preparedId });
    } finally {
      expect(await writer.exited).toBe(0);
    }
  });

  test('serializes same-resource admission across independent SQLite processes', async () => {
    await closeDatabase();
    const script = `
      import { admitResourceStart } from './packages/core/src/db/resource-starts.ts';
      import { closeDatabase } from './packages/core/src/db/connection.ts';
      const disposition = await admitResourceStart(JSON.parse(process.env.TEST_START_INTENT));
      console.log(JSON.stringify(disposition));
      await closeDatabase();
    `;
    const starts = [
      {
        resource: 'repo:process',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue' as const,
        launch: launch('12121212-1212-4212-8212-121212121212'),
      },
      {
        resource: 'repo:process',
        capacity: 1,
        hostId: 'host',
        overlap: 'queue' as const,
        launch: launch('34343434-3434-4434-8434-343434343434'),
      },
    ];
    const children = starts.map(intent =>
      Bun.spawn(['bun', '-e', script], {
        cwd: join(import.meta.dir, '../../../..'),
        env: {
          ...process.env,
          DATABASE_URL: '',
          ARCHON_HOME: root,
          TEST_START_INTENT: JSON.stringify(intent),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    );
    const outputs = await Promise.all(
      children.map(async child => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { status: string };
      })
    );
    expect(outputs.map(output => output.status).sort()).toEqual(['admitted', 'queued']);
    resetDatabase();
  });

  test('a paused owner can continue while requests queue behind its held resource', async () => {
    const owner = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await admitResourceStart({
      resource: 'paused',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(owner),
    });
    await admitResourceStart({
      resource: 'paused',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(queued),
    });
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused' WHERE id = $1",
      [owner]
    );
    expect((await resumeWorkflowRun(owner)).status).toBe('running');
    expect((await getResourceStartRequest(queued))?.status).toBe('queued');
  });

  test('busy resume preserves its scheduled cursor and later reacquires the resource', async () => {
    const firstId = '56565656-5656-4656-8656-565656565656';
    const secondId = '78787878-7878-4878-8878-787878787878';
    await admitResourceStart({
      resource: 'repo:resume',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(firstId),
    });
    expect((await claimPendingWorkflowRun(firstId))?.status).toBe('running');
    await admitResourceStart({
      resource: 'repo:resume',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(secondId),
    });
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-09-22T10:00:00.000Z',
      deadlineAt: '2026-09-22T11:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
    };
    await getDatabase().query(
      `UPDATE remote_agent_workflow_runs SET status = 'failed', metadata = $2 WHERE id = $1`,
      [firstId, JSON.stringify({ scheduled_resume: scheduled })]
    );
    await expect(
      resumeWorkflowRun(firstId, {
        kind: 'quota',
        attempt: scheduled.attempt,
        resumeAt: scheduled.resumeAt,
      })
    ).rejects.toMatchObject({ blocker: { kind: 'request', id: secondId } });
    const beforeDrain = await getDatabase().query<{ metadata: string }>(
      'SELECT metadata FROM remote_agent_workflow_runs WHERE id = $1',
      [firstId]
    );
    expect(
      JSON.parse(beforeDrain.rows[0]?.metadata ?? '{}').scheduled_resume.triggeredAt
    ).toBeUndefined();
    expect(await drainResourceStarts({ resource: 'repo:resume', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: secondId, runId: secondId },
    ]);
    expect((await claimPendingWorkflowRun(secondId))?.status).toBe('running');

    await expect(
      resumeWorkflowRun(firstId, {
        kind: 'quota',
        attempt: scheduled.attempt,
        resumeAt: scheduled.resumeAt,
      })
    ).rejects.toBeInstanceOf(WorkflowResourceBusyError);
    const stillFailed = await getDatabase().query<{ status: string; metadata: string }>(
      'SELECT status, metadata FROM remote_agent_workflow_runs WHERE id = $1',
      [firstId]
    );
    expect(stillFailed.rows[0]?.status).toBe('failed');
    expect(
      JSON.parse(stillFailed.rows[0]?.metadata ?? '{}').scheduled_resume.triggeredAt
    ).toBeUndefined();

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [secondId]
    );
    expect(
      (
        await resumeWorkflowRun(firstId, {
          kind: 'quota',
          attempt: scheduled.attempt,
          resumeAt: scheduled.resumeAt,
        })
      ).status
    ).toBe('running');
  });

  test('a capacity-2 slot admits two holders, queues the third, and drains it on release', async () => {
    const [first, second, third] = [
      '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
      '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
    ];
    const admit = (id: string): ReturnType<typeof admitResourceStart> =>
      admitResourceStart({
        resource: 'pool',
        capacity: 2,
        hostId: 'host',
        overlap: 'queue',
        launch: launch(id),
      });
    expect(await admit(first)).toEqual({ status: 'admitted', requestId: first, runId: first });
    expect(await admit(second)).toEqual({ status: 'admitted', requestId: second, runId: second });
    expect(await admit(third)).toEqual({
      status: 'queued',
      requestId: third,
      blocker: { kind: 'run', id: first },
    });
    expect(await drainResourceStarts({ resource: 'pool', hostId: 'host' })).toEqual([]);

    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
      [second]
    );
    expect(await drainResourceStarts({ resource: 'pool', hostId: 'host' })).toEqual([
      { status: 'admitted', requestId: third, runId: third },
    ]);
    expect((await claimPendingWorkflowRun(third))?.status).toBe('running');
  });

  test('a request that declares a different capacity for a resource fails without a row', async () => {
    const owner = crypto.randomUUID();
    const conflicting = crypto.randomUUID();
    await admitResourceStart({
      resource: 'fixed',
      capacity: 1,
      hostId: 'host',
      overlap: 'queue',
      launch: launch(owner),
    });
    await expect(
      admitResourceStart({
        resource: 'fixed',
        capacity: 3,
        hostId: 'host',
        overlap: 'queue',
        launch: launch(conflicting),
      })
    ).rejects.toBeInstanceOf(ResourceSlotCapacityConflictError);
    expect(await getResourceStartRequest(conflicting)).toBeNull();
    expect(
      (await getDatabase().query('SELECT capacity FROM remote_agent_resource_slots')).rows
    ).toEqual([{ capacity: 1 }]);
  });
});

describe('resource slot holders', () => {
  test('release follows the run state and looks the run up by its primary key', async () => {
    const live = crypto.randomUUID();
    const ended = crypto.randomUUID();
    const vanished = crypto.randomUUID();
    const db = getDatabase();
    for (const [id, status] of [
      [live, 'running'],
      [ended, 'completed'],
    ] as const) {
      await db.query(
        `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status)
         VALUES ($1, '11111111-1111-4111-8111-111111111111', 'test', '', $2)`,
        [id, status]
      );
    }

    const statements: { sql: string; params?: unknown[] }[] = [];
    const holders = await db.withTransaction(async query => {
      await lockResourceSlot(query, 'slot');
      for (const id of [live, ended, vanished]) {
        await addResourceSlotHolder(query, 'slot', { kind: 'run', id });
      }
      const recording: typeof query = (sql, params) => {
        statements.push({ sql, params });
        return query(sql, params);
      };
      return await liveResourceSlotHolders(recording, 'slot');
    });
    expect(holders).toEqual([{ kind: 'run', id: live }]);

    // The adapter runs EXPLAIN as a mutation and drops its rows, so read the plan directly.
    const release = statements.find(statement => statement.sql.includes('DELETE'));
    if (!release) throw new Error('no release statement');
    const raw = new Database(join(root, 'archon.db'), { readonly: true });
    let plan: string[];
    try {
      plan = raw
        .query<{ detail: string }, SQLQueryBindings[]>(
          `EXPLAIN QUERY PLAN ${release.sql.replace(/\$(\d+)/g, '?$1')}`
        )
        .all(...((release.params ?? []) as SQLQueryBindings[]))
        .map(row => row.detail);
    } finally {
      raw.close();
    }
    // The runs table only grows; its lookup must use the primary-key index, not a scan.
    expect(plan).toContainEqual(expect.stringMatching(/^SEARCH w USING .*INDEX/));
    expect(plan).not.toContainEqual(expect.stringMatching(/^SCAN w\b/));
  });
});
