import { beforeEach, describe, expect, mock, test } from 'bun:test';

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
  ensureProjectStructure: mock(async () => undefined),
  resolveRepoProjectIdentity: paths.resolveRepoProjectIdentity,
}));

const mockCloneRepository = mock<typeof import('@archon/git')['cloneRepository']>(async () => ({
  ok: true,
  value: undefined,
}));
const mockAddSafeDirectory = mock(async () => undefined);

mock.module('@archon/git', () => ({
  cloneRepository: mockCloneRepository,
  syncRepository: mock(async () => ({ ok: true, value: undefined })),
  addSafeDirectory: mockAddSafeDirectory,
  toRepoPath: (p: string) => p,
  toBranchName: (b: string) => b,
}));

import { ensureRepoReady } from './repository-readiness';

beforeEach(() => {
  mockCloneRepository.mockClear();
  mockAddSafeDirectory.mockClear();
});

test('passes Gitea and Forgejo clone credentials outside the repository URL', async () => {
  const savedToken = process.env.GITEA_TOKEN;
  const token = 'gitea-clone-token-123';
  process.env.GITEA_TOKEN = token;

  try {
    mockCloneRepository.mockImplementationOnce(async () => {
      expect(mockAddSafeDirectory).toHaveBeenCalledWith('/definitely/missing/forgejo-repo');
      return { ok: true, value: undefined };
    });
    await ensureRepoReady(
      'https://forgejo.example.test:8443',
      'owner',
      'repo',
      'main',
      { name: 'owner/repo', default_cwd: '/definitely/missing/forgejo-repo' },
      false
    );

    const [url, , options] = mockCloneRepository.mock.calls.at(-1)!;
    expect(url).toBe('https://forgejo.example.test:8443/owner/repo.git');
    expect(options).toEqual({ credentials: { username: token, password: '' } });
    expect(JSON.stringify(mockCloneRepository.mock.calls)).not.toContain(`${token}@`);
  } finally {
    if (savedToken === undefined) delete process.env.GITEA_TOKEN;
    else process.env.GITEA_TOKEN = savedToken;
  }
});

describe('clone errors', () => {
  function cloneMissingRepo(): Promise<void> {
    return ensureRepoReady(
      'https://gitea.example.com',
      'owner',
      'repo',
      'main',
      { name: 'owner/repo', default_cwd: '/definitely/missing/gitea-repo' },
      false
    );
  }

  test('preserves the clone destination when disk space is exhausted', async () => {
    mockCloneRepository.mockResolvedValueOnce({
      ok: false,
      error: { code: 'no_space', path: '/clone/destination' },
    });

    await expect(cloneMissingRepo()).rejects.toThrow(
      'No space left while cloning owner/repo to /clone/destination.'
    );
  });

  test('surfaces the message from an unknown clone failure', async () => {
    mockCloneRepository.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'transport helper crashed' },
    });

    await expect(cloneMissingRepo()).rejects.toThrow(
      'Failed to clone owner/repo: transport helper crashed'
    );
  });
});
