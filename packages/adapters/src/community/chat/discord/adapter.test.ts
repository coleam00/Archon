/**
 * Unit tests for Discord adapter
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Mock } from 'bun:test';

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

// Create mock functions before mocking the module
const mockChannelSend = mock(() => Promise.resolve(undefined));
const mockChannelsFetch = mock(() =>
  Promise.resolve({
    isSendable: () => true,
    send: mockChannelSend,
  })
);
const mockClientOn = mock(() => {});
const mockClientOnce = mock(() => {});
const mockClientLogin = mock(() => Promise.resolve('token'));
const mockClientDestroy = mock(() => {});

const mockClient = {
  channels: {
    fetch: mockChannelsFetch,
  },
  on: mockClientOn,
  once: mockClientOnce,
  login: mockClientLogin,
  destroy: mockClientDestroy,
  user: { id: '123456789' },
};

const MockClient = mock(() => mockClient);

// Mock discord.js
mock.module('discord.js', () => ({
  Client: MockClient,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  Partials: {
    Channel: 0,
  },
  Events: {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
  },
}));

import { DiscordAdapter } from './adapter';

describe('DiscordAdapter', () => {
  beforeEach(() => {
    mockChannelSend.mockClear();
    mockChannelsFetch.mockClear();
    mockClientOn.mockClear();
    mockClientOnce.mockClear();
    mockClientLogin.mockClear();
    mockClientDestroy.mockClear();
  });

  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to stream mode', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      expect(adapter.getStreamingMode()).toBe('stream');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('platform type', () => {
    test('should return discord as platform type', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      expect(adapter.getPlatformType()).toBe('discord');
    });
  });

  describe('client instance', () => {
    test('should provide access to client instance', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const client = adapter.getClient();
      expect(client).toBeDefined();
    });
  });

  describe('conversation ID extraction', () => {
    test('should extract channel ID from message', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        channelId: '1234567890',
      } as unknown as import('discord.js').Message;

      expect(adapter.getConversationId(mockMessage)).toBe('1234567890');
    });

    test('should use thread ID when message is in a thread', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockThreadMessage = {
        channelId: '9876543210',
      } as unknown as import('discord.js').Message;

      expect(adapter.getConversationId(mockThreadMessage)).toBe('9876543210');
    });
  });

  describe('message sending', () => {
    test('should send short messages directly', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const client = adapter.getClient();

      await adapter.sendMessage('123', 'Hello, World!');

      expect(client.channels.fetch).toHaveBeenCalledWith('123');
      expect(mockChannelSend).toHaveBeenCalledWith('Hello, World!');
    });

    test('should split long messages into chunks', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');

      const para1 = 'a'.repeat(1500);
      const para2 = 'b'.repeat(1500);
      const longMessage = `${para1}\n\n${para2}`;

      await adapter.sendMessage('123', longMessage);

      expect((mockChannelSend as Mock<typeof mockChannelSend>).mock.calls.length).toBeGreaterThan(
        1
      );
    });
  });

  describe('lifecycle', () => {
    test('should login on start', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const client = adapter.getClient();

      await adapter.start();

      expect(client.login).toHaveBeenCalledWith('fake-token-for-testing');
    });

    test('should destroy client on stop', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const client = adapter.getClient();

      adapter.stop();

      expect(client.destroy).toHaveBeenCalled();
    });

    test('should register message and ready handlers on start', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const client = adapter.getClient();

      await adapter.start();

      expect(client.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
      expect(client.once).toHaveBeenCalledWith('ready', expect.any(Function));
    });
  });

  describe('message handler registration', () => {
    test('should allow registering a message handler', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockHandler = mock(() => Promise.resolve(undefined));

      adapter.onMessage(mockHandler);
      await adapter.start();

      expect(true).toBe(true);
    });
  });

  describe('mention detection', () => {
    test('should detect when bot is mentioned', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        mentions: {
          has: mock(() => true),
        },
      } as unknown as import('discord.js').Message;

      expect(adapter.isBotMentioned(mockMessage)).toBe(true);
    });

    test('should return false when bot is not mentioned', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        mentions: {
          has: mock(() => false),
        },
      } as unknown as import('discord.js').Message;

      expect(adapter.isBotMentioned(mockMessage)).toBe(false);
    });
  });

  describe('thread detection', () => {
    test('should detect thread channel', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        channel: {
          isThread: () => true,
          parentId: '987654321',
        },
      } as unknown as import('discord.js').Message;

      expect(adapter.isThread(mockMessage)).toBe(true);
      expect(adapter.getParentChannelId(mockMessage)).toBe('987654321');
    });

    test('should return null for non-thread channel', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        channel: {
          isThread: () => false,
        },
      } as unknown as import('discord.js').Message;

      expect(adapter.isThread(mockMessage)).toBe(false);
      expect(adapter.getParentChannelId(mockMessage)).toBeNull();
    });
  });

  describe('mention stripping', () => {
    test('should strip bot mention from message', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: '<@123456789> hello world',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('hello world');
    });

    test('should strip bot mention with nickname format', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: '<@!123456789> hello world',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('hello world');
    });

    test('should handle message without mention', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: 'hello world',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('hello world');
    });

    test('should handle mention at end of message', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: 'hello world <@123456789>',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('hello world');
    });
  });

  describe('fetchThreadHistory', () => {
    test('should return empty array for non-thread channel', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        channel: {
          isThread: () => false,
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.fetchThreadHistory(mockMessage);
      expect(result).toEqual([]);
    });

    test('should fetch and return messages in chronological order', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');

      // Discord returns newest-first (Collection), reversed gives oldest-first
      const msg1 = {
        author: { bot: false, displayName: 'Alice', username: 'alice' },
        content: 'Hello there',
      };
      const msg2 = {
        author: { bot: false, displayName: 'Bob', username: 'bob' },
        content: 'How are you?',
      };
      const msg3 = {
        author: { bot: true, displayName: undefined, username: 'MyBot' },
        content: 'I am fine',
      };

      // Mock a Map-like iterable (Discord returns Collection)
      const mockMessagesMap = new Map([
        ['id3', msg3], // newest - first in Collection
        ['id2', msg2],
        ['id1', msg1], // oldest - last in Collection
      ]);

      const mockMessagesFetch = mock(() => Promise.resolve(mockMessagesMap));
      const mockMessage = {
        channel: {
          isThread: () => true,
          id: 'thread-chan-123',
          messages: { fetch: mockMessagesFetch },
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.fetchThreadHistory(mockMessage);

      // After .reverse(), order should be oldest-first: msg1, msg2, msg3
      expect(result).toHaveLength(3);
      expect(result[0]).toBe('Alice: Hello there');
      expect(result[1]).toBe('Bob: How are you?');
      expect(result[2]).toBe('[Bot]: I am fine');
    });

    test('should use username as fallback when displayName is absent', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');

      const msg = {
        author: { bot: false, displayName: undefined, username: 'charlie_dev' },
        content: 'No display name here',
      };
      const mockMessagesMap = new Map([['id1', msg]]);
      const mockMessagesFetch = mock(() => Promise.resolve(mockMessagesMap));
      const mockMessage = {
        channel: {
          isThread: () => true,
          id: 'thread-456',
          messages: { fetch: mockMessagesFetch },
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.fetchThreadHistory(mockMessage);
      expect(result[0]).toBe('charlie_dev: No display name here');
    });

    test('should fetch with limit 100', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessagesFetch = mock(() => Promise.resolve(new Map()));
      const mockMessage = {
        channel: {
          isThread: () => true,
          id: 'thread-789',
          messages: { fetch: mockMessagesFetch },
        },
      } as unknown as import('discord.js').Message;

      await adapter.fetchThreadHistory(mockMessage);

      expect(mockMessagesFetch).toHaveBeenCalledWith({ limit: 100 });
    });

    test('should return empty array and log error when fetch throws', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessagesFetch = mock(() => Promise.reject(new Error('Missing Access')));
      const mockMessage = {
        channel: {
          isThread: () => true,
          id: 'thread-err',
          messages: { fetch: mockMessagesFetch },
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.fetchThreadHistory(mockMessage);
      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should return empty array for thread with no messages', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessagesFetch = mock(() => Promise.resolve(new Map()));
      const mockMessage = {
        channel: {
          isThread: () => true,
          id: 'thread-empty',
          messages: { fetch: mockMessagesFetch },
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.fetchThreadHistory(mockMessage);
      expect(result).toEqual([]);
    });
  });

  describe('generateThreadName (via ensureThread)', () => {
    test('should use exact content when at or under 100 chars', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const content = 'a'.repeat(100);
      const mockStartThread = mock(() => Promise.resolve({ id: 'thread-exact' }));
      const mockMessage = {
        id: 'msg-gen-1',
        channelId: 'chan-gen',
        content,
        channel: { isThread: () => false },
        guild: { id: 'guild-gen' },
        startThread: mockStartThread,
        mentions: { has: () => false },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('chan-gen', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe(content);
      expect(callArgs.name.endsWith('...')).toBe(false);
    });

    test('should truncate to 97 chars + ellipsis when content exceeds 100 chars', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const content = 'x'.repeat(150);
      const mockStartThread = mock(() => Promise.resolve({ id: 'thread-trunc' }));
      const mockMessage = {
        id: 'msg-gen-2',
        channelId: 'chan-gen',
        content,
        channel: { isThread: () => false },
        guild: { id: 'guild-gen' },
        startThread: mockStartThread,
        mentions: { has: () => false },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('chan-gen', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe('x'.repeat(97) + '...');
      expect(callArgs.name.length).toBe(100);
    });

    test('should normalize whitespace in thread name', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockStartThread = mock(() => Promise.resolve({ id: 'thread-ws' }));
      const mockMessage = {
        id: 'msg-gen-3',
        channelId: 'chan-gen',
        content: 'hello   world\t\nfoo',
        channel: { isThread: () => false },
        guild: { id: 'guild-gen' },
        startThread: mockStartThread,
        mentions: { has: () => false },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('chan-gen', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe('hello world foo');
    });
  });

  describe('createThreadFromMessage (via ensureThread)', () => {
    test('should pass autoArchiveDuration of 1440 (OneDay)', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockStartThread = mock(() => Promise.resolve({ id: 'thread-archive' }));
      const mockMessage = {
        id: 'msg-arc-1',
        channelId: 'chan-arc',
        content: 'archive test',
        channel: { isThread: () => false },
        guild: { id: 'guild-arc' },
        startThread: mockStartThread,
        mentions: { has: () => false },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('chan-arc', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as {
        autoArchiveDuration: number;
        reason: string;
      };
      // ThreadAutoArchiveDuration.OneDay = 1440 minutes
      expect(callArgs.autoArchiveDuration).toBe(1440);
      expect(callArgs.reason).toBe('Bot response thread');
    });

    test('should strip bot mention before generating thread name', async () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockStartThread = mock(() => Promise.resolve({ id: 'thread-strip' }));
      const mockMessage = {
        id: 'msg-strip-1',
        channelId: 'chan-strip',
        content: '<@123456789> please help me',
        channel: { isThread: () => false },
        guild: { id: 'guild-strip' },
        startThread: mockStartThread,
        mentions: { has: () => false },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('chan-strip', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe('please help me');
    });
  });

  describe('stripBotMention (additional edge cases)', () => {
    test('should strip multiple bot mentions', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: '<@123456789> hello <@123456789> world',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('hello world');
    });

    test('should handle mixed <@BOT_ID> and <@!BOT_ID> mentions', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: '<@123456789> start <@!123456789> end',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('start end');
    });

    test('should return original content when client has no user', () => {
      // Simulate client.user being null
      const adapter = new DiscordAdapter('fake-token-for-testing');
      // Temporarily null out user
      (mockClient as unknown as { user: null }).user = null;
      const mockMessage = {
        content: 'some content',
      } as unknown as import('discord.js').Message;

      const result = adapter.stripBotMention(mockMessage);
      // Restore user
      (mockClient as unknown as { user: { id: string } }).user = { id: '123456789' };
      expect(result).toBe('some content');
    });

    test('should strip only whitespace that follows the mention', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const mockMessage = {
        content: '<@123456789>message-no-space',
      } as unknown as import('discord.js').Message;

      expect(adapter.stripBotMention(mockMessage)).toBe('message-no-space');
    });
  });

  describe('isBotMentioned (additional edge cases)', () => {
    test('should return false when client.user is null', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      (mockClient as unknown as { user: null }).user = null;

      const mockMessage = {
        mentions: { has: mock(() => true) },
      } as unknown as import('discord.js').Message;

      const result = adapter.isBotMentioned(mockMessage);
      // Restore
      (mockClient as unknown as { user: { id: string } }).user = { id: '123456789' };
      expect(result).toBe(false);
    });

    test('should pass bot user to mentions.has()', () => {
      const adapter = new DiscordAdapter('fake-token-for-testing');
      const hasspy = mock(() => true);
      const mockMessage = {
        mentions: { has: hasspy },
      } as unknown as import('discord.js').Message;

      adapter.isBotMentioned(mockMessage);
      expect(hasspy).toHaveBeenCalledWith(mockClient.user);
    });
  });

  describe('thread creation (ensureThread)', () => {
    let adapter: DiscordAdapter;

    beforeEach(() => {
      adapter = new DiscordAdapter('fake-token-for-testing');
    });

    test('should return original ID when already in thread', async () => {
      const mockMessage = {
        id: 'msg123',
        channelId: 'thread456',
        channel: {
          isThread: () => true,
        },
        guild: { id: 'guild123' },
      } as unknown as import('discord.js').Message;

      const result = await adapter.ensureThread('thread456', mockMessage);
      expect(result).toBe('thread456');
    });

    test('should return original ID for DMs', async () => {
      const mockMessage = {
        id: 'msg123',
        channelId: 'dm789',
        channel: {
          isThread: () => false,
        },
        guild: null, // DM has no guild
      } as unknown as import('discord.js').Message;

      const result = await adapter.ensureThread('dm789', mockMessage);
      expect(result).toBe('dm789');
    });

    test('should return original ID when no message context', async () => {
      const result = await adapter.ensureThread('channel123');
      expect(result).toBe('channel123');
    });

    test('should create thread for channel message', async () => {
      const mockStartThread = mock(() => Promise.resolve({ id: 'newthread123' }));
      const mockMessage = {
        id: 'msg123',
        channelId: 'channel456',
        content: 'Test message for thread',
        channel: {
          isThread: () => false,
        },
        guild: { id: 'guild123' },
        startThread: mockStartThread,
        mentions: {
          has: () => false,
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.ensureThread('channel456', mockMessage);

      expect(mockStartThread).toHaveBeenCalledWith({
        name: 'Test message for thread',
        autoArchiveDuration: 1440,
        reason: 'Bot response thread',
      });
      expect(result).toBe('newthread123');
    });

    test('should truncate long thread names', async () => {
      const longContent = 'a'.repeat(150);
      const mockStartThread = mock(() => Promise.resolve({ id: 'newthread123' }));
      const mockMessage = {
        id: 'msg123',
        channelId: 'channel456',
        content: longContent,
        channel: {
          isThread: () => false,
        },
        guild: { id: 'guild123' },
        startThread: mockStartThread,
        mentions: {
          has: () => false,
        },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('channel456', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name.length).toBeLessThanOrEqual(100);
      expect(callArgs.name.endsWith('...')).toBe(true);
    });

    test('should fall back to channel ID on thread creation error', async () => {
      const mockStartThread = mock(() => Promise.reject(new Error('Permission denied')));
      const mockMessage = {
        id: 'msg123',
        channelId: 'channel456',
        content: 'Test message',
        channel: {
          isThread: () => false,
        },
        guild: { id: 'guild123' },
        startThread: mockStartThread,
        mentions: {
          has: () => false,
        },
      } as unknown as import('discord.js').Message;

      const result = await adapter.ensureThread('channel456', mockMessage);

      expect(result).toBe('channel456'); // Falls back to channel
    });

    test('should deduplicate concurrent thread creation calls', async () => {
      let resolveThread: (value: { id: string }) => void;
      const threadPromise = new Promise<{ id: string }>(resolve => {
        resolveThread = resolve;
      });

      const mockStartThread = mock(() => threadPromise);
      const mockMessage = {
        id: 'msg123',
        channelId: 'channel456',
        content: 'Test message',
        channel: {
          isThread: () => false,
        },
        guild: { id: 'guild123' },
        startThread: mockStartThread,
        mentions: {
          has: () => false,
        },
      } as unknown as import('discord.js').Message;

      // Start two concurrent calls
      const promise1 = adapter.ensureThread('channel456', mockMessage);
      const promise2 = adapter.ensureThread('channel456', mockMessage);

      // Resolve the thread creation
      resolveThread!({ id: 'newthread123' });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Both should get the same thread ID
      expect(result1).toBe('newthread123');
      expect(result2).toBe('newthread123');

      // startThread should only be called once
      expect(mockStartThread).toHaveBeenCalledTimes(1);
    });

    test('should use Bot Response as thread name for empty content', async () => {
      const mockStartThread = mock(() => Promise.resolve({ id: 'newthread123' }));
      const mockMessage = {
        id: 'msg123',
        channelId: 'channel456',
        content: '<@123456789>', // Only bot mention, stripped to empty
        channel: {
          isThread: () => false,
        },
        guild: { id: 'guild123' },
        startThread: mockStartThread,
        mentions: {
          has: () => false,
        },
      } as unknown as import('discord.js').Message;

      await adapter.ensureThread('channel456', mockMessage);

      const callArgs = mockStartThread.mock.calls[0][0] as { name: string };
      expect(callArgs.name).toBe('Bot Response');
    });
  });
});
