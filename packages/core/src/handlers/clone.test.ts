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
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '@archon/git';
import type { Codebase } from '../types';
import type * as CodebaseDb from '../db/codebases';
import type * as Commands from '../utils/commands';
import {
  findCodebaseForCheckoutPath,
  type CodebaseCheckoutResolverDeps,
} from '../services/codebase-checkout-resolver';
import { createMockLogger } from '../test/mocks/logger';

// Capture the real discovery function before the re-export is replaced by the module mock.
const { findCommandFiles: discoverCommandFiles } = await import('@archon/paths/archon-paths');

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
const mockListCodebases = mock<typeof CodebaseDb.listCodebases>(() => Promise.resolve([]));
const mockFindCodebaseByName = mock<typeof CodebaseDb.findCodebaseByName>(() =>
  Promise.resolve(null)
);
const mockUpdateCodebase = mock<typeof CodebaseDb.updateCodebase>(() => Promise.resolve());
const mockCreateProjectSourceSymlink = mock((): Promise<void> => Promise.resolve());

mock.module('../db/codebases', () => ({
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  listCodebases: mockListCodebases,
  findCodebaseByName: mockFindCodebaseByName,
  updateCodebase: mockUpdateCodebase,
}));

// ── @archon/paths mock ──────────────────────────────────────────────────────
const mockLogger = createMockLogger();

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
  ensureProjectStructure: mock(() => Promise.resolve()),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/source`
  ),
  createProjectSourceSymlink: mockCreateProjectSourceSymlink,
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
  // Nothing here calls it, but this factory replaces the module process-wide and
  // child-isolation-resolver.ts imports it by name — omitting it breaks that
  // import at module-eval for anything in the same batch that pulls it in.
  loadRepoConfig: mock(() => Promise.resolve(null)),
}));

// ── utils/commands mock ─────────────────────────────────────────────────────
const mockFindCommandFiles = mock<typeof Commands.findCommandFiles>(() => Promise.resolve([]));
mock.module('../utils/commands', () => ({
  findCommandFiles: mockFindCommandFiles,
}));

// ── Import module under test AFTER mocks are registered ────────────────────
import { cloneRepository, registerRepository, registerFolder } from './clone';

// ── Spies for fs/promises and @archon/git ──────────────────────────────────
let spyFsAccess: ReturnType<typeof spyOn>;
let spyFsRm: ReturnType<typeof spyOn>;
let spyFsStat: ReturnType<typeof spyOn>;
let spyFsRealpath: ReturnType<typeof spyOn>;
let spyExecFileAsync: ReturnType<typeof spyOn>;
let spyCloneGitRepository: ReturnType<typeof spyOn>;
let spyGetCanonicalRepoPath: ReturnType<typeof spyOn>;

function setupSpies(): void {
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
  spyFsAccess?.mockRestore();
  spyFsRm?.mockRestore();
  spyFsRealpath?.mockRestore();
  spyFsStat?.mockRestore();
  spyExecFileAsync?.mockRestore();
  spyCloneGitRepository?.mockRestore();
  spyGetCanonicalRepoPath?.mockRestore();
}

function clearMocks(): void {
  // mockReset() clears both call history AND any queued mockResolvedValueOnce values,
  // preventing cross-test bleed when tests queue different return values.
  mockCreateCodebase.mockReset();
  mockGetCodebaseCommands.mockReset();
  mockUpdateCodebaseCommands.mockReset();
  mockFindCodebaseByRepoUrl.mockReset();
  mockFindCodebaseByDefaultCwd.mockReset();
  mockFindCodebaseByName.mockReset();
  mockUpdateCodebase.mockReset();
  mockCreateProjectSourceSymlink.mockClear();
  mockFindCommandFiles.mockReset();
  mockLoadConfig.mockReset();
  mockLoadConfig.mockResolvedValue({ assistant: 'claude' });
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
    listCodebases: async () => [],
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
  const cwd = '/workspace/external-linked';
  const commonGitDir = '/metadata/repository';

  function externalLinkedError(): gitUtils.CanonicalRepoPathUnavailableError {
    return new gitUtils.CanonicalRepoPathUnavailableError(cwd, commonGitDir);
  }

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
      listCodebases: async () => [registered, separateClone],
      getGitCheckoutIdentity: async path => ({
        gitDir: path === cwd ? `${commonGitDir}/worktrees/linked` : `${path}/.git`,
        commonGitDir:
          path === separateClone.default_cwd ? '/metadata/separate-clone' : commonGitDir,
        linkedWorktree: path === cwd,
      }),
    });

    await expect(findCodebaseForCheckoutPath(cwd, deps)).resolves.toBe(registered);
  });

  test('does not conflate a separate clone with the registered repository', async () => {
    const registered = makeCodebase({ default_cwd: '/workspace/primary' }) as Codebase;
    const deps = makeResolverDeps({
      getCanonicalRepoPath: async () => {
        throw externalLinkedError();
      },
      listCodebases: async () => [registered],
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
      listCodebases: async () => [first, second],
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
  });

  // ── URL normalization / happy-path cloning ─────────────────────────────
  describe('HTTPS URL cloning', () => {
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

    test('adds safe.directory after a successful clone', async () => {
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('https://github.com/owner/repo');

      const safeDir = (spyExecFileAsync.mock.calls as string[][]).find(args =>
        args[1]?.includes('safe.directory')
      );
      expect(safeDir).toBeDefined();
    });

    test('removes the source/ directory before cloning so git has a clean target', async () => {
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('https://github.com/owner/repo');

      expect(spyFsRm.mock.calls.length).toBeGreaterThan(0);
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

    test('passes GH_TOKEN as request-scoped clone credentials', async () => {
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('https://github.com/owner/private-repo');

      const cloneCall = getGitCloneCall();
      expect(cloneCall?.[0]).toBe('https://github.com/owner/private-repo');
      expect(cloneCall?.[2]).toEqual({
        credentials: { username: 'ghp_testtoken123', password: '' },
      });
    });

    test('passes GITHUB_TOKEN as request-scoped clone credentials', async () => {
      process.env.GITHUB_TOKEN = 'ghp_github_token_456';
      delete process.env.GH_TOKEN;
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('https://github.com/owner/private-repo');

      expect(getGitCloneCall()).toEqual([
        'https://github.com/owner/private-repo',
        gitUtils.toRepoPath('/home/test/.archon/workspaces/owner/private-repo/source'),
        { credentials: { username: 'ghp_github_token_456', password: '' } },
      ]);
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
        credentials: { username: 'ghp_testtoken123', password: '' },
      });
    });
  });

  // ── Multi-forge authentication ────────────────────────────────────────
  describe('multi-forge authentication', () => {
    afterEach(() => {
      delete process.env.GITLAB_TOKEN;
      delete process.env.GITEA_TOKEN;
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

    test('passes GITLAB_TOKEN for self-hosted GitLab URLs', async () => {
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

    test('passes GITEA_TOKEN for Gitea URLs', async () => {
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

    test('passes GITEA_TOKEN for Forgejo URLs', async () => {
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

    test('returns GH_TOKEN as username credentials for github.com', () => {
      process.env.GH_TOKEN = 'ghp_abc';
      const result = resolveForgeAuth('https://github.com/owner/repo');
      expect(result).toEqual({ username: 'ghp_abc', password: '' });
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

    test('resolves GH_TOKEN for bare host/path form without protocol', () => {
      process.env.GH_TOKEN = 'ghp_bare';
      const result = resolveForgeAuth('github.com/owner/repo');
      expect(result).toEqual({ username: 'ghp_bare', password: '' });
      delete process.env.GH_TOKEN;
    });

    test('does not match forge name in URL path (security)', () => {
      process.env.GITLAB_TOKEN = 'glpat-leaked';
      const result = resolveForgeAuth('https://evil.example.com/gitlab/mirror');
      expect(result).toBeUndefined();
      delete process.env.GITLAB_TOKEN;
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
    });

    test('returns existing codebase when directory and DB record exist', async () => {
      const existingCodebase = makeCodebase({
        id: 'existing-id',
        name: 'owner/repo',
        repository_url: 'https://github.com/owner/repo',
        default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
      });
      mockFindCodebaseByRepoUrl.mockResolvedValueOnce(existingCodebase);

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.alreadyExisted).toBe(true);
      expect(result.codebaseId).toBe('existing-id');
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
    });

    test('finds existing codebase by URL with .git suffix fallback', async () => {
      // First lookup (no .git) returns null, second (.git) returns codebase
      mockFindCodebaseByRepoUrl
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeCodebase({ id: 'found-via-git-suffix' }));

      const result = await cloneRepository('https://github.com/owner/repo');

      expect(result.alreadyExisted).toBe(true);
      expect(result.codebaseId).toBe('found-via-git-suffix');
    });

    test('throws when directory exists but no matching codebase is found', async () => {
      mockFindCodebaseByRepoUrl.mockResolvedValue(null);

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'Directory already exists'
      );
    });
  });

  // ── Local path delegation ──────────────────────────────────────────────
  describe('local path delegation', () => {
    test('delegates absolute path (/) to registerRepository', async () => {
      // registerRepository calls git rev-parse, then creates codebase
      spyExecFileAsync.mockResolvedValue({ stdout: '.git', stderr: '' });
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
      spyExecFileAsync.mockResolvedValue({ stdout: '.git', stderr: '' });
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
      expect(revParseCall?.[1]).toContain('/home/test/myrepo');
    });

    test('delegates relative path (./) to registerRepository', async () => {
      spyExecFileAsync.mockResolvedValue({ stdout: '.git', stderr: '' });
      mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      const result = await cloneRepository('./my-local-repo');

      expect(result).toBeDefined();
      expect(spyCloneGitRepository).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────
  describe('error handling', () => {
    test('wraps a sanitized clone failure', async () => {
      process.env.GH_TOKEN = 'super_secret_token';
      spyCloneGitRepository.mockResolvedValue({
        ok: false,
        error: { code: 'unknown', message: 'fatal: repository unavailable' },
      });

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'Failed to clone repository: fatal: repository unavailable'
      );
      delete process.env.GH_TOKEN;
    });

    test('re-throws non-ENOENT errors from rm()', async () => {
      const permError = Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      });
      spyFsRm.mockRejectedValueOnce(permError);

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow('EPERM');
    });

    test('ignores ENOENT from rm() (target directory does not exist yet)', async () => {
      const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      spyFsRm.mockRejectedValueOnce(enoentErr);
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      // Should NOT throw
      const result = await cloneRepository('https://github.com/owner/repo');
      expect(result).toBeDefined();
    });
  });

  // ── Command auto-loading ───────────────────────────────────────────────
  describe('command auto-loading', () => {
    test('loads commands when .archon/commands directory exists with markdown files', async () => {
      // access(): .git → ENOENT (proceed to clone), everything else → success (assistant + commands)
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

  // ── Assistant type detection ───────────────────────────────────────────
  describe('assistant type detection', () => {
    test('detects codex assistant when .codex folder exists', async () => {
      // access(): first call is for .git (does not exist), then .codex (exists), then command search
      let callIndex = 0;
      spyFsAccess.mockImplementation((path: string) => {
        if (typeof path === 'string' && path.endsWith('.codex')) {
          return Promise.resolve(undefined);
        }
        if (typeof path === 'string' && path.endsWith('.git')) {
          callIndex++;
          // First call is the .git existence check (must REJECT to proceed to clone)
          if (callIndex === 1)
            return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ ai_assistant_type: 'codex' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo');

      const createCall = mockCreateCodebase.mock.calls[0] as [
        {
          name: string;
          ai_assistant_type: string;
        },
      ];
      expect(createCall[0].ai_assistant_type).toBe('codex');
    });

    test('defaults to claude when neither .codex nor .claude folder exists', async () => {
      spyFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ ai_assistant_type: 'claude' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo');

      const createCall = mockCreateCodebase.mock.calls[0] as [{ ai_assistant_type: string }];
      expect(createCall[0].ai_assistant_type).toBe('claude');
    });

    test('uses configured provider when no .codex or .claude folder exists', async () => {
      mockLoadConfig.mockResolvedValue({ assistant: 'pi' });
      spyFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ ai_assistant_type: 'pi' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo');

      const createCall = mockCreateCodebase.mock.calls[0] as [{ ai_assistant_type: string }];
      expect(createCall[0].ai_assistant_type).toBe('pi');
    });

    test('falls back to claude when loadConfig fails', async () => {
      mockLoadConfig.mockRejectedValue(new Error('config load failed'));
      spyFsAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ ai_assistant_type: 'claude' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo');

      const createCall = mockCreateCodebase.mock.calls[0] as [{ ai_assistant_type: string }];
      expect(createCall[0].ai_assistant_type).toBe('claude');
    });

    test('detects claude assistant when .claude folder exists but .codex does not', async () => {
      spyFsAccess.mockImplementation((path: string) => {
        // .codex → ENOENT, .claude → exists, .git → ENOENT, commands → ENOENT
        if (typeof path === 'string' && path.endsWith('.claude')) {
          return Promise.resolve(undefined);
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ ai_assistant_type: 'claude' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo');

      const createCall = mockCreateCodebase.mock.calls[0] as [{ ai_assistant_type: string }];
      expect(createCall[0].ai_assistant_type).toBe('claude');
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
        mockFindCodebaseByName.mockResolvedValue(alreadyExists ? codebase : null);
        mockCreateCodebase.mockResolvedValue(codebase);
        mockFindCommandFiles.mockImplementation(discoverCommandFiles);
        spyFsAccess.mockResolvedValue(undefined);

        const result = await registerRepository(cwd);

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

  // ── Happy path ─────────────────────────────────────────────────────────
  test('registers a valid local git repo not yet in DB', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('--abbrev-ref'))
        return Promise.resolve({ stdout: 'develop\n', stderr: '' });
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
      expect.objectContaining({ default_branch: 'develop' })
    );
  });

  test('stores null default_branch when checkout is detached', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'HEAD\n', stderr: '' });
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

    expect(mockFindCodebaseByDefaultCwd).toHaveBeenNthCalledWith(1, '/home/user/sibling-worktree');
    expect(mockFindCodebaseByDefaultCwd).toHaveBeenNthCalledWith(2, '/home/user/primary-checkout');
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

  test('does not warn for expected "No such remote" error', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('get-url')) return Promise.reject(new Error('No such remote: origin'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    await registerRepository('/home/user/myrepo');

    // warn must NOT have been called for the "No such remote" error
    expect(mockLogger.warn.mock.calls.length).toBe(0);
  });

  test('logs warn for unexpected git remote-url errors', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('get-url'))
        return Promise.reject(new Error('permission denied: remote access'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    await registerRepository('/home/user/myrepo');

    expect(mockLogger.warn.mock.calls.length).toBe(1);
  });

  test('builds owner/repo name from HTTPS remote URL', async () => {
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
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

  // ── Idempotency ────────────────────────────────────────────────────────
  test('returns the existing record when the path is already registered', async () => {
    const existing = makeCodebase({
      id: 'existing-folder-id',
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
describe('name-based deduplication', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  test('should return existing codebase when registering same owner/repo via different path', async () => {
    // Existing codebase registered via clone (managed path)
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    });
    // registerRepository: rev-parse succeeds, path not in DB, remote URL returns owner/repo
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    // Name-based lookup finds existing codebase
    mockFindCodebaseByName.mockResolvedValueOnce(existingCodebase);

    const result = await registerRepository('/home/user/repo');

    expect(result.alreadyExisted).toBe(true);
    expect(result.codebaseId).toBe('existing-id');
    // createCodebase should NOT be called
    expect(mockCreateCodebase.mock.calls.length).toBe(0);
  });

  test('should update default_cwd to local path when local is registered after clone', async () => {
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    });
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('--abbrev-ref'))
        return Promise.resolve({ stdout: 'develop\n', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockFindCodebaseByName.mockResolvedValueOnce(existingCodebase);

    const result = await registerRepository('/home/user/repo');

    // updateCodebase should be called with the local path
    expect(mockUpdateCodebase.mock.calls.length).toBe(1);
    const updateArgs = mockUpdateCodebase.mock.calls[0] as [
      string,
      { default_cwd?: string; default_branch?: string | null },
    ];
    expect(updateArgs[0]).toBe('existing-id');
    expect(updateArgs[1].default_cwd).toBe('/home/user/repo');
    expect(updateArgs[1].default_branch).toBe('develop');
    expect(result.defaultCwd).toBe('/home/user/repo');
    expect(result.defaultBranch).toBe('develop');
  });

  test('fills missing default_branch on existing local codebase', async () => {
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/user/repo',
      default_branch: null,
    });
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--git-dir')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'trunk\n', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockFindCodebaseByName.mockResolvedValueOnce(existingCodebase);

    const result = await registerRepository('/home/user/repo');

    expect(mockUpdateCodebase).toHaveBeenCalledWith('existing-id', { default_branch: 'trunk' });
    expect(result.defaultBranch).toBe('trunk');
  });

  test('should not downgrade default_cwd from local to managed path', async () => {
    // Existing codebase registered via local path
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/home/user/repo',
    });
    // Clone same repo — name-based lookup finds existing
    // .git does NOT exist (proceed to clone), but name dedup catches it
    mockFindCodebaseByName.mockResolvedValueOnce(existingCodebase);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    const result = await cloneRepository('https://github.com/owner/repo');

    // default_cwd should stay as local path (managed path is NOT "better")
    expect(result.defaultCwd).toBe('/home/user/repo');
    // updateCodebase should NOT be called with default_cwd (no downgrade)
    if (mockUpdateCodebase.mock.calls.length > 0) {
      const updateArgs = mockUpdateCodebase.mock.calls[0] as [string, { default_cwd?: string }];
      expect(updateArgs[1].default_cwd).toBeUndefined();
    }
  });

  test('should fill in repository_url on existing codebase if missing', async () => {
    // Existing codebase registered locally without remote URL
    const existingCodebase = makeCodebase({
      id: 'existing-id',
      name: 'owner/repo',
      repository_url: null,
      default_cwd: '/home/user/repo',
    });
    spyExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockFindCodebaseByName.mockResolvedValueOnce(existingCodebase);

    await registerRepository('/home/user/repo');

    // updateCodebase should be called with repository_url
    expect(mockUpdateCodebase.mock.calls.length).toBe(1);
    const updateArgs = mockUpdateCodebase.mock.calls[0] as [
      string,
      { repository_url?: string | null },
    ];
    expect(updateArgs[1].repository_url).toBe('https://github.com/owner/repo');
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
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce(makeCodebase({ id: 'existing-999' }));

    const result = await cloneRepository('https://github.com/owner/repo');

    expect(result.alreadyExisted).toBe(true);
    expect(result.commandCount).toBe(0);
  });
});
