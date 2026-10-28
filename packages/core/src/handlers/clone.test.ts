// @archon-test-isolated
/**
 * Unit tests for clone.ts (cloneRepository, registerRepository)
 *
 * Strategy:
 * - mock.module() for DB modules and @archon/paths (safe — no standalone test files for these)
 * - spyOn() for @archon/git (execFileAsync) and fs/promises (access, rm)
 *   to avoid process-global mock.module pollution that would break git.test.ts
 * - Lazy logger pattern means @archon/paths mock must be set up before the module import
 */
import { describe, test, expect, mock, beforeEach, afterAll, afterEach, spyOn } from 'bun:test';
import { join, resolve } from 'path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { captureStubLogOutput, removeTempTree } from '@archon/paths/test-utils';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '@archon/git';
import * as registrationRemote from '../services/registration-remote';
import type { Codebase } from '../types';
import * as helperInstaller from '../github-auth/credential-helper-install';
import { createGitHubAppAuthProvider } from '../github-auth/auth';
import { AppNotInstalledError } from '../github-auth/errors';
import type * as CodebaseDb from '../db/codebases';
import type * as Commands from '../utils/commands';
import { quoteCommandArg } from '../utils/command-args';
import {
  findCodebaseForCheckoutPath,
  type CodebaseCheckoutResolverDeps,
} from '../services/codebase-checkout-resolver';
import { createMockLogger } from '../test/mocks/logger';

const realFsAccess = fsPromises.access;
const realFsStat = fsPromises.stat;
const realCheckoutRemote = registrationRemote.assertCheckoutRemote;
const realExecFileAsync = gitUtils.execFileAsync;
const realAddSafeDirectory = gitUtils.addSafeDirectory;

// Capture the real functions before the re-export is replaced by the module mock.
const { findCommandFiles: discoverCommandFiles, isPathInside } = await import(
  '@archon/paths/archon-paths'
);

const appRequest = mock(async () => {
  throw Object.assign(new Error('Not Found'), { status: 404 });
});
mock.module('@octokit/rest', () => ({
  Octokit: class {
    request = appRequest;
  },
}));

// ── DB mocks ────────────────────────────────────────────────────────────────
const mockCreateCodebase = mock<typeof CodebaseDb.createCodebase>(() =>
  Promise.resolve({
    id: 'codebase-uuid-1',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo',
    default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);
const mockGetCodebaseCommands = mock<typeof CodebaseDb.getCodebaseCommands>(() =>
  Promise.resolve({})
);
const mockUpdateCodebaseCommands = mock<typeof CodebaseDb.updateCodebaseCommands>(() =>
  Promise.resolve()
);
const mockFindCodebaseByRepoUrl = mock<typeof CodebaseDb.findCodebaseByRepoUrl>(() =>
  Promise.resolve(null)
);
const mockFindCodebaseByDefaultCwd = mock<typeof CodebaseDb.findCodebaseByDefaultCwd>(() =>
  Promise.resolve(null)
);
const mockListCodebaseClaims = mock<typeof CodebaseDb.listCodebaseClaims>(() =>
  Promise.resolve([])
);
const mockFindCodebaseByName = mock<typeof CodebaseDb.findCodebaseByName>(() =>
  Promise.resolve(null)
);
const mockUpdateCodebase = mock<typeof CodebaseDb.updateCodebase>(() => Promise.resolve());
const mockRemoveUnregisteredCheckout = mock<typeof CodebaseDb.removeUnregisteredCheckout>(
  (path, remove) => remove(path)
);
const mockCreateProjectSourceSymlink = mock((): Promise<void> => Promise.resolve());
const mockEnsureProjectStructure = mock((): Promise<void> => Promise.resolve());

mock.module('../db/codebases', () => ({
  createCodebase: mockCreateCodebase,
  removeUnregisteredCheckout: mockRemoveUnregisteredCheckout,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  listCodebaseClaims: mockListCodebaseClaims,
  findCodebaseByName: mockFindCodebaseByName,
  updateCodebase: mockUpdateCodebase,
}));

// ── @archon/paths mock ──────────────────────────────────────────────────────
const mockLogger = createMockLogger();
let managedSourceOverride: string | undefined;

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  expandTilde: mock((p: string) => p.replace(/^~/, '/home/test')),
  // Mirrors the real canonicalizer's contract (resolve, then realpath, falling
  // back to the resolved path) and reads `fsPromises.realpath` at call time so
  // the symlink test's spy still drives it.
  canonicalizeProjectPath: mock(async (p: string) => {
    const absolute = resolve(p.replace(/^~/, '/home/test'));
    try {
      return await fsPromises.realpath(absolute);
    } catch {
      return absolute;
    }
  }),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  ensureProjectStructure: mockEnsureProjectStructure,
  getProjectSourcePath: mock(
    (owner: string, repo: string) =>
      managedSourceOverride ?? `/home/test/.archon/workspaces/${owner}/${repo}/source`
  ),
  createProjectSourceSymlink: mockCreateProjectSourceSymlink,
  ProjectSourceOccupiedError: class extends Error {},
  isInsideArchonWorkspaces: (p: string) => isPathInside('/home/test/.archon/workspaces', p),
  parseOwnerRepo: mock((name: string) => {
    const parts = name.split('/');
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  }),
  slugifyFolderName: mock((name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  ),
  ensureFolderProjectStructure: mock(() => Promise.resolve()),
  getFolderProjectRoot: mock((slug: string) => `/home/test/.archon/workspaces/_folder/${slug}`),
}));

// ── config-loader mock ──────────────────────────────────────────────────────
const mockLoadConfig = mock(() => Promise.resolve({ assistant: 'claude' }));
mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mock(() => Promise.resolve({})),
}));

// ── utils/commands mock ─────────────────────────────────────────────────────
const mockFindCommandFiles = mock<typeof Commands.findCommandFiles>(() => Promise.resolve([]));
mock.module('../utils/commands', () => ({
  findCommandFiles: mockFindCommandFiles,
}));

// ── Import module under test AFTER mocks are registered ────────────────────
import {
  cloneRepository,
  registerRepository,
  registerFolder,
  inspectProjectBaseBranch,
  ProjectRegistrationError,
} from './sql-registration';

// ── Spies for fs/promises and @archon/git ──────────────────────────────────
let spyCheckoutRemote: ReturnType<typeof spyOn>;
let spyFsAccess: ReturnType<typeof spyOn>;
let spyFsRm: ReturnType<typeof spyOn>;
let spyFsStat: ReturnType<typeof spyOn>;
let spyFsRealpath: ReturnType<typeof spyOn>;
let spyExecFileAsync: ReturnType<typeof spyOn>;
let spyAddSafeDirectory: ReturnType<typeof spyOn>;
let spyTrustRegisteredPath: ReturnType<typeof spyOn>;
let spyCloneGitRepository: ReturnType<typeof spyOn>;
let spyGetCanonicalRepoPath: ReturnType<typeof spyOn>;

function setupSpies(): void {
  spyCheckoutRemote = spyOn(registrationRemote, 'assertCheckoutRemote').mockResolvedValue(
    undefined
  );
  // Default: .git does NOT exist (no pre-existing clone)
  spyFsAccess = spyOn(fsPromises, 'access').mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  );
  spyFsRm = spyOn(fsPromises, 'rm').mockResolvedValue(undefined);
  // Default: stat reports a directory (registerFolder happy path)
  spyFsStat = spyOn(fsPromises, 'stat').mockResolvedValue({
    isDirectory: () => true,
  } as Awaited<ReturnType<typeof fsPromises.stat>>);
  // Default: realpath is identity (no symlink to resolve) — the symlink
  // canonicalization test overrides this to return a distinct real path.
  spyFsRealpath = spyOn(fsPromises, 'realpath').mockImplementation(((p: string) =>
    Promise.resolve(p)) as unknown as typeof fsPromises.realpath);
  spyExecFileAsync = spyOn(gitUtils, 'execFileAsync').mockResolvedValue({
    stdout: '',
    stderr: '',
  });
  spyAddSafeDirectory = spyOn(gitUtils, 'addSafeDirectory').mockResolvedValue(undefined);
  spyTrustRegisteredPath = spyOn(gitUtils, 'trustRegisteredPath').mockResolvedValue(undefined);
  spyCloneGitRepository = spyOn(gitUtils, 'cloneRepository').mockResolvedValue({
    ok: true,
    value: undefined,
  });
  spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockImplementation(
    (path: string): ReturnType<typeof gitUtils.getCanonicalRepoPath> =>
      Promise.resolve(gitUtils.toRepoPath(path))
  );
}

function restoreSpies(): void {
  spyCheckoutRemote?.mockRestore();
  spyFsAccess?.mockRestore();
  spyFsRm?.mockRestore();
  spyFsRealpath?.mockRestore();
  spyFsStat?.mockRestore();
  spyExecFileAsync?.mockRestore();
  spyAddSafeDirectory?.mockRestore();
  spyTrustRegisteredPath?.mockRestore();
  spyCloneGitRepository?.mockRestore();
  spyGetCanonicalRepoPath?.mockRestore();
}

function clearMocks(): void {
  // mockReset() clears both call history AND any queued mockResolvedValueOnce values,
  // preventing cross-test bleed when tests queue different return values.
  mockListCodebaseClaims.mockReset().mockResolvedValue([]);
  mockCreateCodebase.mockReset();
  mockGetCodebaseCommands.mockReset();
  mockUpdateCodebaseCommands.mockReset();
  mockFindCodebaseByRepoUrl.mockReset();
  mockFindCodebaseByDefaultCwd.mockReset();
  mockFindCodebaseByName.mockReset();
  mockUpdateCodebase.mockReset();
  mockCreateProjectSourceSymlink.mockClear();
  mockEnsureProjectStructure.mockClear();
  mockFindCommandFiles.mockReset();
  mockLogger.info.mockClear();
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();

  // Restore sensible defaults after reset (mockReset removes all implementations)
  mockGetCodebaseCommands.mockResolvedValue({});
  mockUpdateCodebaseCommands.mockResolvedValue(undefined);
  mockFindCodebaseByRepoUrl.mockResolvedValue(null);
  mockFindCodebaseByDefaultCwd.mockResolvedValue(null);
  mockFindCodebaseByName.mockResolvedValue(null);
  mockUpdateCodebase.mockResolvedValue(undefined);
  mockFindCommandFiles.mockResolvedValue([]);
}

afterAll(() => {
  restoreSpies();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal codebase row for the mock to return */
function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'codebase-uuid-1',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo',
    default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeResolverDeps(
  overrides: Partial<CodebaseCheckoutResolverDeps> = {}
): CodebaseCheckoutResolverDeps {
  return {
    findCodebaseByDefaultCwd: async () => null,
    listCodebaseClaims: async () => [],
    getCanonicalRepoPath: async path => path,
    getGitCheckoutIdentity: async path => ({
      gitDir: `${path}/.git`,
      commonGitDir: `${path}/.git`,
      linkedWorktree: false,
    }),
    ...overrides,
  };
}

function getGitCloneCall(): Parameters<typeof gitUtils.cloneRepository> | undefined {
  return spyCloneGitRepository.mock.calls.at(-1) as
    | Parameters<typeof gitUtils.cloneRepository>
    | undefined;
}

describe('findCodebaseForCheckoutPath', () => {
  const cwd = resolve('/workspace/external-linked');
  const commonGitDir = '/metadata/repository';

  function externalLinkedError(): gitUtils.CanonicalRepoPathUnavailableError {
    return new gitUtils.CanonicalRepoPathUnavailableError(cwd, commonGitDir);
  }

  test('folder identity is exact, not inherited through a linked git worktree', async () => {
    const folder = makeCodebase({ kind: 'folder', default_cwd: resolve('/repo') });
    const deps = {
      findCodebaseByDefaultCwd: async (cwd: string) => (cwd === folder.default_cwd ? folder : null),
      listCodebaseClaims: async () => [folder],
      getCanonicalRepoPath: async () => folder.default_cwd,
    };
    expect(await findCodebaseForCheckoutPath(folder.default_cwd, deps)).toBe(folder);
    expect(await findCodebaseForCheckoutPath(resolve('/external-worktree'), deps)).toBeNull();
  });

  test('canonicalizes a forward-slash checkout before exact lookup', async () => {
    const gitSpelling = 'C:/workspace/primary';
    const canonical = resolve('/canonical/primary');
    const registered = makeCodebase({ default_cwd: canonical });
    const realpathSpy = spyOn(fsPromises, 'realpath').mockResolvedValue(canonical);
    const findExact = mock(async (path: string) => (path === canonical ? registered : null));
    const getPrimary = mock(async (path: string) => path);
    try {
      await expect(
        findCodebaseForCheckoutPath(
          gitSpelling,
          makeResolverDeps({
            findCodebaseByDefaultCwd: findExact,
            getCanonicalRepoPath: getPrimary,
          })
        )
      ).resolves.toBe(registered);
      expect(findExact).toHaveBeenCalledWith(canonical);
      expect(findExact).not.toHaveBeenCalledWith(gitSpelling);
      expect(getPrimary).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  test('matches an external linked worktree to its uniquely registered Git repository', async () => {
    const registered = makeCodebase({ default_cwd: '/workspace/primary' }) as Codebase;
    const separateClone = makeCodebase({
      id: 'separate-clone',
      default_cwd: '/workspace/separate-clone',
    }) as Codebase;
    const deps = makeResolverDeps({
      getCanonicalRepoPath: async () => {
        throw externalLinkedError();
      },
      listCodebaseClaims: async () => [registered, separateClone],
      getGitCheckoutIdentity: async path => ({
        gitDir: path === cwd ? `${commonGitDir}/worktrees/linked` : `${path}/.git`,
        commonGitDir:
          path === separateClone.default_cwd ? '/metadata/separate-clone' : commonGitDir,
        linkedWorktree: path === cwd,
      }),
    });

    await expect(findCodebaseForCheckoutPath(cwd, deps)).resolves.toBe(registered);
  });

  test('looks up a linked worktree primary under its canonical spelling', async () => {
    // `git worktree list` prints `C:/...` on Windows; `default_cwd` is stored canonically.
    const gitSpelling = resolve('/git-spelling/primary');
    const canonical = resolve('/canonical/primary');
    const registered = makeCodebase({ default_cwd: canonical }) as Codebase;
    const realpathSpy = spyOn(fsPromises, 'realpath').mockImplementation(((p: string) =>
      Promise.resolve(p === gitSpelling ? canonical : p)) as unknown as never);
    try {
      const deps = makeResolverDeps({
        getCanonicalRepoPath: async () => gitSpelling,
        findCodebaseByDefaultCwd: async path => (path === canonical ? registered : null),
      });
      await expect(findCodebaseForCheckoutPath(cwd, deps)).resolves.toBe(registered);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  test('does not conflate a separate clone with the registered repository', async () => {
    const registered = makeCodebase({ default_cwd: '/workspace/primary' }) as Codebase;
    const deps = makeResolverDeps({
      getCanonicalRepoPath: async () => {
        throw externalLinkedError();
      },
      listCodebaseClaims: async () => [registered],
      getGitCheckoutIdentity: async path => ({
        gitDir: path === cwd ? `${commonGitDir}/worktrees/linked` : '/other/clone/.git',
        commonGitDir: path === cwd ? commonGitDir : '/other/clone/.git',
        linkedWorktree: path === cwd,
      }),
    });

    await expect(findCodebaseForCheckoutPath(cwd, deps)).resolves.toBeNull();
  });

  test('rejects ambiguous registrations sharing one external Git directory', async () => {
    const first = makeCodebase({ id: 'first', default_cwd: '/workspace/first' }) as Codebase;
    const second = makeCodebase({ id: 'second', default_cwd: '/workspace/second' }) as Codebase;
    const deps = makeResolverDeps({
      getCanonicalRepoPath: async () => {
        throw externalLinkedError();
      },
      listCodebaseClaims: async () => [first, second],
      getGitCheckoutIdentity: async path => ({
        gitDir: path === cwd ? `${commonGitDir}/worktrees/linked` : commonGitDir,
        commonGitDir,
        linkedWorktree: path === cwd,
      }),
    });

    await expect(findCodebaseForCheckoutPath(cwd, deps)).rejects.toThrow(
      'matches multiple registered codebases'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('cloneRepository', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITEA_TOKEN;
    delete process.env.GITHUB_URL;
  });

  describe('GitHub App registration', () => {
    const getInstallationToken = mock(
      async (_owner: string, _repo: string) => 'installation-secret'
    );
    const options = { githubAppAuth: { getInstallationToken } };
    let helper: ReturnType<typeof spyOn<typeof helperInstaller, 'installCredentialHelper'>>;

    beforeEach(() => {
      getInstallationToken.mockReset();
      getInstallationToken.mockResolvedValue('installation-secret');
      mockCreateCodebase.mockResolvedValue(makeCodebase());
      helper = spyOn(helperInstaller, 'installCredentialHelper').mockResolvedValue({
        kind: 'installed',
        helperPath: '/helper',
      });
    });
    afterEach(() => helper.mockRestore());

    test.each([
      'https://github.com/owner/repo.git',
      'github.com/owner/repo',
      'git@github.com:owner/repo.git',
    ])('clones %s with installation credentials and sets up before persistence', async url => {
      helper.mockImplementation(async () => {
        expect(mockCreateCodebase).not.toHaveBeenCalled();
        return { kind: 'installed', helperPath: '/helper' };
      });
      const result = await cloneRepository(url, options);
      expect(getInstallationToken).toHaveBeenCalledWith('owner', 'repo');
      expect(spyCloneGitRepository).toHaveBeenCalledWith(
        result.repositoryUrl,
        gitUtils.toRepoPath(result.defaultCwd),
        { credentials: { username: 'x-access-token', password: 'installation-secret' } }
      );
      expect(helper).toHaveBeenCalledWith(result.defaultCwd);
      expect(
        JSON.stringify([result, mockLogger.info.mock.calls, mockLogger.debug.mock.calls])
      ).not.toContain('installation-secret');
      process.env.GITHUB_TOKEN = 'pat';
      await cloneRepository('https://github.com/owner/repo');
      expect(spyCloneGitRepository.mock.calls.at(-1)?.[2]).toEqual({
        credentials: { username: 'x-access-token', password: 'pat' },
      });
      await cloneRepository('https://gitlab.com/owner/repo', options);
      expect(getInstallationToken).toHaveBeenCalledTimes(1);
      expect(helper).toHaveBeenCalledTimes(1);
    });

    test('rejects HTTP GitHub URLs before token lookup for clone and inspection', async () => {
      const url = 'http://github.com/owner/repo';
      await expect(cloneRepository(url, options)).rejects.toThrow('HTTPS');
      await expect(inspectProjectBaseBranch({ url }, options)).rejects.toThrow('HTTPS');
      expect(getInstallationToken).not.toHaveBeenCalled();
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
      expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
    });

    test('restricts App credentials and helper setup to the exact GitHub host', async () => {
      await cloneRepository('https://github.com/owner/repo', options);
      await cloneRepository('https://github.com.attacker.test/owner/repo', options);
      expect(getInstallationToken).toHaveBeenCalledTimes(1);
      expect(helper).toHaveBeenCalledTimes(1);
      expect(spyCloneGitRepository.mock.calls.at(-1)?.[2]).toBeUndefined();
    });

    test('uses installation credentials for the GITHUB_URL Enterprise host only over its scheme', async () => {
      process.env.GITHUB_URL = 'https://github.example.com';
      try {
        await cloneRepository('https://github.example.com/owner/repo', options);
        expect(getInstallationToken).toHaveBeenCalledWith('owner', 'repo');
        expect(spyCloneGitRepository.mock.calls.at(-1)?.[2]).toEqual({
          credentials: { username: 'x-access-token', password: 'installation-secret' },
        });
        await expect(
          cloneRepository('http://github.example.com/owner/repo', options)
        ).rejects.toThrow('HTTPS');
        await cloneRepository('https://github.com/owner/other', options);
        expect(getInstallationToken).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.GITHUB_URL;
      }
    });

    test('uses installation credentials for a ported GITHUB_URL only on that port', async () => {
      process.env.GITHUB_URL = 'https://github.example.com:8443';
      try {
        await cloneRepository('https://github.example.com:8443/owner/repo', options);
        await cloneRepository('https://github.example.com/owner/other', options);
        await cloneRepository('https://github.example.com:9000/owner/third', options);
        expect(getInstallationToken).toHaveBeenCalledTimes(1);
        expect(getInstallationToken).toHaveBeenCalledWith('owner', 'repo');
        expect(spyCloneGitRepository.mock.calls.at(-1)?.[2]).toBeUndefined();
      } finally {
        delete process.env.GITHUB_URL;
      }
    });

    test('fixed installation preserves missing-installation guidance for clone and inspection', async () => {
      appRequest.mockClear();
      const provider = createGitHubAppAuthProvider({
        appId: '123',
        privateKey: 'synthetic-key',
        slug: 'archon',
        defaultInstallationId: 555,
        apiBaseUrl: 'https://api.github.com',
      });
      const fixedOptions = { githubAppAuth: provider };
      const url = 'https://github.com/missing/repo';
      await expect(cloneRepository(url, fixedOptions)).rejects.toThrow('not installed');
      await expect(inspectProjectBaseBranch({ url }, fixedOptions)).rejects.toThrow(
        'not installed'
      );
      expect(appRequest).toHaveBeenCalledTimes(2);
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
      expect(mockCreateCodebase).not.toHaveBeenCalled();
      expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
    });

    test('surfaces an unavailable installation before cloning or persistence', async () => {
      getInstallationToken.mockRejectedValue(new AppNotInstalledError('owner', 'repo', 'archon'));
      await expect(cloneRepository('https://github.com/owner/repo', options)).rejects.toThrow(
        'not installed'
      );
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    });

    test('removes a fresh checkout when helper setup fails', async () => {
      helper.mockResolvedValue({ kind: 'failed', error: new Error('config denied') });
      await expect(cloneRepository('https://github.com/owner/repo', options)).rejects.toThrow(
        'credential helper'
      );
      expect(spyFsRm).toHaveBeenCalledWith('/home/test/.archon/workspaces/owner/repo/source', {
        recursive: true,
      });
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    });

    test.each(['https://github.com/owner/repo', 'https://github.com/owner/repo.git'])(
      'refreshes the helper on an existing registration stored as %s and preserves it on setup failure',
      async storedUrl => {
        spyFsAccess.mockResolvedValue(undefined);
        const existing = makeCodebase({
          default_cwd: '/existing/checkout',
          repository_url: storedUrl,
        });
        mockListCodebaseClaims.mockResolvedValue([existing]);
        expect((await cloneRepository('github.com/owner/repo', options)).alreadyExisted).toBe(true);
        expect(helper).toHaveBeenCalledWith('/existing/checkout');
        helper.mockResolvedValue({ kind: 'failed', error: new Error('config denied') });
        await expect(cloneRepository('github.com/owner/repo', options)).rejects.toThrow(
          'credential helper'
        );
        expect(getInstallationToken).not.toHaveBeenCalled();
        expect(spyCloneGitRepository).not.toHaveBeenCalled();
        expect(spyFsRm).not.toHaveBeenCalled();
        expect(mockUpdateCodebase).not.toHaveBeenCalled();
        expect(mockCreateCodebase).not.toHaveBeenCalled();
      }
    );

    test('uses App credentials for inspection and installs the helper before explicit branch validation', async () => {
      const syntax = spyOn(gitUtils, 'validateBranchName').mockResolvedValue(undefined);
      const remote = spyOn(gitUtils, 'getDefaultRemote').mockResolvedValue('origin');
      const inspection = spyOn(gitUtils, 'inspectRemoteBranches').mockResolvedValue({
        status: 'available',
        defaultBranch: gitUtils.toBranchName('dev'),
        branches: [gitUtils.toBranchName('dev')],
      });
      try {
        await inspectProjectBaseBranch({ url: 'https://github.com/owner/repo.git' }, options);
        expect(inspection).toHaveBeenCalledWith({
          kind: 'url',
          url: 'https://github.com/owner/repo.git',
          credentials: { username: 'x-access-token', password: 'installation-secret' },
        });
        expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
        expect(mockCreateCodebase).not.toHaveBeenCalled();
        expect(helper).not.toHaveBeenCalled();
        inspection.mockImplementation(async () => {
          expect(helper).toHaveBeenCalled();
          expect(mockCreateCodebase).not.toHaveBeenCalled();
          return {
            status: 'available',
            defaultBranch: gitUtils.toBranchName('dev'),
            branches: [gitUtils.toBranchName('dev')],
          };
        });
        await cloneRepository('https://github.com/owner/repo', { ...options, baseBranch: 'dev' });
        getInstallationToken.mockRejectedValue(new AppNotInstalledError('owner', 'repo'));
        await expect(
          inspectProjectBaseBranch({ url: 'https://github.com/owner/repo' }, options)
        ).rejects.toThrow('not installed');
      } finally {
        syntax.mockRestore();
        remote.mockRestore();
        inspection.mockRestore();
      }
    });
  });

  test('GitHub remote inspection uses password credentials without changing the URL', async () => {
    process.env.GH_TOKEN = 'inspection-token';
    const inspection = spyOn(gitUtils, 'inspectRemoteBranches').mockResolvedValue({
      status: 'available',
      defaultBranch: gitUtils.toBranchName('main'),
      branches: [gitUtils.toBranchName('main')],
    });
    try {
      await inspectProjectBaseBranch({ url: 'https://github.com/owner/repo.git' });
      expect(inspection).toHaveBeenCalledWith({
        kind: 'url',
        url: 'https://github.com/owner/repo.git',
        credentials: { username: 'x-access-token', password: 'inspection-token' },
      });
    } finally {
      inspection.mockRestore();
    }
  });

  test('a failed remote lookup after cloning removes the new clone', async () => {
    const syntax = spyOn(gitUtils, 'validateBranchName').mockResolvedValue(undefined);
    const remote = spyOn(gitUtils, 'getDefaultRemote').mockRejectedValue(
      new Error('git remote failed')
    );
    try {
      await expect(
        cloneRepository('https://github.com/owner/repo', { baseBranch: 'dev' })
      ).rejects.toThrow('git remote failed');
      const target = getGitCloneCall()?.[1];
      expect(spyAddSafeDirectory).toHaveBeenCalledWith(target);
      expect(spyAddSafeDirectory.mock.invocationCallOrder[0]).toBeLessThan(
        remote.mock.invocationCallOrder[0]
      );
      expect(target).toBeDefined();
      expect(spyFsRm.mock.calls.filter((call: unknown[]) => call[0] === target)).toHaveLength(1);
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    } finally {
      syntax.mockRestore();
      remote.mockRestore();
    }
  });

  test('an unknown explicit branch removes only the new clone and leaves registration retryable', async () => {
    const syntax = spyOn(gitUtils, 'validateBranchName').mockResolvedValue(undefined);
    const remote = spyOn(gitUtils, 'getDefaultRemote').mockResolvedValue('origin');
    const inspection = spyOn(gitUtils, 'inspectRemoteBranches').mockResolvedValue({
      status: 'available',
      defaultBranch: gitUtils.toBranchName('dev'),
      branches: [gitUtils.toBranchName('dev')],
    });
    try {
      await expect(
        cloneRepository('https://github.com/owner/repo', { baseBranch: 'unknown' })
      ).rejects.toThrow("Configured base branch 'unknown' not found on remote 'origin'");
      const target = getGitCloneCall()?.[1];
      expect(target).toBeDefined();
      expect(spyFsRm.mock.calls.filter((call: unknown[]) => call[0] === target)).toHaveLength(1);
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    } finally {
      syntax.mockRestore();
      remote.mockRestore();
      inspection.mockRestore();
    }
  });

  // ── URL normalization / happy-path cloning ─────────────────────────────
  describe('HTTPS URL cloning', () => {
    test.each(['', '/', '/./', '/../missing/../source'])(
      'reclones a missing managed checkout with suffix %j',
      async suffix => {
        const savedPath = `/home/test/.archon/workspaces/owner/repo/source${suffix}`;
        const existing = makeCodebase({ default_cwd: savedPath });
        mockListCodebaseClaims.mockResolvedValueOnce([existing]);
        spyFsStat.mockImplementation(realFsStat);

        const result = await cloneRepository('https://github.com/owner/repo');

        expect(mockEnsureProjectStructure).toHaveBeenCalledWith('owner', 'repo');
        expect(getGitCloneCall()?.slice(0, 2)).toEqual([
          'https://github.com/owner/repo',
          gitUtils.toRepoPath(resolve(savedPath)),
        ]);
        expect(result).toMatchObject({
          codebaseId: existing.id,
          defaultCwd: resolve(savedPath),
          alreadyExisted: true,
        });
        expect(mockCreateCodebase).not.toHaveBeenCalled();
      }
    );

    test('refuses to reclone a missing non-managed checkout with a trailing slash', async () => {
      mockListCodebaseClaims.mockResolvedValueOnce([
        makeCodebase({ default_cwd: '/some/local/checkout/' }),
      ]);

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'checkout is missing'
      );
      expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
    });

    test('refuses to reclone through a symlink alias of the managed source', async () => {
      const source = '/home/test/.archon/workspaces/owner/repo/source';
      const alias = '/some/local/alias';
      spyFsRealpath.mockImplementation(async (path: string) => (path === alias ? source : path));
      mockListCodebaseClaims.mockResolvedValueOnce([makeCodebase({ default_cwd: alias })]);

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'checkout is missing'
      );
      expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
    });

    test.each(['', '/', '/./', '/../missing/../source'])(
      'clones into the managed directory on disk for saved suffix %s',
      async suffix => {
        const root = await fsPromises.mkdtemp(join(tmpdir(), 'archon-clone-retry-'));
        const source = join(root, 'managed', 'source');
        const origin = join(root, 'origin');
        managedSourceOverride = source;
        try {
          await fsPromises.mkdir(source, { recursive: true });
          execFileSync('git', ['init', '--bare', '-q', origin]);
          const saved = source + suffix;
          const existing = makeCodebase({ default_cwd: saved });
          mockListCodebaseClaims.mockResolvedValue([existing]);
          mockUpdateCodebase.mockImplementation(async (_target, data) => {
            if (data.default_cwd !== undefined) existing.default_cwd = data.default_cwd;
          });
          spyFsAccess.mockImplementation(realFsAccess);
          spyFsStat.mockImplementation(realFsStat);
          spyCheckoutRemote.mockImplementation(realCheckoutRemote);
          spyExecFileAsync.mockImplementation(realExecFileAsync);
          spyCloneGitRepository.mockImplementation(async (_url: string, target: string) => {
            execFileSync('git', ['clone', '-q', origin, target], { stdio: 'pipe' });
            execFileSync('git', [
              '-C',
              target,
              'remote',
              'set-url',
              'origin',
              'https://github.com/owner/repo',
            ]);
            return { ok: true, value: undefined };
          });

          const result = await cloneRepository('https://github.com/owner/repo');

          expect(await fsPromises.readdir(source)).toContain('.git');
          expect(result.defaultCwd).toBe(source);
          expect(existing.default_cwd).toBe(source);
          expect((await cloneRepository('https://github.com/owner/repo')).defaultCwd).toBe(source);
          expect(spyCloneGitRepository).toHaveBeenCalledTimes(1);

          if (suffix === '/../missing/../source') {
            existing.default_cwd = saved;
            expect((await cloneRepository('https://github.com/owner/repo')).defaultCwd).toBe(
              source
            );
            expect(existing.default_cwd).toBe(source);
            expect(spyCloneGitRepository).toHaveBeenCalledTimes(1);
          }
        } finally {
          managedSourceOverride = undefined;
          spyFsRm.mockRestore();
          await removeTempTree(root);
        }
      }
    );

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'refuses retry when the managed source cannot be inspected',
      async () => {
        const root = await fsPromises.mkdtemp(join(tmpdir(), 'archon-clone-unreadable-'));
        const source = join(root, 'managed', 'source');
        managedSourceOverride = source;
        try {
          await fsPromises.mkdir(join(root, 'managed'), { recursive: true });
          await fsPromises.chmod(join(root, 'managed'), 0o000);
          const existing = makeCodebase({ default_cwd: `${source}/` });
          mockListCodebaseClaims.mockResolvedValue([existing]);
          spyFsAccess.mockImplementation(realFsAccess);
          spyFsStat.mockImplementation(realFsStat);

          await expect(cloneRepository('https://github.com/owner/repo')).rejects.toMatchObject({
            code: 'EACCES',
          });

          expect(spyCloneGitRepository).not.toHaveBeenCalled();
          expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
          expect(mockUpdateCodebase).not.toHaveBeenCalled();
        } finally {
          managedSourceOverride = undefined;
          await fsPromises.chmod(join(root, 'managed'), 0o755);
          await removeTempTree(root);
        }
      }
    );

    test('clones a standard HTTPS GitHub URL', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.alreadyExisted).toBe(false);
      expect(result.name).toBe('owner/repo');
      expect(result.repositoryUrl).toBe('https://github.com/owner/repo');
      expect(result.commandCount).toBe(0);

      const cloneCall = getGitCloneCall();
      expect(cloneCall).toBeDefined();
      expect(cloneCall?.[0]).toBe('https://github.com/owner/repo');
    });

    test('normalizes a bare host clone source before deriving the project path', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      const result = await cloneRepository('github.com/owner/repo');

      expect(result.name).toBe('owner/repo');
      expect(getGitCloneCall()?.[0]).toBe('https://github.com/owner/repo');
    });

    test('strips trailing slash from URL before cloning', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo/');

      expect(getGitCloneCall()?.[0]).toBe('https://github.com/owner/repo');
    });

    test('strips .git suffix when extracting owner/repo but keeps it in clone URL', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      const result = await cloneRepository('https://github.com/owner/repo.git');

      expect(result.name).toBe('owner/repo');
    });

    test.each([false, true])(
      'repeated clone retains one trust grant after setup (rejected: %s)',
      async rejected => {
        const home = await fsPromises.mkdtemp(join(tmpdir(), 'archon-clone-safe-'));
        const env = {
          HOME: home,
          XDG_CONFIG_HOME: home,
          GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '0',
        };
        const previousEnv = Object.fromEntries(
          Object.keys(env).map(key => [key, process.env[key]])
        );
        try {
          Object.assign(process.env, env);
          spyExecFileAsync.mockImplementation(realExecFileAsync);
          spyAddSafeDirectory.mockImplementation(realAddSafeDirectory);
          await fsPromises.writeFile(
            env.GIT_CONFIG_GLOBAL,
            '[safe]\n directory = /workspace/other\n'
          );
          mockCreateCodebase.mockResolvedValue(makeCodebase());

          // The filesystem mock models a removed clone, so each invocation sets up the same path.
          if (rejected) {
            const syntax = spyOn(gitUtils, 'validateBranchName').mockResolvedValue(undefined);
            const remote = spyOn(gitUtils, 'getDefaultRemote').mockRejectedValue(
              new Error('registration failed')
            );
            try {
              await expect(
                cloneRepository('https://github.com/owner/repo', { baseBranch: 'dev' })
              ).rejects.toThrow('registration failed');
              const target = getGitCloneCall()?.[1];
              expect(spyFsRm.mock.calls.some((call: unknown[]) => call[0] === target)).toBe(true);
            } finally {
              syntax.mockRestore();
              remote.mockRestore();
            }
          } else {
            await cloneRepository('https://github.com/owner/repo');
            await cloneRepository('https://github.com/owner/repo');
          }

          const target = getGitCloneCall()?.[1];
          if (!target) throw new Error('Clone destination missing');
          expect(spyCloneGitRepository).toHaveBeenCalledTimes(rejected ? 1 : 2);
          const { stdout } = await realExecFileAsync('git', [
            'config',
            '--global',
            '--get-all',
            'safe.directory',
          ]);
          expect(stdout.trim().split('\n')).toEqual(['/workspace/other', target]);
        } finally {
          for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          spyFsRm.mockRestore();
          await removeTempTree(home);
        }
      }
    );

    test('trusts the destination before clone can execute checkout hooks', async () => {
      mockCreateCodebase.mockResolvedValue(makeCodebase());
      const cloneWithHook: typeof gitUtils.cloneRepository = async (_url, target) => {
        expect(spyAddSafeDirectory).toHaveBeenCalledWith(target);
        return { ok: true, value: undefined };
      };
      spyCloneGitRepository.mockImplementation(cloneWithHook);
      await cloneRepository('https://github.com/owner/repo');
    });

    test('adds safe.directory before registration and propagates config failures', async () => {
      spyAddSafeDirectory.mockRejectedValueOnce(new Error('config locked'));
      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'config locked'
      );
      expect(mockCreateCodebase).not.toHaveBeenCalled();
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
      expect(spyFsRm).not.toHaveBeenCalled();
    });
  });

  // ── SSH URL conversion ─────────────────────────────────────────────────
  describe('SSH URL conversion', () => {
    test('converts git@ SSH URL to HTTPS before cloning', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('git@github.com:owner/repo.git');

      const cloneUrl = getGitCloneCall()?.[0] ?? '';
      expect(cloneUrl).toContain('https://github.com/owner/repo');
      expect(cloneUrl).not.toContain('git@');
    });

    test('extracts correct owner/repo from SSH URL', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      const result = await cloneRepository('git@github.com:owner/repo.git');

      expect(result.name).toBe('owner/repo');
    });

    test('converts SSH URL with custom host alias to HTTPS', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://gh-work/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('git@gh-work:owner/repo.git');

      const cloneUrl = getGitCloneCall()?.[0] ?? '';
      expect(cloneUrl).toContain('https://gh-work/owner/repo');
      expect(cloneUrl).not.toContain('git@');
    });

    test('converts SSH URL with non-github host to HTTPS', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'team/project',
          repository_url: 'https://gitlab.example.com/team/project',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('git@gitlab.example.com:team/project.git');

      const cloneUrl = getGitCloneCall()?.[0] ?? '';
      expect(cloneUrl).toContain('https://gitlab.example.com/team/project');
      expect(cloneUrl).not.toContain('git@');
    });
  });

  // ── GitHub token authentication ────────────────────────────────────────
  describe('GitHub token authentication', () => {
    beforeEach(() => {
      process.env.GH_TOKEN = 'ghp_testtoken123';
    });

    afterAll(() => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
    });

    test('prefers GH_TOKEN over GITHUB_TOKEN as request-scoped clone credentials', async () => {
      process.env.GITHUB_TOKEN = 'ghp_other_identity';
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      const logOutput = captureStubLogOutput(mockLogger);
      try {
        await cloneRepository('https://github.com/owner/private-repo');
      } finally {
        logOutput.restore();
      }

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://github.com/owner/private-repo');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'x-access-token', password: 'ghp_testtoken123' },
      });
      expect(logOutput.output()).not.toBe('');
      expect(logOutput.output()).not.toContain('ghp_testtoken123');
      expect(logOutput.output()).not.toContain('ghp_other_identity');
    });

    test('falls back to GITHUB_TOKEN when GH_TOKEN is empty', async () => {
      process.env.GITHUB_TOKEN = 'ghp_github_token_456';
      process.env.GH_TOKEN = '';
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('https://github.com/owner/private-repo');

      expect(getGitCloneCall()).toEqual([
        'https://github.com/owner/private-repo',
        gitUtils.toRepoPath('/home/test/.archon/workspaces/owner/private-repo/source'),
        { credentials: { username: 'x-access-token', password: 'ghp_github_token_456' } },
      ]);
    });

    test('scrubbed tokens supply no clone credentials', async () => {
      process.env.GH_TOKEN = '';
      process.env.GITHUB_TOKEN = '';
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase());

      await cloneRepository('https://github.com/owner/private-repo');

      expect(getGitCloneCall()?.[2]).toBeUndefined();
    });

    test('does NOT inject GH_TOKEN into non-github URLs when no forge token set', async () => {
      delete process.env.GITLAB_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://gitlab.com/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://gitlab.com/owner/repo');

      expect(JSON.stringify(getGitCloneCall())).not.toContain('ghp_testtoken123');
    });

    test('converts SSH to HTTPS and passes GH_TOKEN as credentials', async () => {
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('git@github.com:owner/repo.git');

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://github.com/owner/repo.git');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'x-access-token', password: 'ghp_testtoken123' },
      });
    });
  });

  // ── Multi-forge authentication ────────────────────────────────────────
  describe('multi-forge authentication', () => {
    afterEach(() => {
      delete process.env.GITLAB_TOKEN;
      delete process.env.GITEA_TOKEN;
      delete process.env.GITLAB_URL;
      delete process.env.GITEA_URL;
      delete process.env.FORGEJO_URL;
    });

    test('passes GITLAB_TOKEN with oauth2 credentials for gitlab.com URLs', async () => {
      process.env.GITLAB_TOKEN = 'glpat-testtoken456';
      delete process.env.GH_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://gitlab.com/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://gitlab.com/owner/repo');

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://gitlab.com/owner/repo');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'oauth2', password: 'glpat-testtoken456' },
      });
      delete process.env.GITLAB_TOKEN;
    });

    test('passes GITLAB_TOKEN for the configured GITLAB_URL host', async () => {
      process.env.GITLAB_URL = 'https://gitlab.mycompany.com';
      process.env.GITLAB_TOKEN = 'glpat-selfhosted';
      delete process.env.GH_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://gitlab.mycompany.com/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://gitlab.mycompany.com/owner/repo');

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://gitlab.mycompany.com/owner/repo');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'oauth2', password: 'glpat-selfhosted' },
      });
      delete process.env.GITLAB_TOKEN;
    });

    test('passes GITEA_TOKEN for the configured GITEA_URL host', async () => {
      process.env.GITEA_URL = 'https://gitea.myorg.com';
      process.env.GITEA_TOKEN = 'gitea-token-789';
      delete process.env.GH_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://gitea.myorg.com/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://gitea.myorg.com/owner/repo');

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://gitea.myorg.com/owner/repo');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'gitea-token-789', password: '' },
      });
      delete process.env.GITEA_TOKEN;
    });

    test('passes GITEA_TOKEN for the configured FORGEJO_URL host', async () => {
      process.env.FORGEJO_URL = 'https://forgejo.example.org';
      process.env.GITEA_TOKEN = 'forgejo-token';
      delete process.env.GH_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://forgejo.example.org/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://forgejo.example.org/owner/repo');

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://forgejo.example.org/owner/repo');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'forgejo-token', password: '' },
      });
      delete process.env.GITEA_TOKEN;
    });

    test('does not inject auth for unknown forge without token', async () => {
      delete process.env.GH_TOKEN;
      delete process.env.GITLAB_TOKEN;
      delete process.env.GITEA_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://bitbucket.org/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://bitbucket.org/owner/repo');

      expect(getGitCloneCall()).toEqual([
        'https://bitbucket.org/owner/repo',
        gitUtils.toRepoPath('/home/test/.archon/workspaces/owner/repo/source'),
        undefined,
      ]);
    });

    test('does not leak token when forge name appears only in URL path', async () => {
      process.env.GITLAB_TOKEN = 'glpat-shouldnotleak';
      delete process.env.GH_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://evil.example.com/gitlab/mirror',
        }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://evil.example.com/gitlab/mirror');

      expect(JSON.stringify(getGitCloneCall())).not.toContain('glpat-shouldnotleak');
      delete process.env.GITLAB_TOKEN;
    });
  });

  // ── resolveForgeAuth unit tests ──────────────────────────────────────────
  describe('resolveForgeAuth', () => {
    const { resolveForgeAuth } = require('./clone');

    test('returns GH_TOKEN as password credentials for github.com', () => {
      process.env.GH_TOKEN = 'ghp_abc';
      const result = resolveForgeAuth('https://github.com/owner/repo');
      expect(result).toEqual({ username: 'x-access-token', password: 'ghp_abc' });
      delete process.env.GH_TOKEN;
    });

    test('returns GITLAB_TOKEN as oauth2 password credentials for gitlab.com', () => {
      process.env.GITLAB_TOKEN = 'glpat-xyz';
      const result = resolveForgeAuth('https://gitlab.com/owner/repo');
      expect(result).toEqual({ username: 'oauth2', password: 'glpat-xyz' });
      delete process.env.GITLAB_TOKEN;
    });

    test('returns undefined when the credential env var is not set', () => {
      delete process.env.GH_TOKEN;
      const result = resolveForgeAuth('https://github.com/owner/repo');
      expect(result).toBeUndefined();
    });

    test('returns undefined for unknown forge', () => {
      const result = resolveForgeAuth('https://bitbucket.org/owner/repo');
      expect(result).toBeUndefined();
    });

    test('resolves GH_TOKEN for a bare host/path once validateCloneUrl normalizes it', () => {
      process.env.GH_TOKEN = 'ghp_bare';
      const validated = gitUtils.validateCloneUrl('github.com/owner/repo');
      if (!validated.ok) throw new Error(validated.error);
      const result = resolveForgeAuth(validated.url);
      expect(result).toEqual({ username: 'x-access-token', password: 'ghp_bare' });
      delete process.env.GH_TOKEN;
    });

    test.each([
      ['GH_TOKEN', 'http://github.com/owner/repo'],
      ['GH_TOKEN', 'ssh://git@github.com/owner/repo'],
      ['GITLAB_TOKEN', 'http://gitlab.com/owner/repo'],
    ])('does not send %s to a known forge over a non-HTTPS URL: %s', (envVar, url) => {
      process.env[envVar] = 'tok-shouldnotleak';
      mockLogger.warn.mockClear();
      const result = resolveForgeAuth(url);
      delete process.env[envVar];
      expect(result).toBeUndefined();
      // The withheld token is visible in logs, without the token itself.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ expectedScheme: 'https:' }),
        'clone.forge_token_withheld_insecure_scheme'
      );
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('tok-shouldnotleak');
    });

    test('sends a self-hosted token only over the configured scheme', () => {
      process.env.GITLAB_TOKEN = 'glpat-scheme';
      process.env.GITLAB_URL = 'https://code.mycompany.com';
      expect(resolveForgeAuth('http://code.mycompany.com/team/project')).toBeUndefined();

      // An explicitly configured http:// forge keeps working over http://.
      process.env.GITLAB_URL = 'http://code.mycompany.com';
      expect(resolveForgeAuth('http://code.mycompany.com/team/project')).toEqual({
        username: 'oauth2',
        password: 'glpat-scheme',
      });
      expect(resolveForgeAuth('https://code.mycompany.com/team/project')).toBeUndefined();

      delete process.env.GITLAB_URL;
      delete process.env.GITLAB_TOKEN;
    });

    test('sends the GitHub token to the GITHUB_URL Enterprise host only over its scheme and authority', () => {
      process.env.GH_TOKEN = 'ghp_enterprise';
      expect(resolveForgeAuth('https://github.example.com/o/r')).toBeUndefined();

      process.env.GITHUB_URL = 'https://github.example.com';
      expect(resolveForgeAuth('https://github.example.com/o/r')).toEqual({
        username: 'x-access-token',
        password: 'ghp_enterprise',
      });
      expect(resolveForgeAuth('http://github.example.com/o/r')).toBeUndefined();
      expect(resolveForgeAuth('https://github.example.com.attacker.test/o/r')).toBeUndefined();

      delete process.env.GITHUB_URL;
      delete process.env.GH_TOKEN;
    });

    test("a malformed GITHUB_URL does not withhold other forges' credentials", () => {
      process.env.GITHUB_URL = 'https://github.example.com/api/v3';
      process.env.GITLAB_URL = 'https://gitlab.corp.example';
      process.env.GITLAB_TOKEN = 'glpat-corp';
      expect(resolveForgeAuth('https://gitlab.corp.example/o/r')).toEqual({
        username: 'oauth2',
        password: 'glpat-corp',
      });

      delete process.env.GITHUB_URL;
      delete process.env.GITLAB_URL;
      delete process.env.GITLAB_TOKEN;
    });

    test('does not match forge name in URL path (security)', () => {
      process.env.GITLAB_TOKEN = 'glpat-leaked';
      const result = resolveForgeAuth('https://evil.example.com/gitlab/mirror');
      expect(result).toBeUndefined();
      delete process.env.GITLAB_TOKEN;
    });

    test.each([
      ['GITLAB_TOKEN', 'https://gitlab.attacker.example/x.git'],
      ['GITEA_TOKEN', 'https://gitea.attacker.example/x.git'],
      ['GITEA_TOKEN', 'https://forgejo.attacker.example/x.git'],
    ])('does not send %s to an unconfigured host named like a forge: %s', (envVar, url) => {
      process.env[envVar] = 'tok-shouldnotleak';
      const result = resolveForgeAuth(url);
      delete process.env[envVar];
      expect(result).toBeUndefined();
    });

    test('returns GITEA_TOKEN when GITEA_URL hostname matches clone URL', () => {
      process.env.GITEA_URL = 'https://git.example.com';
      process.env.GITEA_TOKEN = 'gitea_tok_123';
      const result = resolveForgeAuth('https://git.example.com/group/app.git');
      expect(result).toEqual({ username: 'gitea_tok_123', password: '' });
      delete process.env.GITEA_URL;
      delete process.env.GITEA_TOKEN;
    });

    test('returns GITLAB_TOKEN as oauth2 password credentials when GITLAB_URL matches', () => {
      process.env.GITLAB_URL = 'https://code.mycompany.com';
      process.env.GITLAB_TOKEN = 'glpat-corp';
      const result = resolveForgeAuth('https://code.mycompany.com/team/project');
      expect(result).toEqual({ username: 'oauth2', password: 'glpat-corp' });
      delete process.env.GITLAB_URL;
      delete process.env.GITLAB_TOKEN;
    });

    test('matches configured forge authentication by explicit authority', () => {
      process.env.GITLAB_URL = 'https://code.mycompany.com:8443';
      process.env.GITLAB_TOKEN = 'glpat-port';

      expect(resolveForgeAuth('https://code.mycompany.com:8443/team/project')).toEqual({
        username: 'oauth2',
        password: 'glpat-port',
      });
      expect(resolveForgeAuth('https://code.mycompany.com:9443/team/project')).toBeUndefined();

      delete process.env.GITLAB_URL;
      delete process.env.GITLAB_TOKEN;
    });

    test('does not leak GITEA_TOKEN when GITEA_URL is set but hostname differs', () => {
      process.env.GITEA_URL = 'https://git.example.com';
      process.env.GITEA_TOKEN = 'gitea_tok_secret';
      const result = resolveForgeAuth('https://evil.example.com/repo');
      expect(result).toBeUndefined();
      delete process.env.GITEA_URL;
      delete process.env.GITEA_TOKEN;
    });

    test('URL fallback does not activate when token env var is unset', () => {
      process.env.GITEA_URL = 'https://git.example.com';
      delete process.env.GITEA_TOKEN;
      const result = resolveForgeAuth('https://git.example.com/group/app');
      expect(result).toBeUndefined();
      delete process.env.GITEA_URL;
    });
  });

  // ── Already-cloned directory ───────────────────────────────────────────
  describe('pre-existing clone', () => {
    beforeEach(() => {
      // .git directory exists
      spyFsAccess.mockResolvedValue(undefined);
      // The fake checkout is absent on disk, so saved-checkout verification has nothing to inspect.
      spyFsStat.mockImplementation(realFsStat);
    });

    test('returns existing codebase when directory and DB record exist', async () => {
      const existingCodebase = makeCodebase({
        id: 'existing-id',
        name: 'owner/repo',
        repository_url: 'https://github.com/owner/repo',
        default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
      });
      mockListCodebaseClaims.mockResolvedValueOnce([existingCodebase]);

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.alreadyExisted).toBe(true);
      expect(result.codebaseId).toBe('existing-id');
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
    });

    test('finds an existing codebase stored with a .git suffix', async () => {
      mockListCodebaseClaims.mockResolvedValueOnce([
        makeCodebase({
          id: 'found-via-git-suffix',
          repository_url: 'https://github.com/owner/repo.git',
        }),
      ]);

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.alreadyExisted).toBe(true);
      expect(result.codebaseId).toBe('found-via-git-suffix');
    });

    test('refuses registration when directory exists but no matching codebase is found', async () => {
      const refusal = await cloneRepository('https://github.com/owner/repo').catch(
        (error: unknown) => error
      );
      expect(refusal).toBeInstanceOf(ProjectRegistrationError);
      expect(refusal instanceof Error && refusal.message).toContain('Directory already exists');
    });
  });

  // ── Local path delegation ──────────────────────────────────────────────
  describe('local path delegation', () => {
    test('delegates absolute path (/) to registerRepository', async () => {
      // registerRepository calls git rev-parse, then creates codebase
      spyExecFileAsync.mockImplementation((_file: string, args: string[]) =>
        Promise.resolve({ stdout: args.includes('rev-parse') ? '.git' : '', stderr: '' })
      );
      mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'myrepo', default_cwd: '/home/user/myrepo' }) as ReturnType<
          typeof makeCodebase
        >
      );

      const result = await cloneRepository('/home/user/myrepo');

      expect(spyCloneGitRepository).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    test('delegates tilde path (~/) to registerRepository with expansion', async () => {
      spyExecFileAsync.mockImplementation((_file: string, args: string[]) =>
        Promise.resolve({ stdout: args.includes('rev-parse') ? '.git' : '', stderr: '' })
      );
      mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'myrepo', default_cwd: '/home/test/myrepo' }) as ReturnType<
          typeof makeCodebase
        >
      );

      const result = await cloneRepository('~/myrepo');

      expect(result).toBeDefined();
      // expandTilde was applied (path became /home/test/myrepo)
      const revParseCall = (spyExecFileAsync.mock.calls as string[][]).find(args =>
        args[1]?.includes('rev-parse')
      );
      expect(revParseCall?.[1]).toContain(resolve('/home/test/myrepo'));
    });

    test('delegates relative path (./) to registerRepository', async () => {
      spyExecFileAsync.mockImplementation((_file: string, args: string[]) =>
        Promise.resolve({ stdout: args.includes('rev-parse') ? '.git' : '', stderr: '' })
      );
      mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      const result = await cloneRepository('./my-local-repo');

      expect(result).toBeDefined();
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────
  describe('error handling', () => {
    test('reports both registration and cleanup failures with the detached checkout path', async () => {
      const registrationError = new Error('Project owner at /existing/checkout; use worktrees');
      const cleanupError = new Error('permission denied');
      mockCreateCodebase.mockRejectedValueOnce(registrationError);
      mockRemoveUnregisteredCheckout.mockImplementationOnce((path, remove) =>
        remove(`${path}.removing`)
      );
      spyFsRm.mockRejectedValueOnce(cleanupError);

      const error = await cloneRepository('https://github.com/owner/repo').catch(
        (error: unknown) => error
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(error instanceof AggregateError && error.errors).toEqual([
        registrationError,
        cleanupError,
      ]);
      expect(error instanceof Error && error.cause).toBe(registrationError);
      expect(error instanceof Error && error.message).toContain(
        'Checkout cleanup failed at /home/test/.archon/workspaces/owner/repo/source.removing:'
      );
      expect(error instanceof Error && error.message).toContain(cleanupError.message);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { path: '/home/test/.archon/workspaces/owner/repo/source.removing', err: cleanupError },
        'registration.checkout_cleanup_failed'
      );
    });

    test('reports a cleanup failure after the delete without a leftover path', async () => {
      const registrationError = new Error('registration failed');
      const lockError = new Error('lock release failed');
      mockCreateCodebase.mockRejectedValueOnce(registrationError);
      mockRemoveUnregisteredCheckout.mockImplementationOnce(async (path, remove) => {
        await remove(`${path}.removing`);
        throw lockError;
      });

      const error = await cloneRepository('https://github.com/owner/repo').catch(
        (error: unknown) => error
      );
      expect(error instanceof AggregateError && error.errors).toEqual([
        registrationError,
        lockError,
      ]);
      expect(error instanceof Error && error.message).toContain(
        'Checkout cleanup failed: lock release failed'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        { path: undefined, err: lockError },
        'registration.checkout_cleanup_failed'
      );
    });

    test('wraps a sanitized clone failure', async () => {
      process.env.GH_TOKEN = 'super_secret_token';
      spyCloneGitRepository.mockResolvedValue({
        ok: false,
        error: { code: 'unknown', message: 'fatal: repository unavailable' },
      });

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'Failed to clone repository: fatal: repository unavailable'
      );
      expect(spyFsRm).not.toHaveBeenCalled();
      expect(mockCreateCodebase).not.toHaveBeenCalled();
      delete process.env.GH_TOKEN;
    });
  });

  // ── Command auto-loading ───────────────────────────────────────────────
  describe('command auto-loading', () => {
    test.each(['EACCES', 'EIO'])(
      'reports command-directory access failure %s and keeps the saved checkout',
      async code => {
        const existing = makeCodebase();
        mockListCodebaseClaims.mockResolvedValueOnce([existing]);
        const error = Object.assign(new Error('commands unavailable'), { code });
        spyFsStat.mockImplementation(realFsStat);
        spyFsAccess.mockImplementation(async (path: Parameters<typeof fsPromises.access>[0]) => {
          if (!String(path).endsWith('.git')) throw error;
        });
        const result = await cloneRepository('https://github.com/owner/repo');
        expect(result).toMatchObject({ codebaseId: existing.id, commandCount: 0 });
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: error }),
          'registration.command_folder_unavailable'
        );
        expect(mockFindCommandFiles).not.toHaveBeenCalled();
        expect(spyFsRm).not.toHaveBeenCalled();
      }
    );

    test('preserves a registered checkout when loading its commands fails', async () => {
      spyFsAccess.mockImplementation(async (path: Parameters<typeof fsPromises.access>[0]) => {
        if (String(path).endsWith('.git')) throw new Error('missing checkout');
      });
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase());
      mockFindCommandFiles.mockResolvedValue([{ commandName: 'build', relativePath: 'build.md' }]);
      const error = new Error('command store unavailable');
      mockGetCodebaseCommands.mockRejectedValueOnce(error);

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toBe(error);
      expect(mockCreateCodebase).toHaveBeenCalledTimes(1);
      expect(spyFsRm).not.toHaveBeenCalled();
    });

    test('loads commands when .archon/commands directory exists with markdown files', async () => {
      // access(): .git → ENOENT (proceed to clone), everything else → success (commands)
      spyFsAccess.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('.git')) {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.resolve(undefined);
      });
      mockFindCommandFiles.mockResolvedValue([
        { commandName: 'build', relativePath: 'build.md' },
        { commandName: 'test', relativePath: 'test.md' },
      ]);
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.commandCount).toBe(2);
      expect(mockUpdateCodebaseCommands.mock.calls.length).toBe(1);
    });

    test('returns commandCount 0 when no command folders exist', async () => {
      // access() always rejects → no command folder found (and no pre-existing .git)
      spyFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.commandCount).toBe(0);
      expect(mockUpdateCodebaseCommands.mock.calls.length).toBe(0);
    });

    test('returns commandCount 0 when command folder exists but contains no markdown files', async () => {
      // access(): .git → ENOENT, command folder → success
      spyFsAccess.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('.git')) {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.resolve(undefined);
      });
      mockFindCommandFiles.mockResolvedValue([]);
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.commandCount).toBe(0);
      expect(mockUpdateCodebaseCommands.mock.calls.length).toBe(0);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('registerRepository', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
  });

  test.each([false, true])(
    'registers only executable command files (existing codebase: %s)',
    async alreadyExists => {
      const cwd = await fsPromises.mkdtemp(join(tmpdir(), 'archon-command-registration-'));
      try {
        const commandRoot = join(cwd, '.archon', 'commands');
        for (const folder of ['zeta', 'alpha', 'group/sub']) {
          await fsPromises.mkdir(join(commandRoot, folder), { recursive: true });
        }
        await fsPromises.writeFile(join(commandRoot, 'zeta', 'review.md'), 'zeta');
        await fsPromises.writeFile(join(commandRoot, 'alpha', 'review.md'), 'alpha');
        await fsPromises.writeFile(join(commandRoot, 'group', 'sub', 'hidden.md'), 'hidden');
        await fsPromises.writeFile(join(commandRoot, 'build.md'), 'build');
        const codebase = makeCodebase({ default_cwd: cwd });
        mockListCodebaseClaims.mockResolvedValue(alreadyExists ? [codebase] : []);
        mockCreateCodebase.mockResolvedValue(codebase);
        mockFindCommandFiles.mockImplementation(discoverCommandFiles);
        // Reusing a registered remote reloads its commands without creating another checkout.
        spyFsAccess.mockImplementation(async (path: Parameters<typeof fsPromises.access>[0]) => {
          if (!alreadyExists && String(path).endsWith('.git'))
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        const result = alreadyExists
          ? await cloneRepository('https://github.com/owner/repo')
          : await registerRepository(cwd);

        expect(mockUpdateCodebaseCommands).toHaveBeenCalledWith(codebase.id, {
          review: {
            path: join('.archon', 'commands', 'alpha', 'review.md'),
            description: 'From .archon/commands',
          },
          build: {
            path: join('.archon', 'commands', 'build.md'),
            description: 'From .archon/commands',
          },
        });
        expect(result.commandCount).toBe(2);
        expect(result.alreadyExisted).toBe(alreadyExists);
      } finally {
        restoreSpies();
        await removeTempTree(cwd);
      }
    }
  );

  test('canonicalizes a forward-slash path before validation, lookup and persistence', async () => {
    const gitSpelling = 'C:/workspace/myrepo';
    const canonical = resolve('/canonical/myrepo');
    spyFsRealpath.mockResolvedValue(canonical);
    mockCreateCodebase.mockResolvedValue(makeCodebase({ default_cwd: canonical }));

    const result = await registerRepository(gitSpelling);

    expect(spyExecFileAsync).toHaveBeenCalledWith('git', [
      '-C',
      canonical,
      'rev-parse',
      '--git-dir',
    ]);
    expect(mockFindCodebaseByDefaultCwd).toHaveBeenCalledWith(canonical);
    expect(mockFindCodebaseByDefaultCwd).not.toHaveBeenCalledWith(gitSpelling);
    expect(mockCreateProjectSourceSymlink).toHaveBeenCalledWith('_local', 'myrepo', canonical);
    expect(mockCreateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ default_cwd: canonical })
    );
    expect(result.defaultCwd).toBe(canonical);
  });

  // ── Happy path ─────────────────────────────────────────────────────────
  test('registers a valid local git repo not yet in DB', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('--abbrev-ref'))
        return Promise.resolve({ stdout: 'develop\n', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({ name: 'owner/repo', default_cwd: '/home/user/myrepo' }) as ReturnType<
        typeof makeCodebase
      >
    );

    const result = await registerRepository('/home/user/myrepo');

    expect(result.alreadyExisted).toBe(false);
    expect(result.name).toBe('owner/repo');
    expect(mockCreateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ default_branch: null })
    );
  });

  test('stores null default_branch when checkout is detached', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'HEAD\n', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({ name: 'owner/repo', default_cwd: '/home/user/myrepo' }) as ReturnType<
        typeof makeCodebase
      >
    );

    await registerRepository('/home/user/myrepo');

    expect(mockCreateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ default_branch: null })
    );
  });

  test('returns existing record immediately when path already registered', async () => {
    spyExecFileAsync.mockResolvedValue({ stdout: '.git', stderr: '' });
    const existingCodebase = makeCodebase({
      id: 'existing-codebase-id',
      default_cwd: '/home/user/myrepo',
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(existingCodebase);

    const result = await registerRepository('/home/user/myrepo');

    expect(result.alreadyExisted).toBe(true);
    expect(result.codebaseId).toBe('existing-codebase-id');
    // createCodebase should NOT be called
    expect(mockCreateCodebase.mock.calls.length).toBe(0);
  });

  test('reuses the registered primary checkout for a linked worktree', async () => {
    spyExecFileAsync.mockResolvedValue({ stdout: '.git', stderr: '' });
    spyGetCanonicalRepoPath.mockResolvedValueOnce(
      gitUtils.toRepoPath('/home/user/primary-checkout')
    );
    const existingCodebase = makeCodebase({
      id: 'primary-codebase-id',
      default_cwd: '/home/user/primary-checkout',
    });
    mockFindCodebaseByDefaultCwd
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingCodebase);

    const result = await registerRepository('/home/user/sibling-worktree');

    expect(mockFindCodebaseByDefaultCwd).toHaveBeenNthCalledWith(
      1,
      resolve('/home/user/sibling-worktree')
    );
    expect(mockFindCodebaseByDefaultCwd).toHaveBeenNthCalledWith(
      2,
      resolve('/home/user/primary-checkout')
    );
    expect(result).toMatchObject({
      alreadyExisted: true,
      codebaseId: 'primary-codebase-id',
      defaultCwd: '/home/user/primary-checkout',
    });
    expect(mockCreateProjectSourceSymlink).not.toHaveBeenCalled();
    expect(mockCreateCodebase).not.toHaveBeenCalled();
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });

  // ── Validation ─────────────────────────────────────────────────────────
  test('throws when path is not a git repository', async () => {
    spyExecFileAsync.mockRejectedValueOnce(new Error('not a git repository'));

    await expect(registerRepository('/home/user/not-a-repo')).rejects.toThrow(
      'Path is not a git repository'
    );
  });

  // ── Remote URL handling ────────────────────────────────────────────────
  test('uses directory name as repo name when no remote URL exists', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: '', stderr: '' });
      if (args.includes('get-url')) return Promise.reject(new Error('No such remote: origin'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({ name: 'myrepo', default_cwd: '/home/user/myrepo' }) as ReturnType<
        typeof makeCodebase
      >
    );

    const result = await registerRepository('/home/user/myrepo');

    // Fallback name is directory basename
    const createArg = mockCreateCodebase.mock.calls[0]?.[0] as { name: string };
    expect(createArg.name).toBe('myrepo');
    expect(result).toBeDefined();
  });

  test('registers a repository with no configured remote without warnings', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: '', stderr: '' });
      if (args.includes('get-url')) return Promise.reject(new Error('No such remote: origin'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    await registerRepository('/home/user/myrepo');

    // warn must NOT have been called for the "No such remote" error
    expect(mockLogger.warn.mock.calls.length).toBe(0);
  });

  test('refuses unexpected git remote-url errors', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.reject(new Error('permission denied: remote access'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    await expect(registerRepository('/home/user/myrepo')).rejects.toThrow(
      'permission denied: remote access'
    );
    expect(mockCreateCodebase).not.toHaveBeenCalled();
  });

  test('builds owner/repo name from HTTPS remote URL', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/acme/frontend', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    // Return a codebase with the name we expect registerRepoAtPath to pass
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({ name: 'acme/frontend' }) as ReturnType<typeof makeCodebase>
    );

    await registerRepository('/home/user/frontend');

    // Verify the name sent TO createCodebase was derived from the remote URL
    const createArg = mockCreateCodebase.mock.calls[0]?.[0] as { name: string };
    expect(createArg.name).toBe('acme/frontend');
  });

  test('builds owner/repo name from SSH remote URL', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'git@github.com:acme/backend.git', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({ name: 'acme/backend' }) as ReturnType<typeof makeCodebase>
    );

    await registerRepository('/home/user/backend');

    // Verify SSH owner/repo was correctly parsed and passed to createCodebase
    const createArg = mockCreateCodebase.mock.calls[0]?.[0] as { name: string };
    expect(createArg.name).toBe('acme/backend');
  });

  // ── Command auto-loading ───────────────────────────────────────────────
  test('auto-loads markdown commands found in .archon/commands', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    // access(): only the command folder path succeeds; .codex/.claude → ENOENT
    spyFsAccess.mockImplementation((path: string) => {
      const normalized = typeof path === 'string' ? path.replace(/\\/g, '/') : '';
      if (normalized.includes('.archon/commands')) {
        return Promise.resolve(undefined);
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    mockFindCommandFiles.mockResolvedValue([{ commandName: 'deploy', relativePath: 'deploy.md' }]);
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    const result = await registerRepository('/home/user/myrepo');

    expect(result.commandCount).toBe(1);
    expect(mockUpdateCodebaseCommands.mock.calls.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('registerFolder', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
  });

  // ── Happy path ─────────────────────────────────────────────────────────
  test('registers a non-git directory as a folder project (kind: folder)', async () => {
    // resolve() the input so the expectation is portable: on Windows,
    // resolve('/tmp/platform') is 'D:\tmp\platform' (drive-qualified), and
    // registerFolder stores that resolved form (realpath spy is identity here).
    const inputPath = '/tmp/platform';
    const resolvedPath = resolve(inputPath);
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'folder-uuid-1',
        name: 'platform',
        repository_url: null,
        default_cwd: resolvedPath,
      }) as ReturnType<typeof makeCodebase>
    );

    const result = await registerFolder(inputPath);

    expect(result.alreadyExisted).toBe(false);
    expect(result.name).toBe('platform');
    expect(result.repositoryUrl).toBeNull();
    expect(result.defaultBranch).toBeNull();
    expect(result.defaultCwd).toBe(resolvedPath);
    // No git commands were ever run
    expect(spyExecFileAsync.mock.calls.length).toBe(0);
    // createCodebase received kind: 'folder' and no repository_url
    expect(mockCreateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'platform', default_cwd: resolvedPath, kind: 'folder' })
    );
    const createArg = mockCreateCodebase.mock.calls[0]?.[0] as { repository_url?: unknown };
    expect(createArg.repository_url).toBeUndefined();
  });

  test('derives name from basename when name not provided', async () => {
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    await registerFolder('/home/user/ops-client');

    const createArg = mockCreateCodebase.mock.calls[0]?.[0] as { name: string };
    expect(createArg.name).toBe('ops-client');
  });

  test('uses the explicit name override when provided', async () => {
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    await registerFolder('/home/user/ops-client', 'Acme Ops');

    const createArg = mockCreateCodebase.mock.calls[0]?.[0] as { name: string };
    expect(createArg.name).toBe('Acme Ops');
  });

  // ── Validation ─────────────────────────────────────────────────────────
  test('throws when the path does not exist', async () => {
    // Canonicalization is fail-safe (it returns the unresolved path), so `stat`
    // is the existence gate. Both reject here the way the real fs does for a
    // missing path, so the registration is refused rather than stored.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    spyFsRealpath.mockRejectedValueOnce(enoent);
    spyFsStat.mockRejectedValueOnce(enoent);

    await expect(registerFolder('/tmp/does-not-exist')).rejects.toThrow('Path does not exist');
    expect(mockCreateCodebase.mock.calls.length).toBe(0);
  });

  // ── Symlink canonicalization (regression) ──────────────────────────────
  test('stores the realpath-canonicalized path so symlinked roots match on lookup', async () => {
    // Simulate macOS /tmp → /private/tmp: realpath maps the symlink to its real
    // target. Both sides are resolve()d so the comparison inside the mock and
    // the expectations hold on Windows too (resolve drive-qualifies the paths).
    const symlinkPath = resolve('/tmp/platform');
    const realPath = resolve('/private/tmp/platform');
    spyFsRealpath.mockImplementationOnce(((p: string) =>
      Promise.resolve(p === symlinkPath ? realPath : p)) as unknown as never);
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'folder-uuid-1',
        name: 'platform',
        repository_url: null,
        default_cwd: realPath,
      }) as ReturnType<typeof makeCodebase>
    );

    const result = await registerFolder('/tmp/platform');

    // The already-registered check and the stored default_cwd both use the REAL
    // path, matching what process.cwd() (and thus the gate/doctor) resolves to.
    expect(mockFindCodebaseByDefaultCwd).toHaveBeenCalledWith(realPath);
    expect(mockCreateCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ default_cwd: realPath, kind: 'folder' })
    );
    expect(result.defaultCwd).toBe(realPath);
  });

  test('throws when the path is a file, not a directory', async () => {
    spyFsStat.mockResolvedValueOnce({
      isDirectory: () => false,
    } as Awaited<ReturnType<typeof fsPromises.stat>>);

    await expect(registerFolder('/tmp/a-file.txt')).rejects.toThrow('Path is not a directory');
    expect(mockCreateCodebase.mock.calls.length).toBe(0);
  });

  test('rejects a base branch for explicit folder registration before touching git or storage', async () => {
    await expect(registerFolder('/repo', undefined, { baseBranch: 'main' })).rejects.toThrow(
      'Folder projects have no base branch'
    );
    expect(mockCreateCodebase).not.toHaveBeenCalled();
    expect(spyExecFileAsync).not.toHaveBeenCalled();
  });

  test('refuses an existing repo registration without changing identity or storage', async () => {
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(
      makeCodebase({ kind: 'repo', default_cwd: resolve('/tmp/platform') })
    );
    await expect(registerFolder('/tmp/platform')).rejects.toThrow('already registered as a repo');
    expect(mockCreateCodebase).not.toHaveBeenCalled();
    expect(spyExecFileAsync).not.toHaveBeenCalled();
  });

  // ── Idempotency ────────────────────────────────────────────────────────
  test('returns the existing record when the path is already registered', async () => {
    const existing = makeCodebase({
      id: 'existing-folder-id',
      kind: 'folder',
      name: 'platform',
      repository_url: null,
      default_cwd: '/tmp/platform',
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(existing);

    const result = await registerFolder('/tmp/platform');

    expect(result.alreadyExisted).toBe(true);
    expect(result.codebaseId).toBe('existing-folder-id');
    expect(mockCreateCodebase.mock.calls.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('normalizeRepoUrl (via cloneRepository)', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  const expectCloneTargetPath = async (url: string): Promise<string> => {
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);
    await cloneRepository(url);
    return getGitCloneCall()?.[1] ?? '';
  };

  test('HTTPS URL produces expected project source path', async () => {
    const targetPath = await expectCloneTargetPath('https://github.com/myorg/myproject');
    expect(targetPath).toBe('/home/test/.archon/workspaces/myorg/myproject/source');
  });

  test('SSH URL produces same project source path as HTTPS equivalent', async () => {
    const targetPath = await expectCloneTargetPath('git@github.com:myorg/myproject.git');
    expect(targetPath).toBe('/home/test/.archon/workspaces/myorg/myproject/source');
  });

  test('URL with trailing slash produces correct path', async () => {
    const targetPath = await expectCloneTargetPath('https://github.com/myorg/myproject/');
    expect(targetPath).toBe('/home/test/.archon/workspaces/myorg/myproject/source');
  });

  test('URL with .git suffix produces correct path without duplication', async () => {
    const targetPath = await expectCloneTargetPath('https://github.com/myorg/myproject.git');
    expect(targetPath).toBe('/home/test/.archon/workspaces/myorg/myproject/source');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('remote registration identity', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  // A same-named managed row may belong to another host sharing the database; the
  // real-git cases live in register-repository-shared-db.integration.test.ts.
  test('refuses to repoint a managed codebase onto a separate local checkout', async () => {
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    });
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockListCodebaseClaims.mockResolvedValueOnce([existingCodebase]);

    const error = await registerRepository('/home/user/repo').then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error?.message).toContain('/home/test/.archon/workspaces/owner/repo/source');
    expect(error?.message).toContain(
      `/update-project ${quoteCommandArg('owner/repo')} ${quoteCommandArg(resolve('/home/user/repo'))}`
    );
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
    expect(mockCreateCodebase).not.toHaveBeenCalled();
    // The refusal is decided before anything is written to disk.
    expect(mockEnsureProjectStructure).not.toHaveBeenCalled();
    expect(mockCreateProjectSourceSymlink).not.toHaveBeenCalled();
  });

  test('treats a path that only contains .archon/workspaces outside the real root as local', async () => {
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    });
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockListCodebaseClaims.mockResolvedValueOnce([existingCodebase]);
    const lookalike = '/mnt/backup/.archon/workspaces/owner/repo/source';

    const error = await registerRepository(lookalike).then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error?.message).toContain(
      `/update-project ${quoteCommandArg('owner/repo')} ${quoteCommandArg(resolve(lookalike))}`
    );
  });

  test('escapes quotes in the project name and path of the /update-project suggestion', async () => {
    // Display names and local paths may contain quotes.
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'we"ird',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/test/.archon/workspaces/_local/we"ird/source',
    });
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.at(-1) === 'remote') return Promise.resolve({ stdout: 'origin', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockListCodebaseClaims.mockResolvedValueOnce([existingCodebase]);

    const error = await registerRepository('/home/user/we"ird').then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error?.message).toContain(
      `/update-project ${JSON.stringify('we"ird')} ${JSON.stringify(resolve('/home/user/we"ird'))}`
    );
  });

  test('should not downgrade default_cwd from local to managed path', async () => {
    // Existing codebase registered via local path
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/user/repo',
    });
    spyFsAccess.mockResolvedValue(undefined);
    // A matching remote reuses the registered checkout before cloning.
    mockListCodebaseClaims.mockResolvedValueOnce([existingCodebase]);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    const result = await cloneRepository('https://github.com/owner/repo');

    // default_cwd should stay as local path (managed path is NOT "better")
    expect(result.defaultCwd).toBe('/home/user/repo');
    // updateCodebase should NOT be called with default_cwd (no downgrade)
    if (mockUpdateCodebase.mock.calls.length > 0) {
      const updateArgs = mockUpdateCodebase.mock.calls[0];
      expect(updateArgs?.[1].default_cwd).toBeUndefined();
    }
  });

  test('a matching name without a matching remote creates a separate project', async () => {
    const existingCodebase = makeCodebase({ repository_url: null, default_cwd: '/home/user/repo' });
    mockListCodebaseClaims.mockResolvedValue([existingCodebase]);
    mockCreateCodebase.mockImplementation(async input =>
      makeCodebase({ ...input, repository_url: input.repository_url ?? null })
    );

    const result = await cloneRepository('https://github.com/owner/repo');

    expect(result.name).toBe('owner/repo-2');
    expect(getGitCloneCall()?.[1]).toBe(
      gitUtils.toRepoPath('/home/test/.archon/workspaces/owner/repo-2/source')
    );
    expect(result.alreadyExisted).toBe(false);
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('RegisterResult shape', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  test('cloneRepository result contains all expected fields', async () => {
    mockCreateCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'abc-123',
        name: 'owner/repo',
        repository_url: 'https://github.com/owner/repo',
        default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
      }) as ReturnType<typeof makeCodebase>
    );

    const result = await cloneRepository('https://github.com/owner/repo');

    expect(result).toMatchObject({
      codebaseId: 'abc-123',
      name: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      defaultCwd: '/home/test/.archon/workspaces/owner/repo/source',
      commandCount: 0,
      alreadyExisted: false,
    });
  });

  test('pre-existing codebase result has alreadyExisted: true and commandCount: 0', async () => {
    spyFsAccess.mockResolvedValue(undefined); // .git exists
    mockListCodebaseClaims.mockResolvedValueOnce([makeCodebase({ id: 'existing-999' })]);
    spyFsStat.mockImplementation(realFsStat);

    const result = await cloneRepository('https://github.com/owner/repo');

    expect(result.alreadyExisted).toBe(true);
    expect(result.commandCount).toBe(0);
  });
});
