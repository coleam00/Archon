// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import type { WorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: { query: <T>(sql: string, values?: unknown[]) => db.query<T>(sql, values) },
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const workflows = await import('./workflows');
afterAll(async () => {
  await db.close();
});

test('attention is unpaged, includes originless triggered runs, and excludes machine-owned pauses', async () => {
  const userId = crypto.randomUUID();
  await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [userId]);
  const gate = { nodeId: 'review', message: 'Approve?', pauseId: 'pause' };
  const waitingSince = '2026-10-01T00:00:00.000Z';
  const wait = { owner: 'node' as const, nodeId: 'hold', waitingSince };
  async function paused(
    metadata: Record<string, unknown>,
    startedAt = '2026-10-01T00:00:00.000Z'
  ): Promise<string> {
    const run = await workflows.createWorkflowRun({
      workflow_name: 'triggered',
      user_message: '',
      origin: { userId },
    });
    await db.query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1, started_at = $2 WHERE id = $3",
      [JSON.stringify(metadata), startedAt, run.id]
    );
    return run.id;
  }
  const old = await paused({ approval: gate });
  const action = await paused({ wait: { ...wait, kind: 'attention', message: 'Rotate key' } });
  await paused({ approval: { ...gate, type: 'child_workflow', childRunId: action } });
  await paused({ approval: { ...gate, resolved: 'approved' } });
  await paused({ wait: { ...wait, kind: 'time', resumeAt: '2026-10-02T00:00:00.000Z' } });
  await paused({
    wait: {
      ...wait,
      kind: 'event',
      event: 'deploy.done',
      resumeAt: '2026-10-02T00:00:00.000Z',
    } satisfies WorkflowWaitContext,
  });
  for (let i = 0; i < 51; i++) {
    const run = await workflows.createWorkflowRun({ workflow_name: 'newer', user_message: '' });
    await db.query('UPDATE remote_agent_workflow_runs SET started_at = $1 WHERE id = $2', [
      '2026-10-12T00:00:00.000Z',
      run.id,
    ]);
  }
  expect((await workflows.listDashboardRuns()).runs.map(run => run.id)).not.toContain(old);
  const attention = await workflows.listRunsNeedingAttention();
  expect(attention.map(run => run.id).sort()).toEqual([old, action].sort());
  for (const run of attention) {
    expect(run.origin).toEqual({ userId });
    expect(run.user_id).toBe(userId);
    expect(run.conversation_id).toBeNull();
    expect(run.platform_type).toBeNull();
    expect(run.worker_platform_id).toBeNull();
  }
});

test('a corrupt paused origin cannot hide an independent valid gate', async () => {
  const valid = await workflows.createWorkflowRun({ workflow_name: 'valid', user_message: '' });
  const corrupt = await workflows.createWorkflowRun({ workflow_name: 'corrupt', user_message: '' });
  for (const run of [valid, corrupt]) {
    await db.query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
      [JSON.stringify({ approval: { nodeId: 'review', message: 'Approve?' } }), run.id]
    );
  }
  await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
    'not-json',
    corrupt.id,
  ]);
  try {
    const attention = await workflows.listRunsNeedingAttention();
    expect(attention.map(run => run.id)).toContain(valid.id);
    expect(attention.map(run => run.id)).not.toContain(corrupt.id);
  } finally {
    await db.query('DELETE FROM remote_agent_workflow_runs WHERE id IN ($1, $2)', [
      valid.id,
      corrupt.id,
    ]);
  }
});

test.each([
  {},
  { wait: { kind: 'attention' } },
  { approval: { message: 'missing address' } },
  { approval: { nodeId: '', message: 'empty address' } },
  { approval: { nodeId: 'review', message: 'unknown reason', type: 'future' } },
  { approval: { nodeId: 'child', message: 'missing pointer', type: 'child_workflow' } },
])('unreadable paused records stay visible for repair: %j', async metadata => {
  const run = await workflows.createWorkflowRun({ workflow_name: 'repair', user_message: '' });
  await db.query(
    "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
    [JSON.stringify(metadata), run.id]
  );
  try {
    expect((await workflows.listRunsNeedingAttention()).map(row => row.id)).toContain(run.id);
  } finally {
    await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [run.id]);
  }
});
