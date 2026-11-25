// @archon-test-isolated
/**
 * SQLite timestamp ties must follow insertion order, including at a LIMIT boundary.
 * Isolated because the connection mock uses a real in-memory adapter.
 */
import { afterAll, describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');
afterAll(() => db.close());

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { listMessages, getRecentWorkflowResultMessages } = await import('./messages');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

async function insertMessage(
  id: string,
  createdAt: string,
  metadata = '{}',
  role: 'user' | 'assistant' = 'user'
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_messages (id, conversation_id, role, content, metadata, created_at)
     VALUES ($1, 'conv-1', $5, $2, $3, $4)`,
    [id, `content-${id}`, metadata, createdAt, role]
  );
}

// Two older messages with distinct timestamps...
await insertMessage('old-2', '2026-01-01 00:00:02');
await insertMessage('old-1', '2026-01-01 00:00:01');
// ...and four messages sharing one created_at, inserted OUT of id order so that
// insertion (scan) order differs from the deterministic id order.
await insertMessage('tie-2', '2026-01-01 00:00:10');
await insertMessage('tie-4', '2026-01-01 00:00:10');
await insertMessage('tie-1', '2026-01-01 00:00:10', '{}', 'assistant');
await insertMessage('tie-3', '2026-01-01 00:00:10');

describe('listMessages — insertion order on shared created_at (#5502)', () => {
  test('a LIMIT cutting inside a tie group keeps the last inserted messages', async () => {
    const rows = await listMessages('conv-1', 3);
    expect(rows.map(r => r.id)).toEqual(['tie-4', 'tie-1', 'tie-3']);
  });

  test('a user message precedes its reply when tied IDs oppose insertion order', async () => {
    const rows = await listMessages('conv-1', 3);
    expect(rows.slice(0, 2).map(({ id, role }) => ({ id, role }))).toEqual([
      { id: 'tie-4', role: 'user' },
      { id: 'tie-1', role: 'assistant' },
    ]);
  });

  test('window membership is identical across refetches', async () => {
    const first = await listMessages('conv-1', 3);
    const second = await listMessages('conv-1', 3);
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id));
  });

  test('distinct timestamps keep the chronological (oldest-first) contract', async () => {
    const rows = await listMessages('conv-1', 10);
    expect(rows.map(r => r.id)).toEqual(['old-1', 'old-2', 'tie-2', 'tie-4', 'tie-1', 'tie-3']);
  });

  test('a limit spanning the tie boundary includes the older distinct row', async () => {
    const rows = await listMessages('conv-1', 5);
    expect(rows.map(r => r.id)).toEqual(['old-2', 'tie-2', 'tie-4', 'tie-1', 'tie-3']);
  });
});

describe('getRecentWorkflowResultMessages — insertion order on shared created_at', () => {
  test('a LIMIT cutting inside a tie group keeps the last inserted messages, newest-first', async () => {
    const meta = '{"workflowResult":{"workflowName":"plan","runId":"run-1"}}';
    await insertMessage('wf-2', '2026-01-01 00:00:20', meta);
    await insertMessage('wf-3', '2026-01-01 00:00:20', meta);
    await insertMessage('wf-1', '2026-01-01 00:00:20', meta);

    const rows = await getRecentWorkflowResultMessages('conv-1', 2);
    expect(rows.map(r => r.id)).toEqual(['wf-1', 'wf-3']);
  });
});
