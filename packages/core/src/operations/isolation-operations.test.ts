import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as git from '@archon/git';
import * as paths from '@archon/paths';
import * as dbIsolationEnvironments from '../db/isolation-environments';
import * as cleanupService from '../services/cleanup-service';

// ---------------------------------------------------------------------------
// Mock modules before importing the module under test
// ---------------------------------------------------------------------------

const mockWorktreeExists = mock(() => Promise.resolve(true));
const mockToWorktreePath = mock((p: string) => p);

const mockListAllActiveWithCodebase = mock(() => Promise.resolve([]));
const mockListByCodebaseWithAge = mock(() => Promise.resolve([]));
const mockUpdateStatus = mock(() => Promise.resolve());

const mockCleanupStale = mock(() => Promise.resolve({ removed: 0, errors: [] }));
const mockCleanupMerged = mock(() => Promise.resolve({ removed: 0, errors: [] }));

// Spy variable declarations
let spyGitWorktreeExists: ReturnType<typeof spyOn>;
let spyGitToWorktreePath: ReturnType<typeof spyOn>;
let spyDbIsolationListAllActive: ReturnType<typeof spyOn>;
let spyDbIsolationListByCodebaseWithAge: ReturnType<typeof spyOn>;
let spyDbIsolationUpdateStatus: ReturnType<typeof spyOn>;
let spyCleanupStale: ReturnType<typeof spyOn>;
let spyCleanupMerged: ReturnType<typeof spyOn>;

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};

let spyPathsCreateLogger: ReturnType<typeof spyOn>;

// Import AFTER mocks
const { listEnvironments, cleanupStaleEnvironments, cleanupMergedEnvironments } =
  await import('./isolation-operations');

beforeEach(() => {
  spyPathsCreateLogger = spyOn(paths, 'createLogger').mockReturnValue(
    mockLogger as ReturnType<typeof paths.createLogger>
  );
  spyGitWorktreeExists = spyOn(git, 'worktreeExists').mockImplementation(mockWorktreeExists);
  spyGitToWorktreePath = spyOn(git, 'toWorktreePath').mockImplementation(
    (p: string) => p as ReturnType<typeof git.toWorktreePath>
  );
  spyDbIsolationListAllActive = spyOn(
    dbIsolationEnvironments,
    'listAllActiveWithCodebase'
  ).mockImplementation(mockListAllActiveWithCodebase);
  spyDbIsolationListByCodebaseWithAge = spyOn(
    dbIsolationEnvironments,
    'listByCodebaseWithAge'
  ).mockImplementation(mockListByCodebaseWithAge);
  spyDbIsolationUpdateStatus = spyOn(dbIsolationEnvironments, 'updateStatus').mockImplementation(
    mockUpdateStatus
  );
  spyCleanupStale = spyOn(cleanupService, 'cleanupStaleWorktrees').mockImplementation(
    mockCleanupStale
  );
  spyCleanupMerged = spyOn(cleanupService, 'cleanupMergedWorktrees').mockImplementation(
    mockCleanupMerged
  );
});

afterEach(() => {
  spyPathsCreateLogger.mockRestore();
  spyGitWorktreeExists.mockRestore();
  spyGitToWorktreePath.mockRestore();
  spyDbIsolationListAllActive.mockRestore();
  spyDbIsolationListByCodebaseWithAge.mockRestore();
  spyDbIsolationUpdateStatus.mockRestore();
  spyCleanupStale.mockRestore();
  spyCleanupMerged.mockRestore();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActiveEnv(overrides: Record<string, unknown> = {}) {
  return {
    codebase_id: 'cb-1',
    codebase_repository_url: 'https://github.com/owner/repo',
    codebase_default_cwd: '/repo',
    ...overrides,
  };
}

function makeEnvWithAge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'env-1',
    working_path: '/worktrees/feat',
    branch_name: 'feat',
    workflow_id: 'wf-1',
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
    mockCleanupStale.mockResolvedValueOnce({ removed: 1, errors: [] });

    const result = await cleanupStaleEnvironments('cb-1', '/main');

    expect(mockCleanupStale).toHaveBeenCalledWith('cb-1', '/main');
    expect(result.removed).toBe(1);
  });
});

describe('cleanupMergedEnvironments', () => {
  beforeEach(() => {
    mockCleanupMerged.mockClear();
  });

  test('delegates to cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({ removed: 2, errors: [] });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(mockCleanupMerged).toHaveBeenCalledWith('cb-1', '/main', {});
    expect(result.removed).toBe(2);
  });

  test('passes through errors from cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({ removed: 0, errors: ['branch-a: git error'] });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(result.errors).toEqual(['branch-a: git error']);
  });

  test('forwards includeClosed option to cleanupMergedWorktrees', async () => {
    mockCleanupMerged.mockResolvedValueOnce({ removed: 1, errors: [] });

    await cleanupMergedEnvironments('cb-1', '/main', { includeClosed: true });

    expect(mockCleanupMerged).toHaveBeenCalledWith('cb-1', '/main', { includeClosed: true });
  });
});
