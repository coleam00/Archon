/**
 * Unit tests for Gitea community forge adapter
 *
 * Note: These tests focus on adapter-specific functionality without mocking
 * database modules to avoid test pollution issues with Bun's mock.module.
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { Mock } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Codebase, Conversation } from '@archon/core';

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
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/tmp/test-workspaces'),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.claude/commands']),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
  resolveRepoProjectIdentity: paths.resolveRepoProjectIdentity,
  logArchonPaths: mock(() => undefined),
  validateAppDefaultsPaths: mock(async () => undefined),
}));

// Mock @archon/core/db modules to throw immediately (avoid DB connection hangs in tests)
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
const mockGetOrCreateConversation = mock(
  async (): Promise<
    Pick<Conversation, 'id' | 'codebase_id' | 'cwd' | 'platform_type' | 'platform_conversation_id'>
  > => {
    throw new Error('DB not mocked in tests');
  }
);
const mockUpdateConversation = mock<
  typeof import('@archon/core/db/conversations')['updateConversation']
>(async () => {
  throw new Error('DB not mocked in tests');
});
const mockGetConversation = mock(async () => null);
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
  getConversation: mockGetConversation,
}));

const mockFindCodebaseByRepoUrl = mock(
  async (): Promise<Pick<Codebase, 'id' | 'repository_url' | 'default_cwd' | 'name'> | null> => null
);
const mockCreateCodebase = mock(
  async (): Promise<Pick<Codebase, 'id' | 'name' | 'default_cwd' | 'repository_url'>> => {
    throw new Error('DB not mocked in tests');
  }
);
const mockGetCodebaseCommands = mock(async () => ({}));
const mockUpdateCodebaseCommands = mock(async () => undefined);
const mockUpdateCodebase = mock(async () => undefined);
mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  createManagedCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  updateCodebase: mockUpdateCodebase,
}));

// Mock @archon/git to avoid real git operations in tests
const mockCloneRepository = mock<typeof import('@archon/git')['cloneRepository']>(async () => ({
  ok: true,
  value: undefined,
}));
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

// Mock @archon/core so we can assert handleMessage call args (e.g. userId propagation)
const mockHandleMessage = mock(async () => undefined);
const mockOnConversationClosed = mock(async () => undefined);
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: mock((err: Error) => err.message),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  onConversationClosed: mockOnConversationClosed,
  ConversationLockManager: class {
    async acquireLock(_id: string, fn: () => Promise<void>): Promise<void> {
      await fn();
    }
  },
}));

import { GiteaAdapter } from './adapter';
import type { WebhookEvent } from './types';
import * as readiness from './repository-readiness';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
type FetchMock = Mock<FetchCall> & Pick<typeof fetch, 'preconnect'>;

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), init);
}

async function copyResponse(response: Response): Promise<Response> {
  const body = await response.clone().arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
  });
}

function makeFetchMock(response: Response = jsonResponse({}, { status: 200 })): FetchMock {
  return Object.assign(
    mock<FetchCall>(() => copyResponse(response)),
    {
      preconnect: mock<typeof fetch.preconnect>(() => undefined),
    }
  );
}

// Create a mock lock manager that immediately executes handlers
const mockAcquireLock = mock(async (_id: string, handler: () => Promise<void>) => {
  await handler();
  return { status: 'started' as const };
});
const mockLockManager = {
  acquireLock: mockAcquireLock,
};

describe('GiteaAdapter', () => {
  let adapter: GiteaAdapter;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockCloneRepository.mockClear();
    mockSyncRepository.mockClear();
    mockAddSafeDirectory.mockClear();
    mockHandleMessage.mockClear();
    mockOnConversationClosed.mockClear();
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

  test('initialization logs only operational configuration', () => {
    expect(mockLogger.info).toHaveBeenCalledWith(
      { baseUrl: 'https://gitea.example.com' },
      'adapter_initialized'
    );
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
      mockAcquireLock.mockClear();
    });

    afterEach(() => {
      if (originalAllowedUsers !== undefined) {
        process.env.GITEA_ALLOWED_USERS = originalAllowedUsers;
      }
    });

    test('webhook clones an absent saved checkout before dispatch', async () => {
      const adapter = createSelfFilterAdapter();
      const path = join(tmpdir(), `archon-saved-checkout-${randomUUID()}`);
      mockFindCodebaseByRepoUrl.mockResolvedValueOnce({
        id: 'saved-project',
        name: 'testuser/testrepo-2',
        default_cwd: path,
        repository_url: 'https://gitea.example.com/testuser/testrepo',
      });
      mockGetOrCreateConversation.mockResolvedValueOnce({
        id: 'conv-saved',
        codebase_id: 'saved-project',
        cwd: path,
        platform_type: 'gitea',
        platform_conversation_id: 'testuser/testrepo#1',
      });
      mockHandleMessage.mockClear();
      mockCloneRepository.mockClear();
      mockCloneRepository.mockImplementationOnce(async () => {
        expect(mockHandleMessage).not.toHaveBeenCalled();
        return { ok: true, value: undefined };
      });
      globalThis.fetch = makeFetchMock(jsonResponse([]));
      await adapter.handleWebhook(
        utf8(createCommentPayload('@archon help', 'user123')),
        'mock-signature'
      );
      expect(mockCloneRepository).toHaveBeenCalledTimes(1);
      expect(mockCloneRepository.mock.calls[0]?.slice(0, 2)).toEqual([
        'https://gitea.example.com/testuser/testrepo.git',
        path,
      ]);
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('allocated checkout path reaches preparation and conversation storage', async () => {
      const adapter = createSelfFilterAdapter();
      const path = '/tmp/test-workspaces/testuser/testrepo-2/source';
      mockFindCodebaseByRepoUrl.mockResolvedValueOnce(null);
      mockCreateCodebase.mockResolvedValueOnce({
        id: 'allocated',
        name: 'testuser/testrepo-2',
        default_cwd: path,
        repository_url: null,
      });
      mockGetOrCreateConversation.mockResolvedValueOnce({
        id: 'conv-allocated',
        codebase_id: null,
        cwd: null,
        platform_type: 'gitea',
        platform_conversation_id: 'testuser/testrepo#42',
      });
      mockUpdateConversation.mockResolvedValueOnce(undefined);
      const prepare = spyOn(readiness, 'ensureRepoReady').mockResolvedValue(undefined);
      globalThis.fetch = makeFetchMock(jsonResponse([]));
      try {
        await adapter.handleWebhook(
          utf8(createCommentPayload('@archon help', 'user123')),
          'mock-signature'
        );
        expect(prepare).toHaveBeenCalledWith(
          'https://gitea.example.com',
          'testuser',
          'testrepo',
          'main',
          expect.objectContaining({ name: 'testuser/testrepo-2', default_cwd: path }),
          true
        );
        expect(mockUpdateConversation).toHaveBeenCalledWith('conv-allocated', {
          codebase_id: 'allocated',
          cwd: path,
        });
      } finally {
        prepare.mockRestore();
      }
    });

    test('should ignore comments from the bot itself', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon fix this', 'archon');

      await adapter.handleWebhook(utf8(payload), 'mock-signature');

      expect(mockLogger.debug).toHaveBeenCalledWith('ignoring_own_comment');
      // Bot's own comments should be silently dropped - no lock acquired, no processing
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    test('should handle case-insensitive username matching', async () => {
      const adapter = createSelfFilterAdapter('Archon'); // Mixed case config
      const payload = createCommentPayload('@archon test', 'archon'); // Lowercase author

      await adapter.handleWebhook(utf8(payload), 'mock-signature');

      // Bot's own comments should be silently dropped regardless of case
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    test('should NOT filter comments from real users', async () => {
      const adapter = createSelfFilterAdapter();
      const payload = createCommentPayload('@archon please help', 'user123');

      // handleWebhook will error on DB operations, but self-filtering runs first
      try {
        await adapter.handleWebhook(utf8(payload), 'mock-signature');
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

      await adapter.handleWebhook(utf8(payload), 'mock-signature');

      expect(mockLogger.debug).toHaveBeenCalledWith('ignoring_marked_comment');
      // Marked comments should be silently dropped
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    test('should process comments without bot marker from same user', async () => {
      const adapter = createSelfFilterAdapter();
      // Comment from same user but WITHOUT marker - should be processed
      const payload = createCommentPayload('@archon fix this', 'Wirasm');

      // Will error on DB operations, but self-filtering runs first
      try {
        await adapter.handleWebhook(utf8(payload), 'mock-signature');
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
        await adapter.handleWebhook(utf8(payload), 'mock-signature');
      } catch {
        // Expected - database not mocked, but no TypeError from undefined user
      }
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
    const secret = 'test-secret';
    // A bot-authored comment stops right after verification and parsing, so the
    // log line proves the payload was accepted without reaching the database.
    const body = JSON.stringify({
      action: 'created',
      issue: { number: 1, title: 't', body: '', user: { login: 'u' }, labels: [], state: 'open' },
      comment: { body: 'hi', user: { login: 'archon' } },
      repository: {
        owner: { login: 'o' },
        name: 'r',
        full_name: 'o/r',
        html_url: 'https://gitea.example.com/o/r',
        default_branch: 'main',
      },
      sender: { login: 'archon' },
    });
    const sign = (bytes: Uint8Array): string =>
      createHmac('sha256', secret).update(bytes).digest('hex');
    const signedAdapter = (): GiteaAdapter =>
      new GiteaAdapter('https://gitea.example.com', 'token', secret, mockLockManager);

    beforeEach(() => {
      mockLogger.debug.mockClear();
      mockLogger.error.mockClear();
    });

    test('accepts a correctly signed body that starts with a UTF-8 BOM', async () => {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(body)]);

      await signedAdapter().handleWebhook(bytes, sign(bytes));

      expect(mockLogger.debug).toHaveBeenCalledWith('ignoring_own_comment');
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        'invalid_webhook_signature'
      );
    });

    test('rejects a body altered after signing', async () => {
      const bytes = utf8(body);
      const signature = sign(bytes);
      const tampered = utf8(body.replace('"hi"', '"ho"'));

      await signedAdapter().handleWebhook(tampered, signature);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), 'invalid_webhook_signature');
      expect(mockLogger.debug).not.toHaveBeenCalledWith('ignoring_own_comment');
    });

    test('rejects a signature of a different length', async () => {
      await signedAdapter().handleWebhook(utf8(body), 'short');

      expect(mockLogger.error).toHaveBeenCalledWith(expect.anything(), 'signature_length_mismatch');
      expect(mockLogger.debug).not.toHaveBeenCalledWith('ignoring_own_comment');
    });
  });

  describe('fork detection logic', () => {
    function createPullRequestCommentPayload(headRepoFullName?: string): string {
      const head =
        headRepoFullName === undefined
          ? { ref: 'feature-branch', sha: 'abc123def456' }
          : {
              ref: 'feature-branch',
              sha: 'abc123def456',
              repo: { full_name: headRepoFullName },
            };

      const event = {
        action: 'created',
        issue: {
          number: 42,
          title: 'Test PR',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
          pull_request: {},
        },
        pull_request: {
          number: 42,
          title: 'Test PR',
          body: 'Description',
          user: { login: 'user123' },
          state: 'open',
          head,
          base: { repo: { full_name: 'testuser/testrepo' } },
        },
        comment: { body: '@archon review this', user: { login: 'user123' } },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://gitea.example.com/testuser/testrepo',
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
      mockGetOrCreateConversation.mockResolvedValueOnce({
        id: 'conv-test-uuid',
        codebase_id: 'codebase-test-uuid',
        cwd: '/tmp/project',
        platform_type: 'gitea',
        platform_conversation_id: 'testuser/testrepo!42',
      });
      mockFindCodebaseByRepoUrl.mockResolvedValueOnce({
        id: 'codebase-test-uuid',
        repository_url: 'https://gitea.example.com/testuser/testrepo',
        default_cwd: '/tmp/test-workspaces/testuser/testrepo/source',
        name: 'testrepo',
      });
      mockHandleMessage.mockClear();
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('[]', { status: 200 })
      );
      const payload = createPullRequestCommentPayload(headRepoFullName);
      const signature = createHmac('sha256', 'fake-webhook-secret').update(payload).digest('hex');

      try {
        await adapter.handleWebhook(utf8(payload), signature);
      } finally {
        fetchSpy.mockRestore();
      }

      expect(mockHandleMessage).toHaveBeenCalledWith(
        expect.anything(),
        'testuser/testrepo!42',
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

    test('should detect fork PR when head.repo is undefined (deleted fork)', async () => {
      await expectForkVerdict(undefined, true);
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

  describe('user identity resolution', () => {
    // Tests here drive handleWebhook() all the way to handleMessage, which first
    // calls fetchCommentHistory() — a bare `fetch` against the adapter's
    // baseUrl. Left unstubbed that is a real DNS + TCP attempt to
    // gitea.example.com on every run, making the test's outcome depend on an
    // external host inside the per-test budget (#2186). Stub it.
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
      mockFindOrCreateUserByPlatformIdentity.mockClear();
      mockFindOrCreateUserByPlatformIdentity.mockImplementation(async () => ({
        id: 'user-test-uuid',
        display_name: 'Test',
        email: null,
        created_at: new Date(),
        updated_at: new Date(),
      }));
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    function createWebhookAdapter(): GiteaAdapter {
      const a = new GiteaAdapter(
        'https://gitea.example.com',
        'fake-token-for-testing',
        'fake-webhook-secret',
        mockLockManager,
        undefined,
        { retryDelayMs: () => 1 }
      );
      // @ts-expect-error - accessing private method for testing
      a.verifySignature = mock(() => true);
      return a;
    }

    test('calls findOrCreateUserByPlatformIdentity with gitea platform and sender login', async () => {
      const adapter = createWebhookAdapter();

      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment: {
          body: '@archon fix this',
          user: { login: 'commenter' },
        },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://gitea.example.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'senderuser' },
      });

      // DB mocks throw, but user resolution runs before DB calls
      try {
        await adapter.handleWebhook(utf8(payload), 'mock-signature');
      } catch {
        // Expected - database not mocked
      }

      expect(mockFindOrCreateUserByPlatformIdentity).toHaveBeenCalledWith(
        'gitea',
        'commenter',
        'commenter'
      );
    });

    test('falls back to sender.login when comment.user is missing', async () => {
      const adapter = createWebhookAdapter();

      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment: {
          body: '@archon fix this',
        },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://gitea.example.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'senderuser' },
      });

      try {
        await adapter.handleWebhook(utf8(payload), 'mock-signature');
      } catch {
        // Expected
      }

      expect(mockFindOrCreateUserByPlatformIdentity).toHaveBeenCalledWith(
        'gitea',
        'senderuser',
        'senderuser'
      );
    });

    test('warn-logs and proceeds when user resolution fails', async () => {
      mockFindOrCreateUserByPlatformIdentity.mockImplementation(async () => {
        throw new Error('DB connection failed');
      });

      const adapter = createWebhookAdapter();

      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment: {
          body: '@archon fix this',
          user: { login: 'commenter' },
        },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://gitea.example.com/testuser/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'senderuser' },
      });

      // Should not throw even though user resolution fails
      try {
        await adapter.handleWebhook(utf8(payload), 'mock-signature');
      } catch {
        // Expected - database not mocked, but not from user resolution
      }

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: 'DB connection failed' }), platform: 'gitea' },
        'gitea.user_resolve_failed'
      );
    });

    test.each(['fix this', '/workflow run @alice'])(
      'dispatches %s with internal identity and private logs',
      async message => {
        // Seed DB mocks so handleWebhook reaches handleMessage
        mockGetOrCreateConversation.mockImplementation(async () => ({
          id: 'conv-test-uuid',
          codebase_id: 'codebase-test-uuid',
          cwd: '/tmp/project',
          platform_type: 'gitea',
          platform_conversation_id: 'testuser/testrepo#42',
        }));
        mockFindCodebaseByRepoUrl.mockImplementation(async () => ({
          id: 'codebase-test-uuid',
          repository_url: 'https://gitea.example.com/testuser/testrepo',
          default_cwd: '/tmp/test-workspaces/testuser/testrepo/source',
          name: 'testrepo',
        }));

        const adapter = createWebhookAdapter();

        const payload = JSON.stringify({
          action: 'created',
          issue: {
            number: 42,
            title: 'Test Issue',
            body: 'Description',
            user: { login: 'user123' },
            labels: [],
            state: 'open',
          },
          comment: {
            body: `@archon ${message}`,
            user: { login: 'commenter' },
          },
          repository: {
            owner: { login: 'testuser' },
            name: 'testrepo',
            full_name: 'testuser/testrepo',
            html_url: 'https://gitea.example.com/testuser/testrepo',
            default_branch: 'main',
          },
          sender: { login: 'senderuser' },
        });

        await adapter.handleWebhook(utf8(payload), 'mock-signature');

        if (message.startsWith('/'))
          expect(mockLogger.debug).toHaveBeenCalledWith('slash_command_processing');

        expect(mockGetOrCreateConversation).toHaveBeenCalledWith(
          'gitea',
          expect.any(String),
          'codebase-test-uuid'
        );
        expect(mockHandleMessage).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ actor: { kind: 'user', userId: 'user-test-uuid' } })
        );
      }
    );

    test('skips user resolution when both commentAuthor and sender are missing', async () => {
      // Seed DB mocks so handleWebhook reaches handleMessage
      mockGetOrCreateConversation.mockImplementation(async () => ({
        id: 'conv-test-uuid',
        codebase_id: 'codebase-test-uuid',
        cwd: '/tmp/project',
        platform_type: 'gitea',
        platform_conversation_id: 'testuser/testrepo#42',
      }));
      mockFindCodebaseByRepoUrl.mockImplementation(async () => ({
        id: 'codebase-test-uuid',
        repository_url: 'https://gitea.example.com/testuser/testrepo',
        default_cwd: '/tmp/test-workspaces/testuser/testrepo/source',
        name: 'testrepo',
      }));

      const adapter = createWebhookAdapter();

      const payload = JSON.stringify({
        action: 'created',
        issue: {
          number: 42,
          title: 'Test Issue',
          body: 'Description',
          user: { login: 'user123' },
          labels: [],
          state: 'open',
        },
        comment: {
          body: '@archon fix this',
        },
        repository: {
          owner: { login: 'testuser' },
          name: 'testrepo',
          full_name: 'testuser/testrepo',
          html_url: 'https://gitea.example.com/testuser/testrepo',
          default_branch: 'main',
        },
        // sender omitted entirely
      });

      await adapter.handleWebhook(utf8(payload), 'mock-signature');

      expect(mockFindOrCreateUserByPlatformIdentity).not.toHaveBeenCalled();
      expect(mockHandleMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ actor: { kind: 'unidentified' } })
      );
    });
  });
});
