/**
 * Unit tests for GitHub adapter
 *
 * Note: Database modules are mocked to prevent self-filtering tests from
 * writing phantom records (e.g., testuser/testrepo) to the real SQLite DB.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

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

// Mock @archon/git for ensureRepoReady integration tests
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
  toBranchName: (n: string) => n,
  toWorktreePath: (p: string) => p,
}));

import { GitHubAdapter } from './adapter';
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

/**
 * Helper to create a test adapter with mocked Octokit createComment method.
 * Reduces duplication across tests that need to verify comment posting behavior.
 */
async function createTestAdapterWithMockedOctokit(
  mockCreateComment: ReturnType<typeof mock>,
  options?: { retryDelayMs?: (attempt: number) => number }
): Promise<GitHubAdapter> {
  const testAdapter = new GitHubAdapter(
    'fake-token-for-testing',
    'fake-webhook-secret',
    mockLockManager,
    undefined,
    options
  );
  await testAdapter.start();
  // @ts-expect-error - accessing private property for testing
  testAdapter.octokit = {
    rest: {
      issues: {
        createComment: mockCreateComment,
      },
    },
  };
  return testAdapter;
}

describe('GitHubAdapter', () => {
  let adapter: GitHubAdapter;

  beforeEach(() => {
    mockExecFile.mockClear();
    adapter = new GitHubAdapter('fake-token-for-testing', 'fake-webhook-secret', mockLockManager);
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
      const adapterWithMention = new GitHubAdapter('token', 'secret', mockLockManager, 'Dylan');
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
      const adapterWithMention = new GitHubAdapter('token', 'secret', mockLockManager, 'Archon');
      const hasMention = (
        adapterWithMention as unknown as { hasMention: (text: string) => boolean }
      ).hasMention;

      expect(hasMention.call(adapterWithMention, '@Archon')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@ARCHON')).toBe(true);
      expect(hasMention.call(adapterWithMention, '@archon')).toBe(true);
    });

    test('should strip mention case-insensitively', () => {
      const adapterWithMention = new GitHubAdapter('token', 'secret', mockLockManager, 'Dylan');
      const stripMention = (
        adapterWithMention as unknown as { stripMention: (text: string) => string }
      ).stripMention;

      expect(stripMention.call(adapterWithMention, '@Dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@dylan please help')).toBe('please help');
      expect(stripMention.call(adapterWithMention, '@DYLAN please help')).toBe('please help');
    });
  });

  describe('self-filtering', () => {
    // Test context for self-filtering tests
    let originalAllowedUsers: string | undefined;

    /**
     * Creates an adapter with mocked signature verification for self-filtering tests.
     */
    function createSelfFilterAdapter(botMention = 'archon'): GitHubAdapter {
      const adapter = new GitHubAdapter(
        'fake-token-for-testing',
        'fake-webhook-secret',
        mockLockManager,
        botMention
      );
      // @ts-expect-error - accessing private method for testing
      adapter.verifySignature = mock(() => true);
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
      mockLockManager.acquireLock.mockClear();
      mockGetOrCreateConversation.mockClear();
      mockFindCodebaseByRepoUrl.mockClear();
      mockCreateCodebase.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITHUB_ALLOWED_USERS = originalAllowedUsers;
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

      // handleWebhook progresses past self-filtering into DB/Octokit operations
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - Octokit API not mocked for this test
      }

      // Real user comments proceed to conversation creation (not self-filtered)
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
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

      // handleWebhook progresses past self-filtering into DB/Octokit operations
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - Octokit API not mocked for this test
      }

      // Comment without marker proceeds to conversation creation (not self-filtered)
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
    });

    test('should handle missing comment.user gracefully', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon help', undefined); // No user field

      // Should not crash on undefined user
      try {
        await adapter.handleWebhook(payload, 'mock-signature');
      } catch {
        // Expected - Octokit API not mocked for this test
      }

      // Missing user should not trigger self-filtering (proceeds to conversation creation)
      expect(mockGetOrCreateConversation).toHaveBeenCalled();
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

      // Invalid format (pr-42 is not a number) should return early without calling API
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

  describe('message splitting', () => {
    test('should split long messages into multiple chunks', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Create message exceeding MAX_LENGTH (65000)
      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await testAdapter.sendMessage('owner/repo#123', message);

      // Should have sent 2 separate comments
      expect(mockCreateComment).toHaveBeenCalledTimes(2);

      // First chunk should contain paragraph1
      expect(mockCreateComment).toHaveBeenNthCalledWith(1, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('aaa'),
      });

      // Second chunk should contain paragraph2
      expect(mockCreateComment).toHaveBeenNthCalledWith(2, {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('bbb'),
      });

      // Verify chunk sizes are within limits
      const firstChunkBody = mockCreateComment.mock.calls[0][0].body as string;
      const secondChunkBody = mockCreateComment.mock.calls[1][0].body as string;
      expect(firstChunkBody.length).toBeLessThanOrEqual(65000);
      expect(secondChunkBody.length).toBeLessThanOrEqual(65000);
    });

    test('should not split message at exactly MAX_LENGTH', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Message exactly at MAX_LENGTH (65000) should not be split
      const message = 'a'.repeat(65000);
      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should handle message without paragraph breaks', async () => {
      const mockCreateComment = mock(() => Promise.resolve({ data: {} }));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Message under MAX_LENGTH with no paragraph breaks
      const message = 'a'.repeat(50000);
      await testAdapter.sendMessage('owner/repo#123', message);

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should throw error when chunk posting fails', async () => {
      const mockCreateComment = mock()
        .mockResolvedValueOnce({ data: {} }) // First chunk succeeds
        .mockRejectedValueOnce(new Error('API rate limit exceeded')); // Second chunk fails
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Create message that will be split into 2 chunks
      const paragraph1 = 'a'.repeat(40000);
      const paragraph2 = 'b'.repeat(30000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      // Should throw with context about partial delivery
      await expect(testAdapter.sendMessage('owner/repo#123', message)).rejects.toThrow(
        /Failed to post comment chunk 2\/2/
      );

      // First chunk should have been posted
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry logic', () => {
    test('should retry on transient network errors', async () => {
      const mockCreateComment = mock()
        .mockRejectedValueOnce(new Error('fetch failed')) // First attempt fails
        .mockResolvedValueOnce({ data: {} }); // Second attempt succeeds
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment, {
        retryDelayMs: () => 1,
      });

      await testAdapter.sendMessage('owner/repo#123', 'test message');

      // Should have retried once
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    test('should retry on transient status errors', async () => {
      const transientError = Object.assign(new Error('Gateway failure'), { status: 502 });
      const mockCreateComment = mock()
        .mockRejectedValueOnce(transientError) // First attempt fails
        .mockResolvedValueOnce({ data: {} }); // Second attempt succeeds
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment, {
        retryDelayMs: () => 1,
      });

      await testAdapter.sendMessage('owner/repo#123', 'test message');

      // Should have retried once for structured 502 status
      expect(mockCreateComment).toHaveBeenCalledTimes(2);
    });

    test('should not retry on non-retryable errors', async () => {
      const mockCreateComment = mock().mockRejectedValue(new Error('Bad credentials'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Should throw immediately without retry
      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'Bad credentials'
      );

      // Should only have tried once (no retry for auth errors)
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should not retry on auth status errors', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const mockCreateComment = mock().mockRejectedValue(authError);
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment);

      // Should throw immediately without retry
      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'Unauthorized'
      );

      // Should only have tried once (no retry for auth errors)
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    test('should throw after exhausting retries', async () => {
      const mockCreateComment = mock().mockRejectedValue(new Error('fetch failed'));
      const testAdapter = await createTestAdapterWithMockedOctokit(mockCreateComment, {
        retryDelayMs: () => 1,
      });

      // Should throw after 3 attempts
      await expect(testAdapter.sendMessage('owner/repo#123', 'test message')).rejects.toThrow(
        'fetch failed'
      );

      // Should have tried 3 times (max retries)
      expect(mockCreateComment).toHaveBeenCalledTimes(3);
    });
  });

  describe('fork detection logic', () => {
    /**
     * Tests for the fork detection comparison logic used in handleWebhook.
     * The actual logic: isForkPR = headRepoFullName !== baseRepoFullName
     * This logic determines whether a PR uses the actual branch (same-repo)
     * or a synthetic pr-N-review branch (fork).
     */

    test('should detect same-repo PR when head and base repos match', () => {
      // Simulates same-repo PR where contributor has push access
      const headRepoFullName = 'owner/repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(false);
    });

    test('should detect fork PR when head and base repos differ', () => {
      // Simulates fork PR where head is from a different repo
      const headRepoFullName = 'contributor/repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      expect(isForkPR).toBe(true);
    });

    test('should detect fork PR when head.repo is null (deleted fork)', () => {
      // When a fork is deleted after a PR was opened, head.repo becomes null
      // The optional chaining (?.) returns undefined, and undefined !== 'owner/repo' is true
      const headRepoFullName: string | undefined = undefined; // Simulates prData.head.repo?.full_name
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      // Correctly treated as fork - can't push to deleted repo anyway
      expect(isForkPR).toBe(true);
    });

    test('should handle case sensitivity correctly', () => {
      // GitHub full_names are case-sensitive in the API response
      const headRepoFullName = 'Owner/Repo';
      const baseRepoFullName = 'owner/repo';
      const isForkPR = headRepoFullName !== baseRepoFullName;

      // Different casing = different repos (fork detection)
      expect(isForkPR).toBe(true);
    });
  });

  describe('fetchCommentHistory', () => {
    /**
     * Helper to create adapter with mocked listComments for fetchCommentHistory tests.
     */
    function createAdapterWithListComments(
      mockListComments: ReturnType<typeof mock>
    ): GitHubAdapter {
      const testAdapter = new GitHubAdapter(
        'fake-token-for-testing',
        'fake-webhook-secret',
        mockLockManager
      );
      // @ts-expect-error - accessing private property for testing
      testAdapter.octokit = { rest: { issues: { listComments: mockListComments } } };
      return testAdapter;
    }

    /**
     * Helper to call the private fetchCommentHistory method.
     */
    async function callFetchCommentHistory(adapter: GitHubAdapter): Promise<string[]> {
      // @ts-expect-error - calling private method for testing
      return adapter.fetchCommentHistory('owner', 'repo', 123);
    }

    test('should fetch and format comment history', async () => {
      const mockListComments = mock(() =>
        Promise.resolve({
          data: [
            // API returns in desc order (newest first) because direction: 'desc'
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

      // Should return in chronological order (oldest first) after reverse
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
      expect(history[0]).toHaveLength(5007); // 'user1: ' (7 chars) + 5000 chars
    });

    test('should handle comments without user or body (null and undefined)', async () => {
      const mockListComments = mock(() =>
        Promise.resolve({
          data: [
            { user: null, body: 'Comment without user' },
            { user: { login: 'user1' }, body: null },
            { user: { login: 'user2' } }, // body property not present (undefined)
          ],
        })
      );

      const testAdapter = createAdapterWithListComments(mockListComments);
      const history = await callFetchCommentHistory(testAdapter);

      // Reversed from desc order, handles null user, null body, and undefined body
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
      testAdapter = new GitHubAdapter('fake-token', 'fake-secret', mockLockManager);
      mockCloneRepository.mockClear();
      mockSyncRepository.mockClear();
      mockAddSafeDirectory.mockClear();
      mockLogger.error.mockClear();
      mockLogger.info.mockClear();
    });

    // Helper to access private method
    function callEnsureRepoReady(
      owner: string,
      repo: string,
      defaultBranch: string,
      repoPath: string,
      shouldSync: boolean
    ): Promise<void> {
      // @ts-expect-error - accessing private method for testing
      return testAdapter.ensureRepoReady(owner, repo, defaultBranch, repoPath, shouldSync);
    }

    test('clones repository when directory does not exist', async () => {
      mockCloneRepository.mockResolvedValue({ ok: true, value: undefined });

      await callEnsureRepoReady('owner', 'repo', 'main', '/nonexistent/path', false);

      expect(mockCloneRepository).toHaveBeenCalledTimes(1);
      const [url, path] = mockCloneRepository.mock.calls[0];
      expect(url).toBe('https://github.com/owner/repo.git');
      expect(path).toBe('/nonexistent/path');
      // 3rd arg is { token } when GITHUB_TOKEN is set, undefined otherwise
      expect(mockAddSafeDirectory).toHaveBeenCalledWith('/nonexistent/path');
    });

    test('syncs repository when directory exists and shouldSync is true', async () => {
      // Use a real temporary directory so access() succeeds
      const { mkdtemp } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);

      mockSyncRepository.mockResolvedValue({ ok: true, value: undefined });

      try {
        await callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true);

        expect(mockSyncRepository).toHaveBeenCalledWith(tmpDir, 'main');
        expect(mockCloneRepository).not.toHaveBeenCalled();
      } finally {
        const { rm } = await import('fs/promises');
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('skips sync when shouldSync is false and directory exists', async () => {
      const { mkdtemp } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);

      try {
        await callEnsureRepoReady('owner', 'repo', 'main', tmpDir, false);

        expect(mockSyncRepository).not.toHaveBeenCalled();
        expect(mockCloneRepository).not.toHaveBeenCalled();
      } finally {
        const { rm } = await import('fs/promises');
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

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
      const { mkdtemp } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);

      mockSyncRepository.mockResolvedValue({
        ok: false,
        error: { code: 'branch_not_found', branch: 'main' },
      });

      try {
        await expect(callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true)).rejects.toThrow(
          "Branch 'main' not found"
        );
      } finally {
        const { rm } = await import('fs/promises');
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('throws for unknown sync error with message', async () => {
      const { mkdtemp } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const tmpDir = await mkdtemp(`${tmpdir()}/github-test-`);

      mockSyncRepository.mockResolvedValue({
        ok: false,
        error: { code: 'unknown', message: 'Network timeout' },
      });

      try {
        await expect(callEnsureRepoReady('owner', 'repo', 'main', tmpDir, true)).rejects.toThrow(
          'Network timeout'
        );
      } finally {
        const { rm } = await import('fs/promises');
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
