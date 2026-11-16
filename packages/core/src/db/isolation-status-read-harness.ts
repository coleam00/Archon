import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import type { IsolationEnvironmentRow } from '@archon/isolation';

export function isolationStatusReadTests(
  getDb: () => IDatabase,
  createEnv: (name: string) => Promise<IsolationEnvironmentRow>
): void {
  async function seedRun(envId: string, status: string): Promise<string> {
    const db = getDb();
    const conversationId = randomUUID();
    const id = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ($1, 'cli', $2)`,
      [conversationId, conversationId]
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, metadata)
       VALUES ($1, $2, 'isolation-status', 'test', $3, $4)`,
      [id, conversationId, status, JSON.stringify({ isolation_env_id: envId })]
    );
    return id;
  }

  test('isolation reads preserve absence and every supported status', async () => {
    const db = getDb();
    const { getLiveRunOwningEnv } = await import('./isolation-environments');
    const { getRunByIsolationEnvId } = await import('./workflow-run-reads');
    const env = await createEnv(randomUUID());
    expect(await getLiveRunOwningEnv(env.id)).toBeNull();
    expect(await getRunByIsolationEnvId(env.id)).toBeNull();
    const id = await seedRun(env.id, 'pending');
    for (const status of workflowRunStatusSchema.options) {
      await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
        status,
        id,
      ]);
      expect((await getRunByIsolationEnvId(env.id))?.status).toBe(status);
    }
  });

  test('environment lookup returns the newest run and inventory returns all matching runs', async () => {
    const db = getDb();
    const { getRunByIsolationEnvId, getRunIdsByIsolationEnvId } = await import(
      './workflow-run-reads'
    );
    const env = await createEnv(randomUUID());
    expect(await getRunIdsByIsolationEnvId(env.id)).toEqual([]);
    const failed = await seedRun(env.id, 'failed');
    const completed = await seedRun(env.id, 'completed');
    const otherEnv = await createEnv(randomUUID());
    await seedRun(otherEnv.id, 'completed');
    for (const [id, date] of [
      [failed, '2020-01-02'],
      [completed, '2020-01-03'],
    ]) {
      await db.query('UPDATE remote_agent_workflow_runs SET started_at = $1 WHERE id = $2', [
        date,
        id,
      ]);
    }
    expect((await getRunByIsolationEnvId(env.id))?.id).toBe(completed);
    expect(await getRunIdsByIsolationEnvId(env.id)).toEqual([failed, completed].sort());
  });

  test('cleanup keeps a checkout handed to a waiting start, and only while it waits', async () => {
    const db = getDb();
    const { getCleanupRunLock } = await import('../services/cleanup/run-lock');
    const { toRepoPath } = await import('@archon/git');
    const env = await createEnv(randomUUID());
    const lock = async () =>
      getCleanupRunLock(
        { id: env.id, working_path: env.working_path, branch_name: null },
        toRepoPath('/tmp/no-repo'),
        { kind: 'merged' }
      );
    const from = await seedRun(env.id, 'completed');
    const receiptId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_start_receipts (id, source_instance_id, content_digest, received_at, outcome)
       VALUES ($1, 'run-ended', 'digest', $2, 'matched')`,
      [receiptId, new Date().toISOString()]
    );
    const checkoutFrom = { runId: from, branch: 'task-build', commit: 'a'.repeat(40) };
    await db.query(
      `INSERT INTO remote_agent_start_receipt_bindings (receipt_id, binding_id, checkout_from, preparation_status)
       VALUES ($1, 'next', $2, 'pending')`,
      [receiptId, JSON.stringify(checkoutFrom)]
    );
    const setBinding = (status: string) =>
      db.query(
        'UPDATE remote_agent_start_receipt_bindings SET preparation_status = $1 WHERE receipt_id = $2',
        [status, receiptId]
      );

    for (const status of ['pending', 'preparing', 'failed']) {
      await setBinding(status);
      expect(await lock()).toMatchObject({
        kind: 'locked',
        blocker: { reason: 'pending_handoff', waitingFor: 'preparation', fromRunId: from },
      });
    }
    for (const status of ['rejected', 'unmatched']) {
      await setBinding(status);
      expect(await lock()).toEqual({ kind: 'free' });
    }

    // Prepared and queued behind capacity: the request still waits for a slot.
    await setBinding('complete');
    expect(await lock()).toEqual({ kind: 'free' });
    const requestId = randomUUID();
    await db.query(
      'INSERT INTO remote_agent_resource_slots (resource_key, capacity) VALUES ($1, 1) ON CONFLICT DO NOTHING',
      ['handoff-test']
    );
    await db.query(
      `INSERT INTO remote_agent_resource_start_requests (id, resource_key, host_id, overlap_policy, status, launch, receipt_id, binding_id)
       VALUES ($1, 'handoff-test', 'host', 'queue', 'queued', '{}', $2, 'next')`,
      [requestId, receiptId]
    );
    const queued = await lock();
    expect(queued).toMatchObject({
      kind: 'locked',
      blocker: { reason: 'pending_handoff', waitingFor: 'capacity', requestId },
    });
    expect(queued.kind === 'locked' && queued.blocker.display).toContain(
      `archon trigger withdraw ${requestId}`
    );
    const setRequest = (status: string) =>
      db.query('UPDATE remote_agent_resource_start_requests SET status = $1 WHERE id = $2', [
        status,
        requestId,
      ]);
    for (const status of ['withdrawn', 'skipped']) {
      await setRequest(status);
      expect(await lock()).toEqual({ kind: 'free' });
    }

    // Admitted: its run holds the checkout before its lane records an environment.
    await setRequest('admitted');
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ($1, 'cli', $2)`,
      [conversationId, conversationId]
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, metadata)
       VALUES ($1, $2, 'next-stage', 'test', 'pending', $3)`,
      [
        requestId,
        conversationId,
        JSON.stringify({ checkout_handoff: { ...checkoutFrom, lane: 'continue' } }),
      ]
    );
    expect(await lock()).toMatchObject({
      kind: 'locked',
      blocker: { reason: 'live_run', runId: requestId, runStatus: 'pending' },
    });
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1", [
      requestId,
    ]);
    expect(await lock()).toEqual({ kind: 'free' });
  });

  test.each(['unexpected', ''])(
    'isolation reads reject %j without changing persisted state',
    async status => {
      const db = getDb();
      const { getLiveRunOwningEnv } = await import('./isolation-environments');
      const { getRunByIsolationEnvId, WorkflowStatusReadError } = await import(
        './workflow-run-reads'
      );
      const env = await createEnv(randomUUID());
      const id = await seedRun(env.id, status);
      const snapshot = async () =>
        Promise.all([
          db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id'),
          db.query('SELECT * FROM remote_agent_isolation_environments ORDER BY id'),
          db.query('SELECT * FROM remote_agent_workflow_events ORDER BY id'),
        ]);
      const before = await snapshot();
      for (const read of [
        () => getLiveRunOwningEnv(env.id),
        () => getLiveRunOwningEnv(env.id, { kind: 'settled' }),
        () => getLiveRunOwningEnv(env.id, { kind: 'stale', staleDays: 7 }),
        () => getRunByIsolationEnvId(env.id),
      ]) {
        const result = read();
        await expect(result).rejects.toBeInstanceOf(WorkflowStatusReadError);
        await expect(result).rejects.toMatchObject({ workflowRunId: id, storedStatus: status });
        expect(await snapshot()).toEqual(before);
      }
      expect(await getLiveRunOwningEnv(env.id, undefined, id)).toBeNull();
    }
  );
}
