/**
 * Unit tests for the Jira adapter.
 *
 * Mocks @archon/core (handleMessage + helpers) and the conversations DB module
 * so handleWebhook can be exercised without a real database or orchestrator.
 * `fetch` is stubbed per-test to emulate the Jira REST API.
 *
 * Mock-isolation: this file mocks @archon/core, so it MUST run in its own
 * `bun test` invocation (see packages/adapters/package.json).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

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

// Capture handleMessage calls. classifyAndFormatError/toError pass through.
const mockHandleMessage = mock(async () => undefined);
class StubLockManager {
  async acquireLock(_id: string, handler: () => Promise<void>): Promise<void> {
    await handler();
  }
}
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  classifyAndFormatError: (e: Error) => e.message,
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  ConversationLockManager: StubLockManager,
}));

const mockGetOrCreateConversation = mock(async (platform: string, id: string) => ({
  id: `conv-${id}`,
  platform,
  codebase_id: null,
}));
mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
}));

import { JiraAdapter } from './adapter';
import type { ConversationLockManager } from '@archon/core';

const lockManager = new StubLockManager() as unknown as ConversationLockManager;

const BASE = 'https://acme.atlassian.net';
const SECRET = 'hook-secret';

/** Install a fetch stub that routes Jira REST calls. Returns the recorded calls. */
function installFetch(opts?: { myselfFails?: boolean }): {
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const stub = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    const json = (body: unknown, ok = true, status = 200): Response =>
      ({ ok, status, json: async () => body }) as unknown as Response;

    if (url.endsWith('/rest/api/3/myself')) {
      if (opts?.myselfFails) return json({}, false, 500);
      return json({ accountId: 'bot-account-id' });
    }
    if (url.includes('/rest/api/3/issue/') && url.includes('?fields=')) {
      return json({
        key: 'PROJ-123',
        fields: {
          summary: 'Login button broken',
          description: 'It does nothing on click',
          issuetype: { name: 'Bug' },
          status: { name: 'To Do' },
        },
      });
    }
    if (url.includes('/comment') && method === 'GET') {
      return json({
        comments: [{ author: { displayName: 'Alice' }, body: 'first comment' }],
      });
    }
    if (url.includes('/comment') && method === 'POST') {
      return json({ id: '10000' });
    }
    return json({}, false, 404);
  });
  global.fetch = stub as unknown as typeof fetch;
  return { calls };
}

function makeCommentEvent(
  commentText: string,
  author?: { accountId?: string; emailAddress?: string }
) {
  return JSON.stringify({
    webhookEvent: 'comment_created',
    issue: { key: 'PROJ-123', fields: { summary: 'Login button broken' } },
    comment: {
      author: author ?? { accountId: 'human-1', emailAddress: 'human@acme.com' },
      body: commentText,
    },
  });
}

async function makeStartedAdapter(opts?: { myselfFails?: boolean }): Promise<JiraAdapter> {
  installFetch(opts);
  const adapter = new JiraAdapter(BASE, 'bot@acme.com', 'token', SECRET, lockManager, 'Archon');
  await adapter.start();
  return adapter;
}

const originalFetch = global.fetch;
beforeEach(() => {
  mockHandleMessage.mockClear();
  mockGetOrCreateConversation.mockClear();
  delete process.env.JIRA_ALLOWED_USERS;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('conversation id + mention helpers', () => {
  test('build/parse conversation id round-trip', () => {
    const adapter = new JiraAdapter(BASE, 'u', 't', SECRET, lockManager) as unknown as {
      buildConversationId: (k: string) => string;
      parseConversationId: (id: string) => { issueKey: string } | null;
    };
    expect(adapter.buildConversationId('PROJ-123')).toBe('PROJ-123');
    expect(adapter.parseConversationId('PROJ-123')).toEqual({ issueKey: 'PROJ-123' });
    expect(adapter.parseConversationId('not a key')).toBeNull();
    expect(adapter.parseConversationId('proj-123')).toBeNull(); // must be uppercase
  });

  test('hasMention / stripMention variants', () => {
    const adapter = new JiraAdapter(BASE, 'u', 't', SECRET, lockManager) as unknown as {
      hasMention: (t: string) => boolean;
      stripMention: (t: string) => string;
    };
    expect(adapter.hasMention('hey @Archon help')).toBe(true);
    expect(adapter.hasMention('@archon')).toBe(true);
    expect(adapter.hasMention('no mention here')).toBe(false);
    expect(adapter.stripMention('@Archon run the tests')).toBe('run the tests');
  });

  test('getPlatformType / getStreamingMode', () => {
    const adapter = new JiraAdapter(BASE, 'u', 't', SECRET, lockManager);
    expect(adapter.getPlatformType()).toBe('jira');
    expect(adapter.getStreamingMode()).toBe('batch');
  });
});

describe('handleWebhook', () => {
  test('drops on secret mismatch', async () => {
    const adapter = await makeStartedAdapter();
    await adapter.handleWebhook(makeCommentEvent('@Archon hi'), 'wrong-secret');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('drops non-comment events', async () => {
    const adapter = await makeStartedAdapter();
    await adapter.handleWebhook(JSON.stringify({ webhookEvent: 'jira:issue_updated' }), SECRET);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('drops self-authored comments (accountId match)', async () => {
    const adapter = await makeStartedAdapter();
    await adapter.handleWebhook(
      makeCommentEvent('@Archon loop?', { accountId: 'bot-account-id' }),
      SECRET
    );
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('drops unauthorized authors when allowlist set', async () => {
    process.env.JIRA_ALLOWED_USERS = 'allowed-account';
    installFetch();
    const adapter = new JiraAdapter(BASE, 'bot@acme.com', 'token', SECRET, lockManager, 'Archon');
    await adapter.start();
    await adapter.handleWebhook(makeCommentEvent('@Archon hi', { accountId: 'stranger' }), SECRET);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('drops comments without a mention', async () => {
    const adapter = await makeStartedAdapter();
    await adapter.handleWebhook(makeCommentEvent('just a normal comment'), SECRET);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('valid comment dispatches with ticket context and NO codebase', async () => {
    const adapter = await makeStartedAdapter();
    await adapter.handleWebhook(makeCommentEvent('@Archon what does this repo do?'), SECRET);

    // Conversation created with platform 'jira' + issue key, no codebase arg.
    expect(mockGetOrCreateConversation).toHaveBeenCalledWith('jira', 'PROJ-123');
    expect(mockGetOrCreateConversation.mock.calls[0]).toHaveLength(2);

    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    const [, conversationId, text, context] = mockHandleMessage.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      { issueContext?: string; threadContext?: string },
    ];
    expect(conversationId).toBe('PROJ-123');
    expect(text).toBe('what does this repo do?');
    expect(context.issueContext).toContain('Login button broken');
    expect(context.threadContext).toContain('Alice: first comment');
  });

  test('rewrites /workflow run without --project to free text', async () => {
    const adapter = await makeStartedAdapter();
    await adapter.handleWebhook(
      makeCommentEvent('@Archon /workflow run archon-fix-jira-bug PROJ-123'),
      SECRET
    );
    const [, , text] = mockHandleMessage.mock.calls[0] as unknown as [unknown, string, string];
    expect(text).toBe('archon-fix-jira-bug PROJ-123');
    expect(text.startsWith('/workflow')).toBe(false);
  });

  test('falls back to marker guard when /myself fails at startup', async () => {
    const adapter = await makeStartedAdapter({ myselfFails: true });
    // A comment carrying the invisible marker is treated as bot-authored.
    const marked = makeCommentEvent('@Archon hi ​​archon-bot-response​​');
    await adapter.handleWebhook(marked, SECRET);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });
});
