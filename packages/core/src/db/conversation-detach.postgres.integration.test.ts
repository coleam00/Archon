// @archon-test-isolated
import { afterAll, beforeAll, describe, mock } from 'bun:test';
import { Pool } from 'pg';
import type { IDatabase } from './adapters/types';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;

const scratchName = `archon_detach_${crypto.randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let db: PostgresAdapter;
let other: PostgresAdapter;
let selected: IDatabase;
mock.module('./connection', () => ({
  pool: { query: <T>(sql: string, params?: unknown[]) => selected.query<T>(sql, params) },
  getDatabase: () => selected,
  getDialect: () => postgresDialect,
  getDatabaseType: () => 'postgresql',
}));
const { conversationDetachTests } = await import('../test/conversation-detach');

describe.skipIf(!baseUrl)('conversation detach on PostgreSQL', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${scratchName}`;
    db = new PostgresAdapter(url.toString());
    selected = db;
    await db.query('SELECT 1');
    other = new PostgresAdapter(url.toString());
    await other.query('SELECT 1');
  }, 120000);
  afterAll(async () => {
    await other?.close();
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 120000);
  conversationDetachTests(
    () => ({ db, other }),
    value => {
      selected = value;
    }
  );
});
