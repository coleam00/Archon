import { describe, test, expect, beforeEach, mock } from 'bun:test';

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

import { getPrState, type PrState } from './pr-state';

const REPO = '/workspace/repo';
const BRANCH = 'feature-branch';

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
    setupGhResponse('https://github.com/owner/repo.git', '[{"state":"MERGED"}]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('MERGED');
  });

  test('returns OPEN when gh reports OPEN', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[{"state":"OPEN"}]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('OPEN');
  });

  test('returns CLOSED when gh reports CLOSED', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[{"state":"CLOSED"}]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('CLOSED');
  });

  test('returns NONE when gh returns empty array (no PR)', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('NONE');
  });

  test('returns NONE when gh CLI is not installed (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    setupGhResponse('https://github.com/owner/repo.git', enoent);
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('NONE');
  });

  test('returns NONE for non-GitHub remote URL', async () => {
    setupGhResponse('https://gitlab.com/owner/repo.git', '[{"state":"MERGED"}]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('NONE');
  });

  test('uses cache on subsequent lookups for same branch', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[{"state":"MERGED"}]');
    const cache = new Map<string, PrState>();
    const first = await getPrState(BRANCH, REPO, cache);
    const callsAfterFirst = mockExecFileAsync.mock.calls.length;
    const second = await getPrState(BRANCH, REPO, cache);
    expect(first).toBe('MERGED');
    expect(second).toBe('MERGED');
    expect(mockExecFileAsync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('returns NONE and warns on non-ENOENT gh error (e.g. auth failure)', async () => {
    const authError = Object.assign(new Error('gh: authentication required'), {
      code: 'ERR_CMD_FAILED',
    });
    setupGhResponse('https://github.com/owner/repo.git', authError);
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('NONE');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('returns NONE when gh returns malformed JSON (e.g. auth error mixed with output)', async () => {
    setupGhResponse('https://github.com/owner/repo.git', 'error: not logged into github.com\n[]');
    const result = await getPrState(BRANCH, REPO);
    expect(result).toBe('NONE');
  });
});
