/**
 * Shared mocks for the WorktreeProvider unit suites.
 *
 * Import this module before `./worktree`. It replaces `@archon/paths` and
 * `node:fs/promises` for the whole process, so the suites that import it share a
 * `testGroups` entry in package.json with nothing else. Call `resetWorktreeMocks`
 * in a `beforeEach`: it restores the defaults below and drops every recorded call.
 */
import { mock, spyOn } from 'bun:test';
import { join, relative } from 'node:path';
import * as git from '@archon/git';
import type { IsolationRequest, PRIsolationRequest } from '../types';

export const mockWarn = mock<(...args: unknown[]) => void>(() => undefined);
export const adoptionWarnings = (): unknown[][] =>
  mockWarn.mock.calls.filter(([, event]) => event === 'worktree_adopted');

// Fixed test home — path assertions use this constant; no duplication of production isDocker() logic.
export const TEST_ARCHON_HOME = '/test/.archon';

// Capture the production contracts before the package re-export is mocked.
const {
  isPathInside,
  parseOwnerRepo,
  resolveRepoProjectIdentity,
  getArchonHome,
  getProjectWorktreesPath,
} = await import('@archon/paths');

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: mockWarn,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
  getArchonHome: () => TEST_ARCHON_HOME,
  getArchonWorkspacesPath: () => join(TEST_ARCHON_HOME, 'workspaces'),
  isInsideArchonWorkspaces: (p: string) => isPathInside(join(TEST_ARCHON_HOME, 'workspaces'), p),
  getArchonWorktreesPath: () => join(TEST_ARCHON_HOME, 'worktrees'),
  getProjectWorktreesPath: (owner: string, repo: string) =>
    join(TEST_ARCHON_HOME, relative(getArchonHome(), getProjectWorktreesPath(owner, repo))),
  isDocker: () => false,
  parseOwnerRepo,
  resolveRepoProjectIdentity,
}));

export const mockAccess = mock((_path?: unknown): Promise<void> => Promise.resolve());
export const mockLstat = mock(
  (_path?: unknown): Promise<{ isDirectory: () => boolean }> =>
    Promise.resolve({ isDirectory: () => true })
);
export const mockReadFile = mock((_path?: unknown): Promise<string> => Promise.resolve(''));
export const mockRm = mock((_path?: unknown): Promise<void> => Promise.resolve());
// create() requires the registered project path to be a directory.
const mockStat = mock((_path?: unknown) => Promise.resolve({ isDirectory: () => true }));
mock.module('node:fs/promises', () => ({
  access: mockAccess,
  lstat: mockLstat,
  readFile: mockReadFile,
  rm: mockRm,
  stat: mockStat,
  writeFile: mock(() => Promise.resolve()),
}));

/** The real implementations, for a test that needs one behind its spy. */
export const realGit = {
  getCanonicalRepoPath: git.getCanonicalRepoPath,
  syncWorkspace: git.syncWorkspace,
};

export const addSafeDirectorySpy = spyOn(git, 'addSafeDirectory');
export const execSpy = spyOn(git, 'execFileAsync');
export const mkdirSpy = spyOn(git, 'mkdirAsync');
export const worktreeExistsSpy = spyOn(git, 'worktreeExists');
export const listWorktreesSpy = spyOn(git, 'listWorktrees');
export const findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch');
export const getCurrentBranchStrictSpy = spyOn(git, 'getCurrentBranchStrict');
export const getCanonicalRepoPathSpy = spyOn(git, 'getCanonicalRepoPath');
export const getGitCheckoutIdentitySpy = spyOn(git, 'getGitCheckoutIdentity');
export const verifyWorktreeOwnershipSpy = spyOn(git, 'verifyWorktreeOwnership');
export const unlockWorktreeSpy = spyOn(git, 'unlockWorktree');
export const readWorktreeLockSpy = spyOn(git, 'readWorktreeLock');
export const readWorktreeRegistrationSpy = spyOn(git, 'readWorktreeRegistration');
export const getDefaultBranchSpy = spyOn(git, 'getDefaultBranch');
export const getDefaultRemoteSpy = spyOn(git, 'getDefaultRemote');
export const syncWorkspaceSpy = spyOn(git, 'syncWorkspace');
export const refreshWorktreeIndexSpy = spyOn(git, 'refreshWorktreeIndex');

export const errno = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

/** The argument lists of every git command run so far. */
export const gitCalls = (): string[][] => execSpy.mock.calls.map(([, args]) => args);
export const ranGit = (token: string): boolean => gitCalls().some(args => args.includes(token));

export const syncResult = (
  branch = 'main',
  mode: git.WorkspaceSyncMode = 'fast-forward'
): git.WorkspaceSyncResult => ({
  branch: git.toBranchName(branch),
  synced: true,
  mode,
  state: 'in_sync',
  previousHead: '',
  newHead: '',
  updated: false,
});

export const REPO = git.toRepoPath('/workspace/repo');
export const issueRequest: IsolationRequest = {
  codebaseId: 'cb-123',
  canonicalRepoPath: REPO,
  workflowType: 'issue',
  identifier: '42',
};
export const prRequest = (
  isForkPR: boolean,
  extra: Partial<PRIsolationRequest> = {}
): PRIsolationRequest => ({
  codebaseId: 'cb-123',
  canonicalRepoPath: REPO,
  workflowType: 'pr',
  identifier: '42',
  prBranch: git.toBranchName('feature/auth'),
  isForkPR,
  ...extra,
});

/** The checkout this test's `worktree add` created still carries the setup lock it took. */
export const holdSetupLockFromAdd = (): void => {
  readWorktreeLockSpy.mockImplementation(async () => {
    const add = gitCalls().find(args => args.includes('add'));
    return add ? { reason: add[add.indexOf('--reason') + 1] } : null;
  });
};

// Worktree paths are absent until this test's `worktree add` and gone again after its `remove`.
const defaultAccess = async (path: unknown): Promise<void> => {
  const normalizedPath = typeof path === 'string' ? path.replace(/\\/g, '/') : '';
  if (
    normalizedPath.endsWith('.gitmodules') ||
    ((normalizedPath.includes('/worktrees/') || normalizedPath.includes('/.worktrees/')) &&
      (!ranGit('add') || ranGit('remove')))
  ) {
    throw errno('ENOENT');
  }
};

export function resetWorktreeMocks(): void {
  for (const fn of [
    mockWarn,
    mockAccess,
    mockLstat,
    mockReadFile,
    mockRm,
    addSafeDirectorySpy,
    execSpy,
    mkdirSpy,
    worktreeExistsSpy,
    listWorktreesSpy,
    findWorktreeByBranchSpy,
    getCurrentBranchStrictSpy,
    getCanonicalRepoPathSpy,
    getGitCheckoutIdentitySpy,
    verifyWorktreeOwnershipSpy,
    unlockWorktreeSpy,
    readWorktreeLockSpy,
    readWorktreeRegistrationSpy,
    getDefaultBranchSpy,
    getDefaultRemoteSpy,
    syncWorkspaceSpy,
    refreshWorktreeIndexSpy,
  ]) {
    fn.mockReset();
  }
  mockAccess.mockImplementation(defaultAccess);
  mockLstat.mockImplementation(async path => {
    await mockAccess(path);
    return { isDirectory: () => true };
  });
  mockReadFile.mockRejectedValue(errno('ENOENT'));
  mockRm.mockResolvedValue(undefined);

  addSafeDirectorySpy.mockResolvedValue(undefined);
  execSpy.mockResolvedValue({ stdout: '', stderr: '' });
  mkdirSpy.mockResolvedValue(undefined);
  worktreeExistsSpy.mockResolvedValue(false);
  listWorktreesSpy.mockResolvedValue([]);
  findWorktreeByBranchSpy.mockResolvedValue(null);
  getCurrentBranchStrictSpy.mockResolvedValue(null);
  getCanonicalRepoPathSpy.mockImplementation(async path => git.toRepoPath(path));
  getGitCheckoutIdentitySpy.mockResolvedValue({
    gitDir: '/git/worktrees/test',
    commonGitDir: '/git',
    linkedWorktree: true,
  });
  verifyWorktreeOwnershipSpy.mockResolvedValue(undefined);
  unlockWorktreeSpy.mockResolvedValue(undefined);
  // Nothing is mid-setup by default: no worktree carries Archon's setup lock.
  readWorktreeLockSpy.mockResolvedValue(null);
  // Git lists no worktree at the target path unless a test says otherwise.
  readWorktreeRegistrationSpy.mockResolvedValue(null);
  getDefaultBranchSpy.mockResolvedValue(git.toBranchName('main'));
  getDefaultRemoteSpy.mockResolvedValue('origin');
  syncWorkspaceSpy.mockResolvedValue(syncResult());
  // The real refresh waits for the next wall-clock second.
  refreshWorktreeIndexSpy.mockResolvedValue(undefined);
}
