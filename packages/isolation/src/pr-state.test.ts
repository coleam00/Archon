import { describe, test, expect, mock } from 'bun:test';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

interface ExecResult {
  stdout: string;
  stderr: string;
}

const mockExecFileAsync = mock(
  (_cmd: string, _args: string[]): Promise<ExecResult> =>
    Promise.resolve({ stdout: '', stderr: '' })
);
mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
  toRepoPath: (p: string) => p,
  toBranchName: (b: string) => b,
}));

import { getPrState, type PrLookup } from './pr-state';
import { toBranchName, toRepoPath } from '@archon/git';

const REPO = toRepoPath('/workspace/repo');
const BRANCH = toBranchName('feature-branch');

function setupGhResponse(remoteUrl: string, ghStdout: string | Error): void {
  mockExecFileAsync.mockReset();
  mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
    if (cmd === 'git') return Promise.resolve({ stdout: remoteUrl, stderr: '' });
    if (cmd === 'gh') {
      if (ghStdout instanceof Error) return Promise.reject(ghStdout);
      return Promise.resolve({ stdout: ghStdout, stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });
}

describe('getPrState', () => {
  test('returns MERGED when gh reports MERGED', async () => {
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'MERGED', headSha: 'abc123' });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--head',
        BRANCH,
        '--state',
        'all',
        '--json',
        'state,headRefOid',
        '--limit',
        '1',
      ],
      expect.any(Object)
    );
  });

  test('returns OPEN when gh reports OPEN', async () => {
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"OPEN","headRefOid":"abc123"}]'
    );
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'OPEN', headSha: 'abc123' });
  });

  test('returns CLOSED when gh reports CLOSED', async () => {
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"CLOSED","headRefOid":"abc123"}]'
    );
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'CLOSED', headSha: 'abc123' });
  });

  test('returns NONE when gh returns empty array (no PR)', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'NONE' });
  });

  test('returns NONE when gh CLI is not installed (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    setupGhResponse('https://github.com/owner/repo.git', enoent);
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'NONE' });
  });

  test('returns NONE for non-GitHub remote URL', async () => {
    setupGhResponse(
      'https://gitlab.com/owner/repo.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'NONE' });
  });

  test('queries the custom remote when provided', async () => {
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );

    const result = await getPrState(BRANCH, REPO, undefined, 'upstream');

    expect(result).toEqual({ state: 'MERGED', headSha: 'abc123' });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', REPO, 'remote', 'get-url', 'upstream'],
      expect.any(Object)
    );
  });

  test('uses cache on subsequent lookups for same branch', async () => {
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );
    const cache = new Map<string, PrLookup>();
    const first = await getPrState(BRANCH, REPO, cache);
    const callsAfterFirst = mockExecFileAsync.mock.calls.length;
    const second = await getPrState(BRANCH, REPO, cache);
    expect(first).toEqual({ state: 'MERGED', headSha: 'abc123' });
    expect(second).toEqual({ state: 'MERGED', headSha: 'abc123' });
    expect(mockExecFileAsync.mock.calls.length).toBe(callsAfterFirst);
  });

  // The scheduled cleanup sweep shares one cache across every registered repository,
  // where the same branch name is two different PRs.
  test('does not serve one repository a cached state from another', async () => {
    const cache = new Map<string, PrLookup>();
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );
    expect(await getPrState(BRANCH, REPO, cache)).toEqual({ state: 'MERGED', headSha: 'abc123' });

    setupGhResponse(
      'https://github.com/owner/other.git',
      '[{"state":"OPEN","headRefOid":"abc123"}]'
    );
    expect(await getPrState(BRANCH, toRepoPath('/workspace/other-repo'), cache)).toEqual({
      state: 'OPEN',
      headSha: 'abc123',
    });
  });

  // A failed lookup is not "no PR": cleanup must keep and report the branch rather
  // than treat it as settled unmerged work.
  test('returns UNAVAILABLE and warns on non-ENOENT gh error (e.g. auth failure)', async () => {
    const authError = Object.assign(new Error('gh: authentication required'), {
      code: 'ERR_CMD_FAILED',
    });
    setupGhResponse('https://github.com/owner/repo.git', authError);
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'UNAVAILABLE' });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('returns UNAVAILABLE when gh returns malformed JSON (e.g. auth error mixed with output)', async () => {
    setupGhResponse('https://github.com/owner/repo.git', 'error: not logged into github.com\n[]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'UNAVAILABLE' });
  });

  test('returns UNAVAILABLE when a PR entry lacks its head commit', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[{"state":"MERGED"}]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'UNAVAILABLE' });
  });
});
