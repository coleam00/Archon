// @archon-test-isolated
/**
 * Integration tests: worktree removal claims against a REAL SQLite file.
 *
 * `withWorktreeRegistration` must run `remove()` with no write transaction open, so a
 * second connection can write during git removal, while the committed claim still
 * refuses a replacement registration and only a provably dead owner's claim is released.
 *
 * Runs in its own `bun test` invocation: it mock.module's ./connection with a real adapter.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
  type IsolationEnvironmentRow,
} from '@archon/isolation';

const paths = { ...(await import('@archon/paths')) };
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

const root = mkdtempSync(join(tmpdir(), 'removal-claim-'));
const dbPath = join(root, 'archon.db');
const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(dbPath);

const connection = { ...(await import('./connection')) };
mock.module('./connection', () => ({
  ...connection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { create, getById, markWorktreeDestroyed, updateMetadata, withWorktreeRegistration } =
  await import('./isolation-environments');
const { claimPendingWorkflowRun } = await import('./workflow-run-transitions');

afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
   VALUES ('cb-1', 'claims', '/tmp/claims', 'folder')`,
  []
);

function createEnv(workflowId: string, workingPath = `/tmp/claims/${workflowId}`) {
  return create({
    codebase_id: 'cb-1',
    workflow_type: 'task',
    workflow_id: workflowId,
    working_path: workingPath,
    branch_name: 'claims-branch' as never,
  });
}

async function seedPendingRun(workingPath: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
     VALUES ($1, 'cli', $1)`,
    [id]
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, metadata, codebase_id, working_path)
     VALUES ($1, $1, 'claims-wf', 'test', 'pending', '{}', 'cb-1', $2)`,
    [id, workingPath]
  );
  return id;
}

async function setClaim(env: IsolationEnvironmentRow, owner: Record<string, unknown>) {
  await db.query(
    `UPDATE remote_agent_isolation_environments SET metadata = json_set(metadata, '$.${WORKTREE_REMOVAL_OWNER}', json($1)) WHERE id = $2`,
    [JSON.stringify(owner), env.id]
  );
}

describe('worktree removal claims on SQLite', () => {
  test('removal holds no write lock, and the claim is gone after retirement', async () => {
    const env = await createEnv('no-lock');
    await withWorktreeRegistration(env, async markDestroyed => {
      const other = new Database(dbPath);
      try {
        other.run('PRAGMA busy_timeout = 0');
        other.run('BEGIN IMMEDIATE');
        other.run('UPDATE remote_agent_isolation_environments SET status = status WHERE id = ?', [
          env.id,
        ]);
        other.run('COMMIT');
      } finally {
        other.close();
      }
      await markDestroyed();
    });
    const retired = await getById(env.id);
    expect(retired?.status).toBe('destroyed');
    expect(retired?.metadata).toEqual(env.metadata);
  });

  test('a same-workflow registration during removal is refused, not published', async () => {
    const env = await createEnv('replacement');
    await withWorktreeRegistration(env, async markDestroyed => {
      await expect(createEnv('replacement', '/tmp/claims/elsewhere')).rejects.toBeInstanceOf(
        WorktreeRemovalInProgressError
      );
      await markDestroyed();
    });
    expect((await getById(env.id))?.status).toBe('destroyed');
    const fresh = await createEnv('replacement', '/tmp/claims/elsewhere');
    expect(fresh.status).toBe('active');
    expect(fresh.id).not.toBe(env.id);
  });

  test('adoption, other retirement and run activation refuse while the claim is held', async () => {
    const env = await createEnv('fenced');
    const runId = await seedPendingRun(env.working_path);
    await expect(
      withWorktreeRegistration(env, async () => {
        await expect(markWorktreeDestroyed(env)).rejects.toBeInstanceOf(
          WorktreeRemovalInProgressError
        );
        await expect(updateMetadata(env.id, { adopted: true }, env)).rejects.toBeInstanceOf(
          WorktreeRemovalInProgressError
        );
        expect(await claimPendingWorkflowRun(runId)).toBeNull();
        throw new Error('removal failed');
      })
    ).rejects.toThrow('removal failed');
    expect((await getById(env.id))?.metadata).toEqual(env.metadata);
    expect((await claimPendingWorkflowRun(runId))?.status).toBe('running');
  });

  test('run activation refuses while a checkout shared with another registration is removed', async () => {
    const env = await createEnv('shared-removed', '/tmp/claims/shared');
    await createEnv('shared-sibling', '/tmp/claims/shared');
    const runId = await seedPendingRun(env.working_path);
    await withWorktreeRegistration(env, async markDestroyed => {
      expect(await claimPendingWorkflowRun(runId)).toBeNull();
      await markDestroyed();
    });
    expect((await claimPendingWorkflowRun(runId))?.status).toBe('running');
  });

  test('a failed removal releases the claim and leaves the registration active', async () => {
    const env = await createEnv('failed');
    await expect(
      withWorktreeRegistration(env, async markDestroyed => {
        await markDestroyed();
        throw new Error('filesystem removal incomplete');
      })
    ).rejects.toThrow('filesystem removal incomplete');
    const kept = await getById(env.id);
    expect(kept?.status).toBe('active');
    expect(kept?.metadata).toEqual(env.metadata);
    await withWorktreeRegistration(kept!, markDestroyed => markDestroyed());
    expect((await getById(env.id))?.status).toBe('destroyed');
  });

  test('a dead owner claim is released, while another host claim refuses untouched', async () => {
    const stale = await createEnv('stale-claim');
    await setClaim(stale, { host: hostname(), pid: process.pid, instance: 'previous-incarnation' });
    await withWorktreeRegistration(stale, markDestroyed => markDestroyed());
    const retired = await getById(stale.id);
    expect(retired?.status).toBe('destroyed');
    expect(retired?.metadata[WORKTREE_REMOVAL_OWNER]).toBeUndefined();

    const held = await createEnv('foreign-claim');
    await setClaim(held, { host: 'other-host', pid: 1, instance: 'x' });
    const claimed = await getById(held.id);
    const remove = mock(async () => undefined);
    await expect(withWorktreeRegistration(held, remove)).rejects.toBeInstanceOf(
      WorktreeRemovalInProgressError
    );
    expect(remove).not.toHaveBeenCalled();
    expect(await getById(held.id)).toEqual(claimed);
  });
});
