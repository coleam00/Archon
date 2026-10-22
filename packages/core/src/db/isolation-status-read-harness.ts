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

  test('environment lookup returns the newest run', async () => {
    const db = getDb();
    const { getRunByIsolationEnvId } = await import('./workflow-run-reads');
    const env = await createEnv(randomUUID());
    const failed = await seedRun(env.id, 'failed');
    const completed = await seedRun(env.id, 'completed');
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
