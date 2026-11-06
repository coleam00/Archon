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

import { getPrState, getPrsForCommit, type PrLookup } from './pr-state';
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
  test.each(['{}', 'null', '"text"', '[null]', '[{}]', '[{"state":"MERGED","headRefOid":42}]'])(
    'returns UNAVAILABLE for unreadable branch response %s',
    async payload => {
      setupGhResponse('https://github.com/owner/repo.git', payload);
      expect(await getPrState(BRANCH, REPO)).toEqual({ state: 'UNAVAILABLE' });
    }
  );

  test('caches remote inspection failure as unavailable', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '[]');
    mockExecFileAsync.mockRejectedValue(new Error('remote inspection failed'));
    const cache = new Map<string, PrLookup>();
    expect(await getPrState(BRANCH, REPO, cache)).toEqual({ state: 'UNAVAILABLE' });
    expect(await getPrState(BRANCH, REPO, cache)).toEqual({ state: 'UNAVAILABLE' });
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  test.each(['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git'])(
    'returns MERGED from the explicit remote %s',
    async remoteUrl => {
      setupGhResponse(remoteUrl, '[{"state":"MERGED","headRefOid":"abc123"}]');
      const result = await getPrState(BRANCH, REPO);
      expect(result).toEqual({ state: 'MERGED', headSha: 'abc123' });
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          remoteUrl,
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
    }
  );

  test.each([
    ['https://user:secret@github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['ssh://user:secret@github.com/owner/repo.git', 'ssh://github.com/owner/repo.git'],
    ['secret@github.com:owner/repo.git', 'git@github.com:owner/repo.git'],
  ])('omits remote credentials from the branch selector: %s', async (remote, selector) => {
    setupGhResponse(remote, '[]');
    expect(await getPrState(BRANCH, REPO)).toEqual({ state: 'NONE' });
    expect(mockExecFileAsync.mock.calls[1][1]).toContain(selector);
    expect(JSON.stringify(mockExecFileAsync.mock.calls[1])).not.toContain('secret');
  });

  test.each(['remote', 'query', 'unreadable', 'malformed', 'unsupported'] as const)(
    'omits credentials and response bodies from branch logs at %s',
    async stage => {
      mockLogger.debug.mockClear();
      mockLogger.warn.mockClear();
      const remote = `https://user:secret@${stage === 'unsupported' ? 'github.com.example.org' : 'github.com'}/owner/repo.git`;
      const error = Object.assign(new Error(`command failed: ${remote}`), { code: 1 });
      setupGhResponse(
        remote,
        stage === 'query' ? error : stage === 'unreadable' ? '[{"state":"secret"}]' : 'secret'
      );
      if (stage === 'remote') mockExecFileAsync.mockRejectedValue(error);
      expect(await getPrState(BRANCH, REPO)).toEqual({
        state: stage === 'unsupported' ? 'NONE' : 'UNAVAILABLE',
      });
      const logs: unknown[] = [...mockLogger.debug.mock.calls, ...mockLogger.warn.mock.calls];
      expect(logs.length).toBeGreaterThan(0);
      expect(
        JSON.stringify(logs, (_key, value: unknown) =>
          value instanceof Error ? { ...value, message: value.message } : value
        )
      ).not.toContain('secret');
      if (stage === 'remote' || stage === 'query') {
        expect(logs).toContainEqual([
          {
            repoPath: REPO,
            branch: BRANCH,
            stage: stage === 'remote' ? 'remote' : 'query',
            code: 1,
          },
          stage === 'remote'
            ? 'isolation.pr_state_remote_lookup_failed'
            : 'isolation.pr_state_lookup_failed',
        ]);
      }
    }
  );

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

  test('returns UNAVAILABLE when gh CLI is not installed (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    setupGhResponse('https://github.com/owner/repo.git', enoent);
    const result = await getPrState(BRANCH, REPO);
    expect(result).toEqual({ state: 'UNAVAILABLE' });
  });

  test.each(['https://gitlab.com/owner/repo.git', 'https://github.com.example.org/owner/repo'])(
    'returns NONE for unsupported remote %s',
    async remoteUrl => {
      setupGhResponse(remoteUrl, '[{"state":"MERGED","headRefOid":"abc123"}]');
      const result = await getPrState(BRANCH, REPO);
      expect(result).toEqual({ state: 'NONE' });
      expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    }
  );

  test('queries the custom remote when provided', async () => {
    setupGhResponse(
      'https://github.com/owner/upstream.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );

    const result = await getPrState(BRANCH, REPO, undefined, 'upstream');

    expect(result).toEqual({ state: 'MERGED', headSha: 'abc123' });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', REPO, 'remote', 'get-url', 'upstream'],
      expect.any(Object)
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--repo', 'https://github.com/owner/upstream.git']),
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

  test('does not reuse cached evidence across selected remotes', async () => {
    const cache = new Map<string, PrLookup>();
    setupGhResponse(
      'https://github.com/owner/repo.git',
      '[{"state":"MERGED","headRefOid":"abc123"}]'
    );
    expect(await getPrState(BRANCH, REPO, cache)).toEqual({ state: 'MERGED', headSha: 'abc123' });
    setupGhResponse(
      'https://github.com/owner/upstream.git',
      '[{"state":"OPEN","headRefOid":"def456"}]'
    );
    expect(await getPrState(BRANCH, REPO, cache, 'upstream')).toEqual({
      state: 'OPEN',
      headSha: 'def456',
    });
    expect(await getPrState(BRANCH, REPO, cache)).toEqual({ state: 'MERGED', headSha: 'abc123' });
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

const COMMIT = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const mergedPr = {
  state: 'closed',
  merged_at: '2026-01-01T00:00:00Z',
  head: { sha: HEAD },
  base: { repo: { full_name: 'owner/repo' } },
};

function setupCommitResponse(
  payload: unknown = [[mergedPr]],
  failure?: 'remote' | 'repository' | 'pulls',
  error = new Error('lookup failed'),
  remoteUrl = 'git@github.com:owner/repo.git'
): void {
  mockExecFileAsync.mockReset().mockImplementation(async (cmd, args) => {
    const stage = cmd === 'git' ? 'remote' : args[0] === 'repo' ? 'repository' : 'pulls';
    if (stage === failure) throw error;
    return {
      stdout:
        stage === 'remote'
          ? remoteUrl
          : stage === 'repository'
            ? JSON.stringify({ nameWithOwner: 'owner/repo' })
            : typeof payload === 'string'
              ? payload
              : Array.isArray(payload)
                ? payload.map(page => JSON.stringify(page)).join('\n')
                : JSON.stringify(payload),
      stderr: '',
    };
  });
}

describe('getPrsForCommit', () => {
  test('the subprocess projection feeds the parser for every PR state', async () => {
    setupCommitResponse();
    await getPrsForCommit(COMMIT, REPO);
    const args = mockExecFileAsync.mock.calls.find(([, args]) => args[0] === 'api')?.[1];
    if (!args) throw new Error('Missing commit lookup');
    const projection = args[args.indexOf('--jq') + 1];
    const proc = Bun.spawn(['jq', '-c', projection], {
      stdin: new Blob([
        JSON.stringify([
          { ...mergedPr, body: 'discarded', merged_at: null },
          { ...mergedPr, body: 'discarded', state: 'open', merged_at: null },
          { ...mergedPr, body: 'discarded' },
        ]),
      ]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).not.toContain('discarded');
    setupCommitResponse(stdout);
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({
      state: 'FOUND',
      prs: [
        { state: 'CLOSED', headSha: HEAD },
        { state: 'OPEN', headSha: HEAD },
        { state: 'MERGED', headSha: HEAD },
      ],
    });
  });

  test('reads all pages and normalizes REST merge state in the selected remote repository', async () => {
    setupCommitResponse([
      [
        { ...mergedPr, merged_at: null },
        { ...mergedPr, state: 'open', merged_at: null },
      ],
      [mergedPr],
    ]);
    expect(await getPrsForCommit(COMMIT, REPO, 'upstream')).toEqual({
      state: 'FOUND',
      prs: [
        { state: 'CLOSED', headSha: HEAD },
        { state: 'OPEN', headSha: HEAD },
        { state: 'MERGED', headSha: HEAD },
      ],
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['-C', REPO, 'remote', 'get-url', 'upstream'],
      expect.any(Object)
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'gh',
      ['repo', 'view', 'git@github.com:owner/repo.git', '--json', 'nameWithOwner'],
      expect.any(Object)
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `repos/owner/repo/commits/${COMMIT}/pulls?per_page=100`,
        '--paginate',
        '--jq',
        'map({state, merged_at, head: {sha: .head.sha}, base: {repo: {full_name: .base.repo.full_name}}})',
      ],
      expect.any(Object)
    );
  });

  test('omits remote credentials from the commit repository selector', async () => {
    setupCommitResponse(
      undefined,
      undefined,
      undefined,
      'https://user:secret@github.com/owner/repo.git'
    );
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({
      state: 'FOUND',
      prs: [{ state: 'MERGED', headSha: HEAD }],
    });
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual([
      'repo',
      'view',
      'https://github.com/owner/repo.git',
      '--json',
      'nameWithOwner',
    ]);
  });

  test('empty pages are successful absence', async () => {
    setupCommitResponse([[]]);
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'NONE' });
  });

  test.each(
    [
      'not JSON',
      [],
      {},
      [[], {}],
      [[{ ...mergedPr, head: {} }]],
      [[{ ...mergedPr, head: { sha: '--all' } }]],
      [[{ ...mergedPr, merged_at: undefined }]],
      [[{ ...mergedPr, merged_at: 'invalid' }]],
      [[{ ...mergedPr, state: 'open' }]],
      [[{ ...mergedPr, state: 'unknown' }]],
      [[{ ...mergedPr, base: { repo: { full_name: 'other/repo' } } }]],
      [[mergedPr], [{ state: 'closed' }]],
    ].map(payload => ({ payload }))
  )('rejects malformed or incomplete pages: $payload', async ({ payload }) => {
    setupCommitResponse(payload);
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'UNAVAILABLE' });
  });

  test.each(['remote', 'repository', 'pulls'] as const)('retains failure at %s', async stage => {
    setupCommitResponse(undefined, stage);
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'UNAVAILABLE' });
  });

  test.each([
    'unknown commit (422)',
    'authentication (401)',
    'rate limit (403)',
    'partial pagination (502)',
  ])('does not treat %s as an empty association', async message => {
    setupCommitResponse(undefined, 'pulls', new Error(message));
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'UNAVAILABLE' });
  });

  test('rejects a malformed repository identity', async () => {
    setupGhResponse('https://github.com/owner/repo.git', '{"nameWithOwner":"invalid"}');
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'UNAVAILABLE' });
  });

  test('logs the failed stage and exit code without credentials or response bodies', async () => {
    mockLogger.warn.mockClear();
    setupCommitResponse(
      undefined,
      'repository',
      Object.assign(new Error('https://user:secret@github.com/owner/repo'), { code: 1 })
    );
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'UNAVAILABLE' });
    expect(mockLogger.warn).toHaveBeenLastCalledWith(
      { repoPath: REPO, stage: 'repository', code: 1 },
      'isolation.commit_pr_lookup_failed'
    );
  });

  test.each(['repository', 'pulls'] as const)('missing gh at %s is unavailable', async stage => {
    setupCommitResponse(undefined, stage, Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'UNAVAILABLE' });
  });

  test.each(['https://gitlab.com/owner/repo', 'https://github.com.example.org/owner/repo'])(
    'does not query an unsupported remote %s',
    async remote => {
      setupGhResponse(remote, 'unexpected');
      expect(await getPrsForCommit(COMMIT, REPO)).toEqual({ state: 'NONE' });
      expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    }
  );
});
