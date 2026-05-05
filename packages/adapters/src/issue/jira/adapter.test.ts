import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

const mockGetOrCreateConversation = mock(async () => ({ id: 'conversation-id' }));
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
}));

const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);

  if (url.endsWith('/rest/api/2/issue/WOR-1/comment?maxResults=20&orderBy=created')) {
    return new Response(
      JSON.stringify({
        comments: [
          {
            body: 'previous comment',
            author: { displayName: 'Alice' },
          },
        ],
      }),
      { status: 200 }
    );
  }

  if (url.endsWith('/rest/api/2/issue/WOR-1/comment')) {
    return new Response(JSON.stringify({ id: 'comment-1', init }), { status: 201 });
  }

  return new Response('{}', { status: 404, statusText: 'Not Found' });
});

globalThis.fetch = fetchMock as typeof fetch;

const { JiraAdapter } = await import('./adapter');
const { ConversationLockManager } = await import('@archon/core');

function createAdapter(options?: { apiVersion?: string }): InstanceType<typeof JiraAdapter> {
  return new JiraAdapter(
    'https://jira.example.com',
    'token',
    'secret',
    new ConversationLockManager() as never,
    {
      apiVersion: options?.apiVersion ?? '2',
      botMention: 'archon',
    }
  );
}

function createCommentPayload(): string {
  return JSON.stringify({
    webhookEvent: 'comment_created',
    user: { accountId: 'user1', displayName: 'Alice' },
    issue: {
      key: 'WOR-1',
      fields: {
        summary: 'Fix planning status',
        description: 'Issue description',
        labels: ['bug'],
        status: { name: 'Open', statusCategory: { key: 'new' } },
        issuetype: { name: 'Task' },
      },
    },
    comment: {
      id: '10001',
      author: { accountId: 'user1', displayName: 'Alice' },
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'mention', attrs: { text: 'archon' } },
              { type: 'text', text: ' implement this' },
            ],
          },
        ],
      },
    },
  });
}

describe('JiraAdapter', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    mockHandleMessage.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockOnConversationClosed.mockClear();
    delete process.env.JIRA_ALLOWED_USERS;
  });

  test('returns batch streaming mode and jira platform type', () => {
    const adapter = createAdapter();
    expect(adapter.getStreamingMode()).toBe('batch');
    expect(adapter.getPlatformType()).toBe('jira');
  });

  test('sends Jira API v2 comments as plain text bodies', async () => {
    const adapter = createAdapter();
    await adapter.sendMessage('WOR-1', 'hello');

    const postCall = fetchMock.mock.calls.find(call =>
      String(call[0]).endsWith('/rest/api/2/issue/WOR-1/comment')
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      body: 'hello\n\n<!-- archon-bot-response -->',
    });
  });

  test('dispatches mentioned ADF comments to Archon with Jira context', async () => {
    const adapter = createAdapter();
    await adapter.handleWebhook(createCommentPayload(), 'secret');

    expect(mockGetOrCreateConversation).toHaveBeenCalledWith('jira', 'WOR-1');
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleMessage.mock.calls[0]?.[1]).toBe('WOR-1');
    expect(mockHandleMessage.mock.calls[0]?.[2]).toContain('[Jira Issue Context]');
    expect(mockHandleMessage.mock.calls[0]?.[2]).toContain('implement this');
  });

  test('rejects invalid webhook tokens', async () => {
    const adapter = createAdapter();
    await adapter.handleWebhook(createCommentPayload(), 'wrong');

    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('cleans up issue conversations when Jira status moves to done', async () => {
    const adapter = createAdapter();
    await adapter.handleWebhook(
      JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        issue: {
          key: 'WOR-1',
          fields: { status: { name: 'Done', statusCategory: { key: 'done' } } },
        },
        changelog: { items: [{ field: 'status', toString: 'Done' }] },
      }),
      'secret'
    );

    expect(mockOnConversationClosed).toHaveBeenCalledWith('jira', 'WOR-1', { merged: false });
  });
});
