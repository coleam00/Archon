/**
 * Integration test: message-query ordering against a REAL bun:sqlite database.
 *
 * SQLite stores `created_at` at 1-second granularity, so consecutive messages
 * routinely share a timestamp. Without a secondary sort key the LIMIT window of
 * `ORDER BY created_at DESC LIMIT n` is undefined for tied rows and can flip
 * between refetches, dropping/duplicating a boundary message (#2218). These
 * tests pin the `id DESC` tie-breaker: tied rows are inserted in an order that
 * differs from their id order, so scan-order luck cannot make them pass.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, test, expect, mock } from 'bun:test';

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
  conversationId = 'conv-1'
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_messages (id, conversation_id, role, content, metadata, created_at)
     VALUES ($1, $2, 'user', $3, $4, $5)`,
    [id, conversationId, `content-${id}`, metadata, createdAt]
  );
}

// Two older messages with distinct timestamps...
await insertMessage('old-1', '2026-01-01 00:00:01');
await insertMessage('old-2', '2026-01-01 00:00:02');
// ...and four messages sharing one created_at, inserted OUT of id order so that
// insertion (scan) order differs from the deterministic id order.
await insertMessage('tie-2', '2026-01-01 00:00:10');
await insertMessage('tie-4', '2026-01-01 00:00:10');
await insertMessage('tie-1', '2026-01-01 00:00:10');
await insertMessage('tie-3', '2026-01-01 00:00:10');

describe('listMessages — deterministic LIMIT window on shared created_at (#2218)', () => {
  test('a LIMIT cutting inside a tie group keeps the highest ids, in stable order', async () => {
    // Newest 3 of the 4 tied rows: id DESC picks tie-4, tie-3, tie-2; reversed
    // to chronological. Without the tie-breaker, membership follows scan order
    // (tie-2, tie-4, tie-1) and this assertion fails.
    const rows = await listMessages('conv-1', 3);
    expect(rows.map(r => r.id)).toEqual(['tie-2', 'tie-3', 'tie-4']);
  });

  test('window membership is identical across refetches', async () => {
    const first = await listMessages('conv-1', 3);
    const second = await listMessages('conv-1', 3);
    expect(second.map(r => r.id)).toEqual(first.map(r => r.id));
  });

  test('distinct timestamps keep the chronological (oldest-first) contract', async () => {
    const rows = await listMessages('conv-1', 10);
    expect(rows.map(r => r.id)).toEqual(['old-1', 'old-2', 'tie-1', 'tie-2', 'tie-3', 'tie-4']);
  });

  test('a limit spanning the tie boundary includes the older distinct row', async () => {
    const rows = await listMessages('conv-1', 5);
    expect(rows.map(r => r.id)).toEqual(['old-2', 'tie-1', 'tie-2', 'tie-3', 'tie-4']);
  });
});

describe('getRecentWorkflowResultMessages — same tie-breaker (#2218)', () => {
  test('a LIMIT cutting inside a tie group keeps the highest ids, newest-first', async () => {
    const meta = '{"workflowResult":{"workflowName":"plan","runId":"run-1"}}';
    await insertMessage('wf-2', '2026-01-01 00:00:20', meta);
    await insertMessage('wf-3', '2026-01-01 00:00:20', meta);
    await insertMessage('wf-1', '2026-01-01 00:00:20', meta);

    const rows = await getRecentWorkflowResultMessages('conv-1', 2);
    expect(rows.map(r => r.id)).toEqual(['wf-3', 'wf-2']);
  });
});
