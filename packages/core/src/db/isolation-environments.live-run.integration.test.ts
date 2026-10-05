/**
 * Integration test: getLiveRunOwningEnv against a REAL bun:sqlite database.
 *
 * The mock-based isolation-environments.test.ts asserts the SQL string, not its
 * behavior. This file proves the actual query semantics that decide whether
 * `isolation cleanup` may remove an environment (#2868): a non-terminal run pins
 * an env through either attachment route, while historical conversation rows and
 * terminal runs never do.
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

const { create, getLiveRunOwningEnv } = await import('./isolation-environments');

// isolation_environments.codebase_id is NOT NULL with an enforced FK — seed a parent.
await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
   VALUES ('cb-1', 'ops-client', '/tmp/ops-client', 'folder')`,
  []
);

async function seedConversation(id: string, envId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id)
     VALUES ($1, 'cli', $1, $2)`,
    [id, envId]
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
     VALUES ($1, $2, 'test-wf', 'test', $3, $4)`,
    [id, conversationId, status, JSON.stringify(metadata)]
  );
}

/** Same as seedRun with an explicit started_at, to order two runs on one env. */
async function seedRunAt(
  id: string,
  conversationId: string,
  status: string,
  startedAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status, metadata, started_at)
     VALUES ($1, $2, 'test-wf', 'test', $3, '{}', $4)`,
    [id, conversationId, status, startedAt]
  );
}

describe('getLiveRunOwningEnv — real SQLite behavior', () => {
  test('an env whose conversation holds only terminal runs is NOT pinned (#2868)', async () => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'task-historical',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
    });
    await seedConversation('conv-historical', env.id);
    await seedRun('run-done', 'conv-historical', 'completed');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toBeNull();
  });

  test('a running run attached through its conversation pins the env', async () => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'task-live-conv',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
    });
    await seedConversation('conv-live', env.id);
    await seedRun('run-old', 'conv-live', 'completed');
    await seedRun('run-active', 'conv-live', 'running');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({
      id: 'run-active',
      status: 'running',
    });
  });

  test('a paused run attached through run metadata (sub-run / container stamp) pins the env', async () => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'task-live-meta',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
    });
    await seedConversation('conv-detached', null);
    await seedRun('run-paused', 'conv-detached', 'paused', { isolation_env_id: env.id });

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({
      id: 'run-paused',
      status: 'paused',
    });
  });

  test('a conversation with no runs never pins the env', async () => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'task-no-runs',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
    });
    await seedConversation('conv-empty', env.id);

    await expect(getLiveRunOwningEnv(env.id)).resolves.toBeNull();
  });

  // 'failed' is terminal but resumable. Releasing its env lets cleanup run
  // `git branch -D` on the only branch `--resume`/`--adopt` can attach to, so a
  // failed run keeps its pin while completed and cancelled runs let go.
  test('a failed run still pins the env — it remains resumable', async () => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'task-failed',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
    });
    await seedConversation('conv-failed', env.id);
    await seedRun('run-failed', 'conv-failed', 'failed');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({
      id: 'run-failed',
      status: 'failed',
    });
  });

  test.each(['completed', 'cancelled'])(
    'a %s run does not pin the env — it can never claim it back',
    async status => {
      const env = await create({
        codebase_id: 'cb-1',
        workflow_type: 'task',
        workflow_id: `task-${status}`,
        working_path: '/tmp/ops-client',
        branch_name: '' as never,
      });
      await seedConversation(`conv-${status}`, env.id);
      await seedRun(`run-${status}`, `conv-${status}`, status);

      await expect(getLiveRunOwningEnv(env.id)).resolves.toBeNull();
    }
  );

  // The container reaper used to take the newest run row and only then check its
  // status, so a newer terminal run hid an older claimable one. Filtering status
  // inside the query is what makes that impossible.
  test('a newer terminal run does not shadow an older claimable one', async () => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: 'task-shadowed',
      working_path: '/tmp/ops-client',
      branch_name: '' as never,
    });
    await seedConversation('conv-shadowed', env.id);
    await seedRunAt('run-still-paused', 'conv-shadowed', 'paused', '2026-08-01T00:00:00.000Z');
    await seedRunAt('run-newer-done', 'conv-shadowed', 'completed', '2026-08-02T00:00:00.000Z');

    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({
      id: 'run-still-paused',
      status: 'paused',
    });
  });
});

test.each(['pending', 'running', 'paused', 'failed'])(
  'same-path %s run pins environment without a conversation link',
  async status => {
    const env = await create({
      codebase_id: 'cb-1',
      workflow_type: 'task',
      workflow_id: `path-${status}`,
      working_path: `/tmp/path-${status}`,
      branch_name: '' as never,
    });
    const conversation = `path-conv-${status}`;
    const run = `path-run-${status}`;
    await seedConversation(conversation, null);
    await seedRun(run, conversation, status);
    await db.query(
      'UPDATE remote_agent_workflow_runs SET codebase_id = $1, working_path = $2 WHERE id = $3',
      ['cb-1', env.working_path, run]
    );
    await expect(getLiveRunOwningEnv(env.id)).resolves.toEqual({ id: run, status });
    await expect(getLiveRunOwningEnv(env.id, [run])).resolves.toBeNull();
  }
);
