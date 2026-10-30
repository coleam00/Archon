// @archon-test-isolated
import { afterAll, afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test';
import type { IsolationEnvironmentRow, IIsolationProvider } from '@archon/isolation';
import type * as Git from '@archon/git';
import { toBranchName } from '@archon/git';
import { createMockLogger } from '@archon/core/test/mocks/logger';

const original: IsolationEnvironmentRow = {
  id: 'same-row',
  codebase_id: 'codebase',
  workflow_type: 'task',
  workflow_id: 'task',
  provider: 'worktree',
  working_path: '/probe/original',
  branch_name: 'probe-branch',
  status: 'active',
  created_at: new Date('2026-01-01T00:00:00Z'),
  created_by_platform: 'cli',
  created_by_user_id: null,
  metadata: {
    worktree_registration_id: 'original-registration',
    worktree_creation_id: 'original-creation',
    worktree_branch_created: true,
  },
};
let observed = original;
let current = original;
let replacement: 'token' | 'path' | 'legacy' | undefined;
const destroy = mock<IIsolationProvider['destroy']>(async () => ({
  worktreeRemoved: true,
  directoryClean: true,
  branchDeleted: true,
  remoteBranchDeleted: true,
  warnings: [],
}));
const { SqliteAdapter, sqliteDialect } = await import('@archon/core/db/adapters/sqlite');
const db = new SqliteAdapter(':memory:');
mock.module('@archon/core/db/connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const isolationDb = await import('@archon/core/db/isolation-environments');
afterAll(() => db.close());

const git = await import('@archon/git');
const worktreeExists = mock<typeof Git.worktreeExists>(async () => true);
mock.module('@archon/git', () => ({
  ...git,
  getGitCheckoutIdentity: async () => ({
    gitDir: '/probe/repo',
    commonGitDir: '/probe/repo',
    linkedWorktree: false,
  }),
  worktreeExists,
  execFileAsync: async (command: string) => ({ stdout: command === 'gh' ? '[]' : '', stderr: '' }),
  hasUncommittedChangesStrict: async () => false,
  getUniqueCommitCount: async () => 0,
  getDefaultBranch: async () => 'dev',
}));
const isolation = await import('@archon/isolation');
mock.module('@archon/isolation', () => ({
  ...isolation,
  getIsolationProvider: () => ({ destroy }),
}));
mock.module('@archon/core/db/conversations', () => ({}));
mock.module('@archon/core/db/sessions', () => ({ SessionNotFoundError: class extends Error {} }));
mock.module('@archon/core/db/workflows', () => ({
  getRunIdsByIsolationEnvId: mock(async (): Promise<string[]> => []),
  getWorkflowRunForAttention: mock(async () => null),
}));
mock.module('@archon/core/db/codebases', () => ({
  getCodebase: async () => {
    const change = replacement;
    if (change) {
      replacement = undefined;
      current = await isolationDb.create({
        ...observed,
        created_by_platform: observed.created_by_platform ?? undefined,
        created_by_user_id: observed.created_by_user_id ?? undefined,
        working_path: change === 'token' ? observed.working_path : '/probe/replacement',
        branch_name: toBranchName(observed.branch_name),
        metadata: { worktree_creation_id: 'replacement-creation', worktree_branch_created: true },
      });
      if (change === 'path') {
        await db.query(
          'UPDATE remote_agent_isolation_environments SET metadata = $1 WHERE id = $2',
          [
            JSON.stringify({
              ...current.metadata,
              worktree_registration_id: observed.metadata.worktree_registration_id,
            }),
            current.id,
          ]
        );
        current = {
          ...current,
          metadata: {
            ...current.metadata,
            worktree_registration_id: observed.metadata.worktree_registration_id,
          },
        };
      }
    }
    return { default_cwd: '/probe/repo' };
  },
}));
mock.module('@archon/core/operations/isolation-operations', () => ({
  listEnvironments: mock(),
  cleanupMergedEnvironments: mock(),
}));
mock.module('@archon/core', () => ({ loadRepoConfig: async () => ({}) }));
mock.module('@archon/core/config/config-loader', () => ({ loadRepoConfig: async () => ({}) }));
mock.module('@archon/paths', () => ({ createLogger: () => createMockLogger() }));

const { setPlatformPolicies, clearPlatformPolicies } = await import(
  '@archon/core/platforms/registry'
);
const { isolationCompleteCommand } = await import('./isolation');
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await db.query('DELETE FROM remote_agent_isolation_environments');
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('codebase', 'probe', '/probe/repo') ON CONFLICT DO NOTHING`
  );
  observed = await isolationDb.create({
    ...original,
    created_by_platform: original.created_by_platform ?? undefined,
    created_by_user_id: original.created_by_user_id ?? undefined,
    branch_name: toBranchName(original.branch_name),
  });
  current = observed;
  replacement = undefined;
  destroy.mockClear();
  worktreeExists.mockClear();
  setPlatformPolicies([{ id: 'cli', workspaceRetention: 'age-based' }]);
  log = spyOn(console, 'log').mockImplementation(() => {});
  error = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  clearPlatformPolicies();
});

it.each(
  [false, true].flatMap(force =>
    (['token', 'path', 'legacy'] as const).map(change => ({ force, change }))
  )
)('refuses $change replacement after selection with force=$force', async ({ force, change }) => {
  if (change === 'legacy') {
    await db.query("UPDATE remote_agent_isolation_environments SET metadata = '{}' WHERE id = $1", [
      observed.id,
    ]);
    observed = { ...observed, metadata: {} };
  }
  current = observed;
  replacement = change;

  await expect(isolationCompleteCommand(['probe-branch'], { force })).rejects.toThrow(
    'Failed to complete'
  );

  expect(destroy).not.toHaveBeenCalled();
  expect(current.id).toBe(observed.id);
  expect((await isolationDb.getById(observed.id))?.status).toBe('active');
  expect(
    current.metadata.worktree_registration_id === observed.metadata.worktree_registration_id
  ).toBe(change === 'path');
  expect(error).toHaveBeenCalledWith(expect.stringContaining('changed during cleanup'));
});

it.each([false, true])('completes unchanged registration (legacy=%s)', async legacy => {
  if (legacy) {
    await db.query("UPDATE remote_agent_isolation_environments SET metadata = '{}' WHERE id = $1", [
      observed.id,
    ]);
    observed = { ...observed, metadata: {} };
  }
  current = observed;

  await isolationCompleteCommand(['probe-branch'], {});

  expect(destroy).toHaveBeenCalledWith(
    observed.working_path,
    expect.objectContaining({ branchName: observed.branch_name })
  );
  expect((await isolationDb.getById(observed.id))?.status).toBe('destroyed');
  expect(log).toHaveBeenCalledWith('  Completed: probe-branch');
});
