import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock @archon/paths
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
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
  ensureProjectStructure: mock(async () => undefined),
  logArchonPaths: mock(() => undefined),
  validateAppDefaultsPaths: mock(async () => undefined),
}));

// Mock @archon/core/db modules
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  updateConversation: mock(async () => {
    throw new Error('DB not mocked in tests');
  }),
  getConversation: mock(async () => null),
}));

// Mock @archon/core
const mockHandleMessage = mock(async () => undefined);
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: mock((err: Error) => err.message),
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  ConversationLockManager: class {
    async acquireLock(_id: string, fn: () => Promise<void>): Promise<void> {
      await fn();
    }
  },
}));

// Mock @archon/isolation (type-only import in adapter, but Bun resolves all modules)
mock.module('@archon/isolation', () => ({
  IsolationHints: {},
}));

// Mock global fetch
const mockFetch = mock(() =>
  Promise.resolve(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
);
globalThis.fetch = mockFetch as typeof globalThis.fetch;

// Now import the adapter (after all mocks)
const { JiraAdapter } = await import('./adapter');
const { ConversationLockManager } = await import('@archon/core');

const TEST_BOT_ACCOUNT_ID = '5b10a2844c20165700ede21g';
const TEST_BASE_URL = 'https://test.atlassian.net';
const TEST_EMAIL = 'bot@example.com';
const TEST_API_TOKEN = 'test-api-token';
const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

function createAdapter(): InstanceType<typeof JiraAdapter> {
  const lockManager = new ConversationLockManager();
  return new JiraAdapter(
    TEST_BASE_URL,
    TEST_EMAIL,
    TEST_API_TOKEN,
    TEST_WEBHOOK_SECRET,
    lockManager as never,
    TEST_BOT_ACCOUNT_ID
  );
}

function adfWithMention(botId: string, extraText?: string): unknown {
  const content: unknown[] = [
    {
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { id: botId, text: '@bot' } },
        ...(extraText ? [{ type: 'text', text: ` ${extraText}` }] : []),
      ],
    },
  ];
  return { version: 1, type: 'doc', content };
}

function adfTextOnly(text: string): unknown {
  return {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function createCommentPayload(overrides?: {
  commentBody?: unknown;
  authorAccountId?: string;
  issueKey?: string;
  issueSummary?: string;
  webhookEvent?: string;
}): string {
  return JSON.stringify({
    webhookEvent: overrides?.webhookEvent ?? 'comment_created',
    comment: {
      id: '10001',
      author: {
        accountId: overrides?.authorAccountId ?? 'user-account-123',
        displayName: 'Test User',
      },
      body: overrides?.commentBody ?? adfWithMention(TEST_BOT_ACCOUNT_ID, 'hello'),
      created: '2024-01-01T00:00:00.000+0000',
      updated: '2024-01-01T00:00:00.000+0000',
    },
    issue: {
      id: '10000',
      key: overrides?.issueKey ?? 'DF-123',
      fields: {
        summary: overrides?.issueSummary ?? 'Test Issue Summary',
        description: null,
        status: { name: 'Open' },
        priority: { name: 'Medium' },
        labels: ['bug'],
      },
    },
  });
}

describe('JiraAdapter', () => {
  beforeEach(() => {
    mockHandleMessage.mockClear();
    mockFetch.mockClear();
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ comments: [] }), { status: 200 }))
    );
    delete process.env.JIRA_ALLOWED_ACCOUNT_IDS;
  });

  describe('basic interface', () => {
    test('returns batch streaming mode', () => {
      const adapter = createAdapter();
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('returns jira platform type', () => {
      const adapter = createAdapter();
      expect(adapter.getPlatformType()).toBe('jira');
    });

    test('start and stop without error', async () => {
      const adapter = createAdapter();
      await adapter.start();
      adapter.stop();
    });

    test('ensureThread returns original id', async () => {
      const adapter = createAdapter();
      const id = await adapter.ensureThread('DF-1');
      expect(id).toBe('DF-1');
    });
  });

  describe('constructor validation', () => {
    const lockManager = new ConversationLockManager();

    test('throws if botAccountId is empty', () => {
      expect(
        () =>
          new JiraAdapter(
            TEST_BASE_URL,
            TEST_EMAIL,
            TEST_API_TOKEN,
            TEST_WEBHOOK_SECRET,
            lockManager as never,
            ''
          )
      ).toThrow('botAccountId');
    });

    test('throws if baseUrl is empty', () => {
      expect(
        () =>
          new JiraAdapter(
            '',
            TEST_EMAIL,
            TEST_API_TOKEN,
            TEST_WEBHOOK_SECRET,
            lockManager as never,
            TEST_BOT_ACCOUNT_ID
          )
      ).toThrow('baseUrl');
    });

    test('throws if email is empty', () => {
      expect(
        () =>
          new JiraAdapter(
            TEST_BASE_URL,
            '',
            TEST_API_TOKEN,
            TEST_WEBHOOK_SECRET,
            lockManager as never,
            TEST_BOT_ACCOUNT_ID
          )
      ).toThrow('email');
    });

    test('throws if apiToken is empty', () => {
      expect(
        () =>
          new JiraAdapter(
            TEST_BASE_URL,
            TEST_EMAIL,
            '',
            TEST_WEBHOOK_SECRET,
            lockManager as never,
            TEST_BOT_ACCOUNT_ID
          )
      ).toThrow('apiToken');
    });

    test('throws if webhookSecret is empty', () => {
      expect(
        () =>
          new JiraAdapter(
            TEST_BASE_URL,
            TEST_EMAIL,
            TEST_API_TOKEN,
            '',
            lockManager as never,
            TEST_BOT_ACCOUNT_ID
          )
      ).toThrow('webhookSecret');
    });
  });

  describe('webhook secret verification', () => {
    test('rejects with wrong secret', async () => {
      const adapter = createAdapter();
      await adapter.handleWebhook(createCommentPayload(), 'wrong-secret');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('rejects with empty secret', async () => {
      const adapter = createAdapter();
      await adapter.handleWebhook(createCommentPayload(), '');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('JSON parse errors', () => {
    test('handles malformed JSON gracefully', async () => {
      const adapter = createAdapter();
      await adapter.handleWebhook('not-valid-json', TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('event type filtering', () => {
    test('ignores comment_updated event', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload({ webhookEvent: 'comment_updated' });
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores issue_created event', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload({ webhookEvent: 'issue_created' });
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('self-trigger guard', () => {
    test('ignores comments authored by botAccountId', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload({ authorAccountId: TEST_BOT_ACCOUNT_ID });
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('accountId allowlist', () => {
    test('rejects unauthorized accountId when allowlist is set', async () => {
      process.env.JIRA_ALLOWED_ACCOUNT_IDS = 'allowed-user-1,allowed-user-2';
      const adapter = createAdapter();
      const payload = createCommentPayload({ authorAccountId: 'unauthorized-user' });
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('allows authorized accountId when allowlist is set', async () => {
      process.env.JIRA_ALLOWED_ACCOUNT_IDS = 'allowed-user-1,user-account-123';
      const adapter = createAdapter();
      const payload = createCommentPayload();
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('allows all when allowlist is empty', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload();
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('ADF mention detection', () => {
    test('ignores comment with no mention node', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload({ commentBody: adfTextOnly('just text, no mention') });
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores comment mentioning a different accountId', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload({
        commentBody: adfWithMention('different-account-id', 'hello'),
      });
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('processes comment with ADF mention matching botAccountId', async () => {
      const adapter = createAdapter();
      const payload = createCommentPayload();
      await adapter.handleWebhook(payload, TEST_WEBHOOK_SECRET);
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
      expect(mockHandleMessage).toHaveBeenCalledWith(
        adapter,
        'DF-123',
        expect.any(String),
        expect.objectContaining({
          issueContext: expect.stringContaining('Jira Issue Context'),
          isolationHints: { workflowType: 'thread', workflowId: 'DF-123' },
        })
      );
    });
  });

  describe('sendMessage', () => {
    test('short message calls fetch once', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('DF-1', 'Hello from Archon');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.atlassian.net/rest/api/3/issue/DF-1/comment');
      expect(options.method).toBe('POST');
    });

    test('long message calls fetch multiple times', async () => {
      const adapter = createAdapter();
      const paragraphs = Array.from(
        { length: 40 },
        (_, i) => `Paragraph ${String(i)}: ${'x'.repeat(990)}`
      );
      const longMessage = paragraphs.join('\n\n');
      await adapter.sendMessage('DF-1', longMessage);

      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    test('POST body contains ADF structure', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('DF-1', 'Test message');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as {
        body: { type: string; version: number };
      };
      expect(body.body.type).toBe('doc');
      expect(body.body.version).toBe(1);
    });

    test('uses Basic auth header', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('DF-1', 'Test');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Basic /);
    });
  });
});
