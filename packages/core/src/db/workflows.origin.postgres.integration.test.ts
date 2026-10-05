import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Pool } from 'pg';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { WORKFLOW_ORIGIN_ANCHOR_ID } from './workflow-origin-anchor';
import { persistScopeKey } from '@archon/workflows/schemas/workflow-node-session';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const scratchName = `archon_origin_${crypto.randomUUID().replaceAll('-', '')}`;

describe.skipIf(!baseUrl)('workflow origin on scratch PostgreSQL', () => {
  let admin: Pool;
  let db: PostgresAdapter;
  let workflows: typeof import('./workflows');

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${scratchName}`;
    db = new PostgresAdapter(scratchUrl.toString());
    mock.module('./connection', () => ({
      pool: db,
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));
    workflows = await import('./workflows');
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  test('fresh origin-free rows retain the FK without exposing the anchor', async () => {
    const run = await workflows.createWorkflowRun({ workflow_name: 'local', user_message: '' });
    expect(run.origin).toBeNull();
    expect(run.conversation_id).toBeNull();
    expect(persistScopeKey(run)).toBeUndefined();
    const raw = await db.query<{ origin: unknown; conversation_id: string }>(
      'SELECT origin, conversation_id FROM remote_agent_workflow_runs WHERE id = $1',
      [run.id]
    );
    expect(raw.rows[0]).toEqual({ origin: {}, conversation_id: WORKFLOW_ORIGIN_ANCHOR_ID });
    const listed = await workflows.listDashboardRuns();
    expect(listed.runs[0]?.platform_type).toBeNull();
    expect(listed.runs[0]?.worker_platform_id).toBeNull();
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1", [
      run.id,
    ]);
    expect((await workflows.resumeWorkflowRun(run.id)).origin).toBeNull();
  });

  test('legacy NULL and explicit empty origin differ; supplied origin survives resume', async () => {
    const conversationId = crypto.randomUUID();
    await db.query(
      "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'cli', $2)",
      [conversationId, conversationId]
    );
    const legacyId = crypto.randomUUID();
    await db.query(
      "INSERT INTO remote_agent_workflow_runs (id, workflow_name, conversation_id, user_message) VALUES ($1, 'old', $2, '')",
      [legacyId, conversationId]
    );
    expect((await workflows.getWorkflowRun(legacyId))?.origin).toEqual({ conversationId });
    await db.query("UPDATE remote_agent_workflow_runs SET origin = '{}' WHERE id = $1", [legacyId]);
    expect((await workflows.getWorkflowRun(legacyId))?.origin).toBeNull();
    const userId = crypto.randomUUID();
    await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [userId]);
    const origin = {
      conversationId,
      userId,
      platform: { type: 'cli', conversationId: 'platform-id' },
    };
    const run = await workflows.createWorkflowRun({
      workflow_name: 'chat',
      user_message: '',
      origin,
    });
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1", [
      run.id,
    ]);
    expect((await workflows.resumeWorkflowRun(run.id)).origin).toEqual(origin);
  });

  test('JSONB null and malformed shapes fail clearly on read', async () => {
    const run = await workflows.createWorkflowRun({ workflow_name: 'corrupt', user_message: '' });
    for (const origin of ['null', '[]', '{"conversationId":42}']) {
      await db.query('UPDATE remote_agent_workflow_runs SET origin = $1::jsonb WHERE id = $2', [
        origin,
        run.id,
      ]);
      await expect(workflows.getWorkflowRun(run.id)).rejects.toThrow();
      await expect(workflows.failWorkflowRun(run.id, 'failure')).rejects.toThrow();
      expect(await workflows.getWorkflowRunStatus(run.id)).toBe('pending');
    }
    await db.query("UPDATE remote_agent_workflow_runs SET origin = '{}' WHERE id = $1", [run.id]);
    await workflows.failWorkflowRun(run.id, 'failure');
    expect(await workflows.getWorkflowRunStatus(run.id)).toBe('failed');
  });

  test('an insert failure rolls back anchor creation and conflicting platform identity fails', async () => {
    // The tests own this scratch database; remove rows before probing creation rollback.
    await db.query('DELETE FROM remote_agent_workflow_runs');
    await db.query('DELETE FROM remote_agent_conversations WHERE id = $1', [
      WORKFLOW_ORIGIN_ANCHOR_ID,
    ]);
    await expect(
      workflows.createWorkflowRun({
        workflow_name: 'invalid',
        user_message: '',
        codebase_id: crypto.randomUUID(),
      })
    ).rejects.toThrow();
    expect(
      (
        await db.query('SELECT id FROM remote_agent_conversations WHERE id = $1', [
          WORKFLOW_ORIGIN_ANCHOR_ID,
        ])
      ).rows
    ).toHaveLength(0);
    await db.query(
      "INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id) VALUES ('archon', 'workflow-store-originless')"
    );
    await expect(
      workflows.createWorkflowRun({ workflow_name: 'local', user_message: '' })
    ).rejects.toThrow('Conflicting');
  });
});
