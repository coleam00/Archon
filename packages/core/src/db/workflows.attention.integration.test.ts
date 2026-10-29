// @archon-test-isolated
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/run-status';
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
  const { values: attention, degraded } = splitAttentionRead(
    await workflows.listRunsNeedingAttention()
  );
  expect(degraded).toEqual([]);
  expect(attention.map(run => run.id).sort()).toEqual([old, action].sort());
  for (const run of attention) {
    expect(run.origin).toEqual({ userId });
    expect(run.user_id).toBe(userId);
    expect(run.conversation_id).toBeNull();
    expect(run.platform_type).toBeNull();
    expect(run.worker_platform_id).toBeNull();
  }
});

test('unreadable origins are reported beside valid gates without changing stored data', async () => {
  const valid = await workflows.createWorkflowRun({ workflow_name: 'valid', user_message: '' });
  const bad: string[] = [];
  for (const origin of ['private-origin-sentinel-not-json', '[]']) {
    const run = await workflows.createWorkflowRun({ workflow_name: 'corrupt', user_message: '' });
    bad.push(run.id);
    await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
      origin,
      run.id,
    ]);
  }
  const ids = [valid.id, ...bad];
  for (const [index, id] of ids.entries()) {
    await db.query(
      "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1, started_at = $3 WHERE id = $2",
      [
        JSON.stringify({ approval: { nodeId: 'review', message: 'Approve?' } }),
        id,
        new Date(Date.UTC(2026, 9, 2, 0, 0, ids.length - index)).toISOString(),
      ]
    );
  }
  const snapshot = async () => ({
    rows: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
    events: (await db.query('SELECT * FROM remote_agent_workflow_events ORDER BY id')).rows,
  });
  const before = await snapshot();
  const { getLog } = await import('./workflow-run-shared');
  const log = spyOn(getLog(), 'error').mockImplementation(() => {});
  try {
    for (const read of [workflows.listRunsNeedingAttention, workflows.listAttentionQueueRows]) {
      const attention = await read();
      expect(attention).toContainEqual(expect.objectContaining({ id: valid.id }));
      for (const runId of bad) {
        expect(attention).toContainEqual({ type: 'degraded', reason: 'run_unreadable', runId });
      }
      expect(splitAttentionRead(attention).degraded.map(report => report.runId)).toEqual(bad);
      expect(JSON.stringify(attention)).not.toContain('private-origin-sentinel');
    }
    expect(log.mock.calls).toEqual(
      [...bad, ...bad].map(workflowRunId => [
        { workflowRunId },
        'attention_run_normalization_failed',
      ])
    );
    expect(await snapshot()).toEqual(before);
  } finally {
    log.mockRestore();
    for (const id of ids)
      await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
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
    expect(
      splitAttentionRead(await workflows.listRunsNeedingAttention()).values.map(row => row.id)
    ).toContain(run.id);
  } finally {
    await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [run.id]);
  }
});

test.each(
  ['child_workflow', 'fan_out'].flatMap(type =>
    ['private-origin-sentinel-not-json', '[]'].flatMap(origin =>
      workflowRunStatusSchema.options.flatMap(status =>
        [false, true].map(nested => ({ type, origin, nested, status }))
      )
    )
  )
)(
  'batch attention contains unreadable descendants: %j',
  async ({ type, origin, nested, status }) => {
    const { listAttentionQueue } = await import('@archon/workflows/attention-queue');
    const ids: string[] = [];
    async function paused(approval: Record<string, unknown>) {
      const run = await workflows.createWorkflowRun({
        workflow_name: 'mixed-tree',
        user_message: '',
      });
      ids.push(run.id);
      await db.query(
        "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
        [
          JSON.stringify({ approval: { nodeId: 'review', message: 'Approve?', ...approval } }),
          run.id,
        ]
      );
      return run;
    }
    const blocked = (childRunId: string) =>
      type === 'child_workflow' ? { type, childRunId } : { type, childRunIds: [childRunId] };
    const valid = await paused({});
    const child = await paused({});
    await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
      origin,
      child.id,
    ]);
    await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
      status,
      child.id,
    ]);
    const badPaused = status === 'paused' ? child : await paused({});
    if (badPaused !== child) {
      await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
        origin,
        badPaused.id,
      ]);
    }
    const intermediate = nested ? await paused(blocked(child.id)) : child;
    const parent = await paused(blocked(intermediate.id));
    const missing = await paused(blocked(crypto.randomUUID()));
    const snapshot = async () => ({
      rows: (await db.query('SELECT * FROM remote_agent_workflow_runs ORDER BY id')).rows,
      events: (await db.query('SELECT * FROM remote_agent_workflow_events ORDER BY id')).rows,
    });
    const before = await snapshot();
    const { getLog } = await import('./workflow-run-shared');
    const log = spyOn(getLog(), 'error').mockImplementation(() => {});
    const pointRead = mock(workflows.getWorkflowRunForAttention);
    try {
      const result = splitAttentionRead(
        await listAttentionQueue({
          store: {
            listAttentionQueueRows: workflows.listAttentionQueueRows,
            getWorkflowRun: workflows.getWorkflowRun,
            getWorkflowRunForAttention: pointRead,
            getCodebase: async () => null,
          },
          branchOf: async () => null,
        })
      );
      expect(result.values.map(item => item.runId)).toContain(valid.id);
      expect(result.values.find(item => item.runId === missing.id)?.kind).toBe('unreadable');
      expect(result.values.map(item => item.runId)).not.toContain(parent.id);
      if (nested) expect(result.values.map(item => item.runId)).not.toContain(intermediate.id);
      expect(result.degraded).toEqual(
        expect.arrayContaining([
          { type: 'degraded', reason: 'run_unreadable', runId: badPaused.id },
          ...(status === 'paused'
            ? []
            : [
                { type: 'degraded', reason: 'run_unreadable', runId: parent.id },
                ...(nested
                  ? [{ type: 'degraded', reason: 'run_unreadable', runId: intermediate.id }]
                  : []),
              ]),
        ])
      );
      expect(result.degraded).toHaveLength(status === 'paused' ? 1 : nested ? 3 : 2);
      expect(pointRead.mock.calls.length).toBeGreaterThan(0);
      if (status === 'paused')
        expect(pointRead.mock.calls.map(([id]) => id)).not.toContain(child.id);
      if (nested) expect(pointRead.mock.calls.map(([id]) => id)).toContain(intermediate.id);
      expect(log.mock.calls).toEqual([
        [{ workflowRunId: badPaused.id }, 'attention_run_normalization_failed'],
        ...(status === 'paused'
          ? []
          : Array.from(
              { length: nested ? 2 : 1 },
              () => [{ workflowRunId: child.id }, 'attention_run_normalization_failed'] as const
            )),
      ]);
      expect(JSON.stringify(result)).not.toContain('private-origin-sentinel');
      expect(await snapshot()).toEqual(before);
    } finally {
      log.mockRestore();
      for (const id of ids)
        await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
    }
  }
);

test('batch attention preserves unexpected descendant read failures', async () => {
  const { listAttentionQueue } = await import('@archon/workflows/attention-queue');
  const run = await workflows.createWorkflowRun({ workflow_name: 'parent', user_message: '' });
  await db.query(
    "UPDATE remote_agent_workflow_runs SET status = 'paused', metadata = $1 WHERE id = $2",
    [
      JSON.stringify({
        approval: {
          nodeId: 'child',
          message: 'Waiting',
          type: 'child_workflow',
          childRunId: 'unavailable',
        },
      }),
      run.id,
    ]
  );
  const failure = new Error('point read unavailable');
  const rows = await workflows.listAttentionQueueRows();
  const query = spyOn(db, 'query').mockRejectedValueOnce(failure);
  try {
    await expect(
      listAttentionQueue({
        store: {
          listAttentionQueueRows: async () => rows,
          getWorkflowRun: workflows.getWorkflowRun,
          getWorkflowRunForAttention: workflows.getWorkflowRunForAttention,
          getCodebase: async () => null,
        },
        branchOf: async () => null,
      })
    ).rejects.toBe(failure);
  } finally {
    query.mockRestore();
    await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [run.id]);
  }
});
