/**
 * Unit tests for GitHub adapter (OAuth App & Per-User Identity mode)
 *
 * Note: Database modules are mocked to prevent self-filtering tests from
 * writing phantom records (e.g., testuser/testrepo) to the real SQLite DB.
 *
 * ARCHON_HOME INVARIANT (#2305): this file must create nothing under
 * `$ARCHON_HOME`.
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
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';

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
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.claude/commands']),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
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
// phantom records to the real SQLite database.
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

const mockFindCodebaseByRepoUrl = mock(async () => null);
const mockCreateCodebase = mock(async () => ({
  id: 'codebase-test',
  name: 'testuser/testrepo',
  default_cwd: '/tmp/test',
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  createCodebase: mockCreateCodebase,
  updateCodebase: mock(async () => {}),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => {}),
}));

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

const mockGetUserIdsByGithubNumericId = mock(async (_numericId: number) => ['user-test-uuid']);
mock.module('@archon/core/db/user-github-token-store', () => ({
  getUserIdsByGithubNumericId: mockGetUserIdsByGithubNumericId,
}));

const mockResolveDefaultAssistant = mock(async () => 'claude' as const);
mock.module('@archon/core/config/resolve-assistant', () => ({
  resolveDefaultAssistant: mockResolveDefaultAssistant,
}));

// Mock @archon/git for ensureRepoReady integration tests
const mockCloneRepository = mock(async () => ({ ok: true, value: undefined }));
const mockSyncRepository = mock(async () => ({ ok: true, value: undefined }));
const mockAddSafeDirectory = mock(async () => undefined);
const mockIsWorktreePath = mock(async () => false);
const mockExecFileAsync = mock(async () => ({ stdout: '', stderr: '' }));

mock.module('@archon/git', () => ({
  cloneRepository: mockCloneRepository,
  syncRepository: mockSyncRepository,
  addSafeDirectory: mockAddSafeDirectory,
  isWorktreePath: mockIsWorktreePath,
  toRepoPath: (p: string) => p,
  toBranchName: (n: string) => n,
  toWorktreePath: (p: string) => p,
  execFileAsync: mockExecFileAsync,
  mkdirAsync: mock(async () => undefined),
}));

import { GitHubAdapter } from './adapter';
import { ConversationLockManager } from '@archon/core';
import * as core from '@archon/core';

const mockLockManager = {
  acquireLock: mock(async (_id: string, handler: () => Promise<void>) => {
    await handler();
  }),
  getStats: () => ({
    active: 0,
    queuedTotal: 0,
    queuedByConversation: [],
    maxConcurrent: 10,
    activeConversationIds: [],
  }),
} as unknown as ConversationLockManager;

let handleMessageSpy: ReturnType<typeof spyOn<typeof core, 'handleMessage'>>;
let installCredentialHelperSpy: ReturnType<typeof spyOn<typeof core, 'installCredentialHelper'>>;
let getLinkedIssueNumbersSpy: ReturnType<typeof spyOn<typeof core, 'getLinkedIssueNumbers'>>;
let isPerUserGitHubEnabledSpy: ReturnType<typeof spyOn<typeof core, 'isPerUserGitHubEnabled'>>;

beforeAll(() => {
  handleMessageSpy = spyOn(core, 'handleMessage').mockImplementation(async () => {});
  installCredentialHelperSpy = spyOn(core, 'installCredentialHelper').mockImplementation(
    async () => ({ kind: 'installed', helperPath: '/stub/.archon/bin/git-credential-archon' })
  );
  getLinkedIssueNumbersSpy = spyOn(core, 'getLinkedIssueNumbers').mockImplementation(
    async () => []
  );
  isPerUserGitHubEnabledSpy = spyOn(core, 'isPerUserGitHubEnabled').mockImplementation(() => true);
});

afterAll(() => {
  handleMessageSpy.mockRestore();
  installCredentialHelperSpy.mockRestore();
  getLinkedIssueNumbersSpy.mockRestore();
  isPerUserGitHubEnabledSpy.mockRestore();
});

function unclonedPath(): string {
  return join(tmpdir(), `archon-clone-test-${randomUUID()}`);
}

interface OctokitStubs {
  reposGet: ReturnType<typeof mock>;
  listComments: ReturnType<typeof mock>;
  createComment: ReturnType<typeof mock>;
  pullsGet: ReturnType<typeof mock>;
}

function installOctokitStubs(
  adapter: GitHubAdapter,
  userId: string = 'user-test-uuid'
): OctokitStubs {
  const stubs: OctokitStubs = {
    reposGet: mock(async () => ({ data: { default_branch: 'main' } })),
    listComments: mock(async () => ({ data: [] })),
    createComment: mock(async () => ({ data: {} })),
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
  const mockOctokit = {
    rest: {
      repos: { get: stubs.reposGet },
      issues: { listComments: stubs.listComments, createComment: stubs.createComment },
      pulls: { get: stubs.pullsGet },
    },
  } as unknown as Octokit;

  // @ts-expect-error - accessing private cache for testing
  adapter.userOctokitCache.set(userId, {
    octokit: mockOctokit,
    expiresAt: Date.now() + 1000 * 60 * 60,
  });
  // @ts-expect-error - accessing private map for testing
  adapter.actorByConversation.set('testuser/testrepo#42', userId);
  // @ts-expect-error - accessing private map for testing
  adapter.actorByConversation.set('owner/repo#123', userId);
  // @ts-expect-error - accessing private map for testing
  adapter.actorByConversation.set('owner/repo#1', userId);
  // @ts-expect-error - accessing private map for testing
  adapter.actorByConversation.set('owner/repo#42', userId);
  // @ts-expect-error - accessing private map for testing
  adapter.actorByConversation.set('alpha/repo#1', userId);
  // @ts-expect-error - accessing private map for testing
  adapter.actorByConversation.set('beta/repo#2', userId);

  return stubs;
}

async function createTestAdapterWithMockedOctokit(
  mockCreateComment: ReturnType<typeof mock>,
  options?: { retryDelayMs?: (attempt: number) => number; userId?: string }
): Promise<GitHubAdapter> {
  const userId = options?.userId ?? 'user-test-uuid';
  const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
    retryDelayMs: options?.retryDelayMs,
    getUserToken: async () => 'fake-token-for-testing',
  });
  await testAdapter.start();
  // @ts-expect-error - accessing private property for testing
  testAdapter.actorByConversation.set('owner/repo#123', userId);
  const mockOctokit = {
    rest: {
      issues: {
        createComment: mockCreateComment,
      },
    },
  } as unknown as Octokit;
  // @ts-expect-error - mock getUserOctokit to prevent live network calls on 401 retry
  testAdapter.getUserOctokit = async () => mockOctokit;
  // @ts-expect-error - accessing private property for testing
  testAdapter.userOctokitCache.set(userId, {
    octokit: mockOctokit,
    expiresAt: Date.now() + 1000 * 60 * 60,
  });
  return testAdapter;
}

describe('GitHubAdapter', () => {
  let adapter: GitHubAdapter;

  beforeEach(() => {
    mockExecFile.mockClear();
    adapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
      getUserToken: async () => 'fake-token-for-testing',
    });
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

  describe('lifecycle methods', () => {
    test('should start without errors', async () => {
      await expect(adapter.start()).resolves.toBeUndefined();
    });

    test('should stop without errors', () => {
      expect(() => adapter.stop()).not.toThrow();
    });
  });

  describe('bot mention detection', () => {
    test('should detect mention case-insensitively', () => {
      const adapterWithMention = new GitHubAdapter('secret', mockLockManager, 'Dylan', {
        getUserToken: async () => 'token',
      });
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@Dylan please help')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@dylan please help')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@DYLAN please help')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@DyLaN please help')).toBe(true);

      expect(hasMention.call(adapterWithMention, '@other-bot please help')).toBe(false);
      expect(hasMention.call(adapterWithMention, 'no mention here')).toBe(false);
    });

    test('should detect mention when it is the entire message', () => {
      const adapterWithMention = new GitHubAdapter('secret', mockLockManager, 'Archon', {
        getUserToken: async () => 'token',
      });
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@Archon')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@ARCHON')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@archon')).toBe(true);
    });

    test('should strip mention case-insensitively', () => {
      const adapterWithMention = new GitHubAdapter('secret', mockLockManager, 'Dylan', {
        getUserToken: async () => 'token',
      });
      const stripMention = (
        adapterWithMention as unknown as { stripMention: (text: string) => string }
      ).stripMention;

      expect(stripMention.call(adapterWithMention, '@Dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@DYLAN please help')).toBe('please help');
    });
  });

  describe('self-filtering', () => {
    let originalAllowedUsers: string | undefined;

    function createSelfFilterAdapter(botMention = 'archon'): GitHubAdapter {
      const selfAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, botMention, {
        getUserToken: async () => 'fake-token-for-testing',
      });
      // @ts-expect-error - accessing private method for testing
      selfAdapter.verifySignature = mock(() => true);
      installOctokitStubs(selfAdapter);
      return selfAdapter;
    }

    function createCommentPayload(commentBody: string, commentAuthor: string | undefined): string {
      const comment: {
        id: number;
        body: string;
        updated_at: string;
        user?: { id: number; login: string };
      } = {
        id: 12345,
        body: commentBody,
        updated_at: '2026-06-12T21:00:00Z',
      };
      if (commentAuthor !== undefined) {
        comment.user = { id: 42, login: commentAuthor };
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
        sender: { id: 42, login: commentAuthor ?? 'user123' },
      });
    }

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      delete process.env.GITHUB_ALLOWED_USERS;
      mockLockManager.acquireLock.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockFindCodebaseByRepoUrl.mockClear();
      mockCreateCodebase.mockClear();
      mockFindOrCreateUserByPlatformIdentity.mockClear();
      mockGetUserIdsByGithubNumericId.mockClear();
      mockGetUserIdsByGithubNumericId.mockResolvedValue(['user-test-uuid']);
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('attribution falls back to sender.login when comment.user is absent', async () => {
      const selfAdapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined);

      await selfAdapter.handleWebhook(payload, 'mock-signature');

      const calls = mockGetUserIdsByGithubNumericId.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toEqual([42]);
    });

    test('attribution prefers comment.user.login over sender.login when both present', async () => {
      const selfAdapter = createSelfFilterAdapter();
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
        comment: {
          id: 12345,
          body: '@archon look at this',
          updated_at: '2026-06-12T21:00:00Z',
          user: { id: 43, login: 'reviewer-alice' },
        },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://github.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { id: 42, login: 'pr-author' },
      });

      await selfAdapter.handleWebhook(payload, 'mock-signature');

      const calls = mockGetUserIdsByGithubNumericId.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toEqual([43]);
    });

    test('handleWebhook never throws when identity resolution fails', async () => {
      const selfAdapter = createSelfFilterAdapter();
      mockFindOrCreateUserByPlatformIdentity.mockRejectedValueOnce(new Error('db down'));
      const payload = createCommentPayload('@archon help', 'user123');

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });

    test('should ignore comments from the bot itself', async () => {
      const selfAdapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon fix this', 'archon');

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    test('should handle case-insensitive username matching', async () => {
      const selfAdapter = createSelfFilterAdapter('Archon');
      const payload = createCommentPayload('@archon test', 'archon');

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    test('should NOT filter comments from real users', async () => {
      const selfAdapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon please help', 'user123');

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });

    test('should ignore comments containing bot marker (works with user PAT)', async () => {
      const selfAdapter = createSelfFilterAdapter();
      const payload = createCommentPayload(
        '@archon fix this\n\n<!-- archon-bot-response -->',
        'Wirasm'
      );

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    test('should process comments without bot marker from same user', async () => {
      const selfAdapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon fix this', 'Wirasm');

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });

    test('should handle missing comment.user gracefully', async () => {
      const selfAdapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined);

      await selfAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });
  });

  describe('webhook delivery dedup', () => {
    let originalAllowedUsers: string | undefined;

    function createDedupAdapter(): { adapter: GitHubAdapter; octokit: OctokitStubs } {
      const dedupAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'archon', {
        getUserToken: async () => 'fake-token-for-testing',
      });
      // @ts-expect-error - accessing private method for testing
      dedupAdapter.verifySignature = mock(() => true);
      return { adapter: dedupAdapter, octokit: installOctokitStubs(dedupAdapter) };
    }

    function createIdentifiedCommentPayload(
      commentBody: string,
      commentId: number | undefined,
      updatedAt: string | undefined
    ): string {
      const comment: {
        id?: number;
        body: string;
        user: { id: number; login: string };
        updated_at?: string;
      } = { body: commentBody, user: { id: 42, login: 'user123' } };
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
        sender: { id: 42, login: 'user123' },
      });
    }

    async function deliver(
      targetAdapter: GitHubAdapter,
      payload: string,
      deliveryId?: string
    ): Promise<void> {
      await targetAdapter.handleWebhook(payload, 'mock-signature', deliveryId);
    }

    beforeEach(() => {
      originalAllowedUsers = process.env.GITHUB_ALLOWED_USERS;
      delete process.env.GITHUB_ALLOWED_USERS;
      mockLockManager.acquireLock.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockLogger.info.mockClear();
      handleMessageSpy.mockClear();
      mockGetUserIdsByGithubNumericId.mockClear();
      mockGetUserIdsByGithubNumericId.mockResolvedValue(['user-test-uuid']);
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('drops a repeat delivery of the same comment (same GUID)', async () => {
      const { adapter: dedupAdapter, octokit } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');

      await deliver(dedupAdapter, payload, 'guid-1');
      await deliver(dedupAdapter, payload, 'guid-1');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      expect(octokit.reposGet).toHaveBeenCalledTimes(1);
      expect(octokit.listComments).toHaveBeenCalledTimes(1);
      expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    });

    test('drops a dual-subscription duplicate (same comment, different GUIDs)', async () => {
      const { adapter: dedupAdapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');

      await deliver(dedupAdapter, payload, 'guid-repo-hook');
      await deliver(dedupAdapter, payload, 'guid-app-hook');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: 'guid-app-hook' }),
        'github.duplicate_delivery_dropped'
      );
    });

    test('redelivery within TTL is dropped even when the first attempt failed (claim-at-ingest tradeoff)', async () => {
      const { adapter: dedupAdapter, octokit } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');
      octokit.reposGet.mockRejectedValueOnce(new Error('transient GitHub outage'));

      await deliver(dedupAdapter, payload, 'guid-1');
      expect(handleMessageSpy).not.toHaveBeenCalled();

      await deliver(dedupAdapter, payload, 'guid-1-redelivery');

      expect(handleMessageSpy).not.toHaveBeenCalled();
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: 'guid-1-redelivery' }),
        'github.duplicate_delivery_dropped'
      );
    });

    test('processes an edited comment again (new updated_at)', async () => {
      const { adapter: dedupAdapter } = createDedupAdapter();
      const original = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');
      const edited = createIdentifiedCommentPayload(
        '@archon help please',
        1001,
        '2026-06-12T21:05:00Z'
      );

      await deliver(dedupAdapter, original, 'guid-1');
      await deliver(dedupAdapter, edited, 'guid-2');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('processes distinct comments independently', async () => {
      const { adapter: dedupAdapter } = createDedupAdapter();
      const first = createIdentifiedCommentPayload('@archon help', 1001, '2026-06-12T21:00:00Z');
      const second = createIdentifiedCommentPayload('@archon also', 1002, '2026-06-12T21:00:30Z');

      await deliver(dedupAdapter, first, 'guid-1');
      await deliver(dedupAdapter, second, 'guid-2');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('requires both id and updated_at for the comment key (id alone uses GUID fallback)', async () => {
      const { adapter: dedupAdapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', 1001, undefined);

      await deliver(dedupAdapter, payload, 'guid-1');
      await deliver(dedupAdapter, payload, 'guid-1');
      await deliver(dedupAdapter, payload, 'guid-2');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('falls back to delivery GUID when payload lacks comment id', async () => {
      const { adapter: dedupAdapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', undefined, undefined);

      await deliver(dedupAdapter, payload, 'guid-1');
      await deliver(dedupAdapter, payload, 'guid-1');

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
    });

    test('fails open when neither comment id nor delivery GUID is available', async () => {
      const { adapter: dedupAdapter } = createDedupAdapter();
      const payload = createIdentifiedCommentPayload('@archon help', undefined, undefined);

      await deliver(dedupAdapter, payload, undefined);
      await deliver(dedupAdapter, payload, undefined);

      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });
  });

  describe('conversationId format', () => {
    test('should parse valid owner/repo#number format', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await testAdapter.sendMessage('owner/repo#123', 'test');

      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: 'test\n\n<!-- archon-bot-response -->',
      });
    });

    test('postComment appends bot marker to outgoing comments', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await testAdapter.sendMessage('owner/repo#123', 'Hello world');

      const body = mockCreateComment.mock.calls[0][0].body as string;
      expect(body).toContain('Hello world');
      expect(body).toContain('<!-- archon-bot-response -->');
      expect(body).toBe('Hello world\n\n<!-- archon-bot-response -->');
    });

    test('should reject invalid conversationId format', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await testAdapter.sendMessage('owner/repo#pr-42', 'test');
      expect(mockCreateComment).not.toHaveBeenCalled();
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
      const number = 42;
      const branchName = `issue-${String(number)}`;
      const message = `Working in isolated branch \`${branchName}\``;

      expect(message).toBe('Working in isolated branch `issue-42`');
      expect(message).toContain('isolated branch');
      expect(message).toContain('issue-42');
    });

    test('PR worktree message format with SHA', () => {
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
      const number = 42;
      const isPR = true;
      const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
      const message = `Working in isolated branch \`${branchName}\``;

      expect(message).toBe('Working in isolated branch `pr-42`');
      expect(message).toContain('isolated branch');
      expect(message).toContain('pr-42');
    });

    test('shared worktree message format (PR linked to issue)', () => {
      const issueNum = 42;
      const message = `Reusing worktree from issue #${String(issueNum)}`;

      expect(message).toBe('Reusing worktree from issue #42');
      expect(message).toContain('Reusing');
      expect(message).toContain('#42');
    });

    test('existing worktree reuse message format', () => {
      const number = 42;
      const isPR = false;
      const branchName = isPR ? `pr-${String(number)}` : `issue-${String(number)}`;
      const message = `Reusing worktree \`${branchName}\``;

      expect(message).toBe('Reusing worktree `issue-42`');
      expect(message).toContain('Reusing');
      expect(message).toContain('issue-42');
    });

    test('messages use backticks for branch names', () => {
      const issueMessage = 'Working in isolated branch `issue-42`';
      const prMessage = 'Reviewing PR at commit `abc1234` (branch: `feature-x`)';

      const issueBackticks = (issueMessage.match(/`/g) ?? []).length;
      const prBackticks = (prMessage.match(/`/g) ?? []).length;

      expect(issueBackticks).toBe(2);
      expect(prBackticks).toBe(4);
    });
  });

  describe('multi-repo path isolation', () => {
    test('should use owner/repo path structure for codebases', () => {
      const workspacePath = '/workspace';
      const owner1 = 'alice';
      const owner2 = 'bob';
      const repo = 'utils';

      const path1 = `${workspacePath}/${owner1}/${repo}`;
      const path2 = `${workspacePath}/${owner2}/${repo}`;

      expect(path1).not.toBe(path2);
      expect(path1).toBe('/workspace/alice/utils');
      expect(path2).toBe('/workspace/bob/utils');
    });

    test('worktrees should be isolated by owner', () => {
      const aliceRepoPath = '/workspace/alice/utils';
      const bobRepoPath = '/workspace/bob/utils';
      const issueNumber = 33;

      const aliceWorktree = `${aliceRepoPath}/../worktrees/issue-${issueNumber}`;
      const bobWorktree = `${bobRepoPath}/../worktrees/issue-${issueNumber}`;

      expect(aliceWorktree).not.toBe(bobWorktree);
    });
  });

  describe('message splitting', () => {
    test('should split long messages into multiple chunks', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(2);

      expect(mockCreateComment).toHaveBeenNthCalledWith(1, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('aaa'),
      });

      expect(mockCreateComment).toHaveBeenNthCalledWith(2, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('bbb'),
      });

      const firstChunkBody = mockCreateComment.mock.calls[0][0].body as string;
      const secondChunkBody = mockCreateComment.mock.calls[1][0].body as string;
      expect(firstChunkBody.length).toBeLessThanOrEqual(65000);
      expect(secondChunkBody.length).toBeLessThanOrEqual(65000);
    });

    test('should not split message at exactly MAX_LENGTH', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      const message = 'a'.repeat(65000);
      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should handle message without paragraph breaks', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      const message = 'a'.repeat(50000);
      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should throw error when chunk posting fails', async () => {
      const mockCreateComment = mock()
        .mockResolvedValueOnce({ data: {} })
        .mockRejectedValueOnce(new Error('API rate limit exceeded'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await expect(testAdapter.sendMessage('owner/repo#123', message)).rejects.toThrow(
        /Failed to post comment chunk 2\/2/
      );

      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry logic', () => {
    test('should retry on transient network errors', async () => {
      const mockCreateComment = mock()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({ data: {} });
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment, {
        retryDelayMs: () => 1,
      });

      await testAdapter.sendMessage('owner/repo#123', 'test message');
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    test('should retry on transient status errors', async () => {
      const transientError = Object.assign(new Error('Gateway failure'), { status: 502 });
      const mockCreateComment = mock()
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ data: {} });
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment, {
        retryDelayMs: () => 1,
      });

      await testAdapter.sendMessage('owner/repo#123', 'test message');
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    test('should not retry on non-retryable errors', async () => {
      const mockCreateComment = mock().mockRejectedValue(new Error('Bad credentials'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'Bad credentials'
      );
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should retry once on 401 token expiration and not continue looping', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const mockCreateComment = mock().mockRejectedValue(authError);
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'Unauthorized'
      );
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    test('should throw after exhausting retries', async () => {
      const mockCreateComment = mock().mockRejectedValue(new Error('fetch failed'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment, {
        retryDelayMs: () => 1,
      });

      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'fetch failed'
      );
      expect(mockCreateComment).toHaveBeenCalledTimes(3);
    });
  });

  describe('fork detection logic', () => {
    test('should detect same-repo PR when head and base repos match', () => {
      const headRepoFullName = 'owner/repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(false);
    });

    test('should detect fork PR when head and base repos differ', () => {
      const headRepoFullName = 'contributor/repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(true);
    });

    test('should detect fork PR when head.repo is null (deleted fork)', () => {
      const headRepoFullName: string | undefined = undefined;
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(true);
    });

    test('should handle case sensitivity correctly', () => {
      const headRepoFullName = 'Owner/Repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(true);
    });
  });

  describe('fetchCommentHistory', () => {
    function createAdapterWithListComments(
      mockListComments: ReturnType<typeof mock>
    ): GitHubAdapter {
      const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
        getUserToken: async () => 'fake-token-for-testing',
      });
      // @ts-expect-error - accessing private property for testing
      testAdapter.actorByConversation.set('owner/repo#123', 'user-test-uuid');
      // @ts-expect-error - accessing private property for testing
      testAdapter.userOctokitCache.set('user-test-uuid', {
        octokit: { rest: { issues: { listComments: mockListComments } } } as unknown as Octokit,
        expiresAt: Date.now() + 1000 * 60 * 60,
      });
      return testAdapter;
    }

    async function callFetchCommentHistory(targetAdapter: GitHubAdapter): Promise<string[]> {
      // @ts-expect-error - calling private method for testing
      return targetAdapter.fetchCommentHistory('owner', 'repo', 123);
    }

    test('should fetch and format comment history', async () => {
      const mockListComments = mock(() =>
        Promise.resolve({
          data: [
            { user: { login: 'user3' }, body: 'Third comment' },
            { user: { login: 'user2' }, body: 'Second comment' },
            { user: { login: 'user1' }, body: 'First comment' },
          ],
        })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(mockListComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        per_page: 20,
        sort: 'created',
        direction: 'desc',
      });

      expect(history).toEqual([
        'user1: First comment',
        'user2: Second comment',
        'user3: Third comment',
      ]);
    });

    test('should preserve full comment content without truncation', async () => {
      const longBody = 'a'.repeat(5000);
      const mockListComments = mock(() =>
        Promise.resolve({ data: [{ user: { login: 'user1' }, body: longBody }] })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toHaveLength(1);
      expect(history[0]).toBe(`user1: ${longBody}`);
      expect(history[0]).toHaveLength(5007);
    });

    test('should handle comments without user or body (null and undefined)', async () => {
      const mockListComments = mock(() =>
        Promise.resolve({
          data: [
            { user: null, body: 'Comment without user' },
            { user: { login: 'user1' }, body: null },
            { user: { login: 'user2' } },
          ],
        })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toEqual(['user2: ', 'user1: ', 'unknown: Comment without user']);
    });

    test('should return empty array on API error', async () => {
      const mockListComments = mock(() => Promise.reject(new Error('API rate limit exceeded')));

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toEqual([]);
    });

    test('should handle empty comment list', async () => {
      const mockListComments = mock(() => Promise.resolve({ data: [] }));

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      expect(history).toEqual([]);
    });
  });

  describe('ensureRepoReady', () => {
    let testAdapter: GitHubAdapter;

    beforeEach(() => {
      testAdapter = new GitHubAdapter('fake-secret', mockLockManager, 'Archon', {
        getUserToken: async () => 'user-token-123',
      });
      mockCloneRepository.mockClear();
      mockSyncRepository.mockClear();
      mockAddSafeDirectory.mockClear();
      mockLogger.error.mockClear();
      mockLogger.info.mockClear();
      installCredentialHelperSpy.mockClear();
    });

    function callEnsureRepoReady(
      owner: string,
      repo: string,
      defaultBranch: string,
      repoPath: string,
      shouldSync: boolean,
      archonUserId?: string
    ): Promise<void> {
      // @ts-expect-error - accessing private method for testing
      return testAdapter.ensureRepoReady(
        owner,
        repo,
        defaultBranch,
        repoPath,
        shouldSync,
        archonUserId
      );
    }

    test('fails closed when no user context is provided', async () => {
      await expect(
        callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false)
      ).rejects.toThrow('ensureRepoReady: no user context for owner/repo');
    });

    test('clones repository when directory does not exist and user context is provided', async () => {
      mockCloneRepository.mockResolvedValue({ ok: true, value: undefined });

      await callEnsureRepoReady(
        'owner',
        'repo',
        'main',
        '/nonexistent/path',
        false,
        'user-test-uuid'
      );

      expect(mockCloneRepository).toHaveBeenCalledTimes(1);
      const [url, path, options] = mockCloneRepository.mock.calls[0];
      expect(url).toBe('https://github.com/owner/repo.git');
      expect(path).toBe('/nonexistent/path');
      expect(options).toEqual({ token: 'user-token-123' });
      expect(mockAddSafeDirectory).toHaveBeenCalledWith('/nonexistent/path');
      expect(installCredentialHelperSpy).toHaveBeenCalledWith('/nonexistent/path');
    });

    test('syncs repository when directory exists and shouldSync is true', async () => {
      const { mkdtemp, rm } = await import('fs/promises');
      const { tmpdir: osTmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${osTmpdir()}/github-test-`);

      mockSyncRepository.mockResolvedValue({ ok: true, value: undefined });

      try {
        await callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true, 'user-test-uuid');

        expect(mockSyncRepository).toHaveBeenCalledWith(tmpDir, 'main');
        expect(mockCloneRepository).not.toHaveBeenCalled();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('skips sync when shouldSync is false and directory exists', async () => {
      const { mkdtemp, rm } = await import('fs/promises');
      const { tmpdir: osTmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${osTmpdir()}/github-test-`);

      try {
        await callEnsureRepoReady('owner', 'repo', 'main', tmpDir, false, 'user-test-uuid');

        expect(mockSyncRepository).not.toHaveBeenCalled();
        expect(mockCloneRepository).not.toHaveBeenCalled();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('throws user-friendly error for not_a_repo clone error', async () => {
      mockCloneRepository.mockResolvedValue({
        ok: false,
        error: { code: 'not_a_repo', path: 'https://github.com/owner/repo.git' },
      });

      await expect(
        callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false, 'user-test-uuid')
      ).rejects.toThrow('not found or is private');
    });

    test('throws user-friendly error for permission_denied clone error', async () => {
      mockCloneRepository.mockResolvedValue({
        ok: false,
        error: { code: 'permission_denied', path: 'https://github.com/owner/repo.git' },
      });

      await expect(
        callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false, 'user-test-uuid')
      ).rejects.toThrow('Authentication failed');
    });

    test('throws user-friendly error for sync branch_not_found', async () => {
      const { mkdtemp, rm } = await import('fs/promises');
      const { tmpdir: osTmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${osTmpdir()}/github-test-`);

      mockSyncRepository.mockResolvedValue({
        ok: false,
        error: { code: 'branch_not_found', branch: 'main' },
      });

      try {
        await expect(
          callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true, 'user-test-uuid')
        ).rejects.toThrow("Branch 'main' not found");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('throws for unknown sync error with message', async () => {
      const { mkdtemp, rm } = await import('fs/promises');
      const { tmpdir: osTmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${osTmpdir()}/github-test-`);

      mockSyncRepository.mockResolvedValue({
        ok: false,
        error: { code: 'unknown', message: 'Network timeout' },
      });

      try {
        await expect(
          callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true, 'user-test-uuid')
        ).rejects.toThrow('Network timeout');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('OAuth App mode & per-user token delegation', () => {
    beforeEach(() => {
      mockGetOrCreateConversation.mockClear();
    });
    test('fails closed when no user token is available for sendMessage', async () => {
      const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
        getUserToken: async () => undefined,
      });
      await expect(testAdapter.sendMessage('owner/repo#1', 'hello')).rejects.toThrow(
        /no user token available/
      );
    });

    test('delegates sendMessage to user-scoped Octokit when token is available', async () => {
      const mockCreateComment = mock(async () => ({ data: { id: 1 } }));
      const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
        getUserToken: async () => 'user-personal-token',
      });
      // @ts-expect-error - set actor
      testAdapter.actorByConversation.set('owner/repo#1', 'user-1');
      // @ts-expect-error - set cached octokit
      testAdapter.userOctokitCache.set('user-1', {
        octokit: { rest: { issues: { createComment: mockCreateComment } } } as unknown as Octokit,
        expiresAt: Date.now() + 100000,
      });

      await testAdapter.sendMessage('owner/repo#1', 'hello');
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('401 from user Octokit evicts userOctokitCache and retries once with fresh token', async () => {
      const mockCreateComment = mock(async () => ({ data: { id: 1 } }));
      let tokenCallCount = 0;
      const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
        getUserToken: async () => {
          tokenCallCount++;
          return `token-v${String(tokenCallCount)}`;
        },
      });
      // @ts-expect-error - set actor
      testAdapter.actorByConversation.set('owner/repo#1', 'user-1');

      const err401 = Object.assign(new Error('Unauthorized'), { status: 401 });
      const staleOctokit = {
        rest: {
          issues: {
            createComment: mock().mockRejectedValueOnce(err401),
          },
        },
      } as unknown as Octokit;

      // Prime stale cache
      // @ts-expect-error - set cache
      testAdapter.userOctokitCache.set('user-1', {
        octokit: staleOctokit,
        expiresAt: Date.now() + 100000,
      });

      // sendMessage should catch 401, evict cache, fetch fresh token, and retry
      // We can intercept getUserOctokit or let it build a new Octokit that posts
      let createdFresh = false;
      const originalGetUserOctokit = (
        testAdapter as unknown as { getUserOctokit: (id: string) => Promise<Octokit | null> }
      ).getUserOctokit;
      (
        testAdapter as unknown as { getUserOctokit: (id: string) => Promise<Octokit | null> }
      ).getUserOctokit = async function (id: string) {
        if (!createdFresh) {
          createdFresh = true;
          return staleOctokit;
        }
        return { rest: { issues: { createComment: mockCreateComment } } } as unknown as Octokit;
      };

      await testAdapter.sendMessage('owner/repo#1', 'retry message');
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('second consecutive 401 propagates without infinite retry', async () => {
      const err401 = Object.assign(new Error('Unauthorized'), { status: 401 });
      const mockFailingComment = mock().mockRejectedValue(err401);
      const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'Archon', {
        getUserToken: async () => 'user-token',
      });
      // @ts-expect-error - set actor
      testAdapter.actorByConversation.set('owner/repo#1', 'user-1');
      // @ts-expect-error - set octokit
      testAdapter.userOctokitCache.set('user-1', {
        octokit: { rest: { issues: { createComment: mockFailingComment } } } as unknown as Octokit,
        expiresAt: Date.now() + 100000,
      });

      (
        testAdapter as unknown as { getUserOctokit: (id: string) => Promise<Octokit | null> }
      ).getUserOctokit = async function () {
        return { rest: { issues: { createComment: mockFailingComment } } } as unknown as Octokit;
      };

      await expect(testAdapter.sendMessage('owner/repo#1', 'failing message')).rejects.toThrow(
        'Unauthorized'
      );
      expect(mockFailingComment.mock.calls.length).toBe(2);
    });

    test('self-filter ignores comments authored by botLogin (case-insensitive)', async () => {
      const testAdapter = new GitHubAdapter('fake-webhook-secret', mockLockManager, 'archon-bot', {
        getUserToken: async () => 'fake-token',
      });
      // @ts-expect-error - mock verifySignature
      testAdapter.verifySignature = mock(() => true);

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
          id: 999,
          body: '@archon-bot ping',
          updated_at: '2026-06-12T21:00:00Z',
          user: { id: 99, login: 'ARCHON-BOT' },
        },
        repository: {
          owner: { login: 'o' },
          name: 'r',
          full_name: 'o/r',
          html_url: 'https://github.com/o/r',
          default_branch: 'main',
        },
        sender: { id: 99, login: 'ARCHON-BOT' },
      });

      await testAdapter.handleWebhook(payload, 'mock-signature');
      expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    });
  });
});
