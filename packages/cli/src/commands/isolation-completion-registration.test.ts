import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test';
import type { IsolationEnvironmentRow, IIsolationProvider } from '@archon/isolation';
import { sameWorktreeRegistration } from '@archon/isolation/types';
import type * as IsolationDb from '@archon/core/db/isolation-environments';
import type * as Git from '@archon/git';
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
const getById = mock<typeof IsolationDb.getById>(async () => {
  if (replacement) {
    current = {
      ...observed,
      working_path: replacement === 'token' ? observed.working_path : '/probe/replacement',
      metadata: {
        worktree_registration_id:
          replacement === 'path' ? 'original-registration' : 'replacement-registration',
        worktree_creation_id: 'replacement-creation',
        worktree_branch_created: true,
      },
    };
  }
  return current;
});
const markDestroyed = mock<typeof IsolationDb.markWorktreeDestroyed>(async env => {
  if (sameWorktreeRegistration(current, env)) current = { ...current, status: 'destroyed' };
});
mock.module('@archon/core/db/isolation-environments', () => ({
  listActive: async () => [observed],
  findActiveByBranchName: async () => ({
    ...observed,
    codebase_default_cwd: '/probe/repo',
    codebase_name: 'probe',
  }),
  getById,
  markWorktreeDestroyed: markDestroyed,
  getLiveRunOwningEnv: async () => null,
}));
const git = await import('@archon/git');
const worktreeExists = mock<typeof Git.worktreeExists>(async () => true);
mock.module('@archon/git', () => ({
  ...git,
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
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/codebases', () => ({
  getCodebase: async () => ({ default_cwd: '/probe/repo' }),
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
beforeEach(() => {
  observed = original;
  current = observed;
  replacement = undefined;
  destroy.mockClear();
  getById.mockClear();
  markDestroyed.mockClear();
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
)('refuses $change replacement at cleanup reload with force=$force', async ({ force, change }) => {
  if (change === 'legacy') observed = { ...original, metadata: {} };
  current = observed;
  replacement = change;

  await expect(isolationCompleteCommand(['probe-branch'], { force })).rejects.toThrow(
    'Failed to complete'
  );

  expect(getById).toHaveBeenCalledWith(original.id);
  expect(destroy).not.toHaveBeenCalled();
  expect(markDestroyed).not.toHaveBeenCalled();
  expect(current.status).toBe('active');
  expect(current.metadata.worktree_registration_id).toBe(
    change === 'path' ? 'original-registration' : 'replacement-registration'
  );
  expect(error).toHaveBeenCalledWith(expect.stringContaining('changed during cleanup'));
});

it.each([false, true])('completes unchanged registration (legacy=%s)', async legacy => {
  observed = legacy ? { ...original, metadata: {} } : original;
  current = observed;

  await isolationCompleteCommand(['probe-branch'], {});

  expect(destroy).toHaveBeenCalledWith(
    observed.working_path,
    expect.objectContaining({ deleteRemoteBranch: true })
  );
  expect(markDestroyed).toHaveBeenCalledWith(observed);
  expect(current.status).toBe('destroyed');
  expect(log).toHaveBeenCalledWith('  Completed: probe-branch');
});
