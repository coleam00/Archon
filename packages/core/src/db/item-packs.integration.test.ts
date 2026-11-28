// @archon-test-isolated
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import { listItemPacks } from './items';
import { createWorkflowRun } from './workflows';

const CODEBASE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
let root = '';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-item-packs-'));
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

const runOn = (item: string, metadata?: Record<string, unknown>) =>
  createWorkflowRun({
    id: crypto.randomUUID(),
    workflow_name: 'w',
    codebase_id: CODEBASE_ID,
    user_message: '',
    origin: { conversationId: CONVERSATION_ID },
    item_key: item,
    ...(metadata === undefined ? {} : { metadata }),
  });

test('a run whose stored metadata is not JSON counts for no pack, and the rest still list', async () => {
  await runOn('a', { dispatch: { pack: 'pack-a' } });
  const broken = await runOn('b');
  // SQLite keeps metadata as TEXT, so nothing stopped a writer leaving this behind.
  await getDatabase().query('UPDATE remote_agent_workflow_runs SET metadata = $1 WHERE id = $2', [
    'not json',
    broken.id,
  ]);
  expect([...(await listItemPacks()).values()]).toEqual([['pack-a']]);
});
