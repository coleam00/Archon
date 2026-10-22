// @archon-test-isolated
import { setPlatformPolicies } from '../platforms/registry';
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { toBranchName } from '@archon/git';
import type * as IsolationDb from '../db/isolation-environments';
import type * as MergedSweep from '../services/cleanup/merged-sweep';
import type * as CleanupRunLock from '../services/cleanup/run-lock';

beforeEach(() => setPlatformPolicies([{ id: 'web', workspaceRetention: 'age-based' }]));

// ---------------------------------------------------------------------------
// Mock modules before importing the module under test
// ---------------------------------------------------------------------------

const mockLstat = mock(() => Promise.resolve());
mock.module('node:fs/promises', () => ({ lstat: mockLstat }));

const mockListAllActiveWithCodebase = mock<typeof IsolationDb.listAllActiveWithCodebase>(() =>
  Promise.resolve([])
);
const mockListByCodebaseWithAge = mock<typeof IsolationDb.listByCodebaseWithAge>(() =>
  Promise.resolve([])
);
const mockMarkWorktreeDestroyed = mock<typeof IsolationDb.markWorktreeDestroyed>(() =>
  Promise.resolve()
);
mock.module('../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  updateStatus: mock(() => Promise.resolve()),
  markWorktreeDestroyed: mockMarkWorktreeDestroyed,
}));

const MERGED_BASE_REF = toBranchName('origin/main');
const mockCleanupMerged = mock<typeof MergedSweep.cleanupMergedWorktrees>(() =>
  Promise.resolve({
    removed: [],
    skipped: [],
    errors: [],
    releasedFailedRuns: [],
    warnings: [],
    baseRef: MERGED_BASE_REF,
  })
);
const mockGetLiveRunBlocker = mock<typeof CleanupRunLock.getLiveRunBlocker>(() =>
  Promise.resolve(null)
);
mock.module('../services/cleanup/merged-sweep', () => ({
  cleanupMergedWorktrees: mockCleanupMerged,
  cleanupToMakeRoom: mock(),
  recordCleanupRemoval: mock(),
}));
mock.module('../services/cleanup/run-lock', () => ({
  getLiveRunBlocker: mockGetLiveRunBlocker,
  getCleanupRunLock: mock(),
  toUnpushedLock: mock(),
  countUnpushedCommits: mock(),
  readLiveRemoteTips: mock(),
  checkRemoval: mock(),
}));

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Import AFTER mocks
const { listEnvironments, cleanupMergedEnvironments } = await import('./isolation-operations');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ActiveEnv = Awaited<ReturnType<typeof IsolationDb.listAllActiveWithCodebase>>[number];
type EnvWithAge = Awaited<ReturnType<typeof IsolationDb.listByCodebaseWithAge>>[number];

function makeActiveEnv(overrides: Partial<ActiveEnv> = {}): ActiveEnv {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'issue',
    workflow_id: 'wf-1',
    provider: 'worktree',
    working_path: '/worktrees/feat',
    branch_name: 'feat',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'web',
    created_by_user_id: null,
    metadata: {},
    codebase_repository_url: 'https://github.com/owner/repo',
    codebase_name: 'test-project',
    codebase_default_cwd: '/repo',
    ...overrides,
  };
}

function makeEnvWithAge(overrides: Partial<EnvWithAge> = {}): EnvWithAge {
  return {
    ...makeActiveEnv(),
    days_since_activity: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listEnvironments', () => {
  beforeEach(() => {
    mockListAllActiveWithCodebase.mockClear();
    mockListByCodebaseWithAge.mockClear();
    mockLstat.mockReset();
    mockLstat.mockImplementation(() => Promise.resolve());
    mockMarkWorktreeDestroyed.mockClear();
    mockGetLiveRunBlocker.mockClear();
    mockGetLiveRunBlocker.mockImplementation(() => Promise.resolve(null));
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  test('returns empty result when no active environments', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);

    const result = await listEnvironments();

    expect(result.codebases).toHaveLength(0);
    expect(result.totalEnvironments).toBe(0);
    expect(result.ghostsReconciled).toBe(0);
    expect(mockListByCodebaseWithAge).not.toHaveBeenCalled();
  });

  test('keeps and reports a missing worktree from an uninstalled chat platform', async () => {
    const env = makeEnvWithAge({ id: 'removed-chat-env', created_by_platform: 'removed-chat' });
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    mockListByCodebaseWithAge.mockResolvedValueOnce([env]);
    mockLstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const result = await listEnvironments();
    expect(result.ghostsReconciled).toBe(0);
    expect(result.codebases[0]?.environments[0]?.cleanupSkipReason).toContain(
      "platform 'removed-chat' is not registered"
    );
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(mockLstat).not.toHaveBeenCalled();
  });

  test('keeps containers visible without inspecting their host paths', async () => {
    const env = makeEnvWithAge({ provider: 'container', working_path: '/missing' });
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv({ provider: 'container' })]);
    mockListByCodebaseWithAge.mockResolvedValueOnce([env]);
    mockLstat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const result = await listEnvironments();
    expect(result.ghostsReconciled).toBe(0);
    expect(result.codebases[0]?.environments).toEqual([env]);
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(mockLstat).not.toHaveBeenCalled();
  });

  test('marks missing worktree as destroyed and increments ghostsReconciled', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    mockListByCodebaseWithAge
      .mockResolvedValueOnce([
        makeEnvWithAge({ id: 'env-ghost', working_path: '/worktrees/ghost' }),
      ])
      // Re-fetch after ghost cleanup returns empty
      .mockResolvedValueOnce([]);
    mockLstat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' })); // ghost

    const result = await listEnvironments();

    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-ghost' })
    );
    expect(result.ghostsReconciled).toBe(1);
    expect(result.totalEnvironments).toBe(0); // re-fetch returned empty
  });

  // listEnvironments() runs ahead of the per-item live-run guard in the `isolation
  // cleanup` commands, so ghosting a row here would hide it from that guard and
  // invalidate the owning run's resume handle.
  test('leaves a missing worktree active when a run can still claim it', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    const env = makeEnvWithAge({ id: 'env-owned', working_path: '/worktrees/gone' });
    mockListByCodebaseWithAge.mockResolvedValueOnce([env]);
    mockLstat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mockGetLiveRunBlocker.mockImplementation(() =>
      Promise.resolve({
        reason: 'live_run',
        display: 'run run-abcd is failed',
        runId: 'run-abcdef12',
        runStatus: 'failed',
      })
    );

    const result = await listEnvironments();

    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(result.ghostsReconciled).toBe(0);
    // No re-fetch, and the env stays visible so the operator can act on it.
    expect(mockListByCodebaseWithAge).toHaveBeenCalledTimes(1);
    expect(result.totalEnvironments).toBe(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-owned', runId: 'run-abcdef12', runStatus: 'failed' }),
      'isolation.ghost_kept_for_live_run'
    );
  });

  test('does not re-fetch when no ghosts found', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    mockListByCodebaseWithAge.mockResolvedValueOnce([makeEnvWithAge()]);
    mockLstat.mockResolvedValueOnce(undefined); // not a ghost

    await listEnvironments();

    // listByCodebaseWithAge called only once — no re-fetch needed
    expect(mockListByCodebaseWithAge).toHaveBeenCalledTimes(1);
  });

  test('handles filesystem error in reconcileGhosts without crashing', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    mockListByCodebaseWithAge.mockResolvedValue([makeEnvWithAge({ id: 'env-err' })]);
    mockLstat.mockRejectedValueOnce(new Error('permission denied'));

    // Should not throw — error is swallowed per the try/catch in reconcileGhosts
    await expect(listEnvironments()).resolves.toBeDefined();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-err' }),
      'isolation.ghost_reconciliation_failed'
    );
  });

  test('returns live environments grouped by codebase', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeActiveEnv({ codebase_id: 'cb-1', codebase_repository_url: 'https://github.com/a/b' }),
    ]);
    const env = makeEnvWithAge({ id: 'env-live' });
    mockListByCodebaseWithAge.mockResolvedValueOnce([env]);
    mockLstat.mockResolvedValueOnce(undefined);

    const result = await listEnvironments();

    expect(result.codebases).toHaveLength(1);
    expect(result.codebases[0].codebaseId).toBe('cb-1');
    expect(result.codebases[0].environments).toHaveLength(1);
    expect(result.totalEnvironments).toBe(1);
    expect(result.ghostsReconciled).toBe(0);
  });
});

describe('cleanupMergedEnvironments', () => {
  beforeEach(() => {
    mockCleanupMerged.mockClear();
  });

  test('delegates to cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({
      removed: ['feat-a', 'feat-b'],
      skipped: [],
      errors: [],
      releasedFailedRuns: [],
      warnings: [],
      baseRef: MERGED_BASE_REF,
    });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(mockCleanupMerged).toHaveBeenCalledWith('cb-1', '/main', {});
    expect(result.removed).toEqual(['feat-a', 'feat-b']);
  });

  test('passes through skipped branches from cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({
      removed: [],
      skipped: [{ branchName: 'branch-a', reason: 'git error' }],
      errors: [],
      releasedFailedRuns: [],
      warnings: [],
      baseRef: MERGED_BASE_REF,
    });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(result.skipped).toEqual([{ branchName: 'branch-a', reason: 'git error' }]);
  });

  test('forwards includeClosed option to cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({
      removed: ['feat'],
      skipped: [],
      errors: [],
      releasedFailedRuns: [],
      warnings: [],
      baseRef: MERGED_BASE_REF,
    });

    await cleanupMergedEnvironments('cb-1', '/main', { includeClosed: true });

    expect(mockCleanupMerged).toHaveBeenCalledWith('cb-1', '/main', { includeClosed: true });
  });
});
