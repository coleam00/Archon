/**
 * Unit tests for Slack adapter
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { Mock } from 'bun:test';
import { tmpdir } from 'node:os';
import { basename, sep } from 'node:path';
import { readFile, rm } from 'node:fs/promises';

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
  getArchonHome: mock(() => tmpdir()),
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

  describe('downloadAttachments', () => {
    let adapter: SlackAdapter;
    const originalFetch = globalThis.fetch;
    const uploadDirs: string[] = [];

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      // Warn counts are asserted below, and the shared mock accumulates across
      // tests — an earlier 403 case would otherwise leak into those totals.
      mockLogger.warn.mockClear();
    });

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      for (const dir of uploadDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('returns an empty result when there are no files', async () => {
      const result = await adapter.downloadAttachments(undefined, 'C123:456.789');
      expect(result.files).toEqual([]);
      expect(result.uploadDir).toBe('');
    });

    test('downloads a file and saves it to disk as an AttachedFile', async () => {
      const content = 'hello world';
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(content, { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [
          {
            id: 'F1',
            name: 'notes.txt',
            mimetype: 'text/plain',
            size: content.length,
            url_private_download: 'https://files.slack.com/f1',
          },
        ],
        'C123:456.789'
      );
      uploadDirs.push(result.uploadDir);

      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.name).toBe('notes.txt');
      expect(result.files[0]?.mimeType).toBe('text/plain');
      expect(result.files[0]?.size).toBe(content.length);
      const saved = await readFile(result.files[0]?.path ?? '', 'utf-8');
      expect(saved).toBe(content);
    });

    test('skips a file over the size cap without failing the batch', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('irrelevant', { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [
          {
            id: 'F2',
            name: 'huge.bin',
            size: 11 * 1024 * 1024,
            url_private_download: 'https://files.slack.com/f2',
          },
        ],
        'C123:456.789'
      );
      expect(result.files).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('skips a file exceeding the cap when size is unknown and Content-Length is absent', async () => {
      // No `file.size` and a streamed (not buffered) response body: Content-Length
      // is never set, so neither pre-fetch check applies. This exercises the
      // post-download `buffer.byteLength` check that exists precisely as the
      // backstop for a missing or understated size.
      const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      });
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(stream, { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F5', name: 'huge-stream.bin', url_private_download: 'https://files.slack.com/f5' }],
        'C123:456.789'
      );
      expect(result.files).toEqual([]);
    });

    test('skips a file when the download response is not ok', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('', { status: 403 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F3', name: 'blocked.txt', url_private_download: 'https://files.slack.com/f3' }],
        'C123:456.789'
      );
      expect(result.files).toEqual([]);
    });

    test('uses a unique upload dir per call so concurrent thread messages cannot collide', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const file = {
        id: 'F1',
        name: 'a.txt',
        size: 1,
        url_private_download: 'https://files.slack.com/f1',
      };
      // Same conversation id — every message in a Slack thread shares one.
      const first = await adapter.downloadAttachments([file], 'C123:456.789');
      const second = await adapter.downloadAttachments([file], 'C123:456.789');
      uploadDirs.push(first.uploadDir, second.uploadDir);

      // Cleanup rm -rf's the whole dir, so sharing one would delete the other's
      // still-unread files (the downloads happen outside the conversation lock).
      expect(first.uploadDir).not.toBe(second.uploadDir);
      expect(first.files[0]?.path).not.toBe(second.files[0]?.path);
    });

    test('skips an oversized file by Content-Length, without buffering the body', async () => {
      let bodyRead = false;
      globalThis.fetch = mock(() => {
        const response = new Response('irrelevant', {
          status: 200,
          headers: { 'content-length': String(11 * 1024 * 1024) },
        });
        // Prove the body is never pulled into memory when the header alone
        // already tells us the file is too big.
        Object.defineProperty(response, 'arrayBuffer', {
          value: () => {
            bodyRead = true;
            return Promise.resolve(new ArrayBuffer(0));
          },
        });
        return Promise.resolve(response);
      }) as unknown as typeof fetch;

      // No `size` on the ref — the pre-flight metadata check cannot catch this.
      const result = await adapter.downloadAttachments(
        [{ id: 'F_BIG', name: 'big.bin', url_private_download: 'https://files.slack.com/big' }],
        'C123:456.789'
      );

      expect(result.files).toEqual([]);
      expect(bodyRead).toBe(false);
    });

    test('still catches an oversized file when Content-Length is absent', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x'.repeat(11 * 1024 * 1024), { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F_NOLEN', name: 'big.bin', url_private_download: 'https://files.slack.com/nolen' }],
        'C123:456.789'
      );

      expect(result.files).toEqual([]);
    });

    test('passes an abort signal so a stalled download cannot hang the message', async () => {
      let sawSignal = false;
      globalThis.fetch = mock((_url: string, init?: RequestInit) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return Promise.resolve(new Response('x', { status: 200 }));
      }) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [
          {
            id: 'F1',
            name: 'a.txt',
            size: 1,
            url_private_download: 'https://files.slack.com/f1',
          },
        ],
        'C123:456.789'
      );
      uploadDirs.push(result.uploadDir);

      expect(sawSignal).toBe(true);
    });

    test('skips an aborted download without failing the batch', async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F_SLOW', name: 'slow.txt', url_private_download: 'https://files.slack.com/slow' }],
        'C123:456.789'
      );

      expect(result.files).toEqual([]);
    });

    test('keeps a traversal-laden file id and name inside the upload dir', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      // Both components come from the Slack payload and are untrusted.
      const result = await adapter.downloadAttachments(
        [
          {
            id: '../../../etc',
            name: '../../../etc/passwd',
            size: 1,
            url_private_download: 'https://files.slack.com/evil',
          },
        ],
        'C123:456.789'
      );
      uploadDirs.push(result.uploadDir);

      const saved = result.files[0]?.path ?? '';
      expect(saved.startsWith(result.uploadDir + sep)).toBe(true);
      expect(saved).not.toContain('..');
      // Nothing may remain that could climb out of the per-call directory.
      expect(basename(saved)).toBe(saved.slice(result.uploadDir.length + 1));
    });

    test('refuses to send the bot token to a download URL that is not a slack.com host', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [
          {
            id: 'F_EVIL',
            name: 'a.txt',
            size: 1,
            // Not a Slack-controlled host — must be rejected before the bot
            // token is ever attached to a request.
            url_private_download: 'https://evil.example.com/f1',
          },
        ],
        'C123:456.789'
      );

      expect(result.files).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('refuses a non-HTTPS download URL even on a slack.com host', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [
          {
            id: 'F_HTTP',
            name: 'a.txt',
            size: 1,
            url_private_download: 'http://files.slack.com/f1',
          },
        ],
        'C123:456.789'
      );

      expect(result.files).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('sanitizes the conversation id used as the directory segment', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F1', name: 'a.txt', size: 1, url_private_download: 'https://files.slack.com/f1' }],
        '../../escape:99.9'
      );
      uploadDirs.push(result.uploadDir);

      // ':' is also invalid in Windows paths, so it must not survive either.
      expect(basename(result.uploadDir)).not.toContain('..');
      expect(basename(result.uploadDir)).not.toContain(':');
      expect(result.uploadDir).toContain('uploads');
    });

    test('warns once about files:read when downloads are rejected with 403', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('', { status: 403 }))
      ) as unknown as typeof fetch;

      await adapter.downloadAttachments(
        [{ id: 'F1', name: 'a.txt', url_private_download: 'https://files.slack.com/f1' }],
        'C123:456.789'
      );
      await adapter.downloadAttachments(
        [{ id: 'F2', name: 'b.txt', url_private_download: 'https://files.slack.com/f2' }],
        'C123:456.789'
      );

      // A standing misconfiguration: once per adapter, not once per file.
      const scopeWarns = (mockLogger.warn as unknown as Mock<() => void>).mock.calls.filter(
        c => c[1] === 'slack.files_read_missing_scope'
      );
      expect(scopeWarns).toHaveLength(1);
    });

    test('does not blame the scope for a non-auth failure', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('', { status: 500 }))
      ) as unknown as typeof fetch;

      await adapter.downloadAttachments(
        [{ id: 'F1', name: 'a.txt', url_private_download: 'https://files.slack.com/f1' }],
        'C123:456.789'
      );

      const scopeWarns = (mockLogger.warn as unknown as Mock<() => void>).mock.calls.filter(
        c => c[1] === 'slack.files_read_missing_scope'
      );
      expect(scopeWarns).toHaveLength(0);
    });

    test('reports why each attachment was dropped', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('', { status: 403 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [
          {
            id: 'F_BIG',
            name: 'dump.sql',
            size: 11 * 1024 * 1024,
            url_private_download: 'https://files.slack.com/big',
          },
          { id: 'F_403', name: 'blocked.txt', url_private_download: 'https://files.slack.com/f' },
          { id: 'F_NOURL', name: 'nourl.txt' },
        ],
        'C123:456.789'
      );

      expect(result.files).toEqual([]);
      // Every drop must be attributable — that is what the user gets told.
      expect(result.skipped).toEqual([
        { name: 'dump.sql', reason: 'too_large' },
        { name: 'blocked.txt', reason: 'download_failed' },
        { name: 'nourl.txt', reason: 'download_failed' },
      ]);
    });

    test('reports files dropped by the per-message cap as too_many', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const files = Array.from({ length: 7 }, (_, i) => ({
        id: `F${i.toString()}`,
        name: `f${i.toString()}.txt`,
        size: 1,
        url_private_download: `https://files.slack.com/f${i.toString()}`,
      }));
      const result = await adapter.downloadAttachments(files, 'C123:456.789');
      uploadDirs.push(result.uploadDir);

      expect(result.files).toHaveLength(5);
      expect(result.skipped).toEqual([
        { name: 'f5.txt', reason: 'too_many' },
        { name: 'f6.txt', reason: 'too_many' },
      ]);
    });

    test('reports an aborted download as a timeout', async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F_SLOW', name: 'slow.pdf', url_private_download: 'https://files.slack.com/slow' }],
        'C123:456.789'
      );

      expect(result.skipped).toEqual([{ name: 'slow.pdf', reason: 'timeout' }]);
    });

    test('reports nothing skipped on a clean download', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const result = await adapter.downloadAttachments(
        [{ id: 'F1', name: 'a.txt', size: 1, url_private_download: 'https://files.slack.com/f1' }],
        'C123:456.789'
      );
      uploadDirs.push(result.uploadDir);

      expect(result.skipped).toEqual([]);
    });

    test('truncates to the max files per message', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('x', { status: 200 }))
      ) as unknown as typeof fetch;

      const files = Array.from({ length: 7 }, (_, i) => ({
        id: `F${i.toString()}`,
        name: `f${i.toString()}.txt`,
        size: 1,
        url_private_download: `https://files.slack.com/f${i.toString()}`,
      }));
      const result = await adapter.downloadAttachments(files, 'C123:456.789');
      uploadDirs.push(result.uploadDir);
      expect(result.files).toHaveLength(5);
    });
  });
});
