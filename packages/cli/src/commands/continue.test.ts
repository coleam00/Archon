/**
 * Tests for `archon continue`'s artifact-directory resolution (#2200).
 *
 * Before this change the helper had no `kind === 'folder'` branch at all, so a
 * folder project silently fell through to a cwd path that never exists. It now
 * delegates to the ONE shared identity→paths resolver, and prefers a run's
 * durable `output_root` over re-deriving from a codebase that may since have
 * been renamed.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mockGetCodebase = mock(
  async (_id: string) => null as null | { kind: string; name: string; default_cwd: string }
);
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mockGetCodebase }));

const mockWorkflowRunCommand = mock((): Promise<void> => Promise.resolve());
mock.module('./workflow', (): { workflowRunCommand: typeof mockWorkflowRunCommand } => ({
  workflowRunCommand: mockWorkflowRunCommand,
}));

const mockFindActiveByBranchName = mock(() => Promise.resolve(null));
mock.module(
  '@archon/core/db/isolation-environments',
  (): { findActiveByBranchName: typeof mockFindActiveByBranchName } => ({
    findActiveByBranchName: mockFindActiveByBranchName,
  })
);

const mockFindLatestRunByWorkingPath = mock(() => Promise.resolve(null));
mock.module(
  '@archon/core/db/workflows',
  (): { findLatestRunByWorkingPath: typeof mockFindLatestRunByWorkingPath } => ({
    findLatestRunByWorkingPath: mockFindLatestRunByWorkingPath,
  })
);

let archonHome: string;

// The real @archon/paths is used deliberately — this test is about delegating
// to it correctly, so a fake resolver would test nothing. ARCHON_HOME is
// redirected at the env level instead.
import { continueCommand, resolveArtifactsDir } from './continue';

beforeEach(async () => {
  mockGetCodebase.mockReset();
  mockWorkflowRunCommand.mockReset();
  mockWorkflowRunCommand.mockResolvedValue(undefined);
  mockFindActiveByBranchName.mockReset();
  mockFindLatestRunByWorkingPath.mockReset();
  archonHome = await mkdtemp(join(tmpdir(), 'archon-continue-'));
  process.env.ARCHON_HOME = archonHome;
});

afterEach(async () => {
  delete process.env.ARCHON_HOME;
  await rm(archonHome, { recursive: true, force: true });
});

describe('resolveArtifactsDir', () => {
  test('resolves a FOLDER project to _folder/<slug> storage (previously unreachable)', async () => {
    const dir = join(
      archonHome,
      'workspaces',
      '_folder',
      'my-ops-folder',
      'artifacts',
      'runs',
      'r1'
    );
    await mkdir(dir, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'folder',
      name: 'My Ops Folder',
      default_cwd: '/srv/ops',
    }));

    const result = await resolveArtifactsDir({ id: 'r1', output_root: null }, 'cb-1', '/srv/ops');

    expect(result).toBe(dir);
  });

  test('resolves a no-remote local repo to _local/<basename>', async () => {
    const dir = join(archonHome, 'workspaces', '_local', 'workspace', 'artifacts', 'runs', 'r2');
    await mkdir(dir, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'repo',
      name: 'workspace',
      default_cwd: '/home/u/workspace',
    }));

    const result = await resolveArtifactsDir(
      { id: 'r2', output_root: null },
      'cb-2',
      '/home/u/workspace'
    );

    expect(result).toBe(dir);
  });

  test('a persisted output_root is preferred over re-deriving from the codebase', async () => {
    const root = join(archonHome, 'workspaces', 'acme', 'original');
    const dir = join(root, 'artifacts', 'runs', 'r3');
    await mkdir(dir, { recursive: true });
    // The codebase resolves somewhere else entirely (renamed since the run).
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'repo',
      name: 'acme/renamed-since',
      default_cwd: '/repos/renamed',
    }));

    const result = await resolveArtifactsDir(
      { id: 'r3', output_root: root },
      'cb-3',
      '/repos/renamed'
    );

    expect(result).toBe(dir);
  });

  test('ignores an output_root outside ARCHON_HOME rather than reading from it', async () => {
    // Same trust boundary the artifact routes and the executor apply. The
    // codebase still resolves, so the run remains readable — the hostile
    // pointer is simply not a candidate.
    const dir = join(archonHome, 'workspaces', '_local', 'workspace', 'artifacts', 'runs', 'r7');
    await mkdir(dir, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => ({
      kind: 'repo',
      name: 'workspace',
      default_cwd: '/home/u/workspace',
    }));

    const result = await resolveArtifactsDir(
      { id: 'r7', output_root: '/etc' },
      'cb-7',
      '/home/u/workspace'
    );

    expect(result).toBe(dir);
  });

  test('falls back to the legacy in-repo location for pre-#2200 runs', async () => {
    const workingPath = await mkdtemp(join(tmpdir(), 'archon-legacy-'));
    const legacy = join(workingPath, '.archon', 'artifacts', 'runs', 'r4');
    await mkdir(legacy, { recursive: true });
    mockGetCodebase.mockImplementationOnce(async () => null);
    try {
      const result = await resolveArtifactsDir(
        { id: 'r4', output_root: null },
        'cb-4',
        workingPath
      );
      expect(result).toBe(legacy);
    } finally {
      await rm(workingPath, { recursive: true, force: true });
    }
  });

  test('returns null when no candidate exists on disk', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);
    const result = await resolveArtifactsDir(
      { id: 'r5', output_root: null },
      'cb-5',
      '/nonexistent/path'
    );
    expect(result).toBeNull();
  });

  test('a codebase lookup failure still tries the remaining candidates', async () => {
    const workingPath = await mkdtemp(join(tmpdir(), 'archon-dberr-'));
    const legacy = join(workingPath, '.archon', 'artifacts', 'runs', 'r6');
    await mkdir(legacy, { recursive: true });
    mockGetCodebase.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    try {
      const result = await resolveArtifactsDir(
        { id: 'r6', output_root: null },
        'cb-6',
        workingPath
      );
      expect(result).toBe(legacy);
    } finally {
      await rm(workingPath, { recursive: true, force: true });
    }
  });
});

describe('continueCommand estate ownership', () => {
  const environment = {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'task',
    workflow_id: 'old-task',
    provider: 'worktree',
    working_path: '/worktrees/feature-live-pr',
    branch_name: 'feature/live-pr',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'cli',
    created_by_user_id: null,
    metadata: {},
    codebase_default_cwd: '/repo',
  } as const;

  test('adopts the exact prior run instead of bypassing provenance', async () => {
    const priorRun = {
      id: 'run-old',
      workflow_name: 'implement',
      status: 'failed',
    } as unknown as WorkflowRun;
    mockFindActiveByBranchName.mockResolvedValueOnce(environment);
    mockFindLatestRunByWorkingPath.mockResolvedValueOnce(priorRun);

    await continueCommand('feature/live-pr', 'finish it', {
      workflow: 'archon-fix',
      noContext: true,
    });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      environment.working_path,
      'archon-fix',
      'finish it',
      { adoptRunId: 'run-old', codebaseId: 'cb-1' }
    );
  });

  test('uses the already resolved worktree directly when no prior run exists', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(environment);
    mockFindLatestRunByWorkingPath.mockResolvedValueOnce(null);

    await continueCommand('feature/live-pr', 'start here', {
      workflow: 'archon-fix',
      noContext: true,
    });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      environment.working_path,
      'archon-fix',
      'start here',
      { noWorktree: true, codebaseId: 'cb-1' }
    );
  });

  test('does not derive estate selection from the user message', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(environment);
    mockFindLatestRunByWorkingPath.mockResolvedValueOnce(null);

    await continueCommand('feature/live-pr', 'please work on branch other/branch', {
      noContext: true,
    });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      environment.working_path,
      'archon-assist',
      'please work on branch other/branch',
      { noWorktree: true, codebaseId: 'cb-1' }
    );
  });
});
