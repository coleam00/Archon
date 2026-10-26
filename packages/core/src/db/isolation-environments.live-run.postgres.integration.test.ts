// @archon-test-isolated
/**
 * Integration tests: isolation environment reads and conditional adoption writes
 * against a REAL Postgres server.
 *
 * The unit suite mocks the pg driver, so the Postgres dialect branch of this
 * SQL never executes there — yet it is shaped differently from the SQLite
 * branch: conversations.isolation_env_id is UUID on Postgres, and an untyped
 * shared $1 compared against text and UUID columns in one OR is rejected at
 * parse time. Only a real server can prove the query runs (#2868).
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test
 * creates and drops its own scratch database; the database named in the URL is
 * only used to reach the server.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';
import { isolationStatusReadTests } from './isolation-status-read-harness';
import { randomUUID } from 'node:crypto';
import { WorktreeRemovalInProgressError } from '@archon/isolation';

const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = `archon_pg_parity_${randomUUID().replaceAll('-', '')}`;

describe.skipIf(!baseUrl)('isolation environments — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let create: typeof import('./isolation-environments').create;
  let withWorktreeRegistration: typeof import('./isolation-environments').withWorktreeRegistration;
  let getById: typeof import('./isolation-environments').getById;
  let updateMetadata: typeof import('./isolation-environments').updateMetadata;
  let getLiveRunOwningEnv: typeof import('./isolation-environments').getLiveRunOwningEnv;
  let markWorktreeDestroyed: typeof import('./isolation-environments').markWorktreeDestroyed;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: baseUrl });
    // The generated name contains only a fixed prefix and hexadecimal UUID characters.
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;

    const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl.toString());

    mock.module('./connection', () => ({
      pool: db,
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));

    ({
      create,
      getLiveRunOwningEnv,
      getById,
      updateMetadata,
      markWorktreeDestroyed,
      withWorktreeRegistration,
    } = await import('./isolation-environments'));
  });

  afterAll(async () => {
    if (db) await db.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  // isolation_environments.codebase_id is NOT NULL with an enforced FK — one
  // parent per env keeps each test's fixtures independent.
  async function createEnv(workflowId: string) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_codebases (name, default_cwd, kind)
       VALUES ('parity', '/tmp/parity', 'folder') RETURNING id`
    );
    return create({
      codebase_id: rows[0].id,
      workflow_type: 'task',
      workflow_id: workflowId,
      working_path: '/tmp/parity',
      branch_name: 'parity-branch' as never,
    });
  }

  isolationStatusReadTests(() => db, createEnv);

  test('removal holds no row lock, refuses a replacement registration and retires after removal', async () => {
    const env = await createEnv('pg-destruction-lock');
    await withWorktreeRegistration(env, async markDestroyed => {
      await db.withTransaction(async query => {
        await query("SET LOCAL lock_timeout = '20ms'");
        await query(
          'UPDATE remote_agent_isolation_environments SET status = status WHERE id = $1',
          [env.id]
        );
      });
      await expect(
        create({
          codebase_id: env.codebase_id,
          workflow_type: env.workflow_type,
          workflow_id: env.workflow_id,
          working_path: '/tmp/other',
          branch_name: 'replacement' as never,
        })
      ).rejects.toBeInstanceOf(WorktreeRemovalInProgressError);
      await markDestroyed();
    });
    expect((await getById(env.id))?.status).toBe('destroyed');
    const remove = mock(async () => undefined);
    await expect(withWorktreeRegistration(env, remove)).rejects.toThrow('changed during cleanup');
    expect(remove).not.toHaveBeenCalled();
  });

  test('legacy conditional adoption rejects a metadata-only replacement and accepts the fresh snapshot', async () => {
    const created = await createEnv('pg-legacy-adoption');
    await db.query(
      'UPDATE remote_agent_isolation_environments SET metadata = $1::jsonb WHERE id = $2',
      [JSON.stringify({ label: 'legacy' }), created.id]
    );
    const observed = (await getById(created.id))!;
    await updateMetadata(created.id, { label: 'replacement' });
    const replacement = (await getById(created.id))!;
    await expect(updateMetadata(created.id, { adopted: true }, observed)).rejects.toThrow(
      'changed during adoption'
    );
    expect(await getById(created.id)).toEqual(replacement);
    expect(replacement.metadata.adopted).toBeUndefined();
    await updateMetadata(replacement.id, { adopted: true }, replacement);
    expect((await getById(created.id))?.metadata).toEqual({ label: 'replacement', adopted: true });
  });

  test('legacy worktree retirement rejects a metadata-only replacement and accepts the fresh snapshot', async () => {
    const created = await createEnv('pg-legacy-retire');
    await db.query(
      'UPDATE remote_agent_isolation_environments SET metadata = $1::jsonb WHERE id = $2',
      [JSON.stringify({ label: 'legacy' }), created.id]
    );
    const observed = (await getById(created.id))!;
    await updateMetadata(created.id, { label: 'replacement' });
    const replacement = (await getById(created.id))!;
    await expect(markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
    expect(await getById(created.id)).toEqual(replacement);
    await markWorktreeDestroyed(replacement);
    expect((await getById(created.id))?.status).toBe('destroyed');
  });

  for (const legacy of [false, true]) {
    test(`retirement of the observed registration is idempotent (legacy: ${legacy})`, async () => {
      const created = await createEnv(`pg-idempotent-${legacy}`);
      if (legacy)
        await db.query(
          "UPDATE remote_agent_isolation_environments SET metadata = '{}'::jsonb WHERE id = $1",
          [created.id]
        );
      const observed = (await getById(created.id))!;
      await markWorktreeDestroyed(observed);
      const destroyed = (await getById(created.id))!;
      await markWorktreeDestroyed(observed);
      await markWorktreeDestroyed(destroyed);
      expect(await getById(created.id)).toEqual(destroyed);
      await expect(updateMetadata(created.id, { adopted: true }, destroyed)).rejects.toThrow(
        'changed during adoption'
      );
      if (legacy) {
        await updateMetadata(created.id, { replaced: true });
        const replacement = await getById(created.id);
        await expect(markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
        expect(await getById(created.id)).toEqual(replacement);
      }
    });
  }

  async function seedConversation(id: string, envId: string | null): Promise<void> {
    // One param per column: $1 doubles as a UUID id and a varchar platform id,
    // and Postgres rejects the shared parameter's inconsistent deduction.
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id)
       VALUES ($1, 'cli', $3, $2::uuid)`,
      [id, envId, id]
    );
  }

  async function seedRun(
    id: string,
    conversationId: string,
    status: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, metadata)
       VALUES ($1, $2, 'parity-wf', 'test', $3, $4::jsonb)`,
      [id, conversationId, status, JSON.stringify(metadata)]
    );
  }

  test('a running run attached through its conversation (UUID route) pins the env', async () => {
    const env = await createEnv('pg-live-conv');
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    await seedConversation(conversationId, env.id);
    await seedRun(runId, conversationId, 'running');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({ id: runId, status: 'running' });
    await expect(getLiveRunOwningEnv(env.id, undefined, runId)).resolves.toBeNull();
  });

  test('a paused run attached through run metadata (sub-run / container stamp) pins the env', async () => {
    const env = await createEnv('pg-live-meta');
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const runId = '44444444-4444-4444-8444-444444444444';
    await seedConversation(conversationId, null);
    await seedRun(runId, conversationId, 'paused', { isolation_env_id: env.id });

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({ id: runId, status: 'paused' });
  });

  test('an env whose conversation holds only terminal runs is NOT pinned (#2868)', async () => {
    const env = await createEnv('pg-terminal-only');
    const conversationId = '55555555-5555-4555-8555-555555555555';
    await seedConversation(conversationId, env.id);
    await seedRun('66666666-6666-4666-8666-666666666666', conversationId, 'completed');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toBeNull();
  });

  // The claimable set is one shared parameter list, but prove it on both dialects
  // so a Postgres-only regression cannot hide behind the SQLite suite.
  test('a failed run still pins the env — it remains resumable', async () => {
    const env = await createEnv('pg-failed-resumable');
    const conversationId = '77777777-7777-4777-8777-777777777777';
    const runId = '88888888-8888-4888-8888-888888888888';
    await seedConversation(conversationId, env.id);
    await seedRun(runId, conversationId, 'failed');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({ id: runId, status: 'failed' });
  });

  test('a failed run stops pinning once settled, or once inactive past the stale window', async () => {
    const env = await createEnv('pg-failed-release');
    const conversationId = '99999999-9999-4999-8999-999999999999';
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seedConversation(conversationId, env.id);
    await seedRun(runId, conversationId, 'failed');
    const stale = { kind: 'stale', staleDays: 7 } as const;

    await expect(getLiveRunOwningEnv(env.id, { kind: 'settled' })).resolves.toBeNull();
    await failedDaysAgo(runId, 1);
    await expect(getLiveRunOwningEnv(env.id, stale)).resolves.toEqual({
      id: runId,
      status: 'failed',
    });
    await failedDaysAgo(runId, 10);
    await expect(getLiveRunOwningEnv(env.id, stale)).resolves.toBeNull();
  });

  test('an old paused run pins the env through every release', async () => {
    const env = await createEnv('pg-paused-release');
    const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await seedConversation(conversationId, env.id);
    await seedRun(runId, conversationId, 'paused');
    await db.query(
      `UPDATE remote_agent_workflow_runs SET started_at = NOW() - INTERVAL '30 days' WHERE id = $1`,
      [runId]
    );
    const paused = { id: runId, status: 'paused' } as const;

    await expect(getLiveRunOwningEnv(env.id, { kind: 'settled' })).resolves.toEqual(paused);
    await expect(getLiveRunOwningEnv(env.id, { kind: 'stale', staleDays: 7 })).resolves.toEqual(
      paused
    );
  });

  async function failedDaysAgo(id: string, days: number): Promise<void> {
    await db.query(
      `UPDATE remote_agent_workflow_runs SET completed_at = NOW() - ($1 || ' days')::INTERVAL WHERE id = $2`,
      [days, id]
    );
  }

  test.each(['pending', 'running', 'paused', 'failed'])(
    'same-path %s run pins environment without a conversation link',
    async status => {
      const { randomUUID } = await import('node:crypto');
      const env = await createEnv(`path-${status}`);
      const conversation = randomUUID();
      const run = randomUUID();
      await seedConversation(conversation, null);
      await seedRun(run, conversation, status);
      await db.query(
        'UPDATE remote_agent_workflow_runs SET codebase_id = $1, working_path = $2 WHERE id = $3',
        [env.codebase_id, env.working_path, run]
      );
      await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({ id: run, status });
    }
  );
});
