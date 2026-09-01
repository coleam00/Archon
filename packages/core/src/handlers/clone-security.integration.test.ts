import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createRecordingGitFixture } from '@archon/git/test-utils';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
};

let workspaceRoot = '';
const realPaths = await import('@archon/paths');

mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => mockLogger),
  expandTilde: (path: string) => path,
  canonicalizeProjectPath: async (path: string) => resolve(path),
  getCommandFolderSearchPaths: () => [],
  getProjectSourcePath: (owner: string, repo: string) => join(workspaceRoot, owner, repo, 'source'),
  ensureProjectStructure: async (owner: string, repo: string) => {
    const projectRoot = join(workspaceRoot, owner, repo);
    await Promise.all(
      ['source', 'worktrees', 'artifacts', 'logs'].map(path =>
        mkdir(join(projectRoot, path), { recursive: true })
      )
    );
  },
  ensureFolderProjectStructure: async () => undefined,
  getFolderProjectRoot: (slug: string) => join(workspaceRoot, '_folder', slug),
  createProjectSourceSymlink: async () => undefined,
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  },
  slugifyFolderName: (name: string) => name,
}));

const mockCreateCodebase = mock(
  async (input: {
    name: string;
    repository_url?: string;
    default_cwd: string;
    default_branch?: string | null;
    ai_assistant_type: string;
  }) => ({
    id: 'codebase-id',
    ...input,
    repository_url: input.repository_url ?? null,
    default_branch: input.default_branch ?? null,
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);

mock.module('../db/codebases', () => ({
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => undefined),
  findCodebaseByRepoUrl: mock(async () => null),
  findCodebaseByDefaultCwd: mock(async () => null),
  listCodebases: mock(async () => []),
  findCodebaseByName: mock(async () => null),
  updateCodebase: mock(async () => undefined),
}));

mock.module('../config/resolve-assistant', () => ({
  resolveDefaultAssistant: mock(async () => 'claude'),
}));

mock.module('../utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

const { cloneRepository } = await import('./clone');
const trackTempRoot = trackTempRoots();

const savedEnv = {
  GITLAB_TOKEN: process.env.GITLAB_TOKEN,
  GITLAB_URL: process.env.GITLAB_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  mockCreateCodebase.mockClear();
  for (const method of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
    mockLogger[method].mockClear();
  }
});

describe('core clone child security boundary', () => {
  test.skipIf(process.platform === 'win32')(
    'keeps GitLab credentials out of child argv and preserves an explicit HTTPS port',
    async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-clone-security-')));
      workspaceRoot = join(root, 'workspaces');
      const fixture = await createRecordingGitFixture(root);
      const token = 'core-gitlab-token-456';
      process.env.GITLAB_TOKEN = token;
      process.env.GITLAB_URL = 'https://gitlab.example.test:8443';

      const result = await fixture.run(() =>
        cloneRepository('https://gitlab.example.test:8443/team/repo.git')
      );

      expect(result.name).toBe('team/repo');
      const invocations = await fixture.readInvocations();
      const clone = invocations.find(invocation => invocation.argv.includes('clone'));
      expect(clone).toBeDefined();
      expect(clone?.argv).toContain('https://gitlab.example.test:8443/team/repo.git');
      expect(clone?.argv.join('\0')).not.toContain(token);
      expect(clone?.env.ARCHON_GIT_USERNAME).toBe('oauth2');
      expect(clone?.env.ARCHON_GIT_PASSWORD).toBe(token);
      expect(clone?.env.GIT_TERMINAL_PROMPT).toBe('0');

      const originConfig = await readFile(
        join(workspaceRoot, 'team', 'repo', 'source', '.git', 'config'),
        'utf8'
      );
      expect(originConfig).toContain('url = https://gitlab.example.test:8443/team/repo.git');
      expect(originConfig).not.toContain(token);
      expect(basename(result.defaultCwd)).toBe('source');
    }
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a malformed credential-bearing URL before any child or retained log sees it',
    async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-clone-malformed-')));
      workspaceRoot = join(root, 'workspaces');
      const fixture = await createRecordingGitFixture(root);
      const credential = 'malformed-url-secret-321';
      const malformedUrl = `https://${credential}@gitlab.example.test:bad/team/repo.git`;

      const clone = fixture.run(() => cloneRepository(malformedUrl));

      await expect(clone).rejects.toThrow(
        'Failed to clone repository: Invalid HTTP(S) repository URL'
      );
      expect(await fixture.readInvocations()).toEqual([]);
      const retainedLogs = [
        mockLogger.fatal,
        mockLogger.error,
        mockLogger.warn,
        mockLogger.info,
        mockLogger.debug,
        mockLogger.trace,
      ].flatMap(method => method.mock.calls);
      expect(retainedLogs).toEqual([]);
      expect(JSON.stringify(retainedLogs)).not.toContain(credential);
    }
  );

  for (const { name, url, credential } of [
    {
      name: 'query credentials',
      url: 'https://example.test/owner/repo.git?access_token=query-core-secret-789',
      credential: 'query-core-secret-789',
    },
    {
      name: 'fragment credentials',
      url: 'https://example.test/owner/repo.git#access_token=fragment-core-secret-789',
      credential: 'fragment-core-secret-789',
    },
    {
      name: 'backslash userinfo',
      url: 'https://backslash-core-secret-789\\@example.test/owner/repo.git',
      credential: 'backslash-core-secret-789',
    },
    {
      name: 'bare-host query credentials',
      url: 'example.test/owner/repo.git?access_token=bare-query-core-secret-789',
      credential: 'bare-query-core-secret-789',
    },
    {
      name: 'bare-host fragment credentials',
      url: 'example.test/owner/repo.git#access_token=bare-fragment-core-secret-789',
      credential: 'bare-fragment-core-secret-789',
    },
    {
      name: 'bare-host backslash userinfo',
      url: 'bare-backslash-core-secret-789\\@example.test/owner/repo.git',
      credential: 'bare-backslash-core-secret-789',
    },
    {
      name: 'SCP-style query credentials',
      url: 'git@example.test:owner/repo.git?access_token=scp-query-core-secret-789',
      credential: 'scp-query-core-secret-789',
    },
    {
      name: 'SCP-style fragment credentials',
      url: 'git@example.test:owner/repo.git#access_token=scp-fragment-core-secret-789',
      credential: 'scp-fragment-core-secret-789',
    },
    {
      name: 'SCP-style backslash userinfo',
      url: 'git@scp-backslash-core-secret-789\\@example.test:owner/repo.git',
      credential: 'scp-backslash-core-secret-789',
    },
  ]) {
    test.skipIf(process.platform === 'win32')(
      `rejects ${name} before the core clone route has any side effect`,
      async () => {
        const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-clone-reject-')));
        workspaceRoot = join(root, 'workspaces');
        const fixture = await createRecordingGitFixture(root);

        let error: Error | undefined;
        try {
          await fixture.run(() => cloneRepository(url));
        } catch (reason) {
          error = reason as Error;
        }

        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toBe('Failed to clone repository: Invalid HTTP(S) repository URL');
        expect(error?.message).not.toContain(credential);
        await expect(access(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fixture.readInvocations()).toEqual([]);
        expect(mockCreateCodebase).not.toHaveBeenCalled();

        const retainedLogs = [
          mockLogger.fatal,
          mockLogger.error,
          mockLogger.warn,
          mockLogger.info,
          mockLogger.debug,
          mockLogger.trace,
        ].flatMap(method => method.mock.calls);
        expect(retainedLogs).toEqual([]);
        expect(JSON.stringify(retainedLogs)).not.toContain(credential);
      }
    );
  }
});
