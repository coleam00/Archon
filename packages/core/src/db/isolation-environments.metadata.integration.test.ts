/**
 * Integration test: isolation-environment `metadata` normalization against a REAL
 * bun:sqlite database.
 *
 * The mock-based isolation-environments.test.ts injects rows straight through a
 * faked `pool`, so it can *simulate* the SQLite string shape but never proves that
 * a real SqliteAdapter actually hands `metadata` back as a JSON STRING. That exact
 * dialect mismatch (SQLite TEXT string vs Postgres parsed JSONB object) leaked a
 * container during Phase B smoke testing. This runs the store's read/write path
 * against a real SqliteAdapter so the round trip is exercised end-to-end: the raw
 * column comes back as a string, and the store's `normalizeEnvironmentRow` boundary
 * turns it into a real object for every consumer.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with isolation-environments.test.ts's
 * fake.
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
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { create, getById, listByCodebase, updateMetadata, findLatestByCodebaseAndWorkingPath } =
  await import('./isolation-environments');

// isolation_environments.codebase_id is NOT NULL with an enforced FK — seed a parent.
await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
   VALUES ('cb-1', 'ops-client', '/tmp/ops-client', 'folder')`,
  []
);

describe('isolation-environments metadata — real SQLite round trip', () => {
  test('SQLite stores metadata as a JSON string, but the store returns a parsed object', async () => {
    const metadata = {
      containerName: 'archon-abc',
      volume: 'archon-abc-upper',
      overlayMode: 'fuse',
    };
    const created = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'wf-1',
      provider: 'container',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
      metadata,
    });

    // `create` returns through the same normalize boundary → already an object.
    expect(typeof created.metadata).toBe('object');
    expect(created.metadata).toEqual(metadata);

    // Prove the RAW column is a STRING on SQLite (this is the whole reason the
    // normalization exists — a naive `SELECT *` reader would get a string here).
    const raw = await db.query<{ metadata: unknown }>(
      'SELECT metadata FROM remote_agent_isolation_environments WHERE id = $1',
      [created.id]
    );
    expect(typeof raw.rows[0]?.metadata).toBe('string');

    // The store's getById normalizes that string into a real object.
    const fetched = await getById(created.id);
    expect(typeof fetched?.metadata).toBe('object');
    expect(fetched?.metadata).toEqual(metadata);
    // The container-leak field is now readable (was `undefined` off the string).
    expect((fetched?.metadata as { containerName?: string }).containerName).toBe('archon-abc');
  });

  test('list reads normalize metadata for every row', async () => {
    const rows = await listByCodebase('cb-1');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.metadata).toBe('object');
    }
  });

  test('a corrupt metadata string normalizes to {} rather than throwing the read', async () => {
    const created = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'wf-corrupt',
      provider: 'container',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
      metadata: { containerName: 'archon-corrupt' },
    });
    // Simulate a corrupt column (external tampering / a bad write).
    await db.query('UPDATE remote_agent_isolation_environments SET metadata = $1 WHERE id = $2', [
      '{not valid json',
      created.id,
    ]);

    const fetched = await getById(created.id);
    expect(fetched?.metadata).toEqual({});
  });

  test('updateMetadata merge round-trips through the string column and reads back as an object', async () => {
    const created = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'wf-merge',
      provider: 'container',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
      metadata: { containerName: 'archon-merge' },
    });
    await updateMetadata(created.id, { volume: 'archon-merge-upper' });

    const fetched = await getById(created.id);
    expect(fetched?.metadata).toEqual({
      containerName: 'archon-merge',
      volume: 'archon-merge-upper',
    });
  });

  test('historical lookup selects the newest estate at or before the run cutoff', async () => {
    const rows = [
      ['history-old', 'wf-history-old', 'old-branch', '2026-08-25 08:00:00'],
      ['history-intended', 'wf-history-intended', 'intended-branch', '2026-08-25 09:00:00'],
      ['history-later', 'wf-history-later', 'later-branch', '2026-08-25 11:00:00'],
    ] as const;
    for (const [id, workflowId, branch, createdAt] of rows) {
      await db.query(
        `INSERT INTO remote_agent_isolation_environments
           (id, codebase_id, workflow_type, workflow_id, provider, working_path,
            branch_name, status, created_at, metadata)
         VALUES ($1, 'cb-1', 'task', $2, 'worktree', '/tmp/shared-estate',
                 $3, 'destroyed', $4, '{}')`,
        [id, workflowId, branch, createdAt]
      );
    }

    const selected = await findLatestByCodebaseAndWorkingPath(
      'cb-1',
      '/tmp/shared-estate',
      new Date('2026-08-25T10:00:00.000Z')
    );

    expect(selected?.id).toBe('history-intended');
    expect(selected?.branch_name).toBe('intended-branch');
  });
});
