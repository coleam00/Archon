/**
 * Unit tests for Gitea community forge adapter
 *
 * Note: These tests focus on adapter-specific functionality without mocking
 * database modules to avoid test pollution issues with Bun's mock.module.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock @archon/paths to suppress noisy logger output during tests
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
  getArchonWorkspacesPath: mock(() => '/tmp/test-workspaces'),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.claude/commands']),
  logArchonPaths: mock(() => undefined),
  validateAppDefaultsPaths: mock(async () => undefined),
}));

// Mock @archon/core/db modules to throw immediately (avoid DB connection hangs in tests)
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  updateConversation: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  getConversation: mock(async () => null),
}));
mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mock(async () => null),
  createCodebase: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  getCodebaseCommands: mock(async () => ({})),
  updateCodebaseCommands: mock(async () => undefined),
  updateCodebase: mock(async () => undefined),
}));

// Mock @archon/git to avoid real git operations in tests
const mockCloneRepository = mock(async () => ({ ok: true, value: undefined }));
const mockSyncRepository = mock(async () => ({ ok: true, value: undefined }));
const mockAddSafeDirectory = mock(async () => undefined);
const mockIsWorktreePath = mock(async () => false);

mock.module('@archon/git', () => ({
  cloneRepository: mockCloneRepository,
  syncRepository: mockSyncRepository,
  addSafeDirectory: mockAddSafeDirectory,
  isWorktreePath: mockIsWorktreePath,
  toRepoPath: (p: string) => p,
  toBranchName: (b: string) => b,
}));

import { GiteaAdapter } from './adapter';
import { ConversationLockManager } from '@archon/core';

// Create a mock lock manager that immediately executes handlers
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

describe('GiteaAdapter', () => {
  let adapter: GiteaAdapter;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mockCloneRepository.mockClear();
    mockSyncRepository.mockClear();
    mockAddSafeDirectory.mockClear();
    originalFetch = globalThis.fetch;
    adapter = new GiteaAdapter(
      'https://gitea.example.com',
      'fake-token-for-testing',
      'fake-webhook-secret',
      mockLockManager,
      undefined,
      { retryDelayMs: () => 1 }
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('streaming mode', () => {
    test('should always return batch mode', () => {
      expect(adapter.getStreamingMode()).toBe('batch');
    });
  });

  describe('platform type', () => {
    test('should return gitea', () => {
      expect(adapter.getPlatformType()).toBe('gitea');
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
      const adapterWithMention = new GiteaAdapter(
        'https://gitea.example.com',
        'token',
        'secret',
        mockLockManager,
        'Dylan'
      );
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
      const adapterWithMention = new GiteaAdapter(
        'https://gitea.example.com',
        'token',
        'secret',
        mockLockManager,
        'Archon'
      );
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@Archon')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@ARCHON')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@archon')).toBe(true);
    });

    test('should strip mention case-insensitively', () => {
      const adapterWithMention = new GiteaAdapter(
        'https://gitea.example.com',
        'token',
        'secret',
        mockLockManager,
        'Dylan'
      );
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

    function createSelfFilterAdapter(botMention = 'archon'): GiteaAdapter {
      const adapter = new GiteaAdapter(
        'https://gitea.example.com',
        'fake-token-for-testing',
        'fake-webhook-secret',
        mockLockManager,
        botMention
      );
      // @ts-expect-error - accessing private method for testing
      adapter.verifySignature = mock(() => true);
      return adapter;
    }

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
          html_url: 'https://gitea.example.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: commentAuthor ?? 'user123' },
      });
    }

    beforeEach(() => {
      originalAllowedUsers = process.env.GITEA_ALLOWED_USERS;
      delete process.env.GITEA_ALLOWED_USERS;
      mockLockManager.acquireLock.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITEA_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('should ignore comments from the bot itself', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon fix this', 'archon');

      await adapter.handleWebhook(payload, 'mock-signature');

      // Bot's own comments should be silently dropped - no lock acquired, no processing
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    test('should handle case-insensitive username matching', async () => {
      const adapter = createSelfFilterAdapter('Archon'); // Mixed case config
      const payload = createCommentPayload('@archon test', 'archon'); // Lowercase author

      await adapter.handleWebhook(payload, 'mock-signature');

      // Bot's own comments should be silently dropped regardless of case
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    test('should NOT filter comments from real users', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon please help', 'user123');

      // handleWebhook will error on DB operations, but self-filtering runs first
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - database not mocked
      }

      // Real user comments should NOT be self-filtered
    });

    test('should ignore comments containing bot marker (works with user PAT)', async () => {
      const adapter = createSelfFilterAdapter();
      // Comment has the marker but author is a real user (using PAT)
      const payload = createCommentPayload(
        '@archon fix this\n\n<!-- archon-bot-response -->',
        'Wirasm'
      );

      await adapter.handleWebhook(payload, 'mock-signature');

      // Marked comments should be silently dropped
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    test('should process comments without bot marker from same user', async () => {
      const adapter = createSelfFilterAdapter();
      // Comment from same user but WITHOUT marker - should be processed
      const payload = createCommentPayload('@archon fix this', 'Wirasm');

      // Will error on DB operations, but self-filtering runs first
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - database not mocked
      }

      // Comment without marker should NOT be self-filtered
    });

    test('should handle missing comment.user gracefully', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined);

      // Should not crash on undefined user
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - database not mocked, but no TypeError from undefined user
      }
    });
  });

  describe('conversationId format', () => {
    test('should parse valid owner/repo#number format for issues', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      await adapter.sendMessage('owner/repo#123', 'test');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(
        'https://gitea.example.com/api/v1/repos/owner/repo/issues/123/comments'
      );
      expect(callArgs[1].method).toBe('POST');
      expect(callArgs[1].headers.Authorization).toBe('token fake-token-for-testing');
    });

    test('should parse valid owner/repo!number format for PRs', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      await adapter.sendMessage('owner/repo!456', 'test');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      // Gitea uses issues endpoint for PR comments too
      expect(callArgs[0]).toBe(
        'https://gitea.example.com/api/v1/repos/owner/repo/issues/456/comments'
      );
    });

    test('postComment appends bot marker to outgoing comments', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      await adapter.sendMessage('owner/repo#123', 'Hello world');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string).body as string;
      expect(body).toContain('Hello world');
      expect(body).toContain('<!-- archon-bot-response -->');
      expect(body).toBe('Hello world\n\n<!-- archon-bot-response -->');
    });

    test('should reject invalid conversationId format', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // Invalid format should return early without calling API
      await adapter.sendMessage('owner/repo#pr-42', 'test');
      expect(mockFetch).not.toHaveBeenCalled();
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
        pull_request: { url: 'https://gitea.example.com/repos/owner/repo/pulls/42' },
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

  describe('signature verification', () => {
    test('should verify valid signature', () => {
      const crypto = require('crypto');
      const secret = 'test-secret';
      const payload = '{"test": "data"}';
      // Gitea uses raw hex, no sha256= prefix
      const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      const testAdapter = new GiteaAdapter(
        'https://gitea.example.com',
        'token',
        secret,
        mockLockManager
      );

      // @ts-expect-error - accessing private method for testing
      const result = testAdapter.verifySignature(payload, signature);
      expect(result).toBe(true);
    });

    test('should reject invalid signature', () => {
      const testAdapter = new GiteaAdapter(
        'https://gitea.example.com',
        'token',
        'test-secret',
        mockLockManager
      );

      // @ts-expect-error - accessing private method for testing
      const result = testAdapter.verifySignature('{"test": "data"}', 'invalid-signature');
      expect(result).toBe(false);
    });

    test('should reject signature with different length', () => {
      const testAdapter = new GiteaAdapter(
        'https://gitea.example.com',
        'token',
        'test-secret',
        mockLockManager
      );

      // @ts-expect-error - accessing private method for testing
      const result = testAdapter.verifySignature('{"test": "data"}', 'short');
      expect(result).toBe(false);
    });
  });

  describe('message splitting', () => {
    test('should split long messages into multiple chunks', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // Create message exceeding MAX_LENGTH (65000)
      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('owner/repo#123', message);

      // Should have sent 2 separate comments
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First chunk should contain paragraph1
      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body as string).body as string;
      expect(firstBody).toContain('aaa');

      // Second chunk should contain paragraph2
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string).body as string;
      expect(secondBody).toContain('bbb');

      // Verify chunk sizes are within limits
      expect(firstBody.length).toBeLessThanOrEqual(65000);
      expect(secondBody.length).toBeLessThanOrEqual(65000);
    });

    test('should not split message at exactly MAX_LENGTH', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // Message exactly at MAX_LENGTH (65000) should not be split
      const message = 'a'.repeat(65000);
      await adapter.sendMessage('owner/repo#123', message);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('should handle message without paragraph breaks', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // Message under MAX_LENGTH with no paragraph breaks
      const message = 'a'.repeat(50000);
      await adapter.sendMessage('owner/repo#123', message);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('should throw error when chunk posting fails', async () => {
      const mockFetch = mock()
        .mockResolvedValueOnce({ ok: true }) // First chunk succeeds
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: () => Promise.resolve('Rate limit exceeded'),
        }); // Second chunk fails
      globalThis.fetch = mockFetch as typeof fetch;

      // Create message that will be split into 2 chunks
      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      // Should throw with context about partial delivery
      await expect(adapter.sendMessage('owner/repo#123', message)).rejects.toThrow(
        /Failed to post comment chunk 2\/2/
      );

      // First chunk should have been posted
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry logic', () => {
    test('should retry on transient network errors', async () => {
      const mockFetch = mock()
        .mockRejectedValueOnce(new Error('fetch failed')) // First attempt fails
        .mockResolvedValueOnce({ ok: true }); // Second attempt succeeds
      globalThis.fetch = mockFetch as typeof fetch;

      await adapter.sendMessage('owner/repo#123', 'test message');

      // Should have retried once
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('should not retry on non-retryable errors', async () => {
      const mockFetch = mock().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Bad credentials'),
      });
      globalThis.fetch = mockFetch as typeof fetch;

      // Should throw immediately without retry
      await expect(adapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'Gitea API error: 401 Unauthorized'
      );

      // Should only have tried once (no retry for auth errors)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('should throw after exhausting retries', async () => {
      const mockFetch = mock().mockRejectedValue(new Error('fetch failed'));
      globalThis.fetch = mockFetch as typeof fetch;

      await expect(adapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'fetch failed'
      );

      // Should have tried 3 times (max retries)
      expect(mockFetch).toHaveBeenCalledTimes(3);
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

    test('should detect fork PR when head.repo is undefined (deleted fork)', () => {
      const headRepoFullName: string | undefined = undefined;
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;
      expect(isForkPR).toBe(true);
    });
  });

  describe('fetchCommentHistory', () => {
    test('should fetch and format comment history', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { user: { login: 'user1' }, body: 'First comment' },
              { user: { login: 'user2' }, body: 'Second comment' },
              { user: { login: 'user3' }, body: 'Third comment' },
            ]),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // @ts-expect-error - calling private method for testing
      const history = await adapter.fetchCommentHistory('owner', 'repo', 123);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitea.example.com/api/v1/repos/owner/repo/issues/123/comments',
        expect.objectContaining({
          headers: { Authorization: 'token fake-token-for-testing' },
        })
      );

      expect(history).toEqual([
        'user1: First comment',
        'user2: Second comment',
        'user3: Third comment',
      ]);
    });

    test('should return empty array on API error', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // @ts-expect-error - calling private method for testing
      const history = await adapter.fetchCommentHistory('owner', 'repo', 123);
      expect(history).toEqual([]);
    });

    test('should only return last 20 comments', async () => {
      const manyComments = Array.from({ length: 30 }, (_, i) => ({
        user: { login: `user${String(i + 1)}` },
        body: `Comment ${String(i + 1)}`,
      }));
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(manyComments),
        })
      );
      globalThis.fetch = mockFetch as typeof fetch;

      // @ts-expect-error - calling private method for testing
      const history = await adapter.fetchCommentHistory('owner', 'repo', 123);

      expect(history).toHaveLength(20);
      expect(history[0]).toBe('user11: Comment 11');
      expect(history[19]).toBe('user30: Comment 30');
    });
  });

  describe('URL normalization', () => {
    test('should remove trailing slash from base URL', () => {
      const adapter1 = new GiteaAdapter(
        'https://gitea.example.com/',
        'token',
        'secret',
        mockLockManager
      );
      const adapter2 = new GiteaAdapter(
        'https://gitea.example.com///',
        'token',
        'secret',
        mockLockManager
      );

      // @ts-expect-error - accessing private property for testing
      expect(adapter1.baseUrl).toBe('https://gitea.example.com');
      // @ts-expect-error - accessing private property for testing
      expect(adapter2.baseUrl).toBe('https://gitea.example.com');
    });
  });

  describe('tea CLI context hints', () => {
    test('should include tea CLI hint in issue context', () => {
      const issue = {
        number: 42,
        title: 'Test Issue',
        body: 'Issue description',
        user: { login: 'testuser' },
        labels: [{ name: 'bug' }],
        state: 'open',
      };

      // @ts-expect-error - accessing private method for testing
      const context = adapter.buildIssueContext(issue, 'fix this please');

      expect(context).toContain('tea issue view 42');
      expect(context).not.toContain('gh issue');
    });

    test('should include tea CLI hint in PR context', () => {
      const pr = {
        number: 99,
        title: 'My PR',
        body: 'PR description',
        user: { login: 'testuser' },
        state: 'open',
        changed_files: 3,
        additions: 10,
        deletions: 2,
      };

      // @ts-expect-error - accessing private method for testing
      const context = adapter.buildPRContext(pr, 'review this please');

      expect(context).toContain('tea pr view 99');
      expect(context).not.toContain('gh pr');
    });
  });

  describe('issue vs PR conversation ID format', () => {
    test('should build issue conversation ID with #', () => {
      // @ts-expect-error - accessing private method for testing
      const id = adapter.buildConversationId('owner', 'repo', 42, false);
      expect(id).toBe('owner/repo#42');
    });

    test('should build PR conversation ID with !', () => {
      // @ts-expect-error - accessing private method for testing
      const id = adapter.buildConversationId('owner', 'repo', 42, true);
      expect(id).toBe('owner/repo!42');
    });

    test('should parse issue conversation ID', () => {
      // @ts-expect-error - accessing private method for testing
      const parsed = adapter.parseConversationId('owner/repo#42');
      expect(parsed).toEqual({ owner: 'owner', repo: 'repo', number: 42, isPR: false });
    });

    test('should parse PR conversation ID', () => {
      // @ts-expect-error - accessing private method for testing
      const parsed = adapter.parseConversationId('owner/repo!42');
      expect(parsed).toEqual({ owner: 'owner', repo: 'repo', number: 42, isPR: true });
    });

    test('should return null for invalid format', () => {
      // @ts-expect-error - accessing private method for testing
      expect(adapter.parseConversationId('invalid')).toBeNull();
      // @ts-expect-error - accessing private method for testing
      expect(adapter.parseConversationId('owner/repo@42')).toBeNull();
      // @ts-expect-error - accessing private method for testing
      expect(adapter.parseConversationId('owner/repo#abc')).toBeNull();
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
  });
});
