// @archon-test-isolated
import { afterAll, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { IDatabase } from './adapters/types';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const root = await mkdtemp(join(tmpdir(), 'archon-detach-'));
const db = new SqliteAdapter(join(root, 'scratch.db'));
const other = new SqliteAdapter(join(root, 'scratch.db'));
await other.query('PRAGMA busy_timeout = 0');
let selected: IDatabase = db;
mock.module('./connection', () => ({
  pool: { query: <T>(sql: string, params?: unknown[]) => selected.query<T>(sql, params) },
  getDatabase: () => selected,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
afterAll(async () => {
  await other.close();
  await db.close();
  await removeTempTree(root);
});
const { conversationDetachTests } = await import('../test/conversation-detach');
conversationDetachTests(
  () => ({ db, other }),
  value => {
    selected = value;
  }
);
