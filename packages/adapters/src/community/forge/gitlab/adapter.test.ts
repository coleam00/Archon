/**
 * Unit tests for GitLab community forge adapter
 *
 * Runs in its own test batch to avoid mock.module pollution with other adapters.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

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
    async acquireLock(_id: string, fn: () => Promise<void>): Promise<void> {
      await fn();
    }
  },
}));

// Mock @archon/git
mock.module('@archon/git', () => ({
  cloneRepository: mock(async () => ({ ok: true })),
  syncRepository: mock(async () => ({ ok: true })),
  addSafeDirectory: mock(async () => undefined),
  toRepoPath: mock((p: string) => p),
  toBranchName: mock((b: string) => b),
  isWorktreePath: mock(async () => false),
  execFileAsync: mock(async () => ({ stdout: '', stderr: '' })),
}));

// Mock @archon/isolation
mock.module('@archon/isolation', () => ({
  IsolationHints: {},
}));

// Mock global fetch to prevent real HTTP calls (gitlab.example.com hangs on CI Linux)
const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
globalThis.fetch = mockFetch as typeof globalThis.fetch;

// Now import the adapter (after all mocks)
const { GitLabAdapter } = await import('./adapter');
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
    lockManager as never,
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
    mockHandleMessage.mockClear();
    mockOnConversationClosed.mockClear();
    mockFetch.mockClear();
    // Reset env
    delete process.env.GITLAB_ALLOWED_USERS;
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
      await adapter.handleWebhook('{}', 'wrong-token');
      // Should log error and return without processing
      expect(mockHandleMessage).not.toHaveBeenCalled();
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

  describe('stripMention', () => {
    const adapter = createAdapter({ botMention: 'archon' });
    const strip = (text: string) =>
      (adapter as unknown as { stripMention: (t: string) => string }).stripMention(text);

    test('strips mention followed by space', () => {
      expect(strip('@archon hello')).toBe('hello');
    });

    test('strips mention followed by comma', () => {
      expect(strip('@archon, please help')).toBe('please help');
    });

    test('strips mention at end of string', () => {
      expect(strip('help me @archon')).toBe('help me');
    });

    test('does NOT strip partial-prefix username (@archonbot)', () => {
      // Regression: old regex `@archon[\s,:;]*` would strip '@archon' from '@archonbot',
      // yielding 'bot hello'. New regex requires a separator or end-of-string.
      expect(strip('@archonbot hello')).toBe('@archonbot hello');
    });
  });

  describe('conversation ID parsing', () => {
    test('parses issue conversation ID (# separator)', () => {
      const adapter = createAdapter();
      // Access private method via type casting for testing
      const parsed = (
        adapter as unknown as { parseConversationId: (id: string) => unknown }
      ).parseConversationId('mygroup/myproject#42');
      expect(parsed).toEqual({ projectPath: 'mygroup/myproject', iid: 42, isMR: false });
    });

    test('parses MR conversation ID (! separator)', () => {
      const adapter = createAdapter();
      const parsed = (
        adapter as unknown as { parseConversationId: (id: string) => unknown }
      ).parseConversationId('mygroup/myproject!15');
      expect(parsed).toEqual({ projectPath: 'mygroup/myproject', iid: 15, isMR: true });
    });

    test('parses nested group conversation ID', () => {
      const adapter = createAdapter();
      const parsed = (
        adapter as unknown as { parseConversationId: (id: string) => unknown }
      ).parseConversationId('org/team/subteam/project#7');
      expect(parsed).toEqual({ projectPath: 'org/team/subteam/project', iid: 7, isMR: false });
    });

    test('returns null for invalid conversation ID', () => {
      const adapter = createAdapter();
      const parsed = (
        adapter as unknown as { parseConversationId: (id: string) => unknown }
      ).parseConversationId('invalid');
      expect(parsed).toBeNull();
    });

    test('builds correct conversation IDs', () => {
      const adapter = createAdapter();
      const build = (
        adapter as unknown as { buildConversationId: (p: string, i: number, m: boolean) => string }
      ).buildConversationId;
      expect(build.call(adapter, 'group/project', 42, false)).toBe('group/project#42');
      expect(build.call(adapter, 'group/project', 15, true)).toBe('group/project!15');
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

  describe('sendMessage', () => {
    let mockFetch: ReturnType<typeof mock>;

    beforeEach(() => {
      mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
      globalThis.fetch = mockFetch as typeof fetch;
    });

    test('posts to correct issue notes API endpoint', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('mygroup/myproject#42', 'Hello from Archon');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://gitlab.example.com/api/v4/projects/mygroup%2Fmyproject/issues/42/notes'
      );
      expect(options.method).toBe('POST');
    });

    test('posts to correct MR notes API endpoint', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('mygroup/myproject!15', 'Review complete');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://gitlab.example.com/api/v4/projects/mygroup%2Fmyproject/merge_requests/15/notes'
      );
    });

    test('appends bot response marker to outgoing comments', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('mygroup/myproject#1', 'Test message');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as { body: string };
      expect(body.body).toContain('Test message');
      expect(body.body).toContain('<!-- archon-bot-response -->');
      expect(body.body).toBe('Test message\n\n<!-- archon-bot-response -->');
    });

    test('encodes nested project path in URL', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('org/team/subproject#7', 'Nested group test');

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('org%2Fteam%2Fsubproject');
    });

    test('rejects invalid conversation ID without calling API', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('invalid-format', 'Should not send');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        { conversationId: 'invalid-format' },
        'gitlab.invalid_conversation_id'
      );
    });

    test('splits long messages into multiple API calls', async () => {
      const adapter = createAdapter();
      // Build a message with paragraph breaks that exceeds MAX_LENGTH (65000)
      // Each paragraph is ~1000 chars, 80 paragraphs = ~80k + separators
      const paragraphs = Array.from(
        { length: 80 },
        (_, i) => `Paragraph ${String(i)}: ${'x'.repeat(990)}`
      );
      const longMessage = paragraphs.join('\n\n');
      await adapter.sendMessage('mygroup/myproject#1', longMessage);

      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
