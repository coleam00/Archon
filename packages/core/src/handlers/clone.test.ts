/**
 * Unit tests for clone.ts (cloneRepository, registerRepository)
 *
 * Strategy:
 * - mock.module() for DB modules and @archon/paths (safe — no standalone test files for these)
 * - spyOn() for @archon/git (execFileAsync) and fs/promises (access, rm)
 *   to avoid process-global mock.module pollution that would break git.test.ts
 * - Lazy logger pattern means @archon/paths mock must be set up before the module import
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '@archon/git';
import { createMockLogger } from '../test/mocks/logger';

// ── DB mocks ────────────────────────────────────────────────────────────────
const mockCreateCodebase = mock(() =>
  Promise.resolve({
    id: 'codebase-uuid-1',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo',
    default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);
const mockGetCodebaseCommands = mock(() => Promise.resolve({}));
const mockUpdateCodebaseCommands = mock(() => Promise.resolve());
const mockFindCodebaseByRepoUrl = mock(() => Promise.resolve(null));
const mockFindCodebaseByDefaultCwd = mock(() => Promise.resolve(null));
const mockFindCodebaseByName = mock(() => Promise.resolve(null));
const mockUpdateCodebase = mock(() => Promise.resolve());

mock.module('../db/codebases', () => ({
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  findCodebaseByName: mockFindCodebaseByName,
  updateCodebase: mockUpdateCodebase,
}));

// ── @archon/paths mock ──────────────────────────────────────────────────────
const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  expandTilde: mock((p: string) => p.replace(/^~/, '/home/test')),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  ensureProjectStructure: mock(() => Promise.resolve()),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/source`
  ),
  createProjectSourceSymlink: mock(() => Promise.resolve()),
  parseOwnerRepo: mock((name: string) => {
    const parts = name.split('/');
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  }),
}));

// ── utils/commands mock ─────────────────────────────────────────────────────
const mockFindMarkdownFilesRecursive = mock(() => Promise.resolve([]));
mock.module('../utils/commands', () => ({
  findMarkdownFilesRecursive: mockFindMarkdownFilesRecursive,
}));

// ── Import module under test AFTER mocks are registered ────────────────────
import { cloneRepository, registerRepository } from './clone';

// ── Spies for fs/promises and @archon/git ──────────────────────────────────
let spyFsAccess: ReturnType<typeof spyOn>;
let spyFsRm: ReturnType<typeof spyOn>;
let spyExecFileAsync: ReturnType<typeof spyOn>;

function setupSpies(): void {
  // Default: .git does NOT exist (no pre-existing clone)
  spyFsAccess = spyOn(fsPromises, 'access').mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  );
  spyFsRm = spyOn(fsPromises, 'rm').mockResolvedValue(undefined);
  spyExecFileAsync = spyOn(gitUtils, 'execFileAsync').mockResolvedValue({
    stdout: '',
    stderr: '',
  });
}

function restoreSpies(): void {
  spyFsAccess?.mockRestore();
  spyFsRm?.mockRestore();
  spyExecFileAsync?.mockRestore();
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
  mockFindMarkdownFilesRecursive.mockReset();
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
  mockFindMarkdownFilesRecursive.mockResolvedValue([]);
}

afterAll(() => {
  restoreSpies();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal codebase row for the mock to return */
function makeCodebase(
  overrides: Partial<{
    id: string;
    name: string;
    repository_url: string | null;
    default_cwd: string;
    ai_assistant_type: string;
  }> = {}
): object {
  return {
    id: 'codebase-uuid-1',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo',
    default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
describe('cloneRepository', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GH_TOKEN;
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

      // git clone was called
      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall).toBeDefined();
      expect(cloneCall?.[1]).toContain('https://github.com/owner/repo');
    });

    test('strips trailing slash from URL before cloning', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      await cloneRepository('https://github.com/owner/repo/');

      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      // URL passed to git clone must not have trailing slash
      expect(cloneCall?.[1]?.[1]).toBe('https://github.com/owner/repo');
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

      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      // SSH converted to HTTPS
      expect(cloneCall?.[1]?.[1]).toContain('https://github.com/owner/repo');
      // No SSH format in the clone URL
      expect(cloneCall?.[1]?.[1]).not.toContain('git@');
    });

    test('extracts correct owner/repo from SSH URL', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({ name: 'owner/repo' }) as ReturnType<typeof makeCodebase>
      );

      const result = await cloneRepository('git@github.com:owner/repo.git');

      expect(result.name).toBe('owner/repo');
    });
  });

  // ── GH_TOKEN authentication ────────────────────────────────────────────
  describe('GH_TOKEN authentication', () => {
    beforeEach(() => {
      process.env.GH_TOKEN = 'ghp_testtoken123';
    });

    afterAll(() => {
      delete process.env.GH_TOKEN;
    });

    test('injects GH_TOKEN into HTTPS clone URL', async () => {
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('https://github.com/owner/private-repo');

      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall?.[1]?.[1]).toContain('ghp_testtoken123@github.com');
    });

    test('does NOT inject GH_TOKEN into non-github URLs', async () => {
      mockCreateCodebase.mockResolvedValueOnce(
        makeCodebase({
          name: 'owner/repo',
          repository_url: 'https://gitlab.com/owner/repo',
        }) as ReturnType<typeof makeCodebase>
      );

      // Override getProjectSourcePath for gitlab
      await cloneRepository('https://gitlab.com/owner/repo');

      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall?.[1]?.[1]).not.toContain('ghp_testtoken123');
    });

    test('converts SSH to HTTPS and injects GH_TOKEN', async () => {
      mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

      await cloneRepository('git@github.com:owner/repo.git');

      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall?.[1]?.[1]).toContain('ghp_testtoken123@github.com');
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
      // git clone must NOT have been called
      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall).toBeUndefined();
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

      // git clone must NOT be called (local path → register)
      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall).toBeUndefined();
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
      const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
        args => args[0] === 'git' && args[1]?.[0] === 'clone'
      );
      expect(cloneCall).toBeUndefined();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────
  describe('error handling', () => {
    test('wraps git clone failure with sanitized message', async () => {
      process.env.GH_TOKEN = 'super_secret_token';
      spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === 'clone') {
          return Promise.reject(
            new Error(
              'fatal: repository https://super_secret_token@github.com/owner/repo not found'
            )
          );
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await expect(cloneRepository('https://github.com/owner/repo')).rejects.toThrow(
        'Failed to clone repository'
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
      mockFindMarkdownFilesRecursive.mockResolvedValue([
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
      mockFindMarkdownFilesRecursive.mockResolvedValue([]);
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

  // ── Happy path ─────────────────────────────────────────────────────────
  test('registers a valid local git repo not yet in DB', async () => {
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
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

  // ── Validation ─────────────────────────────────────────────────────────
  test('throws when path is not a git repository', async () => {
    spyExecFileAsync.mockRejectedValueOnce(new Error('not a git repository'));

    await expect(registerRepository('/home/user/not-a-repo')).rejects.toThrow(
      'Path is not a git repository'
    );
  });

  // ── Remote URL handling ────────────────────────────────────────────────
  test('uses directory name as repo name when no remote URL exists', async () => {
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    mockFindMarkdownFilesRecursive.mockResolvedValue([
      { commandName: 'deploy', relativePath: 'deploy.md' },
    ]);
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);

    const result = await registerRepository('/home/user/myrepo');

    expect(result.commandCount).toBe(1);
    expect(mockUpdateCodebaseCommands.mock.calls.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('normalizeRepoUrl (via cloneRepository)', () => {
  beforeEach(() => {
    clearMocks();
    restoreSpies();
    setupSpies();
    delete process.env.GH_TOKEN;
  });

  const expectCloneTargetPath = async (url: string): Promise<string> => {
    mockCreateCodebase.mockResolvedValueOnce(makeCodebase() as ReturnType<typeof makeCodebase>);
    await cloneRepository(url);
    // The target path is the second positional arg to `git clone <url> <path>`
    const cloneCall = (spyExecFileAsync.mock.calls as string[][]).find(
      args => args[0] === 'git' && args[1]?.[0] === 'clone'
    );
    return cloneCall?.[1]?.[2] ?? '';
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return Promise.resolve({ stdout: '.git', stderr: '' });
      if (args.includes('get-url'))
        return Promise.resolve({ stdout: 'https://github.com/owner/repo', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    mockFindCodebaseByDefaultCwd.mockResolvedValueOnce(null);
    mockFindCodebaseByName.mockResolvedValueOnce(existingCodebase);

    const result = await registerRepository('/home/user/repo');

    // updateCodebase should be called with the local path
    expect(mockUpdateCodebase.mock.calls.length).toBe(1);
    const updateArgs = mockUpdateCodebase.mock.calls[0] as [string, { default_cwd?: string }];
    expect(updateArgs[0]).toBe('existing-id');
    expect(updateArgs[1].default_cwd).toBe('/home/user/repo');
    expect(result.defaultCwd).toBe('/home/user/repo');
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
    spyExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
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
