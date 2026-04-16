/**
 * Telegram platform adapter using grammY SDK
 * Handles message sending with 4096 character limit splitting
 */
import { Bot, Context } from 'grammy';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { parseAllowedUserIds, isUserAuthorized } from './auth';
import { convertToTelegramMarkdown, stripMarkdown } from './markdown';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { TelegramMessageContext } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram');
  return cachedLog;
}

const MAX_LENGTH = 4096;

export class TelegramAdapter implements IPlatformAdapter {
  private bot: Bot;
  private streamingMode: 'stream' | 'batch';
  private allowedUserIds: number[];
  private messageHandler: ((ctx: TelegramMessageContext) => Promise<void>) | null = null;

  constructor(token: string, mode: 'stream' | 'batch' = 'stream') {
    // grammY does not impose a handler timeout by default (unlike Telegraf's 90s limit)
    this.bot = new Bot(token);
    this.streamingMode = mode;

    // Parse Telegram user whitelist (optional - empty = open access)
    // Support both TELEGRAM_ALLOWED_USER_IDS and TELEGRAM_ALLOWED_USERS
    this.allowedUserIds = parseAllowedUserIds(
      process.env.TELEGRAM_ALLOWED_USER_IDS ?? process.env.TELEGRAM_ALLOWED_USERS
    );
    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'telegram.whitelist_enabled');
    } else {
      getLog().info('telegram.whitelist_disabled');
    }

    getLog().info({ mode }, 'telegram.adapter_initialized');
  }

  /**
   * Send a message to a Telegram chat
   * Automatically splits messages longer than 4096 characters
   *
   * Formatting strategy:
   * - Short messages (≤4096 chars): Convert to MarkdownV2 for nice formatting
   * - Long messages: Split by paragraphs, format each chunk independently
   *   (paragraphs rarely have formatting that spans across them)
   */
  async sendMessage(chatId: string, message: string, _metadata?: MessageMetadata): Promise<void> {
    const id = parseInt(chatId);
    getLog().debug({ chatId, messageLength: message.length }, 'telegram.send_message');

    if (message.length <= MAX_LENGTH) {
      // Short message: try MarkdownV2 formatting
      await this.sendFormattedChunk(id, message);
    } else {
      // Long message: split by paragraphs, format each chunk
      getLog().debug({ messageLength: message.length }, 'telegram.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 200);

      for (const chunk of chunks) {
        await this.sendFormattedChunk(id, chunk);
      }
    }
  }

  /**
   * Send a single chunk with MarkdownV2 formatting, with fallback to plain text
   */
  private async sendFormattedChunk(id: number, chunk: string): Promise<void> {
    // If chunk is still too long after paragraph splitting, fall back to plain text
    if (chunk.length > MAX_LENGTH) {
      getLog().debug({ chunkLength: chunk.length }, 'telegram.chunk_too_long_plain_text');
      const plainText = stripMarkdown(chunk);
      // Split by lines if still too long
      const lines = plainText.split('\n');
      let subChunk = '';
      for (const line of lines) {
        if (subChunk.length + line.length + 1 > MAX_LENGTH - 100) {
          if (subChunk) await this.bot.api.sendMessage(id, subChunk);
          subChunk = line;
        } else {
          subChunk += (subChunk ? '\n' : '') + line;
        }
      }
      if (subChunk) await this.bot.api.sendMessage(id, subChunk);
      return;
    }

    // Try MarkdownV2 formatting
    const formatted = convertToTelegramMarkdown(chunk);
    try {
      await this.bot.api.sendMessage(id, formatted, { parse_mode: 'MarkdownV2' });
      getLog().debug({ chunkLength: chunk.length }, 'telegram.markdownv2_chunk_sent');
    } catch (error) {
      // Fallback to stripped plain text for this chunk
      const err = error as Error;
      getLog().warn(
        {
          err,
          originalPreview: chunk.substring(0, 200),
          formattedPreview: formatted.substring(0, 200),
        },
        'telegram.markdownv2_failed'
      );
      await this.bot.api.sendMessage(id, stripMarkdown(chunk));
    }
  }

  /**
   * Get the grammY bot instance
   */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return 'telegram';
  }

  /**
   * Extract conversation ID from Telegram context
   */
  getConversationId(ctx: Context): string {
    if (!ctx.chat) {
      throw new Error('No chat in context');
    }
    return ctx.chat.id.toString();
  }

  /**
   * Ensure responses go to a thread.
   * Telegram doesn't have threads - each chat is a persistent conversation.
   * Returns original conversation ID unchanged.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  /**
   * Register a message handler for incoming messages
   * Must be called before start()
   */
  onMessage(handler: (ctx: TelegramMessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Start the bot (begins polling).
   * Makes up to 3 attempts on 409 Conflict (stale getUpdates connection).
   */
  async start(options?: { retryDelayMs?: number }): Promise<void> {
    // Register message handler before launch
    this.bot.on('message:text', ctx => {
      const message = ctx.message.text;
      if (!message) return;

      // Authorization check - verify sender is in whitelist
      const userId = ctx.from?.id;
      if (!isUserAuthorized(userId, this.allowedUserIds)) {
        // Log unauthorized attempt (mask user ID for privacy)
        const maskedId = userId !== undefined ? `${String(userId).slice(0, 4)}***` : 'unknown';
        getLog().info({ maskedUserId: maskedId }, 'telegram.unauthorized_message');
        return; // Silent rejection
      }

      if (this.messageHandler) {
        const conversationId = this.getConversationId(ctx);
        // Fire-and-forget - errors handled by caller
        void this.messageHandler({ conversationId, message, userId });
      } else {
        // Intentional: message dropped silently if handler not registered yet.
        // In production the server always calls onMessage() before start(); this
        // path only surfaces during development or misconfiguration.
        getLog().debug({ chatId: ctx.chat?.id }, 'telegram.message_dropped_no_handler');
      }
    });

    // Retry on 409 Conflict — another getUpdates is still active (Telegram's long-poll timeout is 50s).
    // Wait 60s between attempts to outlast the stale connection. Do NOT recreate the bot instance
    // on each retry — that adds more stale connections rather than fewer.
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = options?.retryDelayMs ?? 60_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // drop_pending_updates: true — discard queued messages from while the bot was offline
        // to avoid reprocessing stale commands after a container restart.
        // grammY's start() resolves only when the bot stops; use onStart callback to detect
        // successful launch and return immediately while the bot continues running in background.
        await new Promise<void>((resolve, reject) => {
          this.bot
            .start({
              drop_pending_updates: true,
              onStart: () => {
                resolve();
              },
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              // Log post-startup crashes — after onStart fires the reject() below is a no-op
              // (Promise already settled), but the error should still be observable in logs.
              getLog().error({ err: error }, 'telegram.bot_runtime_error');
              reject(error);
            });
        });
        getLog().info('telegram.bot_started');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const is409 = message.includes('409');
        if (is409 && attempt < MAX_ATTEMPTS) {
          getLog().warn(
            { err, attempt, maxAttempts: MAX_ATTEMPTS, retryDelayMs: RETRY_DELAY_MS },
            'telegram.start_conflict_retrying'
          );
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          throw err instanceof Error ? err : new Error(message);
        }
      }
    }
  }

  /**
   * Stop the bot gracefully
   */
  stop(): void {
    this.bot.stop();
    getLog().info('telegram.bot_stopped');
  }
}
