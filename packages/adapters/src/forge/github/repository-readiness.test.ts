/**
 * Repository readiness: clone, sync and App-mode setup of a webhook's checkout.
 *
 * `mock.module()` merges over the real module, so every `@archon/git` and
 * `@archon/paths` export the factories below omit keeps its real
 * implementation. `installCredentialHelper` is stubbed for the whole file: its
 * real implementation writes into `~/.archon/bin/` (#2305).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { resolveGitHubTokenFromEnv } from '@archon/core';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureStubLogOutput, removeTempTree } from '@archon/paths/test-utils';

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
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
  resolveRepoProjectIdentity: paths.resolveRepoProjectIdentity,
}));

const mockCloneRepository = mock<typeof import('@archon/git')['cloneRepository']>(async () => ({
  ok: true,
  value: undefined,
}));
const mockSyncRepository = mock<typeof import('@archon/git')['syncRepository']>(async () => ({
  ok: true,
  value: undefined,
}));
const mockAddSafeDirectory = mock(async () => undefined);

mock.module('@archon/git', () => ({
  cloneRepository: mockCloneRepository,
  syncRepository: mockSyncRepository,
  addSafeDirectory: mockAddSafeDirectory,
  findRepoRoot: mock(async () => null),
  toRepoPath: (p: string) => p,
  toBranchName: (n: string) => n,
}));

import * as core from '@archon/core';
import { GitHubAdapter } from './adapter';
import { ensureRepoReady, type ReadinessAuth } from './repository-readiness';

const mockLockManager = {
  acquireLock: mock(async (_id: string, handler: () => Promise<void>) => {
    await handler();
    return { status: 'started' as const };
  }),
};

let installCredentialHelperSpy: ReturnType<typeof spyOn<typeof core, 'installCredentialHelper'>>;

beforeAll(() => {
  installCredentialHelperSpy = spyOn(core, 'installCredentialHelper').mockImplementation(
    async () => ({ kind: 'installed', helperPath: '/stub/.archon/bin/git-credential-archon' })
  );
});

afterAll(() => {
  installCredentialHelperSpy.mockRestore();
});

/**
 * A path that is guaranteed not to exist, so `ensureRepoReady` takes its CLONE
 * branch rather than the "directory already exists → sync" branch.
 *
 * Shared literals like `/tmp/clone-test` are a collision waiting to happen, and
 * the failure is silent in the wrong direction: on a machine where the path
 * exists, a `not.toHaveBeenCalled()` assertion downstream of the clone branch
 * passes for the wrong reason. Unique per call, and never created.
 */
function unclonedPath(): string {
  return join(tmpdir(), `archon-clone-test-${randomUUID()}`);
}

/** App-mode auth whose installation token for `owner` is `ghs_<owner>_token`. */
function appAuth(): {
  auth: ReadinessAuth;
  getToken: ReturnType<typeof mock<(owner: string, repo: string) => Promise<string>>>;
} {
  const getToken = mock(async (owner: string, _repo: string) => `ghs_${owner}_token`);
  return { auth: { kind: 'app', provider: { getInstallationToken: getToken } }, getToken };
}

function callEnsureRepoReady(
  owner: string,
  repo: string,
  defaultBranch: string,
  repoPath: string,
  shouldSync: boolean
): Promise<void> {
  return ensureRepoReady(
    'https://github.com',
    { kind: 'pat' },
    owner,
    repo,
    defaultBranch,
    { name: `${owner}/${repo}`, default_cwd: repoPath },
    shouldSync
  );
}

describe('ensureRepoReady', () => {
  beforeEach(() => {
    mockCloneRepository.mockReset();
    mockCloneRepository.mockResolvedValue({ ok: true, value: undefined });
    mockSyncRepository.mockClear();
    mockAddSafeDirectory.mockReset();
    mockAddSafeDirectory.mockResolvedValue(undefined);
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  test('clones repository when directory does not exist', async () => {
    mockCloneRepository.mockImplementationOnce(async () => {
      expect(mockAddSafeDirectory).toHaveBeenCalledWith('/nonexistent/path');
      return { ok: true, value: undefined };
    });

    await callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false);

    expect(mockCloneRepository).toHaveBeenCalledTimes(1);
    const [url, path] = mockCloneRepository.mock.calls[0];
    expect(url).toBe('https://github.com/owner/repo.git');
    expect(String(path)).toBe('/nonexistent/path');
    expect(mockAddSafeDirectory).toHaveBeenCalledWith('/nonexistent/path');
  });

  test('clones from the configured GitHub web URL', async () => {
    await ensureRepoReady(
      'https://ghe.example',
      { kind: 'pat' },
      'owner',
      'repo',
      'main',
      { name: 'owner/repo', default_cwd: '/nonexistent/ghe' },
      false
    );

    expect(mockCloneRepository.mock.calls[0]?.[0]).toBe('https://ghe.example/owner/repo.git');
  });

  test('readiness for a different repository completes while the first clone is held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'github-clone-independent-'));
    const firstPath = join(root, 'first', 'source');
    const secondPath = join(root, 'second', 'source');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mockCloneRepository.mockImplementation(async (_url, target) => {
      if (target === firstPath) {
        entered.resolve();
        await release.promise;
      }
      await mkdir(join(target, '.git'), { recursive: true });
      return { ok: true, value: undefined };
    });
    const first = callEnsureRepoReady('owner', 'first', 'main', firstPath, false);
    const pending = [first];
    const deadline = Promise.withResolvers<void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      const second = callEnsureRepoReady('owner', 'second', 'main', secondPath, false);
      pending.push(second);
      timer = setTimeout(() => {
        deadline.reject(new Error('Second repository waited behind the held first clone'));
      }, 2000);
      await Promise.race([second, deadline.promise]);
      expect(mockCloneRepository).toHaveBeenCalledTimes(2);
      expect(mockAddSafeDirectory).toHaveBeenCalledWith(secondPath);
      await access(join(secondPath, '.git'));
      await expect(access(join(firstPath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

      release.resolve();
      await first;
      await access(join(firstPath, '.git'));
      expect(mockAddSafeDirectory).toHaveBeenCalledWith(firstPath);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await Promise.allSettled(pending);
      await removeTempTree(root);
    }
  });

  test.each([
    {
      GH_TOKEN: 'ghp_gh_clone_token',
      GITHUB_TOKEN: 'ghp_github_clone_token',
      expected: 'ghp_gh_clone_token',
    },
    { GH_TOKEN: 'ghp_gh_clone_token', GITHUB_TOKEN: undefined, expected: 'ghp_gh_clone_token' },
    {
      GH_TOKEN: undefined,
      GITHUB_TOKEN: 'ghp_github_clone_token',
      expected: 'ghp_github_clone_token',
    },
    { GH_TOKEN: '', GITHUB_TOKEN: 'ghp_github_clone_token', expected: 'ghp_github_clone_token' },
    { GH_TOKEN: '', GITHUB_TOKEN: '', expected: undefined },
  ])('PAT API and clone select GH_TOKEN before GITHUB_TOKEN: %j', async env => {
    const savedTokens = {
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    const logOutput = captureStubLogOutput(mockLogger);
    try {
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
      const token = resolveGitHubTokenFromEnv();
      if (token) {
        const adapter = new GitHubAdapter({ kind: 'pat', token }, 'fake-secret', mockLockManager);
        // @ts-expect-error - inspect the real private API client's selected credential
        expect(await adapter.octokit.auth()).toMatchObject({ token: env.expected });
      }
      const repoPath = unclonedPath();
      await callEnsureRepoReady('owner', 'repo', 'main', repoPath, false);

      expect(mockCloneRepository).toHaveBeenCalledWith(
        'https://github.com/owner/repo.git',
        repoPath,
        env.expected
          ? { credentials: { username: 'x-access-token', password: env.expected } }
          : undefined
      );
      expect(logOutput.output()).not.toBe('');
      expect(logOutput.output()).not.toContain('ghp_gh_clone_token');
      expect(logOutput.output()).not.toContain('ghp_github_clone_token');
    } finally {
      logOutput.restore();
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
        if (savedTokens[key] === undefined) delete process.env[key];
        else process.env[key] = savedTokens[key];
      }
    }
  });

  test.each([false, true])(
    'retries a failed clone with leftover git metadata: %s',
    async hasGitMetadata => {
      const root = await mkdtemp(join(tmpdir(), 'github-clone-retry-'));
      const repoPath = join(root, 'source');
      mockCloneRepository.mockImplementationOnce(async () => {
        await mkdir(hasGitMetadata ? join(repoPath, '.git') : repoPath, { recursive: true });
        await writeFile(join(repoPath, 'partial.txt'), 'incomplete checkout');
        return {
          ok: false,
          error: { code: 'permission_denied', path: 'https://github.com/owner/repo.git' },
        };
      });

      try {
        await expect(callEnsureRepoReady('owner', 'repo', 'main', repoPath, false)).rejects.toThrow(
          'Authentication failed'
        );
        await expect(access(repoPath)).rejects.toMatchObject({ code: 'ENOENT' });
        mockCloneRepository.mockImplementationOnce(async () => {
          await mkdir(join(repoPath, '.git'), { recursive: true });
          return { ok: true, value: undefined };
        });

        await callEnsureRepoReady('owner', 'repo', 'main', repoPath, false);
        expect(mockCloneRepository).toHaveBeenCalledTimes(2);
        expect(mockSyncRepository).not.toHaveBeenCalled();
        await access(join(repoPath, '.git'));

        await callEnsureRepoReady('owner', 'repo', 'main', repoPath, false);
        expect(mockCloneRepository).toHaveBeenCalledTimes(2);
        await access(join(repoPath, '.git'));
      } finally {
        await removeTempTree(root);
      }
    }
  );

  test('preserves pre-existing files when git refuses a nonempty clone target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'github-clone-preserve-'));
    const filePath = join(root, 'operator.txt');
    await writeFile(filePath, 'keep this file');
    mockCloneRepository.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'destination already exists and is not empty' },
    });
    try {
      await expect(callEnsureRepoReady('owner', 'repo', 'main', root, false)).rejects.toThrow(
        'destination already exists'
      );
      expect(await readFile(filePath, 'utf8')).toBe('keep this file');
    } finally {
      await removeTempTree(root);
    }
  });

  test('syncs repository when directory exists and shouldSync is true', async () => {
    const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);
    await mkdir(join(tmpDir, '.git'));

    mockSyncRepository.mockResolvedValue({ ok: true, value: undefined });

    try {
      await callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true);

      expect(mockSyncRepository).toHaveBeenCalledWith(tmpDir, 'main');
      expect(mockCloneRepository).not.toHaveBeenCalled();
    } finally {
      await removeTempTree(tmpDir);
    }
  });

  test.each(['directory', 'file'])(
    'preserves existing clone with .git %s when shouldSync is false',
    async metadata => {
      const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);
      if (metadata === 'directory') await mkdir(join(tmpDir, '.git'));
      else await writeFile(join(tmpDir, '.git'), 'gitdir: /external/git-directory');

      try {
        await callEnsureRepoReady('owner', 'repo', 'main', tmpDir, false);

        expect(mockSyncRepository).not.toHaveBeenCalled();
        expect(mockCloneRepository).not.toHaveBeenCalled();
        await access(join(tmpDir, '.git'));
      } finally {
        await removeTempTree(tmpDir);
      }
    }
  );

  test('throws user-friendly error for not_a_repo clone error', async () => {
    mockCloneRepository.mockResolvedValue({
      ok: false,
      error: { code: 'not_a_repo', path: 'https://github.com/owner/repo.git' },
    });

    await expect(
      callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false)
    ).rejects.toThrow('not found or is private');
  });

  test('throws user-friendly error for permission_denied clone error', async () => {
    mockCloneRepository.mockResolvedValue({
      ok: false,
      error: { code: 'permission_denied', path: 'https://github.com/owner/repo.git' },
    });

    await expect(
      callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false)
    ).rejects.toThrow('Authentication failed');
  });

  test('throws user-friendly error for sync branch_not_found', async () => {
    const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);
    await mkdir(join(tmpDir, '.git'));

    mockSyncRepository.mockResolvedValue({
      ok: false,
      error: { code: 'branch_not_found', branch: 'main' },
    });

    try {
      await expect(callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true)).rejects.toThrow(
        "Branch 'main' not found"
      );
    } finally {
      await removeTempTree(tmpDir);
    }
  });

  test('throws for unknown sync error with message', async () => {
    const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);
    await mkdir(join(tmpDir, '.git'));

    mockSyncRepository.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'Network timeout' },
    });

    try {
      await expect(callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true)).rejects.toThrow(
        'Network timeout'
      );
    } finally {
      await removeTempTree(tmpDir);
    }
  });
});

describe('App-mode readiness', () => {
  beforeEach(() => {
    mockCloneRepository.mockClear();
    mockCloneRepository.mockResolvedValue({ ok: true, value: undefined });
    installCredentialHelperSpy.mockClear();
  });

  test('clone path resolves installation token (not env GITHUB_TOKEN)', async () => {
    const savedEnv = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = 'ghp_unused_env_token';
      const { auth, getToken } = appAuth();
      await ensureRepoReady(
        'https://github.com',
        auth,
        'owner',
        'repo',
        'main',
        { name: 'owner/repo', default_cwd: '/tmp/nonexistent-test' },
        false
      );
      expect(getToken).toHaveBeenCalledWith('owner', 'repo');
      expect(mockCloneRepository).toHaveBeenCalledTimes(1);
      expect(mockCloneRepository).toHaveBeenCalledWith(
        'https://github.com/owner/repo.git',
        '/tmp/nonexistent-test',
        { credentials: { username: 'x-access-token', password: 'ghs_owner_token' } }
      );
      const [cloneUrl, clonePath] = mockCloneRepository.mock.calls[0] ?? [];
      expect(JSON.stringify([cloneUrl, clonePath])).not.toContain('ghs_owner_token');
    } finally {
      if (savedEnv === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = savedEnv;
      }
    }
  });

  for (const mode of ['app', 'pat'] as const) {
    test.each([false, true])(
      `${mode} overlapping readiness preserves the checkout when the first clone fails: %s`,
      async firstFails => {
        const root = await mkdtemp(join(tmpdir(), 'github-clone-overlap-'));
        const repoPath = join(root, 'source');
        // Two webhooks, as two adapter instances would deliver them.
        const makeAuth = (): ReadinessAuth => (mode === 'app' ? appAuth().auth : { kind: 'pat' });
        const firstAuth = makeAuth();
        const secondAuth = makeAuth();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        mockCloneRepository.mockReset();
        mockCloneRepository.mockImplementation(async (_url, target) => {
          const attempt = mockCloneRepository.mock.calls.length;
          if (attempt === 1) {
            entered.resolve();
            await release.promise;
            if (firstFails) {
              await mkdir(join(String(target), '.git'), { recursive: true });
              await writeFile(join(String(target), 'partial.txt'), 'partial checkout');
              return {
                ok: false,
                error: { code: 'permission_denied', path: String(target) },
              };
            }
          }
          if (await Bun.file(join(String(target), 'tracked.txt')).exists()) {
            return {
              ok: false,
              error: { code: 'unknown', message: 'destination already exists and is not empty' },
            };
          }
          await mkdir(join(String(target), '.git'), { recursive: true });
          await writeFile(join(String(target), 'tracked.txt'), 'successful checkout');
          return { ok: true, value: undefined };
        });
        const ready = (auth: ReadinessAuth) => {
          return ensureRepoReady(
            'https://github.com',
            auth,
            'owner',
            'repo',
            'main',
            { name: 'owner/repo', default_cwd: repoPath },
            false
          );
        };
        const first = ready(firstAuth);
        await entered.promise;
        const second = ready(secondAuth);
        const results = Promise.allSettled([first, second]);
        try {
          // Give the sibling webhook time to reach clone if readiness is unlocked.
          await Bun.sleep(50);
          expect(mockCloneRepository).toHaveBeenCalledTimes(1);
          release.resolve();
          const [firstOutcome, secondOutcome] = await results;
          expect(firstOutcome?.status).toBe(firstFails ? 'rejected' : 'fulfilled');
          expect(secondOutcome?.status).toBe('fulfilled');
          expect(mockCloneRepository).toHaveBeenCalledTimes(firstFails ? 2 : 1);
          await access(join(repoPath, '.git'));
          expect(await readFile(join(repoPath, 'tracked.txt'), 'utf8')).toBe('successful checkout');
          expect(await Bun.file(join(repoPath, 'partial.txt')).exists()).toBe(false);
        } finally {
          release.resolve();
          await results;
          await removeTempTree(root);
        }
      }
    );
  }

  test('AppNotInstalledError on clone surfaces a clean message', async () => {
    const { AppNotInstalledError } = await import('@archon/core');
    const { auth, getToken } = appAuth();
    getToken.mockImplementationOnce(async (owner: string, repo: string) => {
      throw new AppNotInstalledError(owner, repo, 'archon-test');
    });
    const promise = ensureRepoReady(
      'https://github.com',
      auth,
      'owner',
      'repo',
      'main',
      { name: 'owner/repo', default_cwd: '/tmp/missing' },
      false
    );
    await expect(promise).rejects.toBeInstanceOf(AppNotInstalledError);
  });

  test('credential helper install is attempted after successful App-mode clone', async () => {
    const clonePath = unclonedPath();
    await ensureRepoReady(
      'https://github.com',
      appAuth().auth,
      'owner',
      'repo',
      'main',
      { name: 'owner/repo', default_cwd: clonePath },
      false
    );
    expect(mockCloneRepository).toHaveBeenCalledTimes(1);
    expect(installCredentialHelperSpy).toHaveBeenCalledWith(clonePath);
  });

  test.each(['safe directory', 'credential helper'])(
    'retries failed App %s setup without duplicate clones',
    async failure => {
      const root = await mkdtemp(join(tmpdir(), 'github-setup-retry-'));
      const repoPath = join(root, 'source');
      const { auth } = appAuth();
      mockCloneRepository.mockImplementationOnce(async () => {
        await mkdir(join(repoPath, '.git'), { recursive: true });
        return { ok: true, value: undefined };
      });
      mockAddSafeDirectory.mockClear();
      if (failure === 'safe directory') {
        mockAddSafeDirectory.mockRejectedValueOnce(new Error('safe directory setup failed'));
      } else {
        installCredentialHelperSpy.mockImplementationOnce(async () => ({
          kind: 'failed',
          error: new Error('credential helper setup failed'),
        }));
      }
      const ensureReady = () => {
        return ensureRepoReady(
          'https://github.com',
          auth,
          'owner',
          'repo',
          'main',
          { name: 'owner/repo', default_cwd: repoPath },
          false
        );
      };
      try {
        await expect(ensureReady()).rejects.toThrow(`${failure} setup failed`);
        if (failure === 'safe directory') expect(mockCloneRepository).not.toHaveBeenCalled();
        else await access(join(repoPath, '.git'));
        await ensureReady();
        expect(mockCloneRepository).toHaveBeenCalledTimes(1);
        expect(mockAddSafeDirectory).toHaveBeenCalledTimes(2);
        expect(installCredentialHelperSpy).toHaveBeenCalledTimes(
          failure === 'safe directory' ? 1 : 2
        );
        await access(join(repoPath, '.git'));
      } finally {
        await removeTempTree(root);
      }
    }
  );

  test('App-mode setup fails when the bundled credential helper is unavailable', async () => {
    installCredentialHelperSpy.mockImplementationOnce(async () => ({
      kind: 'failed',
      error: new Error('bundled credential helper unavailable'),
    }));
    const setup = ensureRepoReady(
      'https://github.com',
      appAuth().auth,
      'owner',
      'repo',
      'main',
      { name: 'owner/repo', default_cwd: unclonedPath() },
      false
    );

    await expect(setup).rejects.toThrow('bundled credential helper unavailable');
    expect(mockCloneRepository).toHaveBeenCalled();
  });

  test('credential helper install is NOT attempted in PAT mode', async () => {
    try {
      await ensureRepoReady(
        'https://github.com',
        { kind: 'pat' },
        'owner',
        'repo',
        'main',
        { name: 'owner/repo', default_cwd: unclonedPath() },
        false
      );
    } catch {
      // Same bogus-path tolerance as the App-mode case above.
    }
    // Control FIRST, and load-bearing here: this is a `not.toHaveBeenCalled`
    // assertion, so anything that stops ensureRepoReady before the credential
    // block makes it pass VACUOUSLY — the exact silent-pass shape this PR
    // exists to remove. Asserting the clone branch ran means the negative can
    // only be satisfied by the auth-kind guard.
    expect(mockCloneRepository).toHaveBeenCalled();
    // Pins the `this.auth.kind === 'app'` guard: PAT operators never get the
    // helper installed. Without this, stubbing installCredentialHelper above
    // would let the guard be deleted with both tests still green.
    expect(installCredentialHelperSpy).not.toHaveBeenCalled();
  });
});
