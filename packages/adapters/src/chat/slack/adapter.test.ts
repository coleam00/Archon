/**
 * Unit tests for Slack adapter
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

// Create mock functions
const mockPostMessage = mock(() => Promise.resolve(undefined));
const mockReplies = mock(() => Promise.resolve({ messages: [] }));
const mockReactionsAdd = mock(() => Promise.resolve({ ok: true }));
const mockEvent = mock(() => {});
const mockStart = mock(() => Promise.resolve(undefined));
const mockStop = mock(() => Promise.resolve(undefined));

const mockApp = {
  client: {
    chat: {
      postMessage: mockPostMessage,
    },
    conversations: {
      replies: mockReplies,
    },
    reactions: {
      add: mockReactionsAdd,
    },
  },
  event: mockEvent,
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
  });

  describe('interactive-loop gate rendering', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockPostMessage.mockClear();
    });

    test('renders Approve + Request changes buttons when interactiveGate is set', async () => {
      await adapter.sendMessage('C123:1234.5678', 'Review the plan summary.', {
        interactiveGate: { runId: 'run-abc', nodeId: 'refine-plan' },
      });

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      const call = (mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[0][0] as {
        blocks: unknown[];
      };
      expect(call.blocks).toHaveLength(2);
      const actionsBlock = call.blocks[1] as {
        type: string;
        block_id: string;
        elements: Array<{ action_id: string; style?: string; text: { text: string } }>;
      };
      expect(actionsBlock.type).toBe('actions');
      expect(actionsBlock.block_id).toBe('gate_block|run-abc|refine-plan');
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].action_id).toBe('gate_approve|run-abc|refine-plan');
      expect(actionsBlock.elements[0].style).toBe('primary');
      expect(actionsBlock.elements[0].text.text).toBe('Approve');
      expect(actionsBlock.elements[1].action_id).toBe('gate_request_changes|run-abc|refine-plan');
      expect(actionsBlock.elements[1].text.text).toBe('Request changes');
    });

    test('omits gate buttons when no interactiveGate metadata is present', async () => {
      await adapter.sendMessage('C123:1234.5678', 'plain message');

      const call = (mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[0][0] as {
        blocks: unknown[];
      };
      expect(call.blocks).toHaveLength(1);
      expect((call.blocks[0] as { type: string }).type).toBe('markdown');
    });

    test('attaches buttons only to the final chunk of a long message', async () => {
      const paragraph1 = 'a'.repeat(10000);
      const paragraph2 = 'b'.repeat(10000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('C123', message, {
        interactiveGate: { runId: 'run-1', nodeId: 'gate-n' },
      });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      const first = (mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[0][0] as {
        blocks: unknown[];
      };
      const second = (mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[1][0] as {
        blocks: unknown[];
      };
      // First chunk has only markdown; second chunk has markdown + actions.
      expect(first.blocks).toHaveLength(1);
      expect(second.blocks).toHaveLength(2);
      expect((second.blocks[1] as { type: string }).type).toBe('actions');
    });
  });

  describe('acknowledgeReceipt', () => {
    const event: SlackMessageEvent = {
      text: 'hello',
      user: 'U123',
      channel: 'C456',
      ts: '1234567890.000001',
    };

    beforeEach(() => {
      mockReactionsAdd.mockClear();
    });

    test('posts :eyes: reaction on the incoming message', async () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      await adapter.acknowledgeReceipt(event);

      expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
      const args = (mockReactionsAdd as Mock<typeof mockReactionsAdd>).mock.calls[0][0] as {
        channel: string;
        timestamp: string;
        name: string;
      };
      expect(args.channel).toBe('C456');
      expect(args.timestamp).toBe('1234567890.000001');
      expect(args.name).toBe('eyes');
    });

    test('does not throw when reactions:write scope is missing', async () => {
      // Simulate Slack's `missing_scope` error shape.
      const scopeError = Object.assign(new Error('missing_scope'), {
        data: { error: 'missing_scope', needed: 'reactions:write' },
      });
      mockReactionsAdd.mockImplementationOnce(() => Promise.reject(scopeError));

      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      // If this rejected, the test runner would surface it — proving graceful handling.
      await adapter.acknowledgeReceipt(event);
      expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
    });

    test('silently skips when message already has the reaction', async () => {
      const alreadyReacted = Object.assign(new Error('already_reacted'), {
        data: { error: 'already_reacted' },
      });
      mockReactionsAdd.mockImplementationOnce(() => Promise.reject(alreadyReacted));

      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      await adapter.acknowledgeReceipt(event);
      expect(mockReactionsAdd).toHaveBeenCalledTimes(1);
    });
  });
});
