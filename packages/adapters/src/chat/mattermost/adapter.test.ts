import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Mock } from 'bun:test';

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

const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);

  if (url.endsWith('/api/v4/users/me')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'bot123', username: 'archon' }),
    } satisfies Partial<Response> as Response;
  }

  if (url.includes('/api/v4/channels/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'channel1', type: 'D' }),
    } satisfies Partial<Response> as Response;
  }

  if (url.includes('/api/v4/posts/') && url.includes('/thread')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        order: ['root1', 'reply1'],
        posts: {
          root1: { id: 'root1', user_id: 'user1', channel_id: 'channel1', message: 'root' },
          reply1: {
            id: 'reply1',
            user_id: 'bot123',
            channel_id: 'channel1',
            message: 'reply',
            root_id: 'root1',
          },
        },
      }),
    } satisfies Partial<Response> as Response;
  }

  if (url.endsWith('/api/v4/posts')) {
    return {
      ok: true,
      status: 201,
      json: async () => ({ ok: true, init }),
    } satisfies Partial<Response> as Response;
  }

  return {
    ok: false,
    status: 404,
    json: async () => ({}),
  } satisfies Partial<Response> as Response;
});

globalThis.fetch = fetchMock as typeof fetch;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private listeners = new Map<string, Array<(event?: { data?: string }) => void>>();
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: { data?: string }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.emit('close');
  }

  emit(type: string, event?: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

import { MattermostAdapter } from './adapter';
import type { MattermostMessageEvent } from './types';

describe('MattermostAdapter', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    FakeWebSocket.instances.length = 0;
  });

  test('returns configured streaming mode', () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token', 'stream');
    expect(adapter.getStreamingMode()).toBe('stream');
  });

  test('returns platform type', () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    expect(adapter.getPlatformType()).toBe('mattermost');
  });

  test('detects thread messages', () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    const event: MattermostMessageEvent = {
      text: 'reply',
      user: 'user1',
      channel: 'channel1',
      postId: 'reply1',
      root_id: 'root1',
    };

    expect(adapter.isThread(event)).toBe(true);
  });

  test('builds conversation ID from root_id or postId', () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    expect(
      adapter.getConversationId({
        text: 'reply',
        user: 'user1',
        channel: 'channel1',
        postId: 'reply1',
        root_id: 'root1',
      })
    ).toBe('channel1:root1');
    expect(
      adapter.getConversationId({
        text: 'root',
        user: 'user1',
        channel: 'channel1',
        postId: 'root1',
      })
    ).toBe('channel1:root1');
  });

  test('strips leading bot mention', () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    (adapter as { botUsername: string }).botUsername = 'archon';
    expect(adapter.stripBotMention('@archon /status')).toBe('/status');
  });

  test('ensureThread is a no-op', async () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    await expect(adapter.ensureThread('channel1:root1')).resolves.toBe('channel1:root1');
  });

  test('sends message to posts endpoint with root_id', async () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    await adapter.sendMessage('channel1:root1', 'hello');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mm.example.com/api/v4/posts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel_id: 'channel1', message: 'hello', root_id: 'root1' }),
      })
    );
  });

  test('splits long messages into multiple posts', async () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    const message = `${'a'.repeat(10000)}\n\n${'b'.repeat(10000)}`;
    await adapter.sendMessage('channel1:root1', message);

    expect(
      (fetchMock as Mock<typeof fetchMock>).mock.calls.filter(call =>
        String(call[0]).endsWith('/api/v4/posts')
      )
    ).toHaveLength(2);
  });

  test('fetches thread history in chronological order', async () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    (adapter as { botUserId: string }).botUserId = 'bot123';

    await expect(
      adapter.fetchThreadHistory({
        text: 'reply',
        user: 'user1',
        channel: 'channel1',
        postId: 'reply1',
        root_id: 'root1',
      })
    ).resolves.toEqual(['<@user1>: root', '[Bot]: reply']);
  });

  test('starts websocket, authenticates, and forwards DM messages', async () => {
    const adapter = new MattermostAdapter('https://mm.example.com', 'token');
    const handler = mock(async () => undefined);
    adapter.onMessage(handler);

    const startPromise = adapter.start();
    await Bun.sleep(0);
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    await startPromise;

    expect(socket.url).toBe('wss://mm.example.com/api/v4/websocket');
    expect(socket.sent[0]).toContain('authentication_challenge');

    socket.emit('message', {
      data: JSON.stringify({
        event: 'posted',
        data: {
          post: JSON.stringify({
            id: 'post1',
            user_id: 'user1',
            channel_id: 'channel1',
            message: 'hello from dm',
          }),
        },
      }),
    });
    await Bun.sleep(0);

    expect(handler).toHaveBeenCalledWith({
      text: 'hello from dm',
      user: 'user1',
      channel: 'channel1',
      postId: 'post1',
      root_id: undefined,
    });
  });
});
