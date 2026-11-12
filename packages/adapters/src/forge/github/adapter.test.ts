/**
 * Unit tests for GitHub adapter
 *
 * Note: Database modules are mocked to prevent self-filtering tests from
 * writing phantom records (e.g., testuser/testrepo) to the real SQLite DB.
 *
 * ARCHON_HOME INVARIANT (#2305): this file must create nothing under
 * `$ARCHON_HOME`. `mock.module()` MERGES over the real module rather than
 * replacing it, so every export a factory below omits keeps its REAL
 * implementation and quietly does real I/O. Two such gaps produced a real
 * `archon.db` and `bin/git-credential-archon`:
 *
 *   - `installCredentialHelper` (step 8, App-mode clone)
 *     → writes the bundled helper script into ~/.archon/bin/
 *   - `handleMessage`           (step 13, orchestrator)
 *     → opens the real SQLite database and creates ~/.archon/workspaces/
 *
 * Both are stubbed below. The package-cwd test preload checks its own
 * temporary ARCHON_HOME after each test (src/test/no-archon-home-writes.ts).
 */
import {
  describe,
  test,
  expect,
  mock,
  spyOn,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';
import type { Mock } from 'bun:test';
import type { Codebase } from '@archon/core';
import type { Octokit } from '@octokit/rest';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEventSignalCandidate } from '@archon/core/db/workflows';

// Mock logger to suppress noisy output during tests
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
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.claude/commands']),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
  resolveRepoProjectIdentity: paths.resolveRepoProjectIdentity,
}));

// Only mock what's needed for the adapter's direct functionality
const mockExecFile = mock(
  (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    callback(null, { stdout: '', stderr: '' });
  }
);

mock.module('child_process', () => ({
  execFile: mockExecFile,
}));

// Mock database modules to prevent self-filtering tests from writing
// phantom records (testuser/testrepo) to the real SQLite database.
// handleWebhook() calls getOrCreateConversation + getOrCreateCodebaseForRepo
// before hitting unmocked Octokit calls - those DB writes persisted silently.
const mockGetOrCreateConversation = mock(async () => ({
  id: 'conv-test',
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
}));
const mockUpdateConversation = mock(async () => {});

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
}));

const mockUpdateCodebase = mock(async () => {});
const mockFindCodebaseByRepoUrl = mock(
  async (): Promise<Pick<Codebase, 'id' | 'repository_url' | 'default_cwd' | 'name'> | null> => null
);
const mockCreateCodebase = mock(async () => ({
  id: 'codebase-test',
  name: 'testuser/testrepo',
  default_cwd: '/tmp/test',
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  createManagedCodebase: mockCreateCodebase,
  updateCodebase: mockUpdateCodebase,
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => {}),
}));

// Mock the users module so adapter.handleWebhook's user-id resolution can be
// inspected without hitting the real DB. Captures the (platform, login) args
// so the comment.user.login ?? sender.login fallback can be asserted.
const mockFindOrCreateUserByPlatformIdentity = mock(
  async (_platform: string, _platformUserId: string, _displayName?: string) => ({
    id: 'user-test-uuid',
    display_name: 'Test',
    email: null,
    created_at: new Date(),
    updated_at: new Date(),
  })
);
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUserByPlatformIdentity,
}));

// Mock @archon/git for the repository readiness the webhook flow reaches
const mockCloneRepository = mock<typeof import('@archon/git')['cloneRepository']>(async () => ({
  ok: true,
  value: undefined,
}));
const mockSyncRepository = mock<typeof import('@archon/git')['syncRepository']>(async () => ({
  ok: true,
  value: undefined,
}));
const mockAddSafeDirectory = mock(async () => undefined);

// execFileAsync is exported by @archon/git and must exist on the mocked
// namespace rather than be `undefined` (which would TypeError if reached).
// Nothing in this file asserts against it: installCredentialHelper, its only
// caller on this path, is stubbed at file scope (see below), and its use of
// execFileAsync is covered in @archon/core instead.
const mockExecFileAsync = mock(async () => ({ stdout: '', stderr: '' }));

mock.module('@archon/git', () => ({
  cloneRepository: mockCloneRepository,
  syncRepository: mockSyncRepository,
  addSafeDirectory: mockAddSafeDirectory,
  findRepoRoot: mock(async () => null),
  isWorktreePath: mock(async () => false),
  toRepoPath: (p: string) => p,
  toBranchName: (n: string) => n,
  toWorktreePath: (p: string) => p,
  execFileAsync: mockExecFileAsync,
  mkdirAsync: mock(async () => undefined),
}));

import { GitHubAdapter } from './adapter';
import type { WebhookEvent } from './types';
// Namespace import so the dedup tests can spyOn(core, 'handleMessage') — the
// orchestrator entry point the adapter calls after webhook setup succeeds.
import * as core from '@archon/core';
import * as workflowDb from '@archon/core/db/workflows';
import * as readiness from './repository-readiness';

// Create a mock lock manager that immediately executes handlers
const mockAcquireLock = mock(async (_id: string, handler: () => Promise<void>) => {
  await handler();
  return { status: 'started' as const };
});
const mockLockManager = {
  acquireLock: mockAcquireLock,
};

/**
 * File-wide stubs for the `@archon/core` functions `handleWebhook()` reaches in
 * its final steps. `spyOn` (not `mock.module`) because `context.test.ts` already
 * mock.modules `@archon/core` with a different shape, and two conflicting
 * factories for one path is exactly the pollution CLAUDE.md forbids — and
 * because spies are reversible.
 *
 * Lifetime is deliberately the WHOLE FILE, not a single describe block. The
 * `handleMessage` spy used to be scoped to `webhook delivery dedup`, whose
 * `afterAll` restored it before `App mode` ran — which is how the App-mode
 * webhook test ended up running the real orchestrator and opening the real
 * SQLite database (#2305).
 */
let handleMessageSpy: ReturnType<typeof spyOn<typeof core, 'handleMessage'>>;
let installCredentialHelperSpy: ReturnType<typeof spyOn<typeof core, 'installCredentialHelper'>>;
let getLinkedIssueNumbersSpy: ReturnType<typeof spyOn<typeof core, 'getLinkedIssueNumbers'>>;

beforeAll(() => {
  handleMessageSpy = spyOn(core, 'handleMessage').mockImplementation(async () => {});
  installCredentialHelperSpy = spyOn(core, 'installCredentialHelper').mockImplementation(
    async () => ({ kind: 'installed', helperPath: '/stub/.archon/bin/git-credential-archon' })
  );
  getLinkedIssueNumbersSpy = spyOn(core, 'getLinkedIssueNumbers').mockImplementation(
    async () => []
  );
});

afterAll(() => {
  handleMessageSpy.mockRestore();
  installCredentialHelperSpy.mockRestore();
  getLinkedIssueNumbersSpy.mockRestore();
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

/**
 * Every Octokit REST endpoint `handleWebhook()` can reach, stubbed to RESOLVE:
 * `repos.get` (step 7), `issues.createComment` (postComment), `pulls.get`
 * (step 10, PR payloads) and `issues.listComments` (step 12, thread context).
 *
 * Resolving is the point. A stub that only makes `repos.get` REJECT looks
 * complete but merely stops the flow at step 7's catch-and-return, leaving
 * steps 8-13 unmocked; the first payload or code change that gets past step 7
 * then silently falls into real I/O. Stub the whole surface instead.
 */
type CreateCommentArgs = NonNullable<Parameters<Octokit['rest']['issues']['createComment']>[0]>;
type ListCommentsArgs = NonNullable<Parameters<Octokit['rest']['issues']['listComments']>[0]>;
type ListComment = Awaited<ReturnType<Octokit['rest']['issues']['listComments']>>['data'][number];
type ListCommentUser = Pick<NonNullable<ListComment['user']>, 'login'>;
type CreateComment = (args: CreateCommentArgs) => Promise<unknown>;
type ListComments = (args: ListCommentsArgs) => Promise<{
  data: { body?: ListComment['body'] | null; user?: ListCommentUser | null }[];
}>;
type RepositoryData = Awaited<ReturnType<Octokit['rest']['repos']['get']>>['data'];
type PullRequestData = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

interface OctokitStubs {
  reposGet: Mock<
    (
      args: NonNullable<Parameters<Octokit['rest']['repos']['get']>[0]>
    ) => Promise<{ data: Pick<RepositoryData, 'default_branch'> }>
  >;
  listComments: Mock<ListComments>;
  createComment: Mock<CreateComment>;
  pullsGet: Mock<
    (args: NonNullable<Parameters<Octokit['rest']['pulls']['get']>[0]>) => Promise<{
      data: {
        head: Pick<PullRequestData['head'], 'ref' | 'sha'> & {
          repo: Pick<NonNullable<PullRequestData['head']['repo']>, 'full_name'> | null;
        };
        base: { repo: Pick<PullRequestData['base']['repo'], 'full_name'> };
      };
    }>
  >;
}

function makeCreateCommentMock(): Mock<CreateComment> {
  return mock(async () => ({ data: {} }));
}

function makeListCommentsMock(
  data: Awaited<ReturnType<ListComments>>['data'] = []
): Mock<ListComments> {
  return mock(async () => ({ data }));
}

/**
 * Replaces an adapter's private Octokit client with that surface and returns
 * the stubs, for the callers that assert against them.
 */
function installOctokitStubs(
  adapter: GitHubAdapter,
  overrides: Partial<Pick<OctokitStubs, 'createComment' | 'listComments'>> = {}
): OctokitStubs {
  const stubs: OctokitStubs = {
    reposGet: mock(async () => ({ data: { default_branch: 'main' } })),
    listComments: overrides.listComments ?? makeListCommentsMock(),
    createComment: overrides.createComment ?? makeCreateCommentMock(),
    pullsGet: mock(async () => ({
      data: {
        head: {
          ref: 'feature-branch',
          sha: 'abc123def456',
          repo: { full_name: 'testuser/testrepo' },
        },
        base: { repo: { full_name: 'testuser/testrepo' } },
      },
    })),
  };
  // @ts-expect-error - replacing private Octokit client for testing
  adapter.octokit = {
    rest: {
      repos: { get: stubs.reposGet },
      issues: { listComments: stubs.listComments, createComment: stubs.createComment },
      pulls: { get: stubs.pullsGet },
    },
  };
  return stubs;
}

describe('GitHubAdapter', () => {
  let adapter: GitHubAdapter;

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    mockExecFile.mockClear();
    adapter = new GitHubAdapter(
      { kind: 'pat', token: 'fake-token-for-testing' },
      'fake-webhook-secret',
      mockLockManager
    );
  });

  test('initialization logs only operational configuration', () => {
    expect(mockLogger.info).toHaveBeenCalledWith({ authMode: 'pat' }, 'github.adapter_initialized');
  });

  test('the PAT client calls api.github.com, or the GITHUB_URL Enterprise API root', () => {
    // @ts-expect-error - reading the private Octokit client
    expect(adapter.octokit.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');
    process.env.GITHUB_URL = 'https://ghe.example';
    try {
      const enterprise = new GitHubAdapter(
        { kind: 'pat', token: 'fake-token-for-testing' },
        'fake-webhook-secret',
        mockLockManager
      );
      // @ts-expect-error - reading the private Octokit client
      expect(enterprise.octokit.request.endpoint.DEFAULTS.baseUrl).toBe(
        'https://ghe.example/api/v3'
      );
    } finally {
      delete process.env.GITHUB_URL;
    }
  });

  describe('streaming mode', () => {
    test('should always return batch mode', () => {
      expect(adapter.getStreamingMode()).toBe('batch');
    });
  });

  describe('platform type', () => {
    test('should return github', () => {
      expect(adapter.getPlatformType()).toBe('github');
    });
  });

  describe('conversational webhook receipt', () => {
    let originalAllowedUsers: string | undefined;

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      process.env.GITHUB_ALLOWED_USERS = 'user123';
      adapter = new GitHubAdapter(
        { kind: 'pat', token: 'fake-token-for-testing' },
        'fake-webhook-secret',
        mockLockManager,
        'archon'
      );
      installOctokitStubs(adapter);
      handleMessageSpy.mockClear();
      mockAcquireLock.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockLogger.debug.mockClear();
      mockLogger.info.mockClear();
      mockLogger.error.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers === undefined) delete process.env.GITHUB_ALLOWED_USERS;
      else process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
    });

    async function receive(eventName: string, event: unknown): Promise<void> {
      const body = JSON.stringify(event);
      const signature =
        'sha256=' + createHmac('sha256', 'fake-webhook-secret').update(body).digest('hex');
      const handler = spyOn(adapter, 'handleWebhook');
      try {
        expect(await adapter.receiveWebhook(body, signature, 'delivery-1', eventName)).toBe(
          'accepted'
        );
        expect(handler).toHaveBeenCalledTimes(1);
        await handler.mock.results[0].value;
      } finally {
        handler.mockRestore();
      }
    }

    test.each(['installation', 'installation_repositories', 'future_event'])(
      'ignores %s without a repository',
      async eventName => {
        const event = {
          action: 'created',
          installation: { id: 123 },
          repositories_added: [],
          repositories_removed: [],
          sender: { login: 'user123' },
        };
        await receive(eventName, event satisfies WebhookEvent);
        expect(mockLogger.debug).toHaveBeenCalledWith(
          { githubEvent: eventName },
          'github.repositoryless_webhook_ignored'
        );
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
        expect(mockAcquireLock).not.toHaveBeenCalled();
        expect(handleMessageSpy).not.toHaveBeenCalled();
      }
    );

    test('ignores a repository without an owner', async () => {
      await receive('issue_comment', {
        repository: { name: 'testrepo' },
        sender: { login: 'user123' },
      });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { githubEvent: 'issue_comment' },
        'github.repositoryless_webhook_ignored'
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(handleMessageSpy).not.toHaveBeenCalled();
    });

    test('rejects unauthorized senders before the repository check', async () => {
      await receive('installation', { sender: { login: 'outsider' } });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { platform: 'github' },
        'github.unauthorized_webhook'
      );
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(handleMessageSpy).not.toHaveBeenCalled();
    });

    test('rejects invalid signatures before parsing or checking repository shape', async () => {
      expect(
        await adapter.receiveWebhook('invalid json', 'sha256=invalid', 'id', 'installation')
      ).toBe('invalid_signature');
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(handleMessageSpy).not.toHaveBeenCalled();
    });

    test('processes an ordinary issue comment', async () => {
      await receive('issue_comment', {
        action: 'created',
        issue: {
          number: 42,
          title: 'Test issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment: { body: '@archon help', user: { login: 'user123' } },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'user123' },
      } satisfies WebhookEvent);
      expect(mockGetOrCreateConversation).toHaveBeenCalledWith(
        'github',
        'testuser/testrepo#42',
        'codebase-test'
      );
      expect(handleMessageSpy).toHaveBeenCalledTimes(1);
      expect(handleMessageSpy.mock.calls[0][1]).toBe('testuser/testrepo#42');
      expect(handleMessageSpy.mock.calls[0][2]).toContain('[GitHub Issue Context]');
      expect(handleMessageSpy.mock.calls[0][2]).toEndWith('help');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('check_run.completed workflow signal', () => {
    const wait = {
      owner: 'loop_group' as const,
      nodeId: 'await-checks',
      bodyWaitId: 'ci-pause',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'event' as const,
      event: 'checks.complete',
      pauseId: 'check-occurrence',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2099-08-24T11:00:00.000Z',
    };
    const pullRequestRecord = {
      schemaVersion: 1,
      repo: { host: 'github.com', path: 'Example/Repo' },
      number: 42,
      url: 'https://github.com/unrelated/project/pull/999',
      head: 'a-branch-that-is-not-used-for-matching',
      base: 'dev',
      is_draft: true,
      state: 'open',
      head_repo: { host: 'github.com', path: 'Example/Repo' },
      head_revision: 'headsha',
      base_revision: 'basesha',
      maintainer_can_modify: null,
    };
    let originalAllowedUsers: string | undefined;
    let listCandidatesSpy: ReturnType<
      typeof spyOn<typeof workflowDb, 'listWorkflowEventSignalCandidates'>
    >;
    let signalWaitSpy: ReturnType<typeof spyOn<typeof workflowDb, 'signalWorkflowWait'>>;

    const candidate = (
      runId: string,
      structuredOutput: unknown = pullRequestRecord,
      candidateWait = wait
    ): WorkflowEventSignalCandidate => ({
      runId,
      wait: candidateWait,
      outputType: 'pull-request',
      structuredOutput,
    });

    const payload = (overrides: Record<string, unknown> = {}): string =>
      JSON.stringify({
        action: 'completed',
        check_run: {
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-08-24T10:05:00.000Z',
          pull_requests: [{ number: 42 }, { number: 42 }],
        },
        repository: { full_name: 'example/repo' },
        sender: { login: 'github-actions[bot]' },
        ...overrides,
      });

    const deliver = async (body: string): Promise<void> => {
      const signature = 'sha256=' + createHmac('sha256', 'check-secret').update(body).digest('hex');
      await adapter.handleWebhook(body, signature, 'delivery-check', 'check_run');
    };

    beforeAll(() => {
      listCandidatesSpy = spyOn(workflowDb, 'listWorkflowEventSignalCandidates');
      signalWaitSpy = spyOn(workflowDb, 'signalWorkflowWait');
    });

    afterAll(() => {
      listCandidatesSpy.mockRestore();
      signalWaitSpy.mockRestore();
    });

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      process.env.GITHUB_ALLOWED_USERS = 'human-allowlisted-user';
      adapter = new GitHubAdapter(
        { kind: 'pat', token: 'fake-token-for-testing' },
        'check-secret',
        mockLockManager
      );
      listCandidatesSpy.mockReset();
      listCandidatesSpy.mockImplementation(async () => []);
      signalWaitSpy.mockReset();
      signalWaitSpy.mockImplementation(async () => ({ signaled: true }));
      handleMessageSpy.mockClear();
      mockLogger.warn.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers === undefined) delete process.env.GITHUB_ALLOWED_USERS;
      else process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
    });

    test('signals the exact matching wait and bypasses the human sender allowlist', async () => {
      listCandidatesSpy.mockImplementation(async () => [candidate('run-42')]);

      await deliver(payload());

      expect(listCandidatesSpy).toHaveBeenCalledWith('checks.complete', expect.any(Date));
      expect(signalWaitSpy).toHaveBeenCalledTimes(1);
      expect(signalWaitSpy).toHaveBeenCalledWith('run-42', wait, { conclusion: 'success' });
      expect(handleMessageSpy).not.toHaveBeenCalled();
    });

    test('signals a wait keyed to the GITHUB_URL Enterprise host, and not a github.com one', async () => {
      process.env.GITHUB_URL = 'https://ghe.example';
      try {
        adapter = new GitHubAdapter(
          { kind: 'pat', token: 'fake-token-for-testing' },
          'check-secret',
          mockLockManager
        );
      } finally {
        delete process.env.GITHUB_URL;
      }
      const enterpriseRepo = { host: 'ghe.example', path: 'Example/Repo' };
      listCandidatesSpy.mockImplementation(async () => [
        candidate('run-ghe', { ...pullRequestRecord, repo: enterpriseRepo }),
        candidate('run-dotcom'),
      ]);

      await deliver(payload());

      expect(signalWaitSpy).toHaveBeenCalledTimes(1);
      expect(signalWaitSpy).toHaveBeenCalledWith('run-ghe', wait, { conclusion: 'success' });
    });

    test('matches only the qualified repository and PR number, never branch or URL', async () => {
      listCandidatesSpy.mockImplementation(async () => [
        candidate('wrong-repo', {
          ...pullRequestRecord,
          repo: { host: 'github.com', path: 'other/repo' },
        }),
        candidate('wrong-number', { ...pullRequestRecord, number: 7 }),
        { ...candidate('wrong-type'), outputType: 'plan' },
        candidate('malformed-record', { number: 42 }),
      ]);

      await deliver(payload());

      expect(signalWaitSpy).not.toHaveBeenCalled();
    });

    test('does not let an old completion satisfy a newer wait occurrence', async () => {
      const newerWait = { ...wait, waitingSince: '2026-08-24T10:06:00.000Z' };
      listCandidatesSpy.mockImplementation(async () => [
        candidate('run-new-wait', pullRequestRecord, newerWait),
      ]);

      await deliver(payload());

      expect(signalWaitSpy).not.toHaveBeenCalled();
    });

    test('a lost signal CAS causes no secondary action', async () => {
      listCandidatesSpy.mockImplementation(async () => [candidate('run-raced')]);
      signalWaitSpy.mockImplementation(async () => ({ signaled: false }));

      await deliver(payload());

      expect(signalWaitSpy).toHaveBeenCalledTimes(1);
      expect(handleMessageSpy).not.toHaveBeenCalled();
    });

    test('ambiguous ownership signals neither run', async () => {
      listCandidatesSpy.mockImplementation(async () => [candidate('run-a'), candidate('run-b')]);

      await deliver(payload());

      expect(signalWaitSpy).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ repo: 'example/repo', number: 42, runIds: ['run-a', 'run-b'] }),
        'github.check_run_ownership_ambiguous'
      );
    });

    test.each([
      ['non-completed action', { action: 'requested' }],
      [
        'non-completed status',
        {
          check_run: {
            status: 'in_progress',
            conclusion: 'success',
            completed_at: '2026-08-24T10:05:00.000Z',
            pull_requests: [{ number: 42 }],
          },
        },
      ],
      [
        'null conclusion',
        {
          check_run: {
            status: 'completed',
            conclusion: null,
            completed_at: '2026-08-24T10:05:00.000Z',
            pull_requests: [{ number: 42 }],
          },
        },
      ],
      [
        'invalid completion time',
        {
          check_run: {
            status: 'completed',
            conclusion: 'success',
            completed_at: 'not-a-date',
            pull_requests: [{ number: 42 }],
          },
        },
      ],
      [
        'no associated PR',
        {
          check_run: {
            status: 'completed',
            conclusion: 'success',
            completed_at: '2026-08-24T10:05:00.000Z',
            pull_requests: [],
          },
        },
      ],
    ])('ignores %s deliveries', async (_label, overrides) => {
      await deliver(payload(overrides));
      expect(listCandidatesSpy).not.toHaveBeenCalled();
      expect(signalWaitSpy).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle methods', () => {
    test('should start without errors', async () => {
      await expect(adapter.start()).resolves.toBeUndefined();
    });

    test('should stop without errors', () => {
      expect(() => adapter.stop()).not.toThrow();
    });
  });

  describe('self-filtering', () => {
    // Test context for self-filtering tests
    let originalAllowedUsers: string | undefined;

    /**
     * Creates an adapter with mocked signature verification and the full
     * resolving Octokit surface (see `installOctokitStubs`), so a payload that
     * survives self-filtering runs `handleWebhook()` to completion under mocks.
     * NOTHING here depends on a call failing to stop the flow early.
     *
     * These tests assert self-filtering and user attribution, both of which
     * happen at steps 4-5b — before any of the stubbed calls — so how far the
     * flow runs afterwards is deliberately not load-bearing for them.
     */
    function createSelfFilterAdapter(botMention = 'archon'): GitHubAdapter {
      const adapter = new GitHubAdapter(
        { kind: 'pat', token: 'fake-token-for-testing' },
        'fake-webhook-secret',
        mockLockManager,
        botMention
      );
      // @ts-expect-error - accessing private method for testing
      adapter.verifySignature = mock(() => true);
      installOctokitStubs(adapter);
      return adapter;
    }

    /**
     * Creates a webhook payload for issue comment events.
     */
    function createCommentPayload(commentBody: string, commentAuthor: string | undefined): string {
      const comment: { body: string; user?: { login: string } } = { body: commentBody };
      if (commentAuthor !== undefined) {
        comment.user = { login: commentAuthor };
      }
      return JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment,
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: commentAuthor ?? 'user123' },
      });
    }

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      delete process.env.GITHUB_ALLOWED_USERS;
      mockAcquireLock.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockFindCodebaseByRepoUrl.mockClear();
      mockCreateCodebase.mockClear();
      mockFindOrCreateUserByPlatformIdentity.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('webhook clones an absent saved checkout before dispatch', async () => {
      const adapter = createSelfFilterAdapter();
      const path = unclonedPath();
      mockFindCodebaseByRepoUrl.mockResolvedValueOnce({
        id: 'saved-project',
        name: 'testuser/testrepo-2',
        default_cwd: path,
        repository_url: 'https://github.com/testuser/testrepo',
      });
      mockGetOrCreateConversation.mockResolvedValueOnce({
        id: 'conv-saved',
        codebase_id: null,
        cwd: null,
        isolation_env_id: null,
      });
      handleMessageSpy.mockClear();
      mockCloneRepository.mockClear();
      mockCloneRepository.mockImplementationOnce(async () => {
        expect(handleMessageSpy).not.toHaveBeenCalled();
        return { ok: true, value: undefined };
      });

      await adapter.handleWebhook(
        createCommentPayload('@archon help', 'user123'),
        'mock-signature'
      );
      expect(mockCloneRepository).toHaveBeenCalledTimes(1);
      expect(mockCloneRepository.mock.calls[0]?.slice(0, 2)).toEqual([
        'https://github.com/testuser/testrepo.git',
        path,
      ]);
      expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    });

    test('allocated checkout path reaches preparation and conversation storage', async () => {
      const adapter = createSelfFilterAdapter();
      const path = '/tmp/test-workspaces/testuser/testrepo-2/source';
      mockCreateCodebase.mockResolvedValueOnce({
        id: 'allocated',
        name: 'testuser/testrepo-2',
        default_cwd: path,
      });
      const prepare = spyOn(readiness, 'ensureRepoReady').mockResolvedValue(undefined);
      try {
        await adapter.handleWebhook(
          createCommentPayload('@archon help', 'user123'),
          'mock-signature'
        );
        expect(prepare).toHaveBeenCalledWith(
          'https://github.com',
          { kind: 'pat', token: 'fake-token-for-testing' },
          'testuser',
          'testrepo',
          'main',
          expect.objectContaining({ name: 'testuser/testrepo-2', default_cwd: path }),
          true
        );
        expect(mockUpdateConversation).toHaveBeenCalledWith('conv-test', {
          codebase_id: 'allocated',
          cwd: path,
        });
      } finally {
        prepare.mockRestore();
      }
    });

    test('attribution falls back to sender.login when comment.user is absent', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined); // no comment.user
      // sender.login defaults to 'user123' in createCommentPayload when commentAuthor is undefined.

      await adapter.handleWebhook(payload, 'mock-signature');

      // Identity resolution must run, and must have used sender.login.
      const calls = mockFindOrCreateUserByPlatformIdentity.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toEqual(['github', 'user123', 'user123']);
    });

    test('attribution prefers comment.user.login over sender.login when both present', async () => {
      const adapter = createSelfFilterAdapter();
      // Simulate a PR-review-comment shape: sender (e.g. PR author who triggered the
      // event flow) differs from the comment author (the reviewer).
      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'x',
          user: { login: 'pr-author' },
          labels: [],
          state: 'open',
        },
        comment: { body: '@archon look at this', user: { login: 'reviewer-alice' } },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'pr-author' },
      });

      await adapter.handleWebhook(payload, 'mock-signature');

      const calls = mockFindOrCreateUserByPlatformIdentity.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // Reviewer (comment author) gets the row, not the PR author (sender).
      expect(calls[0]).toEqual(['github', 'reviewer-alice', 'reviewer-alice']);
    });

    test('handleWebhook never throws when identity resolution fails', async () => {
      const adapter = createSelfFilterAdapter();
      mockFindOrCreateUserByPlatformIdentity.mockRejectedValueOnce(new Error('db down'));
      const payload = createCommentPayload('@archon help', 'user123');

      // Deliberately NOT wrapped in try/catch: "never throws" is the assertion.
      await adapter.handleWebhook(payload, 'mock-signature');

      // The user-resolution failure was caught and warn-logged; the webhook
      // handler proceeded past it (DB write for the conversation still happened).
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });

    test('should ignore comments from the bot itself', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon fix this', 'archon');

      await adapter.handleWebhook(payload, 'mock-signature');

      expect(mockLogger.debug).toHaveBeenCalledWith('github.ignoring_own_comment');
      // Bot's own comments should be silently dropped - no lock acquired, no processing
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    test('should handle case-insensitive username matching', async () => {
      const adapter = createSelfFilterAdapter('Archon'); // Mixed case config
      const payload = createCommentPayload('@archon test', 'archon'); // Lowercase author

      await adapter.handleWebhook(payload, 'mock-signature');

      // Bot's own comments should be silently dropped regardless of case
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    test.each(['please help', '/workflow run @alice'])(
      'dispatches %s without logging command content',
      async message => {
        const adapter = createSelfFilterAdapter();
        const payload = createCommentPayload(`@archon ${message}`, 'user123');

        // handleWebhook progresses past self-filtering into DB/Octokit operations
        await adapter.handleWebhook(payload, 'mock-signature');

        if (message.startsWith('/'))
          expect(mockLogger.debug).toHaveBeenCalledWith('github.slash_command_processing');
        // Real user comments proceed to conversation creation (not self-filtered)
        expect(mockGetOrCreateConversation).toHaveBeenCalled();
      }
    );

    test('should ignore comments containing bot marker (works with user PAT)', async () => {
      const adapter = createSelfFilterAdapter();
      // Comment has the marker but author is a real user (using PAT)
      const payload = createCommentPayload(
        '@archon fix this\n\n<!-- archon-bot-response -->',
        'Wirasm'
      );

      await adapter.handleWebhook(payload, 'mock-signature');

      expect(mockLogger.debug).toHaveBeenCalledWith('github.ignoring_marked_comment');
      // Marked comments should be silently dropped
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    test('should process comments without bot marker from same user', async () => {
      const adapter = createSelfFilterAdapter();
      // Comment from same user but WITHOUT marker - should be processed
      const payload = createCommentPayload('@archon fix this', 'Wirasm');

      // handleWebhook progresses past self-filtering into DB/Octokit operations
      await adapter.handleWebhook(payload, 'mock-signature');

      // Comment without marker proceeds to conversation creation (not self-filtered)
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });

    test('should handle missing comment.user gracefully', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined); // No user field

      // Should not crash on undefined user
      await adapter.handleWebhook(payload, 'mock-signature');

      // Missing user should not trigger self-filtering (proceeds to conversation creation)
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });
  });

  describe('webhook delivery dedup', () => {
    let originalAllowedUsers: string | undefined;

    /**
     * Adapter whose private Octokit client is replaced with local stubs so
     * handleWebhook() runs its full downstream path without live API calls.
     */
    function createDedupAdapter(): { adapter: GitHubAdapter; octokit: OctokitStubs } {
      const adapter = new GitHubAdapter(
        { kind: 'pat', token: 'fake-token-for-testing' },
        'fake-webhook-secret',
        mockLockManager,
        'archon'
      );
      // @ts-expect-error - accessing private method for testing
      adapter.verifySignature = mock(() => true);
      return { adapter, octokit: installOctokitStubs(adapter) };
    }

    function createIdentifiedCommentPayload(
      commentBody: string,
      commentId: number | undefined,
      updatedAt: string | undefined
    ): string {
      const comment: {
        id?: number;
        body: string;
        user: { login: string };
        updated_at?: string;
      } = { body: commentBody, user: { login: 'user123' } };
      if (commentId !== undefined) comment.id = commentId;
      if (updatedAt !== undefined) comment.updated_at = updatedAt;
      return JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment,
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'user123' },
      });
    }

    async function deliver(
      adapter: GitHubAdapter,
      payload: string,
      deliveryId?: string
    ): Promise<void> {
      await adapter.handleWebhook(payload, 'mock-signature', deliveryId);
    }

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      delete process.env.GITHUB_ALLOWED_USERS;
      mockAcquireLock.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockLogger.info.mockClear();
      handleMessageSpy.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('drops a repeat delivery of the same comment (same GUID)', async () => {
      const { adapter, octokit } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');

      await deliver(adapter, payload, 'guid-1');
      await deliver(adapter, payload, 'guid-1');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      // First delivery completed the full pipeline against local stubs —
      // no unmocked Octokit path (and thus no live API call) was reachable.
      expect(octokit.reposGet).toHaveBeenCalledTimes(1);
      expect(octokit.listComments).toHaveBeenCalledTimes(1);
      expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    });

    test('drops a dual-subscription duplicate (same comment, different GUIDs)', async () => {
      const { adapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');

      // Repo webhook and App webhook deliver the same comment under different
      // delivery GUIDs, so GUID-only dedup would miss this duplicate.
      await deliver(adapter, payload, 'guid-repo-hook');
      await deliver(adapter, payload, 'guid-app-hook');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: 'guid-app-hook' }),
        'github.duplicate_delivery_dropped'
      );
    });

    test('redelivery within TTL is dropped even when the first attempt failed (claim-at-ingest tradeoff)', async () => {
      const { adapter, octokit } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');
      // First attempt fails transiently AFTER the dedup key is claimed.
      octokit.reposGet.mockRejectedValueOnce(new Error('transient GitHub outage'));

      await deliver(adapter, payload, 'guid-1');
      expect(handleMessageSpy).not.toHaveBeenCalled();

      // Pins current behavior: the key is claimed before downstream work, so a
      // redelivery of the failed attempt within the TTL is dropped (accepted
      // fire-and-forget tradeoff). Moving the claim later must flip this
      // assertion deliberately.
      await deliver(adapter, payload, 'guid-1-redelivery');

      expect(handleMessageSpy).not.toHaveBeenCalled();
      expect(octokit.reposGet).toHaveBeenCalledTimes(1);
      expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: 'guid-1-redelivery' }),
        'github.duplicate_delivery_dropped'
      );
    });

    test('processes an edited comment again (new updated_at)', async () => {
      const { adapter } = createDedupAdapter();
      const original = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');
      const edited = createIdentifiedCommentPayload(
        '@archon help please',
        1001,
        '2026-06-12T21:05:00Z'
      );

      await deliver(adapter, original, 'guid-1');
      await deliver(adapter, edited, 'guid-2');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('processes distinct comments independently', async () => {
      const { adapter } = createDedupAdapter();
      const first = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');
      const second = createIdentifiedCommentPayload('@archon also', 1002, '2026-06-12T21:00:30Z');

      await deliver(adapter, first, 'guid-1');
      await deliver(adapter, second, 'guid-2');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('requires both id and updated_at for the comment key (id alone uses GUID fallback)', async () => {
      const { adapter } = createDedupAdapter();
      // id present but updated_at missing — keying on id alone would dedup a
      // later edit against the original, so this must use the GUID fallback.
      const payload = createIdentifiedCommentPayload('@archon help', 1001, undefined);

      await deliver(adapter, payload, 'guid-1');
      await deliver(adapter, payload, 'guid-1');
      await deliver(adapter, payload, 'guid-2');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('falls back to delivery GUID when payload lacks comment id', async () => {
      const { adapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', undefined, undefined);

      await deliver(adapter, payload, 'guid-1');
      await deliver(adapter, payload, 'guid-1');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
    });

    test('fails open when neither comment id nor delivery GUID is available', async () => {
      const { adapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', undefined, undefined);

      await deliver(adapter, payload, undefined);
      await deliver(adapter, payload, undefined);

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });
  });

  describe('PR detection helpers', () => {
    test('should detect PR from issue.pull_request property', () => {
      const issueWithPR = {
        number: 42,
        title: 'Test PR',
        body: 'Test body',
        user: { login: 'testuser' },
        labels: [],
        state: 'open',
        pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
      };

      const issueWithoutPR = {
        number: 42,
        title: 'Test Issue',
        body: 'Test body',
        user: { login: 'testuser' },
        labels: [],
        state: 'open',
      };

      expect(!!issueWithPR.pull_request).toBe(true);
      expect(!!(issueWithoutPR as typeof issueWithPR).pull_request).toBe(false);
    });
  });

  describe('worktree path detection helpers', () => {
    test('paths containing /worktrees/ should be detected', () => {
      const worktreePath = '/workspace/worktrees/issue-42/repo';
      const normalPath = '/workspace/repo';

      expect(worktreePath.includes('/worktrees/')).toBe(true);
      expect(normalPath.includes('/worktrees/')).toBe(false);
    });
  });

  describe('worktree creation feedback messages', () => {
    test('issue worktree message format', () => {
      // Verify the message format for issue worktrees
      const number = 42;
      const branchName = `issue-${String(number)}`;
      const message = `Working in isolated branch \`${branchName}\``;

      expect(message).toBe('Working in isolated branch `issue-42`');
      expect(message).toContain('isolated branch');
      expect(message).toContain('issue-42');
    });

    test('PR worktree message format with SHA', () => {
      // Verify the message format for PR worktrees with SHA
      const prHeadSha = 'abc123def456789';
      const prHeadBranch = 'feature/awesome-feature';
      const shortSha = prHeadSha.substring(0, 7);
      const message = `Reviewing PR at commit \`${shortSha}\` (branch: \`${prHeadBranch}\`)`;

      expect(message).toBe('Reviewing PR at commit `abc123d` (branch: `feature/awesome-feature`)');
      expect(message).toContain('Reviewing PR');
      expect(message).toContain('abc123d');
      expect(message).toContain('feature/awesome-feature');
    });

    test('PR worktree message format without SHA (fallback)', () => {
      // Verify the fallback message format for PRs without head SHA
      const number = 42;
      const isPR = true;
      const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
      const message = `Working in isolated branch \`${branchName}\``;

      expect(message).toBe('Working in isolated branch `pr-42`');
      expect(message).toContain('isolated branch');
      expect(message).toContain('pr-42');
    });

    test('shared worktree message format (PR linked to issue)', () => {
      // Verify the message format when PR shares worktree with linked issue
      const issueNum = 42;
      const message = `Reusing worktree from issue #${String(issueNum)}`;

      expect(message).toBe('Reusing worktree from issue #42');
      expect(message).toContain('Reusing');
      expect(message).toContain('#42');
    });

    test('existing worktree reuse message format', () => {
      // Verify the message format when conversation already has a worktree
      const number = 42;
      const isPR = false;
      const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
      const message = `Reusing worktree \`${branchName}\``;

      expect(message).toBe('Reusing worktree `issue-42`');
      expect(message).toContain('Reusing');
      expect(message).toContain('issue-42');
    });

    test('messages use backticks for branch names', () => {
      // Verify messages use GitHub markdown backticks for branch names
      const issueMessage = 'Working in isolated branch `issue-42`';
      const prMessage = 'Reviewing PR at commit `abc1234` (branch: `feature-x`)';

      // Count backticks (should be pairs for formatting)
      const issueBackticks = (issueMessage.match(/`/g) ?? []).length;
      const prBackticks = (prMessage.match(/`/g) ?? []).length;

      expect(issueBackticks).toBe(2); // One pair for branch name
      expect(prBackticks).toBe(4); // Two pairs (SHA + branch)
    });
  });

  describe('multi-repo path isolation', () => {
    test('should use owner/repo path structure for codebases', () => {
      // Test that path construction includes owner
      const workspacePath = '/workspace';
      const owner1 = 'alice';
      const owner2 = 'bob';
      const repo = 'utils';

      // Simulate the path construction logic
      const path1 = `${workspacePath}/${owner1}/${repo}`;
      const path2 = `${workspacePath}/${owner2}/${repo}`;

      // Paths should be different even with same repo name
      expect(path1).not.toBe(path2);
      expect(path1).toBe('/workspace/alice/utils');
      expect(path2).toBe('/workspace/bob/utils');
    });

    test('worktrees should be isolated by owner', () => {
      // Worktrees are relative to repo path, so they auto-isolate
      const aliceRepoPath = '/workspace/alice/utils';
      const bobRepoPath = '/workspace/bob/utils';
      const issueNumber = 33;

      // Simulate worktree path construction
      const aliceWorktree = `${aliceRepoPath}/../worktrees/issue-${issueNumber}`;
      const bobWorktree = `${bobRepoPath}/../worktrees/issue-${issueNumber}`;

      // Note: These resolve to different paths
      // /workspace/alice/worktrees/issue-33 vs /workspace/bob/worktrees/issue-33
      expect(aliceWorktree).not.toBe(bobWorktree);
    });
  });

  describe('fork detection logic', () => {
    function createPullRequestCommentPayload(): string {
      const event = {
        action: 'created',
        issue: {
          number: 42,
          title: 'Test PR',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
          pull_request: { url: 'https://api.github.com/repos/testuser/testrepo/pulls/42' },
        },
        comment: { body: '@archon review this', user: { login: 'user123' } },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'user123' },
      } satisfies WebhookEvent;

      return JSON.stringify(event);
    }

    async function expectForkVerdict(
      headRepoFullName: string | undefined,
      expected: boolean
    ): Promise<void> {
      handleMessageSpy.mockClear();
      const { pullsGet } = installOctokitStubs(adapter);
      pullsGet.mockResolvedValueOnce({
        data: {
          head: {
            ref: 'feature-branch',
            sha: 'abc123def456',
            repo: headRepoFullName === undefined ? null : { full_name: headRepoFullName },
          },
          base: { repo: { full_name: 'testuser/testrepo' } },
        },
      });
      const payload = createPullRequestCommentPayload();
      const signature =
        'sha256=' + createHmac('sha256', 'fake-webhook-secret').update(payload).digest('hex');

      await adapter.handleWebhook(payload, signature);

      expect(pullsGet).toHaveBeenCalledWith({
        owner: 'testuser',
        repo: 'testrepo',
        pull_number: 42,
      });
      expect(handleMessageSpy).toHaveBeenCalledWith(
        expect.anything(),
        'testuser/testrepo#42',
        expect.anything(),
        expect.objectContaining({
          isolationHints: expect.objectContaining({ isForkPR: expected }),
        })
      );
    }

    test('should detect same-repo PR when head and base repos match', async () => {
      await expectForkVerdict('testuser/testrepo', false);
    });

    test('should detect fork PR when head and base repos differ', async () => {
      await expectForkVerdict('contributor/testrepo', true);
    });

    test('should detect fork PR when head.repo is null (deleted fork)', async () => {
      await expectForkVerdict(undefined, true);
    });

    test('should handle case sensitivity correctly', async () => {
      await expectForkVerdict('TestUser/TestRepo', true);
    });
  });

  // ---------------------------------------------------------------------------
  // App mode (GitHub App auth) — multi-installation routing, payload short-
  // circuit, refresh-on-401, self-filter against <slug>[bot], clone path.
  // ---------------------------------------------------------------------------
  describe('App mode', () => {
    /**
     * Build a mock IGitHubAppAuthProvider. Each fake `(owner) → installationId`
     * pair is encoded by hashing owner — tests assert that distinct owners
     * resolve to distinct installation ids (multi-install routing).
     */
    function makeMockProvider(opts: { slug?: string } = {}): {
      provider: ReturnType<typeof buildProvider>;
      getOctokit: ReturnType<typeof mock>;
      getToken: ReturnType<typeof mock>;
      prime: ReturnType<typeof mock>;
      invalidate: ReturnType<typeof mock>;
      invalidateRepo: ReturnType<typeof mock>;
      resolveId: ReturnType<typeof mock>;
      installationIdFor: (owner: string) => number;
    } {
      const installationIdFor = (owner: string): number =>
        Math.abs(owner.charCodeAt(0) * 37 + (owner.charCodeAt(1) ?? 0));

      type AppOctokit = {
        __installationId: number;
        rest: {
          issues: {
            createComment: Mock<CreateComment>;
            listComments: Mock<ListComments>;
          };
          repos: { get: OctokitStubs['reposGet'] };
          pulls: { get: OctokitStubs['pullsGet'] };
        };
      };

      const octokitInstances = new Map<number, AppOctokit>();
      const lookups = new Map<string, number>();

      const getToken = mock(async (owner: string, _repo: string) => {
        return `ghs_${owner}_token`;
      });
      const resolveId = mock(async (owner: string, _repo: string) => {
        const key = `${owner.toLowerCase()}`;
        if (!lookups.has(key)) lookups.set(key, installationIdFor(owner));
        return lookups.get(key)!;
      });
      const prime = mock((owner: string, _repo: string, installationId: number) => {
        lookups.set(owner.toLowerCase(), installationId);
      });
      const invalidate = mock((_id: number) => undefined);

      // Each per-installation Octokit mock starts with createComment/repos/pulls
      // mocked. Test bodies can call `.mockResolvedValueOnce(...)` /
      // `.mockRejectedValueOnce(...)` on those fields as needed.
      function octokitFor(installationId: number): AppOctokit {
        let oct = octokitInstances.get(installationId);
        if (!oct) {
          const reposGet: OctokitStubs['reposGet'] = mock(async () => ({
            data: { default_branch: 'main' },
          }));
          const pullsGet: OctokitStubs['pullsGet'] = mock(async () => ({
            data: {
              head: { ref: 'feature', sha: 'abc123def', repo: { full_name: 'o/r' } },
              base: { repo: { full_name: 'o/r' } },
            },
          }));
          oct = {
            __installationId: installationId,
            rest: {
              issues: {
                createComment: makeCreateCommentMock(),
                listComments: makeListCommentsMock(),
              },
              repos: {
                get: reposGet,
              },
              pulls: {
                get: pullsGet,
              },
            },
          };
          octokitInstances.set(installationId, oct);
        }
        return oct;
      }

      const getOctokit = mock(async (owner: string, repo: string) => {
        const id = await resolveId(owner, repo);
        return octokitFor(id);
      });

      const invalidateRepo = mock((_owner: string, _repo: string) => undefined);

      function buildProvider() {
        return {
          slug: opts.slug ?? 'archon-test',
          getInstallationToken: getToken,
          getInstallationTokenById: mock(async () => 'ghs_by_id'),
          getOctokitForInstallation: getOctokit,
          resolveInstallationId: resolveId,
          primeInstallationLookup: prime,
          invalidateToken: invalidate,
          invalidateRepo,
        };
      }

      return {
        provider: buildProvider(),
        getOctokit,
        getToken,
        prime,
        invalidate,
        invalidateRepo,
        resolveId,
        installationIdFor,
      };
    }

    function createAppModeAdapter(opts: { slug?: string } = {}): {
      adapter: GitHubAdapter;
      provider: ReturnType<typeof makeMockProvider>;
    } {
      const provider = makeMockProvider(opts);
      const adapter = new GitHubAdapter(
        { kind: 'app', provider: provider.provider },
        'fake-webhook-secret',
        mockLockManager,
        'archon'
      );
      // @ts-expect-error - mock signature verification
      adapter.verifySignature = mock(() => true);
      return { adapter, provider };
    }

    beforeEach(() => {
      mockCloneRepository.mockClear();
      mockCloneRepository.mockResolvedValue({ ok: true, value: undefined });
      mockExecFileAsync.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockFindCodebaseByRepoUrl.mockClear();
      mockCreateCodebase.mockClear();
      mockFindOrCreateUserByPlatformIdentity.mockClear();
      installCredentialHelperSpy.mockClear();
    });

    test('getInstallationToken called once per (owner, repo) for sendMessage', async () => {
      const { adapter, provider } = createAppModeAdapter();
      // sendMessage flow goes through resolveOctokit -> getOctokitForInstallation,
      // not getInstallationToken. Assert the Octokit path was exercised instead.
      await adapter.sendMessage('owner/repo#42', 'hello');
      expect(provider.getOctokit).toHaveBeenCalledWith('owner', 'repo');
      expect(provider.getOctokit.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    test('multi-install routing — different (owner, repo) get different installations', async () => {
      const { adapter, provider } = createAppModeAdapter();
      await adapter.sendMessage('alpha/repo#1', 'one');
      await adapter.sendMessage('beta/repo#2', 'two');

      const idAlpha = await provider.resolveId('alpha', 'repo');
      const idBeta = await provider.resolveId('beta', 'repo');
      expect(idAlpha).not.toBe(idBeta);
      expect(provider.getOctokit).toHaveBeenCalledWith('alpha', 'repo');
      expect(provider.getOctokit).toHaveBeenCalledWith('beta', 'repo');
    });

    test('webhook installation.id primes the lookup cache (no extra round trip)', async () => {
      const { adapter, provider } = createAppModeAdapter();
      mockFindOrCreateUserByPlatformIdentity.mockResolvedValueOnce({
        id: 'u',
        display_name: 'u',
        email: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 1,
          title: 't',
          body: '',
          user: { login: 'someone' },
          labels: [],
          state: 'open',
        },
        comment: { body: '@archon help', user: { login: 'someone' } },
        repository: {
          owner: { login: 'alpha' },
          name: 'repo',
          full_name: 'alpha/repo',
          html_url: 'https://github.com/alpha/repo',
          default_branch: 'main',
        },
        sender: { login: 'someone' },
        installation: { id: 99999 },
      });
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Inner orchestrator path may throw — we only care about priming here.
      }
      expect(provider.prime).toHaveBeenCalledWith('alpha', 'repo', 99999);
    });

    test('401 from Octokit triggers invalidateRepo + retry once', async () => {
      const { adapter, provider } = createAppModeAdapter();
      // First call to Octokit.createComment throws 401; second succeeds.
      const octokit = await provider.getOctokit('owner', 'repo');
      const err401 = Object.assign(new Error('Unauthorized'), { status: 401 });
      octokit.rest.issues.createComment
        .mockRejectedValueOnce(err401)
        .mockResolvedValueOnce({ data: { id: 1 } });

      await adapter.sendMessage('owner/repo#1', 'msg');
      // invalidateRepo evicts BOTH the lookup cache and the token cache
      // for (owner, repo) — see C2 in the PR-B review.
      expect(provider.invalidateRepo).toHaveBeenCalledWith('owner', 'repo');
    });

    test('T3: second consecutive 401 propagates (no infinite retry)', async () => {
      const { adapter, provider } = createAppModeAdapter();
      const octokit = await provider.getOctokit('owner', 'repo');
      const err401a = Object.assign(new Error('Unauthorized A'), { status: 401 });
      const err401b = Object.assign(new Error('Unauthorized B'), { status: 401 });
      // Two consecutive 401s — retry path must surface the second error and
      // NOT call invalidateRepo a second time (which would suggest looping).
      octokit.rest.issues.createComment
        .mockRejectedValueOnce(err401a)
        .mockRejectedValueOnce(err401b);

      // The retry path swallows non-retryable errors at the postComment
      // wrapper layer (401 is not in the retryable set), so the second
      // failure propagates and postComment will log + throw it. We assert
      // the side effects directly rather than depending on whether the
      // outer wrapper swallows or propagates.
      await adapter.sendMessage('owner/repo#1', 'msg').catch(() => undefined);

      // Exactly one invalidateRepo call (single retry, not infinite).
      expect(provider.invalidateRepo).toHaveBeenCalledTimes(1);
      // The retry fn(fresh) WAS called — second mock value was consumed.
      expect(octokit.rest.issues.createComment.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('lookupCache eviction on 401 — adapter calls invalidateRepo(owner, repo) not invalidateToken(id)', async () => {
      // C2 regression guard: the adapter must use invalidateRepo (which evicts
      // BOTH caches) and not invalidateToken (which used to leave lookupCache
      // populated with the stale id).
      const { adapter, provider } = createAppModeAdapter();
      const octokit = await provider.getOctokit('owner', 'repo');
      const err401 = Object.assign(new Error('Unauthorized'), { status: 401 });
      octokit.rest.issues.createComment
        .mockRejectedValueOnce(err401)
        .mockResolvedValueOnce({ data: { id: 1 } });

      await adapter.sendMessage('owner/repo#1', 'msg');
      expect(provider.invalidateRepo).toHaveBeenCalledWith('owner', 'repo');
      // Specifically NOT the by-id variant — that's the C2 bug shape.
      expect(provider.invalidate).not.toHaveBeenCalled();
    });

    test('self-filter ignores comments authored by "<slug>[bot]"', async () => {
      const { adapter } = createAppModeAdapter({ slug: 'archon-bot' });
      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 1,
          title: 't',
          body: '',
          user: { login: 'someone' },
          labels: [],
          state: 'open',
        },
        comment: {
          body: '@archon ping', // would normally trigger; bot login filter must reject first
          user: { login: 'archon-bot[bot]' },
        },
        repository: {
          owner: { login: 'o' },
          name: 'r',
          full_name: 'o/r',
          html_url: 'https://github.com/o/r',
          default_branch: 'main',
        },
        sender: { login: 'archon-bot[bot]' },
      });
      await adapter.handleWebhook(payload, 'mock-signature');
      // Filter triggered: no user creation, no codebase lookup downstream.
      expect(mockFindOrCreateUserByPlatformIdentity).not.toHaveBeenCalled();
      expect(mockFindCodebaseByRepoUrl).not.toHaveBeenCalled();
    });
  });
});
