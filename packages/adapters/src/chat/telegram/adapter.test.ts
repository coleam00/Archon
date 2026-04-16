/**
 * Unit tests for Telegram adapter
 *
 * Note: We use the real telegram-markdown module instead of mocking it.
 * Mocking internal modules with mock.module() causes test isolation issues
 * since the mock persists across test files.
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

import { TelegramAdapter } from './adapter';

describe('TelegramAdapter', () => {
  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to stream mode', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getStreamingMode()).toBe('stream');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('bot instance', () => {
    test('should provide access to bot instance', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const bot = adapter.getBot();
      expect(bot).toBeDefined();
      expect(bot.api).toBeDefined();
    });
  });

  describe('message formatting', () => {
    let adapter: TelegramAdapter;
    let mockSendMessage: Mock<() => Promise<void>>;

    beforeEach(() => {
      adapter = new TelegramAdapter('fake-token-for-testing');
      mockSendMessage = mock(() => Promise.resolve());
      // Override bot's sendMessage
      (adapter.getBot().api as unknown as { sendMessage: Mock<() => Promise<void>> }).sendMessage =
        mockSendMessage;
    });

    test('should send with MarkdownV2 parse_mode', async () => {
      await adapter.sendMessage('12345', '**test**');

      // Should send with MarkdownV2 parse_mode
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fallback to plain text when MarkdownV2 fails', async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('12345', '**test**');

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call with MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      // Second call plain text fallback (no parse_mode)
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 12345, expect.any(String));
    });

    test('should split long messages into multiple chunks', async () => {
      // Create a message that will be split (>4096 chars)
      const paragraph1 = 'a'.repeat(3000);
      const paragraph2 = 'b'.repeat(3000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('12345', message);

      // Should have sent multiple chunks
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Each chunk should be sent with MarkdownV2
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should handle single paragraph longer than MAX_LENGTH', async () => {
      // A single paragraph (no \n\n breaks) longer than MAX_LENGTH
      const longLine = 'x'.repeat(5000);
      await adapter.sendMessage('12345', longLine);
      // Should still send successfully via sendFormattedChunk fallback
      expect(mockSendMessage).toHaveBeenCalled();
    });

    test('should send each paragraph-split chunk independently', async () => {
      // Two large paragraphs (double-newline separated) that together exceed MAX_LENGTH.
      // splitIntoParagraphChunks breaks them apart so each chunk is under the limit.
      const para1 = 'A'.repeat(3000);
      const para2 = 'B'.repeat(3000);
      const message = `${para1}\n\n${para2}`;

      await adapter.sendMessage('55555', message);

      // Two separate sendMessage calls — one per paragraph chunk
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call has parse_mode: MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        55555,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        2,
        55555,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fall back to plain text and use line-based batching when MarkdownV2 fails on chunk', async () => {
      // First MarkdownV2 attempt fails; second call is plain-text fallback
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('77777', 'plain fallback text');

      // 2 calls: 1 failed MarkdownV2 + 1 plain text fallback
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Second call has no parse_mode (plain text)
      const secondCall = mockSendMessage.mock.calls[1];
      expect(secondCall.length).toBe(2); // (id, text) — no options object
    });
  });

  describe('getConversationId', () => {
    test('should return chat.id as string for private chat', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: 12345 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('12345');
    });

    test('should return chat.id as string for group chat', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: -987654321 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('-987654321');
    });

    test('should return chat.id as string for supergroup', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: -1001234567890 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('-1001234567890');
    });

    test('should throw when ctx.chat is undefined', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: undefined,
      } as unknown as import('grammy').Context;

      expect(() => adapter.getConversationId(ctx)).toThrow('No chat in context');
    });

    test('should throw when ctx.chat is null', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: null,
      } as unknown as import('grammy').Context;

      expect(() => adapter.getConversationId(ctx)).toThrow('No chat in context');
    });
  });

  describe('ensureThread', () => {
    test('should return the original conversation ID unchanged', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const result = await adapter.ensureThread('12345');
      expect(result).toBe('12345');
    });

    test('should return original ID even when messageContext is supplied', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const result = await adapter.ensureThread('99999', { some: 'context' });
      expect(result).toBe('99999');
    });
  });

  describe('platform type and streaming mode', () => {
    test('should return telegram as platform type', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getPlatformType()).toBe('telegram');
    });
  });

  describe('stop()', () => {
    test('should call bot.stop()', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStop = mock(() => undefined);
      (adapter.getBot() as unknown as { stop: typeof mockStop }).stop = mockStop;
      adapter.stop();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      mockLogger.warn.mockClear();
      mockLogger.info.mockClear();
    });

    test('should retry on 409 and succeed on second attempt', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      // grammY's start() resolves when bot stops, not when started — onStart fires on startup
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(new Error('409: Conflict: terminated by other getUpdates request'))
        .mockImplementationOnce(opts => {
          opts?.onStart?.();
          return new Promise(() => {});
        });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });

      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
        'telegram.start_conflict_retrying'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('telegram.bot_started');
    });

    test('should throw immediately on non-409 error', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >().mockRejectedValueOnce(new Error('401: Unauthorized'));
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow('401: Unauthorized');
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    test('should retry twice on 409 and succeed on third attempt', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const conflictError = new Error('409: Conflict: terminated by other getUpdates request');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError)
        .mockImplementationOnce(opts => {
          opts?.onStart?.();
          return new Promise(() => {});
        });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });

      expect(mockStart).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    test('should throw after exhausting all 409 retry attempts', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const conflictError = new Error('409: Conflict: terminated by other getUpdates request');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError);
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow('409');
      expect(mockStart).toHaveBeenCalledTimes(3);
    });
  });
});
