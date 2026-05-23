/**
 * Slack platform adapter using @slack/bolt with Socket Mode
 * Handles message sending with markdown block formatting for AI responses
 */
import { App, LogLevel } from '@slack/bolt';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { isSlackUserAuthorized } from './auth';
import { parseAllowedUserIds } from './auth';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { SlackMessageEvent } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.slack');
  return cachedLog;
}

const MAX_MARKDOWN_BLOCK_LENGTH = 12000; // Slack markdown block limit

export class SlackAdapter implements IPlatformAdapter {
  private app: App;
  private streamingMode: 'stream' | 'batch';
  private messageHandler: ((event: SlackMessageEvent) => Promise<void>) | null = null;
  private allowedUserIds: string[];
  /** Tracks the "thinking" ack message per conversation so the first
   * outgoing reply can morph it via chat.update instead of posting fresh. */
  private pendingAcks: Map<string, string> = new Map();

  constructor(botToken: string, appToken: string, mode: 'stream' | 'batch' = 'batch') {
    this.app = new App({
      token: botToken,
      socketMode: true,
      appToken: appToken,
      logLevel: LogLevel.INFO,
    });
    this.streamingMode = mode;

    // Parse Slack user whitelist (optional - empty = open access)
    this.allowedUserIds = parseAllowedUserIds(process.env.SLACK_ALLOWED_USER_IDS);
    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'slack.whitelist_enabled');
    } else {
      getLog().info('slack.whitelist_disabled');
    }

    getLog().info({ mode }, 'slack.adapter_initialized');
  }

  /**
   * Send a message to a Slack channel/thread
   * Uses markdown block for proper formatting of AI responses
   * Automatically splits messages longer than 12000 characters
   */
  async sendMessage(
    channelId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    getLog().debug({ channelId, messageLength: message.length }, 'slack.send_message');

    // Parse channelId - may include thread_ts as "channel:thread_ts"
    const [channel, threadTs] = channelId.includes(':')
      ? channelId.split(':')
      : [channelId, undefined];

    // If we have a pending "thinking" ack for this conversation, morph the
    // first chunk into the ack via chat.update so users see a single message
    // transition from "thinking…" to the reply with no flicker.
    const pendingAckTs = this.pendingAcks.get(channelId);

    if (message.length <= MAX_MARKDOWN_BLOCK_LENGTH) {
      if (pendingAckTs) {
        this.pendingAcks.delete(channelId);
        await this.updateWithMarkdownBlock(channel, pendingAckTs, message, threadTs);
      } else {
        await this.sendWithMarkdownBlock(channel, message, threadTs);
      }
    } else {
      // Long message: split by paragraphs
      getLog().debug({ messageLength: message.length }, 'slack.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_MARKDOWN_BLOCK_LENGTH - 500);

      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && pendingAckTs) {
          this.pendingAcks.delete(channelId);
          await this.updateWithMarkdownBlock(channel, pendingAckTs, chunks[i], threadTs);
        } else {
          await this.sendWithMarkdownBlock(channel, chunks[i], threadTs);
        }
      }
    }
  }

  /**
   * Replace an existing message in-place via chat.update. Used to morph the
   * "thinking" ack into the actual reply. Falls back to posting a new
   * message if the update fails (e.g. message was deleted by user).
   */
  private async updateWithMarkdownBlock(
    channel: string,
    ts: string,
    message: string,
    threadTs?: string
  ): Promise<void> {
    try {
      await this.app.client.chat.update({
        channel,
        ts,
        blocks: [{ type: 'markdown', text: message }],
        text: message.substring(0, 150) + (message.length > 150 ? '...' : ''),
      });
      getLog().debug({ ts, messageLength: message.length }, 'slack.ack_updated');
    } catch (error) {
      getLog().warn({ err: error, channel, ts }, 'slack.ack_update_failed');
      await this.sendWithMarkdownBlock(channel, message, threadTs);
    }
  }

  /**
   * Send a message using Slack's markdown block for proper formatting
   * Falls back to plain text if block fails
   */
  private async sendWithMarkdownBlock(
    channel: string,
    message: string,
    threadTs?: string
  ): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks: [
          {
            type: 'markdown',
            text: message,
          },
        ],
        // Fallback text for notifications/accessibility
        text: message.substring(0, 150) + (message.length > 150 ? '...' : ''),
      });
      getLog().debug({ messageLength: message.length }, 'slack.markdown_block_sent');
    } catch (error) {
      // Fallback to plain text
      const err = error as Error;
      getLog().warn({ err, channel, threadTs }, 'slack.markdown_block_failed');
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: message,
      });
    }
  }

  /**
   * Post a transient "thinking" acknowledgment so users see the bot received
   * their message while the workflow runs. Returns the channel:ts of the
   * posted message so callers can delete or update it later if desired.
   */
  async sendThinkingAck(channelId: string): Promise<string | null> {
    const [channel, threadTs] = channelId.includes(':')
      ? channelId.split(':')
      : [channelId, undefined];

    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: ':hourglass_flowing_sand: _Archon is thinking…_',
      });
      if (result.ts) {
        // Remember this ack so sendMessage can chat.update it instead of
        // posting a new reply, giving a single seamless message.
        this.pendingAcks.set(channelId, result.ts);
        getLog().info({ channel, ts: result.ts }, 'slack.thinking_ack_sent');
        return `${channel}:${result.ts}`;
      }
      getLog().warn({ channel, threadTs, result }, 'slack.thinking_ack_no_ts');
      return null;
    } catch (error) {
      getLog().warn({ err: error, channel, threadTs }, 'slack.thinking_ack_failed');
      return null;
    }
  }

  /**
   * Clear a still-pending "thinking" ack (workflow errored before replying).
   * No-op if sendMessage already consumed the ack via chat.update — that's
   * the happy path and the ack message IS now the reply, so we mustn't
   * delete it.
   */
  async clearPendingAck(channelId: string): Promise<void> {
    const ts = this.pendingAcks.get(channelId);
    if (!ts) return;
    this.pendingAcks.delete(channelId);
    const [channel] = channelId.includes(':') ? channelId.split(':') : [channelId];
    try {
      await this.app.client.chat.delete({ channel, ts });
    } catch (error) {
      getLog().warn({ err: error, channel, ts }, 'slack.clear_pending_ack_failed');
    }
  }

  /**
   * Get the Bolt App instance
   */
  getApp(): App {
    return this.app;
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
    return 'slack';
  }

  /**
   * Check if a message is in a thread
   */
  isThread(event: SlackMessageEvent): boolean {
    return event.thread_ts !== undefined && event.thread_ts !== event.ts;
  }

  /**
   * Get parent conversation ID for a thread message
   * Returns null if not in a thread
   */
  getParentConversationId(event: SlackMessageEvent): string | null {
    if (this.isThread(event)) {
      // Parent conversation is the channel with the original message ts
      return `${event.channel}:${event.thread_ts}`;
    }
    return null;
  }

  /**
   * Fetch thread history (messages in the thread)
   * Returns messages in chronological order (oldest first)
   */
  async fetchThreadHistory(event: SlackMessageEvent): Promise<string[]> {
    if (!this.isThread(event) || !event.thread_ts) {
      return [];
    }

    try {
      const result = await this.app.client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 100,
      });

      if (!result.messages) {
        return [];
      }

      // Messages are already in chronological order
      return result.messages.map(msg => {
        const author = msg.bot_id ? '[Bot]' : `<@${msg.user}>`;
        return `${author}: ${msg.text ?? ''}`;
      });
    } catch (error) {
      getLog().error({ err: error }, 'slack.thread_history_fetch_failed');
      return [];
    }
  }

  /**
   * Get conversation ID from Slack event
   * For threads: returns "channel:thread_ts" to maintain thread context
   * For non-threads: returns channel ID only
   */
  getConversationId(event: SlackMessageEvent): string {
    // If in a thread, use "channel:thread_ts" format
    // This ensures thread replies stay in the same conversation
    if (event.thread_ts) {
      return `${event.channel}:${event.thread_ts}`;
    }
    // If starting a new conversation in channel, use "channel:ts"
    // so future replies create a thread
    return `${event.channel}:${event.ts}`;
  }

  /**
   * Strip bot mention from message text and normalize Slack formatting
   */
  stripBotMention(text: string): string {
    // Slack mentions are <@USERID> format
    // Remove all user mentions at the start of the message
    let result = text.replace(/^<@[UW][A-Z0-9]+>\s*/g, '').trim();

    // Normalize Slack URL formatting: <https://example.com> -> https://example.com
    // Also handles URLs with labels: <https://example.com|example.com> -> https://example.com
    result = result.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g, '$1');

    return result;
  }

  /**
   * Ensure responses go to a thread.
   * For Slack, this is a no-op because:
   * 1. getConversationId() already returns "channel:ts" for non-thread messages
   * 2. sendMessage() parses this and uses ts as thread_ts
   * 3. This means all replies already go to threads
   *
   * @returns The original conversation ID (already thread-safe)
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    // Slack's conversation ID pattern already ensures threading:
    // - Non-thread: "channel:ts" → sendMessage uses ts as thread_ts
    // - In-thread: "channel:thread_ts" → sendMessage uses thread_ts
    // No additional work needed.
    return originalConversationId;
  }

  /**
   * Register a message handler for incoming messages
   * Must be called before start()
   */
  onMessage(handler: (event: SlackMessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Start the bot (connects via Socket Mode)
   */
  async start(): Promise<void> {
    // Register app_mention event handler (when bot is @mentioned)
    this.app.event('app_mention', async ({ event }) => {
      // Authorization check
      const userId = event.user;
      if (!isSlackUserAuthorized(userId, this.allowedUserIds)) {
        const maskedId = userId ? `${userId.slice(0, 4)}***` : 'unknown';
        getLog().info({ maskedUserId: maskedId }, 'slack.unauthorized_message');
        return;
      }

      if (this.messageHandler && event.user) {
        const messageEvent: SlackMessageEvent = {
          text: event.text,
          user: event.user,
          channel: event.channel,
          ts: event.ts,
          thread_ts: event.thread_ts,
        };
        // Fire-and-forget - errors handled by caller
        void this.messageHandler(messageEvent);
      }
    });

    // Also handle direct messages (DMs don't require @mention)
    this.app.event('message', async ({ event }) => {
      // Only handle DM messages (channel type 'im')
      // Skip if this is a message in a channel (requires @mention via app_mention)
      // The 'channel_type' is on certain event subtypes
      const channelType = (event as { channel_type?: string }).channel_type;
      if (channelType !== 'im') {
        return;
      }

      // Skip bot messages to prevent loops
      if ('bot_id' in event && event.bot_id) {
        return;
      }

      // Authorization check
      const userId = 'user' in event ? event.user : undefined;
      if (!isSlackUserAuthorized(userId, this.allowedUserIds)) {
        const maskedId = userId ? `${userId.slice(0, 4)}***` : 'unknown';
        getLog().info({ maskedUserId: maskedId }, 'slack.unauthorized_dm');
        return;
      }

      if (this.messageHandler && 'text' in event && event.text) {
        const messageEvent: SlackMessageEvent = {
          text: event.text,
          user: userId ?? '',
          channel: event.channel,
          ts: event.ts,
          thread_ts: 'thread_ts' in event ? event.thread_ts : undefined,
        };
        void this.messageHandler(messageEvent);
      }
    });

    await this.app.start();
    getLog().info('slack.bot_started');
  }

  /**
   * Stop the bot gracefully
   */
  stop(): void {
    void this.app.stop();
    getLog().info('slack.bot_stopped');
  }
}
