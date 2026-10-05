import { afterAll, describe, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { WORKFLOW_ORIGIN_ANCHOR_ID } from './workflow-origin-anchor';
import { persistScopeKey } from '@archon/workflows/schemas/workflow-node-session';
import { trackTempRoots } from '@archon/paths/test-utils';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: { query: <T>(sql: string, values?: unknown[]) => db.query<T>(sql, values) },
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const workflows = await import('./workflows');
const conversations = await import('./conversations');
const messages = await import('./messages');
const trackTempRoot = trackTempRoots();
afterAll(async () => {
  await db.close();
});

async function seedConversation(id = crypto.randomUUID()): Promise<string> {
  await db.query(
    'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $1)',
    [id, 'cli']
  );
  return id;
}
async function oldWriter(id: string, conversationId: string): Promise<void> {
  await db.query(
    'INSERT INTO remote_agent_workflow_runs (id, workflow_name, conversation_id, user_message) VALUES ($1, $2, $3, $4)',
    [id, 'legacy', conversationId, 'old writer']
  );
}

describe('optional workflow origin', () => {
  test('public creation has no origin, no scope, and one hidden physical anchor', async () => {
    const run = await workflows.createWorkflowRun({
      workflow_name: 'local',
      user_message: 'hello',
    });
    const second = await workflows.createWorkflowRun({
      workflow_name: 'local',
      user_message: 'again',
    });
    expect(run.origin).toBeNull();
    expect(run.conversation_id).toBeNull();
    expect(persistScopeKey(run)).toBeUndefined();
    expect(second.conversation_id).toBeNull();
    const physical = await db.query<{ conversation_id: string; origin: string }>(
      'SELECT conversation_id, origin FROM remote_agent_workflow_runs WHERE id = $1',
      [run.id]
    );
    expect(physical.rows[0]).toEqual({ conversation_id: WORKFLOW_ORIGIN_ANCHOR_ID, origin: '{}' });
    expect(await conversations.listConversations()).toEqual([]);
    const listed = await workflows.listDashboardRuns();
    expect(listed.runs[0]?.conversation_id).toBeNull();
    expect(listed.runs[0]?.platform_type).toBeNull();
    expect(listed.runs[0]?.worker_platform_id).toBeNull();
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1", [
      run.id,
    ]);
    expect((await workflows.resumeWorkflowRun(run.id)).origin).toBeNull();
  });

  test('chat origin owns projections and resume preserves it', async () => {
    const conversationId = await seedConversation();
    const parentConversationId = await seedConversation();
    const userId = crypto.randomUUID();
    await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [userId]);
    const origin = {
      userId,
      conversationId,
      parentConversationId,
    };
    const run = await workflows.createWorkflowRun({
      workflow_name: 'chat',
      user_message: '',
      origin,
    });
    expect(run.origin).toEqual(origin);
    expect(run.conversation_id).toBe(conversationId);
    expect(run.user_id).toBe(userId);
    expect(persistScopeKey(run)).toBe(parentConversationId);
    await workflows.claimPendingWorkflowRun(run.id);
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1", [
      run.id,
    ]);
    expect((await workflows.resumeWorkflowRun(run.id)).origin).toEqual(origin);
  });

  test('legacy SQL NULL synthesizes origin but explicit empty origin does not', async () => {
    const conversationId = await seedConversation();
    const id = crypto.randomUUID();
    await oldWriter(id, conversationId);
    await db.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = $1", [id]);
    const parentConversationId = await seedConversation();
    const userId = crypto.randomUUID();
    await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [userId]);
    await db.query(
      'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1, user_id = $2 WHERE id = $3',
      [parentConversationId, userId, id]
    );
    expect((await workflows.getWorkflowRun(id))?.origin).toEqual({
      conversationId,
      parentConversationId,
      userId,
    });
    expect(
      (await workflows.getRunningWorkflows()).find(run => run.id === id)?.conversation_id
    ).toBe(conversationId);
    await db.query("UPDATE remote_agent_workflow_runs SET origin = '{}' WHERE id = $1", [id]);
    expect((await workflows.getWorkflowRun(id))?.origin).toBeNull();
    expect((await workflows.getWorkflowRun(id))?.conversation_id).toBeNull();
    expect(
      (await workflows.getRunningWorkflows()).find(run => run.id === id)?.conversation_id
    ).toBeNull();
  });

  test('corrupt and JSON-null origins fail instead of losing provenance', async () => {
    const run = await workflows.createWorkflowRun({ workflow_name: 'corrupt', user_message: '' });
    for (const origin of ['{broken', 'null', '[]', '{"conversationId":3}']) {
      await db.query('UPDATE remote_agent_workflow_runs SET origin = $1 WHERE id = $2', [
        origin,
        run.id,
      ]);
      await expect(workflows.getWorkflowRun(run.id)).rejects.toThrow();
    }
  });

  test('the anchor cannot be edited, deleted, read as history or supplied as origin', async () => {
    await expect(
      conversations.getOrCreateConversation('archon', 'workflow-store-originless')
    ).rejects.toThrow('reserved');
    await expect(
      conversations.updateConversation(WORKFLOW_ORIGIN_ANCHOR_ID, { hidden: false })
    ).rejects.toThrow('reserved');
    await expect(
      conversations.updateConversationTitle(WORKFLOW_ORIGIN_ANCHOR_ID, 'title')
    ).rejects.toThrow('reserved');
    await expect(conversations.softDeleteConversation(WORKFLOW_ORIGIN_ANCHOR_ID)).rejects.toThrow(
      'reserved'
    );
    await expect(
      messages.addMessage(WORKFLOW_ORIGIN_ANCHOR_ID, 'assistant', 'hello')
    ).rejects.toThrow('reserved');
    await expect(messages.listMessages(WORKFLOW_ORIGIN_ANCHOR_ID)).rejects.toThrow('reserved');
    await expect(
      workflows.createWorkflowRun({
        workflow_name: 'reserved',
        user_message: '',
        origin: { conversationId: WORKFLOW_ORIGIN_ANCHOR_ID },
      })
    ).rejects.toThrow('reserved');
  });

  // The anchor's platform ID is fixed and public, so every lookup by a caller-supplied
  // platform ID must treat it as absent rather than expose origin-free runs.
  test('the anchor platform ID resolves to no run and no conversation', async () => {
    const run = await workflows.createWorkflowRun({
      workflow_name: 'private',
      user_message: 'not for platform lookups',
    });
    expect(run.origin).toBeNull();
    expect(
      await workflows.getWorkflowRunByWorkerPlatformId('workflow-store-originless')
    ).toBeNull();
    expect(
      await conversations.findConversationByPlatformId('workflow-store-originless')
    ).toBeNull();
    expect(
      await conversations.getConversationByPlatformId('archon', 'workflow-store-originless')
    ).toBeNull();
  });

  test('a conflicting reserved identity is rejected and failed insertion rolls back the anchor', async () => {
    await db.close();
    db = new SqliteAdapter(':memory:');
    await expect(
      workflows.createWorkflowRun({
        workflow_name: 'invalid',
        user_message: '',
        codebase_id: 'missing',
      })
    ).rejects.toThrow();
    expect((await db.query('SELECT id FROM remote_agent_conversations')).rows).toHaveLength(0);
    await db.query(
      "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, 'cli', 'real-thread')",
      [WORKFLOW_ORIGIN_ANCHOR_ID]
    );
    await expect(
      workflows.createWorkflowRun({ workflow_name: 'local', user_message: '' })
    ).rejects.toThrow('Conflicting');
  });

  test('a shipped SQLite schema upgrades and still accepts an older writer', async () => {
    await db.close();
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-origin-upgrade-')));
    const path = join(root, 'archon.db');
    const raw = new Database(path);
    raw.exec(await readFile(join(import.meta.dir, 'fixtures/sqlite-vintages/v0.11.0.sql'), 'utf8'));
    raw.close();
    db = new SqliteAdapter(path);
    const conversationId = await seedConversation();
    const legacyId = crypto.randomUUID();
    await oldWriter(legacyId, conversationId);
    expect((await workflows.getWorkflowRun(legacyId))?.origin).toEqual({ conversationId });
    const run = await workflows.createWorkflowRun({ workflow_name: 'upgraded', user_message: '' });
    expect(run.origin).toBeNull();
    const columns = await db.query<{ name: string; notnull: number }>(
      'SELECT name, "notnull" FROM pragma_table_info(\'remote_agent_workflow_runs\')'
    );
    expect(columns.rows.find(column => column.name === 'conversation_id')?.notnull).toBe(1);
    expect(columns.rows.find(column => column.name === 'origin')?.notnull).toBe(0);
  });
});
