// @archon-test-isolated
import { toBranchName } from '@archon/git';
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { IDatabase } from './adapters/types';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const root = await mkdtemp(join(tmpdir(), 'archon-codebase-delete-'));
const db = new SqliteAdapter(join(root, 'test.db'));
const registrar = new SqliteAdapter(join(root, 'test.db'));
await registrar.query('SELECT 1');
let afterContainerRead: (() => Promise<void>) | undefined;
const withTransaction: IDatabase['withTransaction'] = fn =>
  db.withTransaction(query =>
    fn(async <U>(sql: string, params?: unknown[]) => {
      const result = await query<U>(sql, params);
      if (sql.includes("provider = 'container'") && afterContainerRead) {
        const hook = afterContainerRead;
        afterContainerRead = undefined;
        await hook();
      }
      return result;
    })
  );
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => ({ withTransaction }),
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
afterAll(async () => {
  await registrar.close();
  await db.close();
  await removeTempTree(root);
});

test('deletion allows an active worktree environment', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const project = await createCodebase({ name: 'worktree-delete', default_cwd: '/repos/worktree' });
  await db.query(
    `INSERT INTO remote_agent_isolation_environments
     (id, codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
     VALUES ('worktree', $1, 'test', 'workflow', 'worktree', '/repos/worktree/branch', 'branch', 'active')`,
    [project.id]
  );

  await deleteCodebase(project.id);

  expect(await getCodebase(project.id)).toBeNull();
  expect(
    (await db.query("SELECT id FROM remote_agent_isolation_environments WHERE id = 'worktree'"))
      .rows
  ).toHaveLength(0);
});

test('deletion refuses a container registered after the caller snapshot and preserves references', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const project = await createCodebase({ name: 'delete-test', default_cwd: '/repos/delete-test' });
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id)
     VALUES ('conversation', 'cli', 'delete-test', $1)`,
    [project.id]
  );
  await db.query(
    `INSERT INTO remote_agent_sessions (id, conversation_id, codebase_id, ai_assistant_type)
     VALUES ('session', 'conversation', $1, 'claude')`,
    [project.id]
  );
  expect(
    (
      await db.query('SELECT id FROM remote_agent_isolation_environments WHERE codebase_id = $1', [
        project.id,
      ])
    ).rows
  ).toHaveLength(0);
  await db.query(
    `INSERT INTO remote_agent_isolation_environments
     (id, codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
     VALUES ('container', $1, 'test', 'workflow', 'container', '/missing', '', 'active')`,
    [project.id]
  );
  await expect(deleteCodebase(project.id)).rejects.toThrow('container');
  expect(await getCodebase(project.id)).not.toBeNull();
  for (const table of ['remote_agent_sessions', 'remote_agent_conversations']) {
    expect(
      (await db.query<{ codebase_id: string }>(`SELECT codebase_id FROM ${table}`)).rows[0]
        ?.codebase_id
    ).toBe(project.id);
  }
  expect(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM remote_agent_isolation_environments WHERE id = 'container'"
      )
    ).rows[0]?.status
  ).toBe('active');
  await db.query(
    "UPDATE remote_agent_isolation_environments SET status = 'destroyed' WHERE id = 'container'"
  );
  await deleteCodebase(project.id);
  expect(await getCodebase(project.id)).toBeNull();
});

test('a concurrent registration invalidates the SQLite snapshot and deletion retries the guard', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const project = await createCodebase({
    name: 'concurrent-delete',
    default_cwd: '/repos/concurrent-delete',
  });
  afterContainerRead = async () => {
    await registrar.query(
      `INSERT INTO remote_agent_isolation_environments
       (id, codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
       VALUES ('concurrent-container', $1, 'test', 'workflow', 'container', '/missing', '', 'active')`,
      [project.id]
    );
  };
  await expect(deleteCodebase(project.id)).rejects.toThrow('concurrent-container');
  expect(afterContainerRead).toBeUndefined();
  expect(await getCodebase(project.id)).not.toBeNull();
  expect(
    (
      await registrar.query<{ status: string }>(
        "SELECT status FROM remote_agent_isolation_environments WHERE id = 'concurrent-container'"
      )
    ).rows[0]?.status
  ).toBe('active');
});

test('workspace deletion refuses a worktree registered during cleanup and succeeds after cleanup', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const project = await createCodebase({
    name: 'late-worktree',
    default_cwd: '/repos/late-worktree',
  });
  afterContainerRead = async () => {
    await registrar.query(
      `INSERT INTO remote_agent_isolation_environments
       (id, codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
       VALUES ('late-worktree', $1, 'test', 'workflow', 'worktree', '/repos/late-worktree/branch', 'branch', 'active')`,
      [project.id]
    );
  };
  await expect(deleteCodebase(project.id, { requireWorktreeCleanup: true })).rejects.toThrow(
    'late-worktree'
  );
  expect(afterContainerRead).toBeUndefined();
  expect(await getCodebase(project.id)).not.toBeNull();
  expect(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM remote_agent_isolation_environments WHERE id = 'late-worktree'"
      )
    ).rows[0]?.status
  ).toBe('active');
  await db.query(
    "UPDATE remote_agent_isolation_environments SET status = 'destroyed' WHERE id = 'late-worktree'"
  );
  await deleteCodebase(project.id, { requireWorktreeCleanup: true });
  expect(await getCodebase(project.id)).toBeNull();
});

for (const replacement of [
  'path',
  'creation proof',
  'provider',
  'identical adopted registration',
] as const) {
  test(`cleanup preserves a same-ID replacement: ${replacement}`, async () => {
    const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
    const { create, getById, markWorktreeDestroyed } = await import('./isolation-environments');
    const project = await createCodebase({
      name: `replacement-${replacement}`,
      // Each project needs its own checkout path, and so its own storage root.
      default_cwd: `/repos/replacement-${replacement.replaceAll(' ', '-')}`,
    });
    const original = await create({
      codebase_id: project.id,
      workflow_type: 'issue',
      workflow_id: '42',
      provider: 'worktree',
      working_path: '/repos/original',
      branch_name: toBranchName('branch'),
      metadata: {
        worktree_creation_id:
          replacement === 'identical adopted registration' ? null : 'original-creation',
      },
    });
    const current = await create({
      codebase_id: project.id,
      workflow_type: 'issue',
      workflow_id: '42',
      provider: replacement === 'provider' ? 'container' : 'worktree',
      working_path: replacement === 'path' ? '/repos/replacement' : original.working_path,
      branch_name: toBranchName(original.branch_name),
      metadata: {
        ...original.metadata,
        ...(replacement === 'creation proof' ? { worktree_creation_id: 'new-creation' } : {}),
      },
    });
    expect(current.id).toBe(original.id);
    await expect(markWorktreeDestroyed(original)).rejects.toThrow('changed during cleanup');
    expect((await getById(original.id))?.status).toBe('active');
    await expect(deleteCodebase(project.id, { requireWorktreeCleanup: true })).rejects.toThrow(
      original.id
    );
    expect(await getCodebase(project.id)).not.toBeNull();
    if (replacement !== 'provider') {
      await markWorktreeDestroyed(current);
      await deleteCodebase(project.id, { requireWorktreeCleanup: true });
      expect(await getCodebase(project.id)).toBeNull();
    }
  });
}

test('cleanup supports legacy registrations and rejects their identical re-registration', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const { create, getById, markWorktreeDestroyed, updateMetadata } = await import(
    './isolation-environments'
  );
  for (const replace of [false, true]) {
    const project = await createCodebase({
      name: `legacy-${replace}`,
      default_cwd: '/repos/legacy',
    });
    await db.query(
      `INSERT INTO remote_agent_isolation_environments
       (codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, metadata)
       VALUES ($1, '42', 'issue', 'worktree', '/repos/legacy/branch', 'branch', '{"worktree_creation_id":null}')`,
      [project.id]
    );
    const { listByCodebase } = await import('./isolation-environments');
    const original = (await listByCodebase(project.id))[0];
    if (!original) throw new Error('Expected legacy worktree');
    if (replace) {
      const current = await create({
        codebase_id: project.id,
        workflow_type: original.workflow_type,
        workflow_id: original.workflow_id,
        working_path: original.working_path,
        branch_name: toBranchName(original.branch_name),
        metadata: original.metadata,
      });
      expect(current.id).toBe(original.id);
      await expect(markWorktreeDestroyed(original)).rejects.toThrow('changed during cleanup');
      expect((await getById(original.id))?.status).toBe('active');
      await expect(deleteCodebase(project.id, { requireWorktreeCleanup: true })).rejects.toThrow(
        original.id
      );
      await updateMetadata(current.id, { pr_number: 42 });
      await markWorktreeDestroyed(current);
    } else {
      await markWorktreeDestroyed(original);
    }
    await deleteCodebase(project.id, { requireWorktreeCleanup: true });
    expect(await getCodebase(project.id)).toBeNull();
  }
});

for (const legacy of [false, true]) {
  test(`retiring the same registration is idempotent (legacy: ${legacy})`, async () => {
    const { createCodebase } = await import('./codebases');
    const { create, getById, markWorktreeDestroyed, updateMetadata } = await import(
      './isolation-environments'
    );
    const project = await createCodebase({
      name: `idempotent-retire-${legacy}`,
      default_cwd: `/repos/retire-${legacy}`,
    });
    const input = {
      codebase_id: project.id,
      workflow_type: 'task' as const,
      workflow_id: 'retire',
      working_path: '/repos/retire/task',
      branch_name: toBranchName('task'),
    };
    const created = await create(input);
    if (legacy) {
      await db.query(
        "UPDATE remote_agent_isolation_environments SET metadata = '{}' WHERE id = $1",
        [created.id]
      );
    }
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
      const replaced = await getById(created.id);
      await expect(markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
      expect(await getById(created.id)).toEqual(replaced);
    }
    await db.query(
      "UPDATE remote_agent_isolation_environments SET status = 'active' WHERE id = $1",
      [created.id]
    );
    const replacement = await create(input);
    expect(replacement.id).toBe(observed.id);
    await expect(markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
    expect(await getById(created.id)).toEqual(replacement);
    await markWorktreeDestroyed(replacement);
    await expect(markWorktreeDestroyed(observed)).rejects.toThrow('changed during cleanup');
  });
}

test('legacy writer replacement cannot be retired by a stale cleanup observation', async () => {
  const { createCodebase } = await import('./codebases');
  const { getById, markWorktreeDestroyed, listByCodebase } = await import(
    './isolation-environments'
  );
  const project = await createCodebase({
    name: 'legacy-writer',
    default_cwd: '/repos/legacy-writer',
  });
  await db.query(
    `INSERT INTO remote_agent_isolation_environments
     (codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, metadata)
     VALUES ($1, '42', 'issue', 'worktree', '/repos/legacy-writer/old', 'old', '{}')`,
    [project.id]
  );
  const original = (await listByCodebase(project.id))[0];
  if (!original) throw new Error('Expected legacy registration');
  await db.query(
    "UPDATE remote_agent_isolation_environments SET working_path = '/repos/legacy-writer/new', branch_name = 'new' WHERE id = $1",
    [original.id]
  );
  await expect(markWorktreeDestroyed(original)).rejects.toThrow('changed during cleanup');
  expect(await getById(original.id)).toMatchObject({
    status: 'active',
    working_path: '/repos/legacy-writer/new',
    branch_name: 'new',
  });
});
