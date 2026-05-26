/**
 * Slack platform adapter using @slack/bolt with Socket Mode
 * Handles message sending with markdown block formatting for AI responses
 */
import { App, LogLevel, type SlashCommand } from '@slack/bolt';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { TokenUsage } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import { isSlackUserAuthorized } from './auth';
import { parseAllowedUserIds } from './auth';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import { formatCostFooter } from './blocks';
import type { SlackMessageEvent } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.slack');
  return cachedLog;
}

const MAX_MARKDOWN_BLOCK_LENGTH = 12000; // Slack markdown block limit

/** Slack channel + message ts pair used for reactions and edits. */
export interface SlackMessageRef {
  channel: string;
  ts: string;
}

/** Cap on the in-memory triggering-message map to prevent unbounded growth. */
const MAX_TRACKED_TRIGGERS = 1000;

export class SlackAdapter implements IPlatformAdapter {
  private app: App;
  private streamingMode: 'stream' | 'batch';
  private messageHandler: ((event: SlackMessageEvent) => Promise<void>) | null = null;
  private allowedUserIds: string[];
  /** Maps conversation ID → triggering Slack message so the bridge can react / edit. */
  private triggeringMessages = new Map<string, SlackMessageRef>();

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
   * Automatically splits messages longer than 12000 characters and footers each
   * chunk with `_part i/n_` so users know the output was wrapped.
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

    if (message.length <= MAX_MARKDOWN_BLOCK_LENGTH) {
      await this.sendWithMarkdownBlock(channel, message, threadTs);
      return;
    }

    getLog().debug({ messageLength: message.length }, 'slack.message_splitting');
    // Reserve headroom for the trailing "_part i/n_" footer. The longest footer
    // appears on the largest split (e.g. 7 chunks → "_part 7/7_") and is well
    // under 32 chars, so a 64-char reserve is comfortable.
    const chunks = splitIntoParagraphChunks(message, MAX_MARKDOWN_BLOCK_LENGTH - 500 - 64);
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const body = chunks[i] ?? '';
      const annotated = total > 1 ? `${body}\n\n_part ${i + 1}/${total}_` : body;
      await this.sendWithMarkdownBlock(channel, annotated, threadTs);
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
   * Append a small italic cost / token footer after a direct-chat assistant
   * turn. Posted as a context block so it visually de-emphasises vs the
   * assistant reply. No-op when there's nothing meaningful to surface.
   */
  async sendResultFooter(
    conversationId: string,
    info: { cost?: number; tokens?: TokenUsage; stopReason?: string }
  ): Promise<void> {
    const text = formatCostFooter(info);
    if (!text) return;

    const [channel, threadTs] = conversationId.includes(':')
      ? conversationId.split(':')
      : [conversationId, undefined];

    try {
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        blocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text }],
          },
        ],
      });
    } catch (error) {
      // Cost footer is informational only — never let it fail the conversation.
      getLog().warn({ err: error as Error, channel }, 'slack.result_footer_failed');
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
   * Returns the channel/ts of the inbound user message that triggered the
   * given conversation, if we have it. Workflow bridge uses this to add
   * lifecycle reactions to the user's mention/DM.
   */
  getTriggeringMessage(conversationId: string): SlackMessageRef | undefined {
    return this.triggeringMessages.get(conversationId);
  }

  /** Drop the cached triggering message for a conversation (e.g. on workflow terminal). */
  clearTriggeringMessage(conversationId: string): void {
    this.triggeringMessages.delete(conversationId);
  }

  /** Test seam: expose the configured whitelist to the workflow bridge. */
  getAllowedUserIds(): string[] {
    return this.allowedUserIds;
  }

  private trackTrigger(conversationId: string, ref: SlackMessageRef): void {
    // Defensive cap so chat-only conversations that never run a workflow
    // can't grow the map without bound.
    if (this.triggeringMessages.size >= MAX_TRACKED_TRIGGERS) {
      const oldest = this.triggeringMessages.keys().next().value;
      if (oldest !== undefined) {
        this.triggeringMessages.delete(oldest);
      }
    }
    this.triggeringMessages.set(conversationId, ref);
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
        this.trackTrigger(this.getConversationId(messageEvent), {
          channel: event.channel,
          ts: event.ts,
        });
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
        this.trackTrigger(this.getConversationId(messageEvent), {
          channel: event.channel,
          ts: event.ts,
        });
        void this.messageHandler(messageEvent);
      }
    });

    this.app.command('/archon', async ({ command, ack, respond, client }) => {
      await ack();
      await this.handleSlashCommand(command, respond, client, 'archon');
    });
    this.app.command('/archon-workflow', async ({ command, ack, respond, client }) => {
      await ack();
      await this.handleSlashCommand(command, respond, client, 'archon-workflow');
    });

    await this.app.start();
    getLog().info('slack.bot_started');
  }

  /**
   * Forward a slash command into the same message-handling flow used by
   * @mention. Slash commands carry no message ts of their own, so we first
   * post a visible "seed" message in the channel — its ts becomes the thread
   * root for everything that follows, giving slash-driven runs the same
   * threading model as @mention runs.
   */
  private async handleSlashCommand(
    command: SlashCommand,
    respond: (msg: { response_type: 'ephemeral' | 'in_channel'; text: string }) => Promise<unknown>,
    client: App['client'],
    kind: 'archon' | 'archon-workflow'
  ): Promise<void> {
    const actorId = command.user_id;
    if (!isSlackUserAuthorized(actorId, this.allowedUserIds)) {
      // Silent rejection with masked logging — matches the inbound event-handler
      // policy (see app_mention / message.im handlers above). Posting a denial
      // would tell unauthorized users a bot exists and is listening.
      getLog().info(
        { maskedUserId: `${actorId.slice(0, 4)}***`, kind },
        'slack.slash_unauthorized'
      );
      return;
    }

    if (!this.messageHandler) {
      await respond({
        response_type: 'ephemeral',
        text: 'Archon is starting up — try again in a moment.',
      });
      return;
    }

    const raw = (command.text ?? '').trim();
    if (!raw) {
      const help =
        kind === 'archon-workflow'
          ? 'Usage: `/archon-workflow <subcommand>` — e.g. `list`, `status`, `run <name> <args>`, `approve <id>`, `reject <id> <reason>`, `abandon <id>`.'
          : 'Usage: `/archon <message>` — talk to Archon in this channel.';
      await respond({ response_type: 'ephemeral', text: help });
      return;
    }

    const messageText = kind === 'archon-workflow' ? `/workflow ${raw}` : raw;

    // Post a visible seed message so the bot's responses thread cleanly under
    // a parent. The seed quotes the invoking user and the command they ran,
    // mirroring how @mention surfaces the original message in the thread.
    let seedTs: string | undefined;
    try {
      const seedText =
        kind === 'archon-workflow'
          ? `<@${actorId}> ran \`/archon-workflow ${raw}\``
          : `<@${actorId}> via /archon: ${raw}`;
      const posted = await client.chat.postMessage({
        channel: command.channel_id,
        text: seedText,
      });
      seedTs = posted.ts ?? undefined;
    } catch (error) {
      getLog().warn(
        { err: error as Error, channel: command.channel_id, kind },
        'slack.slash_seed_post_failed'
      );
      await respond({
        response_type: 'ephemeral',
        text: 'Could not post in this channel — is the bot invited here?',
      });
      return;
    }

    if (!seedTs) {
      await respond({
        response_type: 'ephemeral',
        text: 'Could not start the conversation (Slack returned no message id).',
      });
      return;
    }

    const messageEvent: SlackMessageEvent = {
      text: messageText,
      user: actorId,
      channel: command.channel_id,
      ts: seedTs,
    };
    this.trackTrigger(this.getConversationId(messageEvent), {
      channel: command.channel_id,
      ts: seedTs,
    });

    await respond({
      response_type: 'ephemeral',
      text:
        kind === 'archon-workflow'
          ? `Running \`/workflow ${raw}\` — see thread for output.`
          : `Running \`${raw}\` — see thread for output.`,
    });

    void this.messageHandler(messageEvent);
  }

  /**
   * Stop the bot gracefully
   */
  stop(): void {
    void this.app.stop();
    getLog().info('slack.bot_stopped');
  }
}
