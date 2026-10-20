// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { toBranchName } from '@archon/git';
import { FAN_OUT_CANCEL_REASONS } from '@archon/workflows/store';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDatabaseType: () => 'sqlite',
  getDialect: () => sqliteDialect,
}));
const { create, markWorktreeDestroyed } = await import('./isolation-environments');
const { resumeWorkflowRun, recoverCancelledFanOutRun } = await import('./workflow-run-resume');
afterAll(() => db.close());

for (const state of ['failed', 'paused', 'running', ...FAN_OUT_CANCEL_REASONS] as const) {
  for (const active of [false, true]) {
    test(`${state} ${active ? 'uses an active replacement' : 'refuses a retired checkout'}`, async () => {
      const codebaseId = randomUUID();
      const runId = randomUUID();
      await db.query(
        `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
         VALUES ($1, $1, '/tmp/checkout', 'folder')`,
        [codebaseId]
      );
      const env = await create({
        codebase_id: codebaseId,
        workflow_type: 'task',
        workflow_id: randomUUID(),
        working_path: '/tmp/checkout',
        branch_name: toBranchName('checkout'),
      });
      await markWorktreeDestroyed(env);
      if (active) {
        await create({
          codebase_id: codebaseId,
          workflow_type: 'task',
          workflow_id: randomUUID(),
          working_path: env.working_path,
          branch_name: toBranchName(env.branch_name),
        });
      }
      await db.query(
        `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
         VALUES ($1, 'cli', $1)`,
        [runId]
      );
      const recovery = FAN_OUT_CANCEL_REASONS.some(reason => reason === state);
      await db.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, working_path, workflow_name, user_message, status, metadata, last_activity_at)
         VALUES ($1, $1, $2, $3, 'checkout', 'test', $4, $5, '2000-01-01')`,
        [
          runId,
          codebaseId,
          env.working_path,
          recovery ? 'cancelled' : state,
          JSON.stringify({
            error: 'prior failure',
            ...(recovery ? { cancelled_reason: state } : {}),
          }),
        ]
      );
      const activate = () =>
        recovery ? recoverCancelledFanOutRun(runId) : resumeWorkflowRun(runId);
      if (active) {
        expect((await activate()).status).toBe('running');
      } else {
        const before = await db.query('SELECT * FROM remote_agent_workflow_runs WHERE id = $1', [
          runId,
        ]);
        await expect(activate()).rejects.toThrow('checkout is no longer active');
        expect(
          await db.query('SELECT * FROM remote_agent_workflow_runs WHERE id = $1', [runId])
        ).toEqual(before);
        const events = await db.query(
          'SELECT * FROM remote_agent_workflow_events WHERE workflow_run_id = $1',
          [runId]
        );
        expect(events.rows).toHaveLength(0);
      }
    });
  }
}
