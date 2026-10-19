/**
 * Unit tests for GitLab community forge adapter
 *
 * Runs in its own test batch to avoid mock.module pollution with other adapters.
 */
import { describe, test, expect, mock, spyOn, beforeEach } from 'bun:test';
import type { Mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Codebase, Conversation } from '@archon/core';

type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
type FetchMock = Mock<FetchCall> & Pick<typeof fetch, 'preconnect'>;

async function copyResponse(response: Response): Promise<Response> {
  const body = await response.clone().arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
  });
}

function makeFetchMock(response: Response): FetchMock {
  return Object.assign(
    mock<FetchCall>(() => copyResponse(response)),
    {
      preconnect: mock<typeof fetch.preconnect>(() => undefined),
    }
  );
}

const paths = await import('@archon/paths');
const git = await import('@archon/git');

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
  ...paths,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/tmp/test-workspaces'),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.claude/commands']),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
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

// Mock @archon/core
const mockHandleMessage = mock(async () => undefined);
const mockOnConversationClosed = mock(async () => undefined);
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: mock((err: Error) => err.message),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  onConversationClosed: mockOnConversationClosed,
  ConversationNotFoundError: class extends Error {},
  ConversationLockManager: class {
    async acquireLock(_id: string, fn: () => Promise<void>): Promise<{ status: 'started' }> {
      await fn();
      return { status: 'started' };
    }
  },
}));

const mockCloneRepository = mock<typeof import('@archon/git')['cloneRepository']>(async () => ({
  ok: true,
  value: undefined,
}));

// Mock @archon/git
mock.module('@archon/git', () => ({
  ...git,
  cloneRepository: mockCloneRepository,
  syncRepository: mock(async () => ({ ok: true })),
  addSafeDirectory: mock(async () => undefined),
  toRepoPath: mock((p: string) => p),
  toBranchName: mock((b: string) => b),
  isWorktreePath: mock(async () => false),
  execFileAsync: mock(async () => ({ stdout: '', stderr: '' })),
}));

// Mock global fetch to prevent real HTTP calls (gitlab.example.com hangs on CI Linux)
const mockFetch = makeFetchMock(new Response(JSON.stringify({}), { status: 200 }));
globalThis.fetch = mockFetch;

// Now import the adapter (after all mocks)
const { GitLabAdapter } = await import('./adapter');
const readiness = await import('./repository-readiness');
const { ConversationLockManager } = await import('@archon/core');

// Helper: Create adapter with default test config
function createAdapter(options?: {
  token?: string;
  secret?: string;
  gitlabUrl?: string;
  botMention?: string;
}): InstanceType<typeof GitLabAdapter> {
  const lockManager = new ConversationLockManager();
  return new GitLabAdapter(
    options?.token ?? 'test-token',
    options?.secret ?? 'test-secret',
    lockManager,
    options?.gitlabUrl ?? 'https://gitlab.example.com',
    options?.botMention ?? 'archon'
  );
}

// Helper: Create a valid note webhook payload
function createNotePayload(overrides?: {
  note?: string;
  noteableType?: 'Issue' | 'MergeRequest';
  username?: string;
  projectPath?: string;
  iid?: number;
}): string {
  const noteableType = overrides?.noteableType ?? 'Issue';
  const iid = overrides?.iid ?? 1;

  const base: Record<string, unknown> = {
    object_kind: 'note',
    event_type: 'note',
    user: { username: overrides?.username ?? 'testuser', name: 'Test User' },
    project: {
      id: 1,
      path_with_namespace: overrides?.projectPath ?? 'mygroup/myproject',
      default_branch: 'main',
      web_url: 'https://gitlab.example.com/mygroup/myproject',
      http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
    },
    object_attributes: {
      noteable_type: noteableType,
      note: overrides?.note ?? '@archon hello',
      noteable_id: 100,
    },
  };

  if (noteableType === 'Issue') {
    base.issue = {
      iid,
      title: 'Test Issue',
      description: 'Test description',
      state: 'opened',
      labels: [{ title: 'bug' }],
    };
  } else {
    base.merge_request = {
      iid,
      title: 'Test MR',
      description: 'Test MR description',
      state: 'opened',
      source_branch: 'feature-branch',
      target_branch: 'main',
      source_project_id: 1,
      target_project_id: 1,
    };
  }

  return JSON.stringify(base);
}

describe('GitLabAdapter', () => {
  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockHandleMessage.mockClear();
    mockOnConversationClosed.mockClear();
    mockFetch.mockClear();
    // Reset env
    delete process.env.GITLAB_ALLOWED_USERS;
  });

  test('initialization logs only operational configuration', () => {
    createAdapter();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { gitlabUrl: 'https://gitlab.example.com' },
      'gitlab.adapter_initialized'
    );
  });

  test('webhook clones an absent saved checkout before dispatch', async () => {
    const adapter = createAdapter();
    const path = join(tmpdir(), `archon-saved-checkout-${randomUUID()}`);
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce({
      id: 'saved-project',
      name: 'mygroup/myproject-2',
      default_cwd: path,
      repository_url: 'https://gitlab.example.com/mygroup/myproject',
    });
    mockGetOrCreateConversation.mockResolvedValueOnce({
      id: 'conv-saved',
      codebase_id: 'saved-project',
      cwd: path,
      platform_type: 'gitlab',
      platform_conversation_id: 'mygroup/myproject#1',
    });
    mockHandleMessage.mockClear();
    mockCloneRepository.mockClear();
    mockCloneRepository.mockImplementationOnce(async () => {
      expect(mockHandleMessage).not.toHaveBeenCalled();
      return { ok: true, value: undefined };
    });

    await adapter.handleWebhook(createNotePayload({ note: '@archon help' }), 'test-secret');
    expect(mockCloneRepository).toHaveBeenCalledTimes(1);
    expect(mockCloneRepository.mock.calls[0]?.slice(0, 2)).toEqual([
      'https://gitlab.example.com/mygroup/myproject.git',
      path,
    ]);
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
  });

  test('allocated checkout path reaches preparation and conversation storage', async () => {
    const adapter = createAdapter();
    const path = '/tmp/test-workspaces/mygroup/myproject-2/source';
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce(null);
    mockCreateCodebase.mockResolvedValueOnce({
      id: 'allocated',
      name: 'mygroup/myproject-2',
      default_cwd: path,
      repository_url: null,
    });
    mockGetOrCreateConversation.mockResolvedValueOnce({
      id: 'conv-allocated',
      codebase_id: null,
      cwd: null,
      platform_type: 'gitlab',
      platform_conversation_id: 'mygroup/myproject#1',
    });
    mockUpdateConversation.mockResolvedValueOnce(undefined);
    const prepare = spyOn(readiness, 'ensureRepoReady').mockResolvedValue(undefined);
    try {
      await adapter.handleWebhook(createNotePayload({ note: '@archon help' }), 'test-secret');
      expect(prepare).toHaveBeenCalledWith(
        { gitlabUrl: 'https://gitlab.example.com', token: 'test-token' },
        'mygroup/myproject',
        'main',
        expect.objectContaining({ default_cwd: path }),
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

  test.each(['own', 'marked'])('suppresses %s comments without logging identities', async kind => {
    const adapter = createAdapter({ botMention: 'private-bot' });
    await adapter.handleWebhook(
      createNotePayload({
        username: kind === 'own' ? 'private-bot' : 'alice',
        note:
          kind === 'marked' ? '@archon hello <!-- archon-bot-response -->' : '@private-bot hello',
      }),
      'test-secret'
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      kind === 'own' ? 'gitlab.ignoring_own_comment' : 'gitlab.ignoring_marked_comment'
    );
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  describe('basic interface', () => {
    test('returns batch streaming mode', () => {
      const adapter = createAdapter();
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('returns gitlab platform type', () => {
      const adapter = createAdapter();
      expect(adapter.getPlatformType()).toBe('gitlab');
    });

    test('start and stop without error', async () => {
      const adapter = createAdapter();
      await adapter.start();
      adapter.stop();
    });

    test('ensureThread returns original id', async () => {
      const adapter = createAdapter();
      const id = await adapter.ensureThread('mygroup/myproject#1');
      expect(id).toBe('mygroup/myproject#1');
    });
  });

  describe('webhook token verification', () => {
    test('rejects invalid token', async () => {
      const adapter = createAdapter({ secret: 'correct-secret' });
      mockLogger.error.mockClear();
      await adapter.handleWebhook('{}', 'wrong-token');
      // Should log error and return without processing
      expect(mockHandleMessage).not.toHaveBeenCalled();
      // A rejected token is often a real but stale secret: no fragment of it is logged.
      expect(mockLogger.error).toHaveBeenCalledWith(
        { payloadSize: 2 },
        'gitlab.invalid_webhook_token'
      );
    });

    test('rejects empty token', async () => {
      const adapter = createAdapter({ secret: 'correct-secret' });
      await adapter.handleWebhook('{}', '');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('webhook JSON parse error', () => {
    test('handles malformed JSON gracefully', async () => {
      const adapter = createAdapter();
      await adapter.handleWebhook('not-json', 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('self-filtering', () => {
    test('ignores comments with bot response marker', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({
        note: '@archon hello\n\n<!-- archon-bot-response -->',
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores comments from bot account', async () => {
      const adapter = createAdapter({ botMention: 'archon' });
      const payload = createNotePayload({
        note: '@archon something',
        username: 'archon',
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('mention detection', () => {
    test('ignores comments without mention', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({ note: 'just a regular comment' });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    test('rejects unauthorized users when whitelist is set', async () => {
      process.env.GITLAB_ALLOWED_USERS = 'alice,bob';
      const adapter = createAdapter();
      const payload = createNotePayload({ username: 'mallory', note: '@archon hello' });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('close events', () => {
    test('handles issue close event', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'issue',
        event_type: 'issue',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 5,
          action: 'close',
          title: 'Closed Issue',
          description: null,
          state: 'closed',
          labels: [],
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockOnConversationClosed).toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('handles MR merge event', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'merge_request',
        event_type: 'merge_request',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 10,
          action: 'merge',
          title: 'Merged MR',
          description: null,
          state: 'merged',
          source_branch: 'feature',
          target_branch: 'main',
          source_project_id: 1,
          target_project_id: 1,
          merge_status: 'can_be_merged',
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockOnConversationClosed).toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('unrecognized events', () => {
    test('ignores issue open events', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'issue',
        event_type: 'issue',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 1,
          action: 'open',
          title: 'New Issue',
          description: 'description',
          state: 'opened',
          labels: [],
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockOnConversationClosed).not.toHaveBeenCalled();
    });

    test('ignores MR open events (descriptions are not commands)', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'merge_request',
        event_type: 'merge_request',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 1,
          action: 'open',
          title: 'New MR',
          description: '@archon review this',
          state: 'opened',
          source_branch: 'feature',
          target_branch: 'main',
          source_project_id: 1,
          target_project_id: 1,
          merge_status: 'can_be_merged',
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockOnConversationClosed).not.toHaveBeenCalled();
    });
  });

  describe('mention patterns', () => {
    test('detects mention at end of string', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({ note: 'help me @archon' });
      await adapter.handleWebhook(payload, 'test-secret');
      // DB mock throws, so mention detection succeeded if webhook_setup_failed was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'mygroup/myproject#1' }),
        'gitlab.webhook_setup_failed'
      );
    });

    test('detects mention with comma separator', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({ note: '@archon, please help' });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'mygroup/myproject#1' }),
        'gitlab.webhook_setup_failed'
      );
    });

    test('case-insensitive mention detection', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({ note: '@ARCHON help' });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'mygroup/myproject#1' }),
        'gitlab.webhook_setup_failed'
      );
    });
  });

  describe('MR close event with merge flag', () => {
    test('passes merged=true for merge action', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'merge_request',
        event_type: 'merge_request',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 10,
          action: 'merge',
          title: 'Merged MR',
          description: null,
          state: 'merged',
          source_branch: 'feature',
          target_branch: 'main',
          source_project_id: 1,
          target_project_id: 1,
          merge_status: 'can_be_merged',
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockOnConversationClosed).toHaveBeenCalledWith('gitlab', 'mygroup/myproject!10', {
        merged: true,
      });
    });

    test('passes merged=false for close action', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'merge_request',
        event_type: 'merge_request',
        user: { username: 'testuser', name: 'Test' },
        project: {
          id: 1,
          path_with_namespace: 'mygroup/myproject',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/mygroup/myproject',
          http_url_to_repo: 'https://gitlab.example.com/mygroup/myproject.git',
        },
        object_attributes: {
          iid: 10,
          action: 'close',
          title: 'Closed MR',
          description: null,
          state: 'closed',
          source_branch: 'feature',
          target_branch: 'main',
          source_project_id: 1,
          target_project_id: 1,
          merge_status: 'can_be_merged',
        },
      });
      await adapter.handleWebhook(payload, 'test-secret');
      expect(mockOnConversationClosed).toHaveBeenCalledWith('gitlab', 'mygroup/myproject!10', {
        merged: false,
      });
    });
  });

  describe('MR note with fork detection', () => {
    test('detects fork when source_project_id differs from target_project_id', async () => {
      const adapter = createAdapter();
      const payload = JSON.stringify({
        object_kind: 'note',
        event_type: 'note',
        user: { username: 'contributor', name: 'Contributor' },
        project: {
          id: 1,
          path_with_namespace: 'upstream/project',
          default_branch: 'main',
          web_url: 'https://gitlab.example.com/upstream/project',
          http_url_to_repo: 'https://gitlab.example.com/upstream/project.git',
        },
        object_attributes: {
          noteable_type: 'MergeRequest',
          note: '@archon review',
          noteable_id: 99,
        },
        merge_request: {
          iid: 5,
          title: 'Fork MR',
          description: 'From a fork',
          state: 'opened',
          source_branch: 'fix-bug',
          target_branch: 'main',
          source_project_id: 999,
          target_project_id: 1,
        },
      });
      // Will attempt DB operations which throw, but we can verify the event was parsed
      await adapter.handleWebhook(payload, 'test-secret');
      // The fork detection happens inside handleWebhook — if it reaches webhook_processing
      // log, the event was parsed correctly including the MR context
    });
  });

  describe('user identity resolution', () => {
    beforeEach(() => {
      mockFindOrCreateUserByPlatformIdentity.mockClear();
      mockFindOrCreateUserByPlatformIdentity.mockImplementation(async () => ({
        id: 'user-test-uuid',
        display_name: 'Test',
        email: null,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      mockHandleMessage.mockClear();
    });

    test('calls findOrCreateUserByPlatformIdentity with gitlab platform and sender username', async () => {
      const adapter = createAdapter();
      const payload = createNotePayload({ username: 'testuser' });

      try {
        await adapter.handleWebhook(payload, 'test-secret');
      } catch {
        // Expected - database not mocked
      }

      expect(mockFindOrCreateUserByPlatformIdentity).toHaveBeenCalledWith(
        'gitlab',
        'testuser',
        'testuser'
      );
    });

    test('warn-logs and proceeds when user resolution fails', async () => {
      mockFindOrCreateUserByPlatformIdentity.mockImplementation(async () => {
        throw new Error('DB connection failed');
      });

      const adapter = createAdapter();
      const payload = createNotePayload({ username: 'testuser' });

      try {
        await adapter.handleWebhook(payload, 'test-secret');
      } catch {
        // Expected - database not mocked, but not from user resolution
      }

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: 'DB connection failed' }), platform: 'gitlab' },
        'gitlab.user_resolve_failed'
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
          platform_type: 'gitlab',
          platform_conversation_id: 'mygroup/myproject#1',
        }));
        mockFindCodebaseByRepoUrl.mockImplementation(async () => ({
          id: 'codebase-test-uuid',
          repository_url: 'https://gitlab.example.com/mygroup/myproject',
          default_cwd: '/tmp/test-workspaces/mygroup/myproject/source',
          name: 'myproject',
        }));

        const adapter = createAdapter();
        const payload = createNotePayload({ username: 'testuser', note: `@archon ${message}` });

        await adapter.handleWebhook(payload, 'test-secret');

        if (message.startsWith('/'))
          expect(mockLogger.debug).toHaveBeenCalledWith('gitlab.slash_command_processing');

        expect(mockGetOrCreateConversation).toHaveBeenCalledWith(
          'gitlab',
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

    test('skips user resolution when sender username is missing', async () => {
      // Seed DB mocks so handleWebhook reaches handleMessage
      mockGetOrCreateConversation.mockImplementation(async () => ({
        id: 'conv-test-uuid',
        codebase_id: 'codebase-test-uuid',
        cwd: '/tmp/project',
        platform_type: 'gitlab',
        platform_conversation_id: 'mygroup/myproject#1',
      }));
      mockFindCodebaseByRepoUrl.mockImplementation(async () => ({
        id: 'codebase-test-uuid',
        repository_url: 'https://gitlab.example.com/mygroup/myproject',
        default_cwd: '/tmp/test-workspaces/mygroup/myproject/source',
        name: 'myproject',
      }));

      const adapter = createAdapter();
      const base = JSON.parse(createNotePayload({ username: 'testuser' }));
      delete base.user;
      const payload = JSON.stringify(base);

      await adapter.handleWebhook(payload, 'test-secret');

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
