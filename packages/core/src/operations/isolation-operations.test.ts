import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

// ---------------------------------------------------------------------------
// Import namespace modules for spyOn (must come before module under test)
// ---------------------------------------------------------------------------

import * as git from '@archon/git';
import * as isolationDb from '../db/isolation-environments';
import * as cleanupService from '../services/cleanup-service';
import * as archonPaths from '@archon/paths';

// ---------------------------------------------------------------------------
// Import module under test (static import — spyOn intercepts at call time)
// ---------------------------------------------------------------------------

import {
  listEnvironments,
  cleanupStaleEnvironments,
  cleanupMergedEnvironments,
} from './isolation-operations';

// ---------------------------------------------------------------------------
// Spy variables
// ---------------------------------------------------------------------------

const mockLogger = createMockLogger();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateLogger: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyWorktreeExists: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyToWorktreePath: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyListAllActiveWithCodebase: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyListByCodebaseWithAge: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyUpdateStatus: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCleanupStaleWorktrees: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCleanupMergedWorktrees: any;

beforeEach(() => {
  spyCreateLogger = spyOn(archonPaths, 'createLogger').mockReturnValue(mockLogger as never);
  spyWorktreeExists = spyOn(git, 'worktreeExists').mockResolvedValue(true);
  spyToWorktreePath = spyOn(git, 'toWorktreePath').mockImplementation((p: string) => p as never);
  spyListAllActiveWithCodebase = spyOn(isolationDb, 'listAllActiveWithCodebase').mockResolvedValue(
    []
  );
  spyListByCodebaseWithAge = spyOn(isolationDb, 'listByCodebaseWithAge').mockResolvedValue([]);
  spyUpdateStatus = spyOn(isolationDb, 'updateStatus').mockResolvedValue(undefined);
  spyCleanupStaleWorktrees = spyOn(cleanupService, 'cleanupStaleWorktrees').mockResolvedValue({
    removed: 0,
    errors: [],
  } as never);
  spyCleanupMergedWorktrees = spyOn(cleanupService, 'cleanupMergedWorktrees').mockResolvedValue({
    removed: 0,
    errors: [],
  } as never);
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

afterEach(() => {
  spyCreateLogger.mockRestore();
  spyWorktreeExists.mockRestore();
  spyToWorktreePath.mockRestore();
  spyListAllActiveWithCodebase.mockRestore();
  spyListByCodebaseWithAge.mockRestore();
  spyUpdateStatus.mockRestore();
  spyCleanupStaleWorktrees.mockRestore();
  spyCleanupMergedWorktrees.mockRestore();
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
    spyListAllActiveWithCodebase.mockClear();
    spyListByCodebaseWithAge.mockClear();
    spyWorktreeExists.mockClear();
    spyUpdateStatus.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  test('returns empty result when no active environments', async () => {
    spyListAllActiveWithCodebase.mockResolvedValueOnce([]);

    const result = await listEnvironments();

    expect(result.codebases).toHaveLength(0);
    expect(result.totalEnvironments).toBe(0);
    expect(result.ghostsReconciled).toBe(0);
    expect(spyListByCodebaseWithAge).not.toHaveBeenCalled();
  });

  test('marks missing worktree as destroyed and increments ghostsReconciled', async () => {
    spyListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    spyListByCodebaseWithAge
      .mockResolvedValueOnce([
        makeEnvWithAge({ id: 'env-ghost', working_path: '/worktrees/ghost' }),
      ])
      // Re-fetch after ghost cleanup returns empty
      .mockResolvedValueOnce([]);
    spyWorktreeExists.mockResolvedValueOnce(false); // ghost

    const result = await listEnvironments();

    expect(spyUpdateStatus).toHaveBeenCalledWith('env-ghost', 'destroyed');
    expect(result.ghostsReconciled).toBe(1);
    expect(result.totalEnvironments).toBe(0); // re-fetch returned empty
  });

  test('does not re-fetch when no ghosts found', async () => {
    spyListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    spyListByCodebaseWithAge.mockResolvedValueOnce([makeEnvWithAge()]);
    spyWorktreeExists.mockResolvedValueOnce(true); // not a ghost

    await listEnvironments();

    // listByCodebaseWithAge called only once — no re-fetch needed
    expect(spyListByCodebaseWithAge).toHaveBeenCalledTimes(1);
  });

  test('handles worktreeExists error in reconcileGhosts without crashing', async () => {
    spyListAllActiveWithCodebase.mockResolvedValueOnce([makeActiveEnv()]);
    spyListByCodebaseWithAge.mockResolvedValue([makeEnvWithAge({ id: 'env-err' })]);
    spyWorktreeExists.mockRejectedValueOnce(new Error('permission denied'));

    // Should not throw — error is swallowed per the try/catch in reconcileGhosts
    await expect(listEnvironments()).resolves.toBeDefined();
    expect(spyUpdateStatus).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-err' }),
      'isolation.ghost_reconciliation_failed'
    );
  });

  test('returns live environments grouped by codebase', async () => {
    spyListAllActiveWithCodebase.mockResolvedValueOnce([
      makeActiveEnv({ codebase_id: 'cb-1', codebase_repository_url: 'https://github.com/a/b' }),
    ]);
    const env = makeEnvWithAge({ id: 'env-live' });
    spyListByCodebaseWithAge.mockResolvedValueOnce([env]);
    spyWorktreeExists.mockResolvedValueOnce(true);

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
    spyListAllActiveWithCodebase.mockClear();
    spyWorktreeExists.mockClear();
    spyCleanupStaleWorktrees.mockClear();
  });

  test('reconciles ghosts then delegates to cleanupStaleWorktrees', async () => {
    // listAllActiveWithCodebase returns envs with codebase_id matching 'cb-1'
    spyListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        ...makeActiveEnv({ codebase_id: 'cb-1' }),
        id: 'env-1',
        working_path: '/worktrees/feat',
        branch_name: 'feat',
        workflow_id: 'wf-1',
      },
    ]);
    spyWorktreeExists.mockResolvedValueOnce(true); // not a ghost
    spyCleanupStaleWorktrees.mockResolvedValueOnce({ removed: 1, errors: [] });

    const result = await cleanupStaleEnvironments('cb-1', '/main');

    expect(spyCleanupStaleWorktrees).toHaveBeenCalledWith('cb-1', '/main');
    expect(result.removed).toBe(1);
  });
});

describe('cleanupMergedEnvironments', () => {
  beforeEach(() => {
    spyCleanupMergedWorktrees.mockClear();
  });

  test('delegates to cleanupMergedWorktrees', async () => {
    spyCleanupMergedWorktrees.mockResolvedValueOnce({ removed: 2, errors: [] });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(spyCleanupMergedWorktrees).toHaveBeenCalledWith('cb-1', '/main', {});
    expect(result.removed).toBe(2);
  });

  test('passes through errors from cleanupMergedWorktrees', async () => {
    spyCleanupMergedWorktrees.mockResolvedValueOnce({
      removed: 0,
      errors: ['branch-a: git error'],
    });

    const result = await cleanupMergedEnvironments('cb-1', '/main');

    expect(result.errors).toEqual(['branch-a: git error']);
  });

  test('forwards includeClosed option to cleanupMergedWorktrees', async () => {
    spyCleanupMergedWorktrees.mockResolvedValueOnce({ removed: 1, errors: [] });

    await cleanupMergedEnvironments('cb-1', '/main', { includeClosed: true });

    expect(spyCleanupMergedWorktrees).toHaveBeenCalledWith('cb-1', '/main', {
      includeClosed: true,
    });
  });
});
