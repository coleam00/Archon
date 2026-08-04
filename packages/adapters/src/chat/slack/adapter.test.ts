/**
 * Unit tests for Slack adapter
 */
import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
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
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
}));

// Create mock functions
const mockPostMessage = mock(() => Promise.resolve(undefined));
const mockReplies = mock(() => Promise.resolve({ messages: [] }));
const mockUsersInfo = mock(() =>
  Promise.resolve({
    user: {
      id: 'U123',
      real_name: 'Alice Liddell',
      profile: { email: 'alice@example.com' },
    },
  })
);
const mockConversationsInfo = mock(() =>
  Promise.resolve({
    channel: { id: 'C456', name: 'ai-web-project' } as {
      id: string;
      name?: string;
      is_im?: boolean;
    },
  })
);
const mockEvent = mock(() => {});
const mockStart = mock(() => Promise.resolve(undefined));
const mockStop = mock(() => Promise.resolve(undefined));
const mockCommand = mock(() => {});
const mockAction = mock(() => {});

const mockApp = {
  client: {
    chat: {
      postMessage: mockPostMessage,
    },
    conversations: {
      replies: mockReplies,
      info: mockConversationsInfo,
    },
    users: {
      info: mockUsersInfo,
    },
  },
  event: mockEvent,
  command: mockCommand,
  action: mockAction,
  start: mockStart,
  stop: mockStop,
};

// Mock @slack/bolt
mock.module('@slack/bolt', () => ({
  App: mock(() => mockApp),
  LogLevel: {
    INFO: 'info',
  },
}));

import { SlackAdapter } from './adapter';
import type { SlackMessageEvent } from './types';

describe('SlackAdapter', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to batch mode', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('platform type', () => {
    test('should return slack', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      expect(adapter.getPlatformType()).toBe('slack');
    });
  });

  describe('thread detection', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should detect thread when thread_ts differs from ts', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000001',
      };
      expect(adapter.isThread(event)).toBe(true);
    });

    test('should not detect thread when thread_ts equals ts', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.123456',
      };
      expect(adapter.isThread(event)).toBe(false);
    });

    test('should not detect thread when thread_ts is undefined', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
      };
      expect(adapter.isThread(event)).toBe(false);
    });
  });

  describe('conversation ID', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should return channel:thread_ts for thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000001',
      };
      expect(adapter.getConversationId(event)).toBe('C456:1234567890.000001');
    });

    test('should return channel:ts for non-thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
      };
      expect(adapter.getConversationId(event)).toBe('C456:1234567890.123456');
    });
  });

  describe('stripBotMention', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should strip bot mention from start', () => {
      expect(adapter.stripBotMention('<@U1234ABCD> /clone https://github.com/test/repo')).toBe(
        '/clone https://github.com/test/repo'
      );
    });

    test('should strip multiple mentions', () => {
      expect(adapter.stripBotMention('<@U1234ABCD> <@W5678EFGH> hello')).toBe('<@W5678EFGH> hello');
    });

    test('should return unchanged if no mention', () => {
      expect(adapter.stripBotMention('/status')).toBe('/status');
    });

    test('should normalize Slack URL formatting', () => {
      expect(adapter.stripBotMention('<@U1234ABCD> /clone <https://github.com/test/repo>')).toBe(
        '/clone https://github.com/test/repo'
      );
    });

    test('should normalize Slack URL with label', () => {
      expect(
        adapter.stripBotMention(
          '<@U1234ABCD> check <https://github.com/test/repo|github.com/test/repo>'
        )
      ).toBe('check https://github.com/test/repo');
    });

    test('should normalize multiple URLs', () => {
      expect(
        adapter.stripBotMention(
          '<@U1234ABCD> compare <https://github.com/a> and <https://github.com/b>'
        )
      ).toBe('compare https://github.com/a and https://github.com/b');
    });
  });

  describe('parent conversation ID', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should return parent conversation ID for thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000001',
      };
      expect(adapter.getParentConversationId(event)).toBe('C456:1234567890.000001');
    });

    test('should return null for non-thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
      };
      expect(adapter.getParentConversationId(event)).toBe(null);
    });
  });

  describe('app instance', () => {
    test('should provide access to app instance', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const app = adapter.getApp();
      expect(app).toBeDefined();
      expect(app.client).toBeDefined();
    });
  });

  describe('thread creation (ensureThread)', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should return original ID unchanged (threading via conversation ID pattern)', async () => {
      // Slack threading works via the "channel:ts" conversation ID pattern
      // No additional thread creation needed
      const result = await adapter.ensureThread('C123:1234567890.123456');
      expect(result).toBe('C123:1234567890.123456');
    });

    test('should work with thread conversation IDs', async () => {
      const result = await adapter.ensureThread('C123:1234567890.000001');
      expect(result).toBe('C123:1234567890.000001');
    });

    test('should work with channel-only IDs', async () => {
      // Edge case: if somehow only channel ID is passed
      const result = await adapter.ensureThread('C123');
      expect(result).toBe('C123');
    });
  });

  describe('message formatting', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockPostMessage.mockClear();
    });

    test('should send short messages with markdown block', async () => {
      await adapter.sendMessage('C123:1234.5678', '**Hello** world');

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '1234.5678',
        blocks: [
          {
            type: 'markdown',
            text: '**Hello** world',
          },
        ],
        text: '**Hello** world',
      });
    });

    test('should send messages without thread_ts when not in thread', async () => {
      await adapter.sendMessage('C123', 'Hello');

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: undefined,
        blocks: [
          {
            type: 'markdown',
            text: 'Hello',
          },
        ],
        text: 'Hello',
      });
    });

    test('should truncate fallback text for long messages', async () => {
      const longMessage = 'a'.repeat(200);
      await adapter.sendMessage('C123', longMessage);

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'a'.repeat(150) + '...',
        })
      );
    });

    test('should fallback to plain text when markdown block fails', async () => {
      mockPostMessage
        .mockRejectedValueOnce(new Error('markdown block not supported'))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('C123', 'test message');

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      // First call with markdown block
      expect(mockPostMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          blocks: expect.any(Array),
        })
      );
      // Second call plain text fallback
      expect(mockPostMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          text: 'test message',
        })
      );
      expect((mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[1][0]).not.toHaveProperty(
        'blocks'
      );
    });

    test('should split long messages into multiple markdown blocks', async () => {
      const paragraph1 = 'a'.repeat(10000);
      const paragraph2 = 'b'.repeat(10000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('C123', message);

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      // Both calls should use markdown blocks
      expect((mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[0][0]).toHaveProperty(
        'blocks'
      );
      expect((mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[1][0]).toHaveProperty(
        'blocks'
      );
    });

    test('should handle empty message without crashing', async () => {
      await adapter.sendMessage('C123', '');

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [{ type: 'markdown', text: '' }],
        })
      );
    });

    test('single-chunk message is sent without _part footer', async () => {
      await adapter.sendMessage('C1:111.0', 'short message');
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      const blocks = (mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[0][0].blocks;
      expect(blocks[0].text).toBe('short message');
      expect(blocks[0].text).not.toContain('_part ');
    });

    test('multi-chunk message annotates each part with _part i/n_', async () => {
      const paragraph1 = 'a'.repeat(10000);
      const paragraph2 = 'b'.repeat(10000);
      await adapter.sendMessage('C1:111.0', `${paragraph1}\n\n${paragraph2}`);
      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      const calls = (mockPostMessage as Mock<typeof mockPostMessage>).mock.calls;
      expect(calls[0][0].blocks[0].text).toContain('_part 1/2_');
      expect(calls[1][0].blocks[0].text).toContain('_part 2/2_');
    });
  });

  describe('triggering message tracking', () => {
    test('FIFO evicts oldest entry past the cap', async () => {
      // SlackAdapter caps the in-memory map at 1000 entries. To keep this
      // test fast we exercise the eviction trigger by pumping app_mention
      // events through the registered handler.
      mockEvent.mockClear();
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      adapter.onMessage(async () => {
        /* no-op handler; we only care about the trigger map side-effect */
      });
      await adapter.start();
      // Find the app_mention handler we just registered.
      const calls = (mockEvent as unknown as Mock<(t: string, h: unknown) => void>).mock.calls;
      const mentionReg = calls.find(c => c[0] === 'app_mention');
      expect(mentionReg).toBeDefined();
      const handler = mentionReg![1] as (args: { event: SlackMessageEvent }) => Promise<void>;

      const CAP = 1000;
      for (let i = 0; i < CAP + 5; i++) {
        await handler({
          event: { text: 'hi', user: 'U1', channel: 'C1', ts: `${i}.0` },
        });
      }

      // Oldest 5 should be evicted (channel:ts pairs 0.0 .. 4.0)
      expect(adapter.getTriggeringMessage('C1:0.0')).toBeUndefined();
      expect(adapter.getTriggeringMessage('C1:4.0')).toBeUndefined();
      // Boundary: entry 5 is the new oldest and must still be tracked.
      expect(adapter.getTriggeringMessage('C1:5.0')).toEqual({ channel: 'C1', ts: '5.0' });
      // Newest entry must be present.
      expect(adapter.getTriggeringMessage(`C1:${CAP + 4}.0`)).toEqual({
        channel: 'C1',
        ts: `${CAP + 4}.0`,
      });
    });
  });

  describe('slash commands', () => {
    function findCommandHandler(name: string): (args: unknown) => Promise<void> {
      const calls = (mockCommand as unknown as Mock<(n: string, h: unknown) => void>).mock.calls;
      const reg = calls.find(c => c[0] === name);
      if (!reg) throw new Error(`no handler registered for ${name}`);
      return reg[1] as (args: unknown) => Promise<void>;
    }

    function makeSlashArgs(overrides: Record<string, unknown> = {}) {
      const ack = mock(async () => {});
      const respond = mock(async () => {});
      const fakeClient = { chat: { postMessage: mockPostMessage } };
      return {
        ack,
        respond,
        client: fakeClient,
        command: {
          user_id: 'U123',
          text: 'list',
          channel_id: 'C1',
          trigger_id: 't1',
          ...overrides,
        },
      };
    }

    test('unauthorized user is silently rejected — no respond, no seed post', async () => {
      mockPostMessage.mockClear();
      mockCommand.mockClear();
      const original = process.env.SLACK_ALLOWED_USER_IDS;
      process.env.SLACK_ALLOWED_USER_IDS = 'U1ALICE';
      try {
        const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
        adapter.onMessage(async () => {});
        await adapter.start();

        const handler = findCommandHandler('/archon-workflow');
        const args = makeSlashArgs({ user_id: 'U2BOB' });
        await handler(args);

        // ack always fires (Slack 3s deadline).
        expect((args.ack as Mock<() => Promise<void>>).mock.calls.length).toBe(1);
        // But the unauthorized branch must NOT speak back to the user
        // (mirrors the app_mention silent-rejection policy).
        expect((args.respond as Mock<() => Promise<void>>).mock.calls.length).toBe(0);
        expect(mockPostMessage).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) delete process.env.SLACK_ALLOWED_USER_IDS;
        else process.env.SLACK_ALLOWED_USER_IDS = original;
      }
    });

    test('seed-post failure surfaces ephemeral error and skips message handler', async () => {
      mockPostMessage.mockClear();
      mockCommand.mockClear();
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const onMessage = mock(async () => {});
      adapter.onMessage(onMessage);
      await adapter.start();

      // Reject the seed post — adapter must surface an ephemeral error and
      // never invoke the message handler with an undefined ts.
      const seedError = new Error('not_in_channel');
      const failingPost = mock(async () => Promise.reject(seedError));
      const fakeClient = { chat: { postMessage: failingPost } };
      const ack = mock(async () => {});
      const respond = mock(async () => {});

      const handler = findCommandHandler('/archon');
      await handler({
        ack,
        respond,
        client: fakeClient,
        command: {
          user_id: 'U123',
          text: 'hello',
          channel_id: 'C_HIDDEN',
          trigger_id: 't1',
        },
      });

      expect(failingPost).toHaveBeenCalledTimes(1);
      expect(onMessage).not.toHaveBeenCalled();
      const respondCalls = (respond as Mock<() => Promise<void>>).mock.calls;
      expect(respondCalls.length).toBe(1);
      expect((respondCalls[0]![0] as { response_type: string }).response_type).toBe('ephemeral');
    });
  });

  describe('fetchDisplayName (users.info enrichment)', () => {
    beforeEach(() => {
      mockUsersInfo.mockClear();
    });

    test('returns real_name from users.info on first call and caches result', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const name1 = await adapter.fetchDisplayName('U123');
      const name2 = await adapter.fetchDisplayName('U123');
      expect(name1).toBe('Alice Liddell');
      expect(name2).toBe('Alice Liddell');
      // Second call hits the in-memory cache — no second API call.
      expect(mockUsersInfo).toHaveBeenCalledTimes(1);
    });

    test('returns undefined and warn-logs once on missing_scope failure', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const slackErr = Object.assign(new Error('missing_scope'), {
        data: { error: 'missing_scope' },
      });
      mockUsersInfo.mockRejectedValueOnce(slackErr);

      const name = await adapter.fetchDisplayName('U_NEW');

      expect(name).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('missing_scope WARN fires only once per adapter even after many sightings', async () => {
      mockLogger.warn.mockClear();
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const makeErr = (): Error =>
        Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
      mockUsersInfo.mockRejectedValueOnce(makeErr());
      mockUsersInfo.mockRejectedValueOnce(makeErr());
      mockUsersInfo.mockRejectedValueOnce(makeErr());

      await adapter.fetchDisplayName('U_A');
      await adapter.fetchDisplayName('U_B');
      await adapter.fetchDisplayName('U_C');

      const missingScopeCalls = (
        mockLogger.warn as unknown as Mock<(obj: object, evt: string) => void>
      ).mock.calls.filter(c => c[1] === 'slack.users_info_missing_scope');
      expect(missingScopeCalls.length).toBe(1);
    });

    test('users_info_failed log strips err.data (no PII leak)', async () => {
      mockLogger.warn.mockClear();
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const slackErr = Object.assign(new Error('rate_limited'), {
        data: { error: 'rate_limited', response_metadata: { workspace: 'sensitive-info' } },
      });
      mockUsersInfo.mockRejectedValueOnce(slackErr);

      await adapter.fetchDisplayName('U_RATE');

      const failedCall = (
        mockLogger.warn as unknown as Mock<(obj: object, evt: string) => void>
      ).mock.calls.find(c => c[1] === 'slack.users_info_failed');
      expect(failedCall).toBeDefined();
      const payload = failedCall![0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('err');
      expect(JSON.stringify(payload)).not.toContain('sensitive-info');
      expect(payload).toHaveProperty('errMessage', 'rate_limited');
      expect(payload).toHaveProperty('slackErrorCode', 'rate_limited');
    });

    test('returns undefined for empty slackUserId without calling the API', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const name = await adapter.fetchDisplayName('');
      expect(name).toBeUndefined();
      expect(mockUsersInfo).not.toHaveBeenCalled();
    });

    test('retries on next sighting after failure (negative results not cached)', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockUsersInfo.mockRejectedValueOnce(new Error('rate_limited'));
      const first = await adapter.fetchDisplayName('U_RETRY');
      expect(first).toBeUndefined();

      mockUsersInfo.mockResolvedValueOnce({
        user: { id: 'U_RETRY', real_name: 'Eventually' },
      });
      const second = await adapter.fetchDisplayName('U_RETRY');
      expect(second).toBe('Eventually');
      expect(mockUsersInfo).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveChannelName', () => {
    beforeEach(() => {
      mockConversationsInfo.mockClear();
      mockLogger.warn.mockClear();
    });

    test('resolves a public channel to its name', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const result = await adapter.resolveChannelName('C456');

      expect(result).toEqual({ kind: 'name', name: 'ai-web-project' });
    });

    test('caches the resolved name (one API call for repeat lookups)', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      await adapter.resolveChannelName('C_CACHED');
      await adapter.resolveChannelName('C_CACHED');

      expect(mockConversationsInfo).toHaveBeenCalledTimes(1);
    });

    test('coalesces concurrent lookups for the same channel into one API call', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');

      let resolveApiCall!: (value: { channel: { id: string; name: string } }) => void;
      mockConversationsInfo.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveApiCall = resolve;
          })
      );

      // Start two lookups for the same channel BEFORE the mocked API call
      // ever resolves — the second must reuse the first's in-flight promise
      // rather than firing its own conversations.info request.
      const first = adapter.resolveChannelName('C_CONCURRENT');
      const second = adapter.resolveChannelName('C_CONCURRENT');

      resolveApiCall({ channel: { id: 'C_CONCURRENT', name: 'concurrent-channel' } });

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({ kind: 'name', name: 'concurrent-channel' });
      expect(secondResult).toEqual({ kind: 'name', name: 'concurrent-channel' });
      expect(mockConversationsInfo).toHaveBeenCalledTimes(1);
    });

    test('reports a DM as dm rather than a failed lookup', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockConversationsInfo.mockResolvedValueOnce({ channel: { id: 'D1', is_im: true } });

      expect(await adapter.resolveChannelName('D1')).toEqual({ kind: 'dm' });
    });

    test('caches a DM result too (it is a stable fact about the channel)', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockConversationsInfo.mockResolvedValueOnce({ channel: { id: 'D2', is_im: true } });
      await adapter.resolveChannelName('D2');
      await adapter.resolveChannelName('D2');

      expect(mockConversationsInfo).toHaveBeenCalledTimes(1);
    });

    test('returns unavailable and warns once on missing_scope', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const scopeError = Object.assign(new Error('missing_scope'), {
        data: { error: 'missing_scope' },
      });
      mockConversationsInfo.mockRejectedValueOnce(scopeError);
      expect(await adapter.resolveChannelName('C_NOSCOPE')).toEqual({ kind: 'unavailable' });

      mockConversationsInfo.mockRejectedValueOnce(scopeError);
      await adapter.resolveChannelName('C_NOSCOPE2');

      // Permanent misconfiguration: log once per adapter, not once per channel.
      const scopeWarns = (mockLogger.warn as unknown as Mock<() => void>).mock.calls.filter(
        c => c[1] === 'slack.channel_info_missing_scope'
      );
      expect(scopeWarns).toHaveLength(1);
    });

    test('does not retry a failed lookup within the backoff window', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockConversationsInfo.mockRejectedValueOnce(new Error('rate_limited'));
      expect(await adapter.resolveChannelName('C_RETRY')).toEqual({ kind: 'unavailable' });

      // A second lookup immediately after must NOT call the API again — the
      // whole point of bounding the retry rate. (No mock queued here: if the
      // implementation regresses and calls the API anyway, it falls through
      // to the describe block's default resolved mock, which the call-count
      // assertion below still catches.)
      expect(await adapter.resolveChannelName('C_RETRY')).toEqual({ kind: 'unavailable' });
      expect(mockConversationsInfo).toHaveBeenCalledTimes(1);
    });

    test('retries after the backoff window elapses — a scope added mid-flight recovers', async () => {
      const baseTime = 1_700_000_000_000;
      let mockedNow = baseTime;
      const nowSpy = spyOn(Date, 'now').mockImplementation(() => mockedNow);

      try {
        const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
        mockConversationsInfo.mockRejectedValueOnce(new Error('rate_limited'));
        expect(await adapter.resolveChannelName('C_RETRY2')).toEqual({ kind: 'unavailable' });

        // Still within the backoff window: no retry.
        mockedNow = baseTime + 59_000;
        expect(await adapter.resolveChannelName('C_RETRY2')).toEqual({ kind: 'unavailable' });
        expect(mockConversationsInfo).toHaveBeenCalledTimes(1);

        // Past the backoff window: retries, and recovers.
        mockedNow = baseTime + 60_001;
        mockConversationsInfo.mockResolvedValueOnce({
          channel: { id: 'C_RETRY2', name: 'now-visible' },
        });
        expect(await adapter.resolveChannelName('C_RETRY2')).toEqual({
          kind: 'name',
          name: 'now-visible',
        });
        expect(mockConversationsInfo).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    test('honors a rate-limit retry_after hint instead of the default backoff', async () => {
      const baseTime = 1_700_000_000_000;
      let mockedNow = baseTime;
      const nowSpy = spyOn(Date, 'now').mockImplementation(() => mockedNow);

      try {
        const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
        const rateLimitError = Object.assign(new Error('rate_limited'), {
          data: { error: 'ratelimited', retry_after: 5 },
        });
        mockConversationsInfo.mockRejectedValueOnce(rateLimitError);
        expect(await adapter.resolveChannelName('C_RATELIMIT')).toEqual({ kind: 'unavailable' });

        // Default backoff (60s) would still be blocking here, but the 5s
        // retry_after hint should already have expired.
        mockedNow = baseTime + 5_001;
        mockConversationsInfo.mockResolvedValueOnce({
          channel: { id: 'C_RATELIMIT', name: 'now-visible' },
        });
        expect(await adapter.resolveChannelName('C_RATELIMIT')).toEqual({
          kind: 'name',
          name: 'now-visible',
        });
        expect(mockConversationsInfo).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    test('returns unavailable for an empty channel id without calling the API', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');

      expect(await adapter.resolveChannelName('')).toEqual({ kind: 'unavailable' });
      expect(mockConversationsInfo).not.toHaveBeenCalled();
    });
  });
});
