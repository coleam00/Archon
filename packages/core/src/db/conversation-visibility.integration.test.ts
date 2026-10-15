// @archon-test-isolated
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: { query: <T>(sql: string, values?: unknown[]) => db.query<T>(sql, values) },
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const conversations = await import('./conversations');
const workflows = await import('./workflows');

afterAll(async () => {
  await db.close();
});

async function seed(
  id: string,
  platformType: string,
  userId: string | null,
  hidden = false
): Promise<void> {
  await db.query(
    'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, user_id, title, hidden) VALUES ($1, $2, $1, $3, $1, $4)',
    [id, platformType, userId, hidden ? 1 : 0]
  );
}

async function run(conversationId: string, parentConversationId: string | null): Promise<void> {
  await db.query(
    'INSERT INTO remote_agent_workflow_runs (workflow_name, conversation_id, parent_conversation_id, user_message) VALUES ($1, $2, $3, $4)',
    ['demo', conversationId, parentConversationId, 'go']
  );
}

beforeAll(async () => {
  for (const id of ['alice', 'bob']) {
    await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [id]);
  }
  await seed('alice-web', 'web', 'alice');
  await seed('alice-cli', 'cli', 'alice');
  await seed('bob-web', 'web', 'bob');
  await seed('ownerless-web', 'web', null);
  await seed('team-slack', 'slack', null);
  await seed('alice-worker', 'web', 'alice', true);
  await seed('cli-run', 'cli', null);
  await run('alice-worker', 'alice-web');
  await run('cli-run', null);
  // A foreground run executes in the chat it was started from.
  await run('bob-web', 'bob-web');
});

const ids = (rows: readonly { id: string }[]): string[] => rows.map(r => r.id).sort();

describe('listConversations visibility', () => {
  test("an owner sees their own web and CLI conversations and other platforms, never another user's", async () => {
    expect(ids(await conversations.listConversations({ kind: 'owner', userId: 'alice' }))).toEqual([
      'alice-cli',
      'alice-web',
      'team-slack',
    ]);
  });

  test('ownerless operator conversations match nobody', async () => {
    const listed = ids(await conversations.listConversations({ kind: 'owner', userId: 'bob' }));
    expect(listed).toEqual(['bob-web', 'team-slack']);
  });

  test('`all` lists every visible conversation', async () => {
    expect(ids(await conversations.listConversations({ kind: 'all' }))).toEqual([
      'alice-cli',
      'alice-web',
      'bob-web',
      'cli-run',
      'ownerless-web',
      'team-slack',
    ]);
  });
});

describe('isRunTranscriptConversation', () => {
  test("a hidden worker and a CLI run's conversation are transcripts", async () => {
    expect(await workflows.isRunTranscriptConversation('alice-worker')).toBe(true);
    expect(await workflows.isRunTranscriptConversation('cli-run')).toBe(true);
  });

  test('a chat a foreground run executed in stays a private chat', async () => {
    expect(await workflows.isRunTranscriptConversation('bob-web')).toBe(false);
  });

  test('a chat that only launched a worker run is not a transcript', async () => {
    expect(await workflows.isRunTranscriptConversation('alice-web')).toBe(false);
  });
});
