/** Creating a worktree, or adopting the one already there, for an isolation request. */
import {
  TEST_ARCHON_HOME,
  addSafeDirectorySpy,
  adoptionWarnings,
  errno,
  execSpy,
  findWorktreeByBranchSpy,
  getCanonicalRepoPathSpy,
  getCurrentBranchStrictSpy,
  getDefaultBranchSpy,
  getDefaultRemoteSpy,
  getGitCheckoutIdentitySpy,
  gitCalls,
  holdSetupLockFromAdd,
  issueRequest,
  listWorktreesSpy,
  mkdirSpy,
  mockAccess,
  mockReadFile,
  mockRm,
  prRequest,
  ranGit,
  readWorktreeLockSpy,
  realGit,
  refreshWorktreeIndexSpy,
  resetWorktreeMocks,
  syncResult,
  syncWorkspaceSpy,
  unlockWorktreeSpy,
  verifyWorktreeOwnershipSpy,
  worktreeExistsSpy,
} from './worktree-test-fixture';
import { describe, test, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { join } from 'node:path';
import * as git from '@archon/git';
import * as worktreeCopy from '../worktree-copy';
import type {
  IsolationRequest,
  TaskBranchSelection,
  WorktreeCreateConfig,
  WorktreeSetupInput,
} from '../types';
import type { IIsolationStore } from '../store';
import { classifyIsolationError } from '../errors';
import { IsolationResolver } from '../resolver';
import { WorktreeProvider } from './worktree';

let provider: WorktreeProvider;
beforeEach(() => {
  resetWorktreeMocks();
  provider = new WorktreeProvider(async () => ({ baseBranch: git.toBranchName('main') }));
});

const withConfig = (config: WorktreeCreateConfig): WorktreeProvider =>
  new WorktreeProvider(async () => config);
const issuePath = (): string => provider.getWorktreePath(issueRequest, 'archon/issue-42');
const worktreeAdds = (): string[][] =>
  gitCalls().filter(args => args.includes('worktree') && args.includes('add'));
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const thrown: unknown = await promise.then(
    () => undefined,
    cause => cause
  );
  if (!(thrown instanceof Error)) throw new Error('Expected create() to reject with an Error');
  return thrown;
};
/** An isolation store whose `create` always fails with `message`. */
const failingStore = (message: string): IIsolationStore => ({
  getById: async () => null,
  findActiveByWorkflow: async () => null,
  listActive: async () => [],
  create: async () => {
    throw new Error(message);
  },
  updateStatus: async () => undefined,
  updateMetadata: async () => undefined,
  markWorktreeDestroyed: async () => undefined,
  countActiveByCodebase: async () => 0,
});
// `.gitmodules` exists; worktree paths exist only between this test's add and remove.
const gitmodulesPresent = (): void => {
  mockAccess.mockImplementation(async (path: unknown) => {
    if (
      typeof path === 'string' &&
      !path.endsWith('.gitmodules') &&
      (!ranGit('add') || ranGit('remove'))
    ) {
      throw errno('ENOENT');
    }
  });
};
const LOCKED_ADD = [
  '-C',
  '/workspace/repo',
  'worktree',
  'add',
  '--lock',
  '--reason',
  expect.stringMatching(/^archon: worktree setup in progress: .+/),
  expect.any(String),
];

describe('a new checkout', () => {
  test('creates worktree for issue workflow', async () => {
    const env = await provider.create(issueRequest);

    expect(env.provider).toBe('worktree');
    expect(env.branchName).toBe(git.toBranchName('archon/issue-42'));
    expect(env.metadata).toHaveProperty('branchCreated', true);
    expect(env.workingPath).toContain('issue-42');
    expect(env.status).toBe('active');
    // --no-track, -b and origin/main as start-point
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'worktree',
        'add',
        '--no-track',
        expect.any(String),
        '-b',
        'archon/issue-42',
        'origin/main',
      ]),
      expect.any(Object)
    );
  });

  test('records the commit a new branch was cut from, read from the created branch', async () => {
    const cutFrom = 'a'.repeat(40);
    execSpy.mockImplementation(async (_cmd: string, args: string[]) =>
      args.includes('rev-parse') && args.includes('HEAD^{commit}')
        ? { stdout: `${cutFrom}\n`, stderr: '' }
        : { stdout: '', stderr: '' }
    );

    const env = await provider.create(issueRequest);

    expect(env.metadata).toMatchObject({ adopted: false, cutFromCommit: cutFrom });
    expect(adoptionWarnings()).toHaveLength(0);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', env.workingPath, 'rev-parse', '--verify', 'HEAD^{commit}'],
      expect.any(Object)
    );
  });

  test('removes the locked checkout when reading its cut-from commit fails', async () => {
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('rev-parse') && args.includes('HEAD^{commit}')) {
        throw new Error('fatal: not a valid object name HEAD');
      }
      return { stdout: '', stderr: '' };
    });
    holdSetupLockFromAdd();

    await expect(provider.create(issueRequest)).rejects.toThrow(/not a valid object name/);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'remove', '--force', '--force']),
      expect.any(Object)
    );
  });

  test('checks out an existing issue branch as it is', async () => {
    execSpy.mockResolvedValueOnce({ stdout: 'existing-branch-sha\n', stderr: '' });

    const env = await provider.create(issueRequest);

    expect(env.metadata).toHaveProperty('branchCreated', false);
    expect(env.metadata).not.toHaveProperty('cutFromCommit');
    expect(env.resolvedBaseBranch).toBeUndefined();
    expect(gitCalls().some(args => args.includes('branch') && args.includes('-f'))).toBe(false);
    expect(gitCalls()).toContainEqual([...LOCKED_ADD, 'archon/issue-42']);
  });

  test.each<IsolationRequest>([
    issueRequest,
    { ...issueRequest, workflowType: 'review' },
    { ...issueRequest, workflowType: 'thread' },
    { ...issueRequest, workflowType: 'task', taskBranch: { kind: 'new' } },
  ])(
    'checks out an existing remote-only $workflowType branch with no known base',
    async request => {
      const branch = provider.generateBranchName(request);
      execSpy.mockImplementation(async (_cmd, args) => ({
        stdout: args.includes('ls-remote') ? `remote-sha\trefs/heads/${branch}\n` : '',
        stderr: '',
      }));

      const env = await provider.create(request);

      expect(env.resolvedBaseBranch).toBeUndefined();
      expect(env.metadata).not.toHaveProperty('cutFromCommit');
      expect(env.metadata).toHaveProperty('branchCreated', true);
      expect(gitCalls()).toContainEqual([
        ...LOCKED_ADD.slice(0, -1),
        '--track',
        expect.any(String),
        '-b',
        branch,
        `origin/${branch}`,
      ]);
    }
  );

  test('refreshes the index of a worktree it created, once, after creating it', async () => {
    let addedBeforeRefresh = false;
    refreshWorktreeIndexSpy.mockImplementation(async () => {
      addedBeforeRefresh = worktreeAdds().length > 0;
    });

    const env = await provider.create(issueRequest);

    expect(refreshWorktreeIndexSpy.mock.calls).toEqual([[git.toWorktreePath(env.workingPath)]]);
    expect(addedBeforeRefresh).toBe(true);
  });

  test('a failed index refresh still creates the worktree', async () => {
    refreshWorktreeIndexSpy.mockRejectedValue(new Error('index.lock exists'));

    const env = await provider.create(issueRequest);

    expect(env.status).toBe('active');
  });

  test('trusts a new checkout before Git reads, submodules, refresh, and identity', async () => {
    const access = mockAccess.getMockImplementation();
    if (!access) throw new Error('Missing filesystem fixture');
    mockAccess.mockImplementation(async path => {
      if (typeof path === 'string' && path.endsWith('.gitmodules')) return;
      await access(path);
    });
    const assertTrusted = (path: string): void => {
      expect(addSafeDirectorySpy).toHaveBeenCalledWith(git.toRepoPath(path));
    };
    execSpy.mockImplementation(async (_command, args) => {
      if (args[0] === '-C' && args[1] !== issueRequest.canonicalRepoPath) {
        assertTrusted(args[1]);
      }
      return { stdout: '', stderr: '' };
    });
    refreshWorktreeIndexSpy.mockImplementation(async path => assertTrusted(path));
    getGitCheckoutIdentitySpy.mockImplementation(async path => {
      assertTrusted(path);
      return { gitDir: '/git/worktrees/test', commonGitDir: '/git', linkedWorktree: true };
    });

    const env = await provider.create(issueRequest);
    expect(addSafeDirectorySpy.mock.calls).toEqual([[git.toRepoPath(env.workingPath)]]);
    expect(ranGit('submodule')).toBe(true);
    expect(refreshWorktreeIndexSpy).toHaveBeenCalled();
    expect(getGitCheckoutIdentitySpy).toHaveBeenCalled();
  });

  test('safe directory failure prevents setup and environment return', async () => {
    addSafeDirectorySpy.mockRejectedValueOnce(new Error('config locked'));
    await expect(provider.create(issueRequest)).rejects.toThrow('config locked');
    expect(refreshWorktreeIndexSpy).not.toHaveBeenCalled();
    expect(getGitCheckoutIdentitySpy).not.toHaveBeenCalled();
  });

  test('does not run git checkout or reset --hard on canonical repo', async () => {
    await provider.create(issueRequest);

    expect(gitCalls().filter(args => args.includes('checkout') && !args.includes('-b'))).toEqual(
      []
    );
    expect(gitCalls().filter(args => args.includes('reset') && args.includes('--hard'))).toEqual(
      []
    );
  });

  test('creates worktree under project-scoped path for locally-registered repo', async () => {
    const env = await provider.create({
      codebaseId: 'cb-local',
      codebaseName: 'Widinglabs/sasha-demo',
      canonicalRepoPath: git.toRepoPath('/Users/rasmus/Projects/sasha-demo'), // not under workspaces
      workflowType: 'task',
      identifier: 'fix-issue-42',
    });

    const projectWorktrees = join(
      TEST_ARCHON_HOME,
      'workspaces',
      'Widinglabs',
      'sasha-demo',
      'worktrees'
    );
    expect(env.workingPath).toBe(join(projectWorktrees, env.branchName));
    expect(mkdirSpy).toHaveBeenCalledWith(projectWorktrees, { recursive: true });
  });

  test('refuses a pre-existing directory without removing its contents', async () => {
    mockAccess.mockResolvedValue(undefined);
    await expect(provider.create(issueRequest)).rejects.toThrow(
      'a pre-existing directory occupies this path'
    );
    expect(mockRm).not.toHaveBeenCalled();
    expect(ranGit('add')).toBe(false);
  });

  test('throws when checking for a pre-existing directory fails with a non-ENOENT error', async () => {
    mockAccess.mockRejectedValue(errno('EACCES', 'EACCES: permission denied'));

    await expect(provider.create(issueRequest)).rejects.toThrow('Failed to check directory');
  });
});

describe('task branches', () => {
  const task = (taskBranch: TaskBranchSelection | undefined): IsolationRequest => ({
    ...issueRequest,
    workflowType: 'task',
    identifier: taskBranch?.kind === 'existing' ? 'adopt-run-1' : 'test-adapters',
    taskBranch,
  });
  const fromAdapters = task({
    kind: 'new',
    fromBranch: git.toBranchName('feature/extract-adapters'),
  });
  const existingLivePr = task({ kind: 'existing', branch: git.toBranchName('feature/live-pr') });
  const ALREADY_EXISTS =
    'Branch "archon/task-test-adapters" already exists. Cannot create it from "feature/extract-adapters".';

  test('creates task worktree from specified fromBranch', async () => {
    await provider.create(fromAdapters);

    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'worktree',
        'add',
        '--no-track',
        expect.any(String),
        '-b',
        'archon/task-test-adapters',
        'feature/extract-adapters',
      ]),
      expect.any(Object)
    );
  });

  test('throws when branch already exists and fromBranch is specified', async () => {
    execSpy.mockResolvedValueOnce({ stdout: 'existing-branch-sha\n', stderr: '' });

    await expect(provider.create(fromAdapters)).rejects.toThrow(ALREADY_EXISTS);
  });

  test('refuses --from when the branch exists only on the remote', async () => {
    execSpy.mockImplementation(async (_cmd: string, args: string[]) =>
      args.includes('ls-remote')
        ? { stdout: 'remote-sha\trefs/heads/archon/task-test-adapters\n', stderr: '' }
        : { stdout: '', stderr: '' }
    );

    await expect(provider.create(fromAdapters)).rejects.toThrow(ALREADY_EXISTS);
    expect(ranGit('worktree')).toBe(false);
  });

  test('names the remote and branch when the remote branch lookup fails', async () => {
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) throw new Error('fatal: unable to access remote');
      return { stdout: '', stderr: '' };
    });

    const error = await rejection(provider.create(task(undefined)));
    expect(String(error)).toContain(
      "Cannot check whether branch 'archon/task-test-adapters' exists on 'origin': fatal: unable to access remote"
    );
    expect(error.cause).toBeInstanceOf(Error);
    expect(ranGit('worktree')).toBe(false);
  });

  test('checks out an exact existing task branch without creating or syncing a branch', async () => {
    const env = await provider.create(existingLivePr);

    expect(env.branchName).toBe(git.toBranchName('feature/live-pr'));
    expect(env.metadata).toMatchObject({ adopted: true, adoptedFrom: 'branch' });
    expect(adoptionWarnings()).toHaveLength(1);
    // Adoption continues an existing branch; it never claims a cut-from commit.
    expect(Object.hasOwn(env.metadata, 'cutFromCommit')).toBe(false);
    expect(env.resolvedBaseBranch).toBeUndefined();
    expect(syncWorkspaceSpy).not.toHaveBeenCalled();
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      [...LOCKED_ADD, 'feature/live-pr'],
      expect.any(Object)
    );
  });

  test("does not remove another attempt's worktree when add fails", async () => {
    execSpy.mockRejectedValueOnce(new Error('checkout interrupted'));
    mockAccess.mockRejectedValueOnce(errno('ENOENT')).mockResolvedValue(undefined);
    readWorktreeLockSpy.mockResolvedValue({
      reason: 'archon: worktree setup in progress: other-attempt',
    });

    await expect(provider.create(existingLivePr)).rejects.toThrow('checkout interrupted');
    expect(ranGit('remove')).toBe(false);
    expect(mockRm).not.toHaveBeenCalled();
  });

  test('reuses an exact task branch worktree discovered outside the expected path', async () => {
    listWorktreesSpy.mockResolvedValue([
      {
        path: git.toWorktreePath('/external/worktrees/feature-live-pr'),
        branch: git.toBranchName('feature/live-pr'),
      },
    ]);
    verifyWorktreeOwnershipSpy.mockImplementation(async path => {
      expect(addSafeDirectorySpy).toHaveBeenCalledWith(git.toRepoPath(path));
    });

    const env = await provider.create(existingLivePr);

    expect(verifyWorktreeOwnershipSpy).toHaveBeenCalledWith(
      '/external/worktrees/feature-live-pr',
      existingLivePr.canonicalRepoPath
    );
    expect(env.workingPath).toBe('/external/worktrees/feature-live-pr');
    expect(env.resolvedBaseBranch).toBeUndefined();
    expect(env.metadata).toMatchObject({ adopted: true, adoptedFrom: 'branch' });
    expect(adoptionWarnings()).toHaveLength(1);
    expect(syncWorkspaceSpy).not.toHaveBeenCalled();
  });

  test('refuses an expected-path worktree on a different branch', async () => {
    worktreeExistsSpy.mockResolvedValueOnce(true);
    getCurrentBranchStrictSpy.mockResolvedValueOnce(git.toBranchName('other/branch'));

    await expect(provider.create(existingLivePr)).rejects.toThrow(
      "expected branch 'feature/live-pr', found 'other/branch'"
    );
  });

  test('preserves an unexpected current-branch probe failure', async () => {
    worktreeExistsSpy.mockResolvedValueOnce(true);
    getCurrentBranchStrictSpy.mockRejectedValueOnce(new Error('git probe timed out'));

    await expect(provider.create(existingLivePr)).rejects.toThrow(/git probe timed out/);
  });
});

describe('adopting an existing checkout', () => {
  test('adopts the worktree at the expected path without syncing, setting up or refreshing it', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    const copy = spyOn(worktreeCopy, 'copyWorktreeFiles').mockResolvedValue([]);
    try {
      const env = await withConfig({ copyFiles: ['.env'] }).create(issueRequest);

      expect(env.resolvedBaseBranch).toBeUndefined();
      expect(env.metadata).toHaveProperty('adopted', true);
      expect(env.workingPath).toContain('issue-42');
      expect(adoptionWarnings()).toHaveLength(1);
      expect(adoptionWarnings()[0][0]).toMatchObject({
        worktreePath: env.workingPath,
        branchName: env.branchName,
        codebaseId: issueRequest.codebaseId,
        workflowType: issueRequest.workflowType,
        identifier: issueRequest.identifier,
      });
      expect(ranGit('add')).toBe(false);
      expect(syncWorkspaceSpy).not.toHaveBeenCalled();
      expect(getDefaultBranchSpy).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(refreshWorktreeIndexSpy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
  });

  test('trusts an existing checkout before ownership verification', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    verifyWorktreeOwnershipSpy.mockImplementation(async path => {
      expect(addSafeDirectorySpy).toHaveBeenCalledWith(git.toRepoPath(path));
    });
    const env = await provider.create(issueRequest);
    expect(env.metadata.adopted).toBe(true);
  });

  test('refuses a worktree belonging to a different clone', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    verifyWorktreeOwnershipSpy.mockRejectedValueOnce(
      new Error('Worktree belongs to a different clone (/different/repo/.git).')
    );

    await expect(provider.create(issueRequest)).rejects.toThrow(/belongs to a different clone/);
  });

  test('refuses a worktree whose setup never finished instead of adopting it', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    // A previous run died between `git worktree add` and the end of its setup,
    // so its lock is still on the checkout.
    readWorktreeLockSpy.mockResolvedValue({ reason: 'archon: worktree setup in progress' });

    const error = await rejection(provider.create(issueRequest));

    expect(error.message).toMatch(/its setup did not finish/);
    expect(adoptionWarnings()).toHaveLength(0);
    // The operator is told which checkout and the command that clears it.
    expect(classifyIsolationError(error)).toContain(
      `git worktree remove --force --force ${issuePath()}`
    );
    // Refusing is the whole point: nothing may be created over it either.
    expect(ranGit('add')).toBe(false);
  });

  test('adopts a worktree locked by someone other than a setup in progress', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    // A user lock (portable media, manual pin) is not Archon's marker and says
    // nothing about whether setup finished.
    readWorktreeLockSpy.mockResolvedValue({ reason: 'on the external drive' });

    const env = await provider.create(issueRequest);

    expect(env.metadata).toHaveProperty('adopted', true);
  });

  describe('found by its PR branch elsewhere (skill symbiosis)', () => {
    beforeEach(() => {
      findWorktreeByBranchSpy.mockResolvedValue(
        git.toWorktreePath('/workspace/worktrees/repo/feature-auth')
      );
    });

    test('adopts it', async () => {
      const env = await provider.create(prRequest(false));

      expect(env.workingPath).toBe('/workspace/worktrees/repo/feature-auth');
      expect(env.resolvedBaseBranch).toBeUndefined();
      expect(env.metadata).toHaveProperty('adopted', true);
      expect(env.metadata).toHaveProperty('adoptedFrom', 'branch');
      expect(adoptionWarnings()).toHaveLength(1);
      expect(ranGit('add')).toBe(false);
    });

    test('refuses it when it belongs to a different clone', async () => {
      verifyWorktreeOwnershipSpy.mockRejectedValueOnce(
        new Error('Worktree belongs to a different clone (/other/clone/.git).')
      );

      await expect(provider.create(prRequest(false))).rejects.toThrow(
        /belongs to a different clone/
      );
      expect(adoptionWarnings()).toHaveLength(0);
    });

    test('refuses it when its setup never finished', async () => {
      readWorktreeLockSpy.mockResolvedValue({ reason: 'archon: worktree setup in progress' });

      await expect(provider.create(prRequest(false))).rejects.toThrow(/its setup did not finish/);
    });
  });
});

describe('same-repo PRs', () => {
  test.each([
    [undefined, 'origin'],
    ['upstream', 'upstream'],
  ])('checks out the PR branch tracking %s', async (configuredRemote, remote) => {
    const environment = await withConfig({
      baseBranch: git.toBranchName('main'),
      remote: configuredRemote,
    }).create(prRequest(false));

    expect(environment.branchName).toBe(git.toBranchName('feature/auth'));
    expect(environment.metadata).toHaveProperty('branchCreated', true);
    expect(syncWorkspaceSpy).toHaveBeenCalledWith(
      '/workspace/repo',
      git.toBranchName('feature/auth'),
      { mode: 'fetch-only', remote }
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'worktree',
        'add',
        expect.any(String),
        '-b',
        'feature/auth',
        `${remote}/feature/auth`,
      ]),
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        expect.any(String),
        'branch',
        '--set-upstream-to',
        `${remote}/feature/auth`,
      ]),
      expect.any(Object)
    );
  });

  test('handles existing branch for same-repo PR', async () => {
    execSpy.mockResolvedValueOnce({ stdout: 'existing-branch-sha\n', stderr: '' });

    const environment = await provider.create(prRequest(false));

    expect(environment.metadata).toHaveProperty('branchCreated', false);
    // The existing local branch is selected before add runs.
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'worktree',
        'add',
        expect.any(String),
        'feature/auth',
      ]),
      expect.any(Object)
    );
  });

  test('wraps a PR branch fetch failure and creates nothing', async () => {
    // syncWorkspace owns fetch retries; the provider only reports what it returns.
    const fetchError =
      "Sync fetch from origin/feature/auth failed: error: cannot lock ref 'refs/remotes/origin/feature/auth': is at de581e24 but expected 8eaa8d42";
    syncWorkspaceSpy.mockImplementation(async (_repo, branch) => {
      if (branch === git.toBranchName('feature/auth')) throw new Error(fetchError);
      return syncResult();
    });

    // The outer wrap names the PR; the inner one separates fetch failures from add failures.
    await expect(provider.create(prRequest(false))).rejects.toThrow(
      `Failed to create worktree for PR #42: Fetch origin/feature/auth failed: ${fetchError}`
    );
    expect(syncWorkspaceSpy).toHaveBeenCalledTimes(2);
    expect(worktreeAdds()).toEqual([]);
  });
});

describe('fork PRs', () => {
  test.each([
    [undefined, 'origin'],
    ['upstream', 'upstream'],
  ])('fetches the PR ref from %s into the review branch', async (configuredRemote, remote) => {
    const environment = await withConfig({
      baseBranch: git.toBranchName('main'),
      remote: configuredRemote,
    }).create(prRequest(true));

    expect(environment.branchName).toBe(git.toBranchName('pr-42-review'));
    expect(environment.metadata).toHaveProperty('branchCreated', true);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'fetch',
        remote,
        'pull/42/head:pr-42-review',
      ]),
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'worktree',
        'add',
        expect.any(String),
        'pr-42-review',
      ]),
      expect.any(Object)
    );
  });

  test('checks out the exact head SHA for a reproducible review', async () => {
    const environment = await provider.create(prRequest(true, { prSha: 'abc123def456' }));

    expect(environment.branchName).toBe(git.toBranchName('pr-42-review'));
    expect(environment.metadata).toHaveProperty('branchCreated', true);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-C', '/workspace/repo', 'fetch', 'origin', 'pull/42/head']),
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        '/workspace/repo',
        'worktree',
        'add',
        expect.any(String),
        'abc123def456',
      ]),
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        '-C',
        expect.any(String),
        'checkout',
        '-b',
        'pr-42-review',
        'abc123def456',
      ]),
      expect.any(Object)
    );
  });

  test('replaces a stale review branch when checking out a head SHA', async () => {
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => ({
      stdout: args.includes('--quiet') ? 'existing-review-sha\n' : '',
      stderr: '',
    }));

    await provider.create(prRequest(true, { prSha: 'abc123' }));

    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/repo', 'branch', '-D', 'pr-42-review'],
      expect.any(Object)
    );
    expect(gitCalls().filter(args => args.includes('checkout'))).toHaveLength(1);
  });

  describe('with a head SHA whose review-branch checkout fails', () => {
    const failCheckout = (removeError?: Error): void => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('checkout') && args.includes('-b')) {
          throw new Error('fatal: reference is not a tree: abc123');
        }
        if (removeError && args.includes('remove')) throw removeError;
        return { stdout: '', stderr: '' };
      });
      holdSetupLockFromAdd();
    };

    test('removes the locked checkout it added', async () => {
      failCheckout();

      await expect(provider.create(prRequest(true, { prSha: 'abc123' }))).rejects.toThrow(
        /Failed to create worktree for PR #42: fatal: reference is not a tree/
      );
      // Forced twice: git refuses to remove a locked worktree otherwise.
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove', '--force', '--force']),
        expect.any(Object)
      );
    });

    test('reports a rollback that could not finish', async () => {
      failCheckout(new Error('permission denied'));

      const error = await rejection(provider.create(prRequest(true, { prSha: 'abc123' })));

      expect(classifyIsolationError(error)).toContain('was left behind');
    });
  });

  test.each(['already exists', 'cannot lock ref: unable to update local ref'])(
    'a fork fetch failure containing %s never deletes a branch and has bounded retries',
    async text => {
      const error = new git.GitFailure(
        'unclassified',
        `git fetch failed: ${text}`,
        Object.assign(new Error(text), { code: 128, stderr: text })
      );
      let fetches = 0;
      execSpy.mockImplementation(async (_cmd, args) => {
        if (args.includes('fetch')) {
          fetches++;
          throw error;
        }
        return { stdout: '', stderr: '' };
      });
      await expect(provider.create(prRequest(true))).rejects.toThrow(text);
      expect(fetches).toBe(3);
      expect(ranGit('-D')).toBe(false);
    }
  );

  test.each([
    [
      'lock prose',
      "error: cannot lock ref 'refs/heads/pr-42-review': is at de581e24 but expected 8eaa8d42\n" +
        '! 8eaa8d420..de581e24b pr-42-review -> pr-42-review (unable to update local ref)',
    ],
    ['a missing remote', "fatal: 'origin' does not appear to be a git repository"],
  ])(
    'does not retry a fetch failure without an exit status, even with %s',
    async (_label, text) => {
      const error = Object.assign(new Error(text), { stderr: text });
      let fetchCalls = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          fetchCalls++;
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(prRequest(true))).rejects.toThrow(
        `Failed to create worktree for PR #42: ${text}`
      );
      expect(fetchCalls).toBe(1);
      expect(ranGit('add')).toBe(false);
    }
  );

  test('adopts an expected-path worktree by its synthetic review branch', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    getCurrentBranchStrictSpy.mockResolvedValue(git.toBranchName('pr-42-review'));

    const environment = await provider.create(prRequest(true));

    expect(getCurrentBranchStrictSpy).toHaveBeenCalledWith(environment.workingPath);
    expect(environment.branchName).toBe(git.toBranchName('pr-42-review'));
    expect(environment.metadata).toHaveProperty('adopted', true);
    expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
  });

  test('refuses an expected-path worktree on a different branch', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    getCurrentBranchStrictSpy.mockResolvedValue(git.toBranchName('feature/auth'));

    await expect(provider.create(prRequest(true))).rejects.toThrow(
      "expected branch 'pr-42-review', found 'feature/auth'"
    );
    expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
  });

  describe('two launches racing for one review checkout', () => {
    // The loser's `worktree add` fails after both launches saw no registered
    // checkout; the third `listWorktrees` then finds the winner's.
    const race = () => {
      const request = prRequest(true);
      const providerAt = (path: string): [WorktreeProvider, string] => {
        const config = { baseBranch: git.toBranchName('main'), path };
        const racer = withConfig(config);
        return [racer, racer.getWorktreePath(request, racer.generateBranchName(request), config)];
      };
      const [winner, winningPath] = providerAt('.worktrees/winner');
      const [loser, losingPath] = providerAt('.worktrees/loser');
      const defaultAccess = mockAccess.getMockImplementation();
      mockAccess.mockImplementation(async path => {
        if (path === losingPath) throw errno('ENOENT');
        return defaultAccess?.(path);
      });

      let releaseInitialLookups!: () => void;
      const initialLookupsComplete = new Promise<void>(resolve => {
        releaseInitialLookups = resolve;
      });
      let lists = 0;
      listWorktreesSpy.mockImplementation(async () => {
        lists++;
        if (lists > 2) {
          return [
            { path: git.toWorktreePath(winningPath), branch: git.toBranchName('pr-42-review') },
          ];
        }
        if (lists === 2) releaseInitialLookups();
        await initialLookupsComplete;
        return [];
      });

      let releaseWorktreeAdds!: () => void;
      const worktreeAddsComplete = new Promise<void>(resolve => {
        releaseWorktreeAdds = resolve;
      });
      let adds = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('worktree') && args.includes('add')) {
          adds++;
          if (adds === 2) releaseWorktreeAdds();
          await worktreeAddsComplete;
          if (!args.includes(winningPath)) {
            throw new Error('simulated concurrent worktree rejection');
          }
        }
        return { stdout: '', stderr: '' };
      });
      return { request, winner, loser, winningPath, counts: () => ({ lists, adds }) };
    };

    test('the loser adopts the registered review checkout', async () => {
      const { request, winner, loser, winningPath, counts } = race();

      const [created, adopted] = await Promise.all([winner.create(request), loser.create(request)]);

      expect(created.workingPath).toBe(winningPath);
      expect(created.metadata).toHaveProperty('adopted', false);
      expect(adopted.workingPath).toBe(winningPath);
      expect(adopted.branchName).toBe(git.toBranchName('pr-42-review'));
      expect(adopted.metadata).toMatchObject({ adopted: true, adoptedFrom: 'branch' });
      expect(adoptionWarnings()).toHaveLength(1);
      expect(counts()).toEqual({ lists: 3, adds: 2 });
      expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
    });

    test('a failed isolation record does not destroy the adopted checkout', async () => {
      const { request, winner, loser, counts } = race();
      const destroySpy = spyOn(loser, 'destroy');
      const resolver = new IsolationResolver({
        store: failingStore('DB constraint violation'),
        provider: loser,
      });

      const [winningResult, losingResult] = await Promise.allSettled([
        winner.create(request),
        resolver.resolve({
          existingEnvId: null,
          codebase: { id: 'cb-123', defaultCwd: '/workspace/repo', name: 'owner/repo' },
          hints: {
            workflowType: 'pr',
            workflowId: '42',
            prBranch: git.toBranchName('feature/auth'),
            isForkPR: true,
          },
          platformType: 'web',
        }),
      ]);

      expect(winningResult.status).toBe('fulfilled');
      expect(losingResult).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'DB constraint violation' }),
      });
      expect(destroySpy).not.toHaveBeenCalled();
      expect(counts()).toEqual({ lists: 3, adds: 2 });
    });
  });

  test('keeps concurrent fork-PR launches for different PRs independent', async () => {
    const environments = await Promise.all([
      provider.create(prRequest(true)),
      provider.create(
        prRequest(true, { identifier: '43', prBranch: git.toBranchName('feature/billing') })
      ),
    ]);

    expect(environments.map(environment => environment.metadata.adopted)).toEqual([false, false]);
    const addedRefs = worktreeAdds().map(args => args.at(-1));
    expect(addedRefs).toContain('pr-42-review');
    expect(addedRefs).toContain('pr-43-review');
    expect(listWorktreesSpy).toHaveBeenCalledTimes(2);
    expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
  });

  describe('when only a slug-colliding branch is registered', () => {
    const collidingPath = git.toWorktreePath('/workspace/worktrees/pr-42-review');
    beforeEach(() => {
      listWorktreesSpy.mockResolvedValue([
        { path: collidingPath, branch: git.toBranchName('pr/42/review') },
      ]);
      findWorktreeByBranchSpy.mockResolvedValue(collidingPath);
    });

    test('creates its own review checkout instead of adopting it', async () => {
      const environment = await provider.create(prRequest(true));

      expect(environment.workingPath).not.toBe(collidingPath);
      expect(environment.metadata.adopted).toBe(false);
      expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
    });

    test('preserves its own worktree creation failure', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('worktree') && args.includes('add')) {
          throw new Error('simulated worktree add failure');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(prRequest(true))).rejects.toThrow(
        'Failed to create worktree for PR #42: simulated worktree add failure'
      );
      expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
    });
  });

  test('preserves the fork-PR add error when its dirty checkout cannot be adopted', async () => {
    const request = prRequest(true);
    const worktreePath = provider.getWorktreePath(request, provider.generateBranchName(request));
    listWorktreesSpy
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { path: git.toWorktreePath(worktreePath), branch: git.toBranchName('pr-42-review') },
      ]);
    holdSetupLockFromAdd();
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('add')) throw new Error('post-checkout hook failed');
      return { stdout: args.includes('status') ? '?? hook-work\n' : '', stderr: '' };
    });

    const error = await rejection(provider.create(request));

    expect(error.message).toContain('post-checkout hook failed');
    expect(classifyIsolationError(error)).toContain('contains changes');
    expect(ranGit('remove')).toBe(false);
  });

  test('preserves a fork-PR worktree creation failure when no review checkout is registered', async () => {
    const request = prRequest(true);
    const worktreePath = provider.getWorktreePath(request, provider.generateBranchName(request));
    const defaultAccess = mockAccess.getMockImplementation();
    mockAccess.mockImplementation(async path => {
      if (path === worktreePath) throw errno('ENOENT');
      return defaultAccess?.(path);
    });
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('worktree') && args.includes('add')) {
        throw new Error('simulated worktree add failure');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(provider.create(request)).rejects.toThrow(
      'Failed to create worktree for PR #42: simulated worktree add failure'
    );
    expect(listWorktreesSpy).toHaveBeenCalledTimes(2);
    expect(findWorktreeByBranchSpy).not.toHaveBeenCalled();
  });
});

describe('base branch and remote', () => {
  const baseSynced = (branch: string | undefined, mode = 'fast-forward', remote = 'origin') =>
    expect(syncWorkspaceSpy).toHaveBeenCalledWith('/workspace/repo', branch, { mode, remote });
  const cutFrom = (startPoint: string, branch = 'archon/issue-42') =>
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'worktree',
        'add',
        '--no-track',
        expect.any(String),
        '-b',
        branch,
        startPoint,
      ]),
      expect.any(Object)
    );

  test('cuts from <remote>/<configured base> after syncing it', async () => {
    syncWorkspaceSpy.mockResolvedValue(syncResult('develop'));

    await withConfig({ baseBranch: git.toBranchName('develop') }).create(issueRequest);

    baseSynced('develop');
    expect(getDefaultBranchSpy).not.toHaveBeenCalled();
    cutFrom('origin/develop');
  });

  test('lets the sync auto-detect the base when nothing names one', async () => {
    await withConfig({}).create(issueRequest);

    baseSynced(undefined);
  });

  test('uses request baseBranch when no config baseBranch is set', async () => {
    syncWorkspaceSpy.mockResolvedValue(syncResult('develop'));

    await withConfig({}).create({ ...issueRequest, baseBranch: git.toBranchName('develop') });

    baseSynced('develop');
    cutFrom('origin/develop');
  });

  test('returns the base selected by sync rather than the request hint', async () => {
    syncWorkspaceSpy.mockResolvedValueOnce(syncResult('detected-release'));

    const env = await withConfig({}).create(issueRequest);

    expect(env.resolvedBaseBranch).toBe('detected-release');
    cutFrom('origin/detected-release');
  });

  test('uses configured baseBranch over request baseBranch when both are set', async () => {
    const env = await provider.create({ ...issueRequest, baseBranch: git.toBranchName('develop') });

    expect(env.resolvedBaseBranch).toBe('main');

    baseSynced('main');
  });

  test('uses request baseOverride over configured baseBranch and request baseBranch', async () => {
    const env = await provider.create({
      ...issueRequest,
      baseBranch: git.toBranchName('develop'),
      baseOverride: git.toBranchName('epic/foo'),
    });

    expect(env.resolvedBaseBranch).toBe('main');
    // --base (baseOverride) is the top precedence level.
    baseSynced('epic/foo');
  });

  test("a task's fromBranch is its start point, never the synced base", async () => {
    const env = await withConfig({}).create({
      ...issueRequest,
      workflowType: 'task',
      identifier: 'test-feature',
      taskBranch: { kind: 'new', fromBranch: git.toBranchName('dev') },
    });

    expect(env.resolvedBaseBranch).toBe('main');
    baseSynced(undefined);
  });

  test.each([
    ['resets a managed clone', '/test/.archon/workspaces/owner/repo/source', 'reset'],
    [
      'fast-forwards a checkout that only shares the workspaces prefix',
      '/test/.archon/workspaces-old/owner/repo/source',
      'fast-forward',
    ],
  ])('%s before cutting', async (_label, repoPath, mode) => {
    await withConfig({}).create({ ...issueRequest, canonicalRepoPath: git.toRepoPath(repoPath) });

    expect(syncWorkspaceSpy).toHaveBeenCalledWith(repoPath, undefined, { mode, remote: 'origin' });
  });

  test.each(['Network timeout', 'EACCES: permission denied'])(
    'wraps a sync failure (%s) with the remote it fetched from',
    async message => {
      syncWorkspaceSpy.mockRejectedValue(new Error(message));

      const error = await rejection(provider.create(issueRequest));

      expect(error.message).toContain("Failed to fetch base branch from 'origin'");
      expect(error.message).toContain(message);
    }
  );

  test('a configured base branch that does not exist reaches the operator unwrapped', async () => {
    const missing = new git.ConfiguredBaseBranchNotFoundError('does-not-exist', 'origin');
    syncWorkspaceSpy.mockRejectedValue(missing);

    // The config remedy reaches the operator without network advice.
    const failure = await withConfig({ baseBranch: git.toBranchName('does-not-exist') })
      .create(issueRequest)
      .catch((error: unknown) => error);
    expect(failure).toBe(missing);
  });

  test('throws with config error details when repo config fails to load', async () => {
    const failing = new WorktreeProvider(async () => {
      throw new Error('Config load failed');
    });

    await expect(failing.create(issueRequest)).rejects.toThrow(
      'Failed to load config: Config load failed'
    );
  });

  test('uses the configured remote without auto-detecting one', async () => {
    await withConfig({ baseBranch: git.toBranchName('main'), remote: 'mar' }).create(issueRequest);

    baseSynced('main', 'fast-forward', 'mar');
    expect(getDefaultRemoteSpy).not.toHaveBeenCalled();
    cutFrom('mar/main');
  });

  test('auto-detects remote when not configured', async () => {
    getDefaultRemoteSpy.mockResolvedValue('upstream');

    await provider.create(issueRequest);

    baseSynced('main', 'fast-forward', 'upstream');
  });

  test('fromBranch start-point is not remote-prefixed (task workflow)', async () => {
    await withConfig({ baseBranch: git.toBranchName('main'), remote: 'upstream' }).create({
      ...issueRequest,
      workflowType: 'task',
      identifier: 'my-feature',
      taskBranch: { kind: 'new', fromBranch: git.toBranchName('develop') },
    });

    baseSynced('main', 'fast-forward', 'upstream');
    cutFrom('develop', 'archon/task-my-feature');
  });

  test('throws actionable error when remote is ambiguous', async () => {
    getDefaultRemoteSpy.mockResolvedValue(null);
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      // `git remote` listing for the error message
      if (args.includes('remote') && !args.includes('get-url')) {
        return { stdout: 'jan\nfeb\nmar\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(provider.create(issueRequest)).rejects.toThrow(
      /Cannot determine git remote.*jan, feb, mar.*Set worktree\.remote/s
    );
    // No sync attempted from an unknown remote
    expect(syncWorkspaceSpy).not.toHaveBeenCalled();
  });

  test('throws actionable error when no remote is configured', async () => {
    getDefaultRemoteSpy.mockResolvedValue(null);

    const creation = provider.create(issueRequest);

    await expect(creation).rejects.toThrow(
      /no git remote is configured.*git remote add origin URL.*--no-worktree/s
    );
    await expect(creation).rejects.not.toThrow(/multiple remotes|worktree\.remote/s);
    expect(syncWorkspaceSpy).not.toHaveBeenCalled();
  });
});

describe('submodules', () => {
  const submoduleUpdates = (): string[][] =>
    gitCalls().filter(args => args.includes('submodule') && args.includes('update'));
  const submoduleError = Object.assign(new Error('git submodule update failed'), {
    stderr: 'fatal: could not read from remote repository',
  });
  const failSubmodules = (error: Error, removeError?: Error): void => {
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('submodule')) throw error;
      if (removeError && args.includes('remove')) throw removeError;
      return { stdout: '', stderr: '' };
    });
  };

  test.each([{}, { initSubmodules: true }])(
    'initializes submodules when .gitmodules exists and config is %j',
    async config => {
      gitmodulesPresent();

      await withConfig({ baseBranch: git.toBranchName('main'), ...config }).create(issueRequest);

      expect(submoduleUpdates()).toEqual([
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'submodule',
          'update',
          '--init',
          '--recursive',
        ]),
      ]);
    }
  );

  test('skips submodule init when initSubmodules is false', async () => {
    // Even when .gitmodules exists, explicit opt-out must win.
    gitmodulesPresent();

    await withConfig({ baseBranch: git.toBranchName('main'), initSubmodules: false }).create(
      issueRequest
    );

    expect(submoduleUpdates()).toEqual([]);
  });

  test('skips submodule init when .gitmodules does not exist', async () => {
    await provider.create(issueRequest);

    expect(submoduleUpdates()).toEqual([]);
  });

  test.each([
    ['its stderr', submoduleError, 'fatal: could not read from remote repository'],
    [
      'its message when stderr is empty (a timeout)',
      Object.assign(new Error('Command failed: git submodule update'), {
        killed: true,
        signal: 'SIGTERM',
        stderr: '',
      }),
      'Command failed: git submodule update',
    ],
  ])('a failed init fails creation with %s', async (_label, error, detail) => {
    gitmodulesPresent();
    failSubmodules(error);

    // A worktree with uninitialized submodules is a silent broken state.
    await expect(provider.create(issueRequest)).rejects.toThrow(
      `Submodule initialization failed: ${detail}`
    );
  });

  test('throws when .gitmodules read fails with EACCES (fail-fast, no silent skip)', async () => {
    // Skipping would produce a worktree with empty submodule dirs.
    mockAccess.mockImplementation(async (path: unknown) => {
      throw errno(typeof path === 'string' && path.endsWith('.gitmodules') ? 'EACCES' : 'ENOENT');
    });

    await expect(provider.create(issueRequest)).rejects.toThrow(
      /Submodule initialization failed: cannot read \.gitmodules \(EACCES\)/
    );
    expect(submoduleUpdates()).toEqual([]);
  });

  describe('rollback of a setup that did not finish', () => {
    test('removes the worktree this call created and leaves the branch alone', async () => {
      gitmodulesPresent();
      failSubmodules(submoduleError);
      // The lock is still on while the removal runs, so nothing can adopt the
      // checkout in between.
      holdSetupLockFromAdd();

      const error = await rejection(provider.create(issueRequest));

      expect(error.message).toMatch(/Submodule initialization failed/);
      // Forced twice: once for the partly initialized submodule git refuses to
      // remove, once for the setup lock git refuses to remove past.
      expect(gitCalls().find(args => args.includes('remove'))).toEqual([
        '-C',
        '/workspace/repo',
        'worktree',
        'remove',
        '--force',
        '--force',
        issuePath(),
      ]);
      expect(ranGit('-D')).toBe(false);
      expect(refreshWorktreeIndexSpy).not.toHaveBeenCalled();
      // A rollback that worked must not claim it left something behind.
      expect(classifyIsolationError(error)).not.toContain('was left behind');
      expect((error as { cleanupFailure?: string }).cleanupFailure).toBeUndefined();
    });

    test('keeps the checkout when the setup lock it took is gone', async () => {
      gitmodulesPresent();
      failSubmodules(submoduleError);
      // Another caller unlocked the path, so this call can no longer prove the
      // checkout is still its own to delete.
      readWorktreeLockSpy.mockResolvedValue(null);

      const error = await rejection(provider.create(issueRequest));

      expect(ranGit('remove')).toBe(false);
      const userMessage = classifyIsolationError(error);
      expect(userMessage).toContain('Submodule initialization failed');
      expect(userMessage).toContain('was left behind');
    });

    test.each(['ownership changes', 'status fails'])(
      'preserves the checkout when %s during cleanup',
      async failure => {
        gitmodulesPresent();
        execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
          if (args.includes('submodule')) throw submoduleError;
          if (failure === 'status fails' && args.includes('status'))
            throw new Error('status unavailable');
          return { stdout: '', stderr: '' };
        });
        let lockReads = 0;
        readWorktreeLockSpy.mockImplementation(async () => {
          const add = gitCalls().find(args => args.includes('add'));
          if (!add) throw new Error('Expected locked add');
          lockReads++;
          return {
            reason:
              failure === 'ownership changes' && lockReads > 1
                ? 'archon: worktree setup in progress: another-attempt'
                : add[add.indexOf('--reason') + 1],
          };
        });
        const error = await rejection(provider.create(issueRequest));
        expect(error.message).toContain('Submodule initialization failed');
        expect(classifyIsolationError(error)).toContain('was left behind');
        expect(ranGit('remove')).toBe(false);
      }
    );

    test('reports a failed rollback alongside the setup error instead of replacing it', async () => {
      gitmodulesPresent();
      failSubmodules(submoduleError, new Error('permission denied'));
      holdSetupLockFromAdd();

      const error = await rejection(provider.create(issueRequest));

      expect(error.message).toMatch(/Submodule initialization failed/);
      // The cleanup wording must not outrank the cause: 'permission denied' is
      // classified ahead of a submodule failure when it reaches the message.
      const userMessage = classifyIsolationError(error);
      expect(userMessage).toContain('Submodule initialization failed');
      expect(userMessage).toContain(issuePath());
      expect(userMessage).toContain('permission denied');
    });
  });
});

describe('setup order and the setup lock', () => {
  test('post-create runs after submodules and copies, before refreshing and unlocking', async () => {
    gitmodulesPresent();
    const steps: string[] = [];
    const copy = spyOn(worktreeCopy, 'copyWorktreeFiles').mockImplementation(async () => {
      steps.push('copy');
      return [worktreeCopy.parseCopyFileEntry('.seed')];
    });
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('add')) steps.push('add');
      if (args.includes('submodule')) steps.push('submodule');
      return { stdout: '', stderr: '' };
    });
    refreshWorktreeIndexSpy.mockImplementation(async () => {
      steps.push('refresh');
    });
    unlockWorktreeSpy.mockImplementation(async () => {
      steps.push('unlock');
    });
    const setup = mock(async (input: WorktreeSetupInput) => {
      steps.push('commands');
      expect(input.workingPath).toBe(issuePath());
      expect(input.timeout).toBe(1234);
    });
    const configured = new WorktreeProvider(
      async () => ({ copyFiles: ['.seed'], postCreate: ['true'], postCreateTimeout: 1234 }),
      setup
    );
    try {
      await configured.create(issueRequest);
      expect(steps).toEqual(['add', 'submodule', 'copy', 'commands', 'refresh', 'unlock']);
    } finally {
      copy.mockRestore();
    }
  });

  test('the checkout is born locked, so setup never runs on an adoptable one', async () => {
    gitmodulesPresent();
    const steps: string[] = [];
    unlockWorktreeSpy.mockImplementation(async () => {
      steps.push('unlock');
    });
    refreshWorktreeIndexSpy.mockImplementation(async () => {
      steps.push('refresh');
    });
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[2] === 'worktree' && args[3] === 'add') steps.push('add');
      if (args[2] === 'worktree' && args[3] === 'lock') steps.push('lock');
      if (args.includes('submodule')) steps.push('submodule');
      return { stdout: '', stderr: '' };
    });

    await provider.create(issueRequest);

    // No 'lock' step: git takes the lock as part of the add, so the checkout
    // is marked unfinished from the first instant it exists. A separate lock
    // afterwards would leave a window in which another caller adopts a
    // half-built checkout — and rolls it back under the run using it. The
    // index refresh runs while the lock still holds, so no adopter's git
    // command can contend with it for the index lock.
    expect(steps).toEqual(['add', 'submodule', 'refresh', 'unlock']);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'worktree',
        'add',
        '--lock',
        '--reason',
        expect.stringMatching(/^archon: worktree setup in progress: .+/),
      ]),
      expect.any(Object)
    );
    expect(unlockWorktreeSpy).toHaveBeenCalledWith('/workspace/repo', issuePath());
  });

  test('reports a worktree left locked instead of handing back a silent trap', async () => {
    unlockWorktreeSpy.mockRejectedValue(new Error('fatal: unable to write lock file'));

    const env = await provider.create(issueRequest);

    expect(env.warnings?.join(' ')).toContain('git worktree unlock');
  });
});

describe('file copying', () => {
  let copyWorktreeFilesSpy: Mock<typeof worktreeCopy.copyWorktreeFiles>;
  beforeEach(() => {
    copyWorktreeFilesSpy = spyOn(worktreeCopy, 'copyWorktreeFiles').mockResolvedValue([]);
  });
  afterEach(() => {
    copyWorktreeFilesSpy.mockRestore();
  });

  test('copies exactly the configured files, in order and once each', async () => {
    // `.archon` is copied only when the operator lists it.
    await withConfig({ copyFiles: ['.archon', '.env', '.archon'] }).create(issueRequest);

    expect(copyWorktreeFilesSpy.mock.calls).toEqual([
      ['/workspace/repo', expect.stringContaining('issue-42'), ['.archon', '.env']],
    ]);
  });

  test.each<WorktreeCreateConfig>([{}, { copyFiles: [] }])(
    'copies nothing for %j',
    async config => {
      // A worktree already holds the repo's tracked files. The implicit `.archon` copy
      // that used to happen here also carried IGNORED content (`.archon/.env`, cross-run
      // `state/`) and overwrote the worktree's own tracked `.archon` with another
      // branch's. Workflow source now travels with the run instead.
      await withConfig(config).create(issueRequest);

      expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
    }
  );

  test('does not fail worktree creation if file copying fails', async () => {
    copyWorktreeFilesSpy.mockRejectedValue(new Error('Copy failed'));

    const env = await withConfig({ copyFiles: ['.env'] }).create(issueRequest);

    expect(env.workingPath).toContain('issue-42');
  });
});

describe('infrastructure failures through the resolver', () => {
  for (const path of ['canonicalization', 'config', 'ancestry']) {
    test(`${path} preserves its infrastructure cause`, async () => {
      const cause =
        path === 'ancestry'
          ? new git.GitFailure(
              'unclassified',
              'merge-base failed',
              Object.assign(new Error('ancestry command'), {
                code: 128,
                stderr: 'original git evidence',
              })
            )
          : errno('EACCES', 'read denied');
      const failing = new WorktreeProvider(async () => {
        if (path === 'config') throw cause;
        return { baseBranch: git.toBranchName('main') };
      });
      if (path === 'canonicalization') {
        getCanonicalRepoPathSpy.mockImplementation(realGit.getCanonicalRepoPath);
        mockReadFile.mockRejectedValue(cause);
      }
      if (path === 'ancestry') {
        syncWorkspaceSpy.mockImplementation(realGit.syncWorkspace);
        execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
          if (args.includes('merge-base')) throw cause;
          if (args.includes('rev-parse'))
            return { stdout: args.includes('HEAD') ? 'local-sha' : 'remote-sha', stderr: '' };
          return { stdout: '', stderr: '' };
        });
      }
      const resolver = new IsolationResolver({
        store: failingStore('must not persist a failed creation'),
        provider: failing,
      });
      const resolution = resolver.resolve({
        existingEnvId: null,
        codebase: { id: 'cb-123', defaultCwd: '/workspace/repo', name: 'owner/repo' },
        hints: { workflowType: 'issue', workflowId: '42' },
        platformType: 'web',
      });
      if (path === 'ancestry') {
        const error = await rejection(resolution);
        expect(error.cause).toMatchObject({ cause });
        expect(error.message).toContain('merge-base failed');
        expect(error.message).toContain('original git evidence');
        expect(error.message).toContain('exit code 128');
      } else {
        const result = await resolution;
        expect(result.status).toBe('blocked');
        if (result.status !== 'blocked') throw new Error('expected blocked result');
        expect(result.userMessage).toContain('Permission denied');
      }
    });
  }
});
