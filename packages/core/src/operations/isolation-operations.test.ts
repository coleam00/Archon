import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type * as IsolationDb from '../db/isolation-environments';
import type * as CleanupService from '../services/cleanup-service';

// ---------------------------------------------------------------------------
// Mock modules before importing the module under test
// ---------------------------------------------------------------------------

const mockWorktreeExists = mock(() => Promise.resolve(true));
const mockToWorktreePath = mock((p: string) => p);
mock.module('@archon/git', () => ({
  worktreeExists: mockWorktreeExists,
  toWorktreePath: mockToWorktreePath,
}));

const mockListAllActiveWithCodebase = mock<typeof IsolationDb.listAllActiveWithCodebase>(() =>
  Promise.resolve([])
);
const mockListByCodebaseWithAge = mock<typeof IsolationDb.listByCodebaseWithAge>(() =>
  Promise.resolve([])
);
const mockUpdateStatus = mock<typeof IsolationDb.updateStatus>(() => Promise.resolve());
const mockGetLiveRunOwningEnv = mock<typeof IsolationDb.getLiveRunOwningEnv>(() =>
  Promise.resolve(null)
);
mock.module('../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  updateStatus: mockUpdateStatus,
  getLiveRunOwningEnv: mockGetLiveRunOwningEnv,
}));

const mockCleanupStale = mock<typeof CleanupService.cleanupStaleWorktrees>(() =>
  Promise.resolve({ removed: [], skipped: [] })
);
const mockCleanupMerged = mock<typeof CleanupService.cleanupMergedWorktrees>(() =>
  Promise.resolve({ removed: [], skipped: [] })
);
mock.module('../services/cleanup-service', () => ({
  cleanupStaleWorktrees: mockCleanupStale,
  cleanupMergedWorktrees: mockCleanupMerged,
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
const { listEnvironments, cleanupStaleEnvironments, cleanupMergedEnvironments } =
  await import('./isolation-operations');

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
    mockWorktreeExists.mockClear();
    mockUpdateStatus.mockClear();
    mockGetLiveRunOwningEnv.mockClear();
    mockGetLiveRunOwningEnv.mockImplementation(() => Promise.resolve(null));
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

  test('marks missing worktree as destroyed and increments ghostsReconciled', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    mockListByCodebaseWithAge
      .mockResolvedValueOnce([
        makeEnvWithAge({ id: 'env-ghost', working_path: '/worktrees/ghost' }),
      ])
      // Re-fetch after ghost cleanup returns empty
      .mockResolvedValueOnce([]);
    mockWorktreeExists.mockResolvedValueOnce(false); // ghost

    const result = await listEnvironments();

    expect(mockUpdateStatus).toHaveBeenCalledWith('env-ghost', 'destroyed');
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
    mockWorktreeExists.mockResolvedValueOnce(false);
    mockGetLiveRunOwningEnv.mockImplementation(() =>
      Promise.resolve({ id: 'run-abcdef12', status: 'failed' })
    );

    const result = await listEnvironments();

    expect(mockUpdateStatus).not.toHaveBeenCalled();
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
    mockWorktreeExists.mockResolvedValueOnce(true); // not a ghost

    await listEnvironments();

    // listByCodebaseWithAge called only once — no re-fetch needed
    expect(mockListByCodebaseWithAge).toHaveBeenCalledTimes(1);
  });

  test('handles worktreeExists error in reconcileGhosts without crashing', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    mockListByCodebaseWithAge.mockResolvedValue([makeEnvWithAge({ id: 'env-err' })]);
    mockWorktreeExists.mockRejectedValueOnce(new Error('permission denied'));

    // Should not throw — error is swallowed per the try/catch in reconcileGhosts
    await expect(listEnvironments()).resolves.toBeDefined();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
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
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await listEnvironments();

    expect(result.codebases).toHaveLength(1);
    expect(result.codebases[0].codebaseId).toBe('cb-1');
    expect(result.codebases[0].environments).toHaveLength(1);
    expect(result.totalEnvironments).toBe(1);
    expect(result.ghostsReconciled).toBe(0);
  });
});

describe('cleanupStaleEnvironments', () => {
  beforeEach(() => {
    mockListAllActiveWithCodebase.mockClear();
    mockWorktreeExists.mockClear();
    mockCleanupStale.mockClear();
  });

  test('reconciles ghosts then delegates to cleanupStaleWorktrees', async () => {
    // listAllActiveWithCodebase returns envs with codebase_id matching 'cb-1'
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        ...makeActiveEnv({ codebase_id: 'cb-1' }),
        id: 'env-1',
        working_path: '/worktrees/feat',
        branch_name: 'feat',
        workflow_id: 'wf-1',
      },
    ]);
    mockWorktreeExists.mockResolvedValueOnce(true); // not a ghost
    mockCleanupStale.mockResolvedValueOnce({ removed: ['feat'], skipped: [] });

    const result = await cleanupStaleEnvironments('cb-1', '/main');

    expect(mockCleanupStale).toHaveBeenCalledWith('cb-1', '/main');
    expect(result.removed).toEqual(['feat']);
  });
});

describe('cleanupMergedEnvironments', () => {
  beforeEach(() => {
    mockCleanupMerged.mockClear();
  });

  test('delegates to cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({ removed: ['feat-a', 'feat-b'], skipped: [] });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(mockCleanupMerged).toHaveBeenCalledWith('cb-1', '/main', {});
    expect(result.removed).toEqual(['feat-a', 'feat-b']);
  });

  test('passes through skipped branches from cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({
      removed: [],
      skipped: [{ branchName: 'branch-a', reason: 'git error' }],
    });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(result.skipped).toEqual([{ branchName: 'branch-a', reason: 'git error' }]);
  });

  test('forwards includeClosed option to cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({ removed: ['feat'], skipped: [] });

    await cleanupMergedEnvironments('cb-1', '/main', { includeClosed: true });

    expect(mockCleanupMerged).toHaveBeenCalledWith('cb-1', '/main', { includeClosed: true });
  });
});
