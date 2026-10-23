import { App, LogLevel, type SlashCommand } from '@slack/bolt';
import {
  ChatStartError,
  type ChatContext,
  type ChatSend,
  type ChatResultFooter,
} from '@archon/chat-contract';
import { formatCostFooter } from './blocks';
import { logFailure } from './log';
import { descriptor } from './descriptor';

const MAX_MARKDOWN_BLOCK_LENGTH = 12000;

export interface SlackMessageRef {
  channel: string;
  ts: string;
}
export interface SlackMessageEvent extends SlackMessageRef {
  user: string;
  text: string;
  thread_ts?: string;
}

export function splitConversationId(id: string): [string, string | undefined] {
  const index = id.indexOf(':');
  return index < 0 ? [id, undefined] : [id.slice(0, index), id.slice(index + 1)];
}

export function stripBotMention(text: string): string {
  const normalized = text
    .replace(/^<@[UW][A-Z0-9]+>\s*/g, '')
    .trim()
    .replace(/<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g, '$1');
  // Slack intercepts /reset before it reaches the bot.
  return normalized.toLowerCase() === 'reset' ? '/reset' : normalized;
}

export function splitMessage(text: string): string[] {
  const limit = MAX_MARKDOWN_BLOCK_LENGTH - 64;
  const chunks: string[] = [];
  while (text.length > limit) {
    let end = text.lastIndexOf('\n\n', limit);
    if (end <= 0) end = text.lastIndexOf('\n', limit);
    if (end <= 0) end = limit;
    // Avoid splitting a UTF-16 surrogate pair when a long line has no breaks.
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

export class SlackAdapter {
  private app?: App;
  private ctx?: ChatContext;
  private readonly triggers = new Map<string, SlackMessageRef>();
  private readonly names = new Map<string, string>();

  constructor(
    private readonly createApp: (botToken: string, appToken: string) => App = (token, appToken) =>
      new App({
        token,
        appToken,
        socketMode: true,
        // Bolt's default logger includes incoming payloads on some failure paths.
        logLevel: LogLevel.ERROR,
        logger: {
          debug(): void {
            return undefined;
          },
          info(): void {
            return undefined;
          },
          warn(): void {
            return undefined;
          },
          error(...errors: unknown[]): void {
            logFailure('bolt', errors[0]);
          },
          setLevel(): void {
            return undefined;
          },
          getLevel(): LogLevel {
            return LogLevel.ERROR;
          },
          setName(): void {
            return undefined;
          },
        },
      })
  ) {}

  getApp(): App {
    if (!this.app) throw new Error('Slack has not started');
    return this.app;
  }

  getTriggeringMessage(conversationId: string): SlackMessageRef | undefined {
    return this.triggers.get(conversationId);
  }

  clearTriggeringMessage(conversationId: string): void {
    this.triggers.delete(conversationId);
  }

  private trackTrigger(id: string, ref: SlackMessageRef): void {
    if (!this.triggers.has(id) && this.triggers.size >= 1000) {
      const oldest = this.triggers.keys().next().value;
      if (oldest !== undefined) this.triggers.delete(oldest);
    }
    this.triggers.set(id, ref);
  }

  async fetchDisplayName(user: string): Promise<string | undefined> {
    const cached = this.names.get(user);
    if (cached) return cached;
    try {
      const { user: info } = await this.getApp().client.users.info({ user });
      const name = info?.real_name ?? info?.profile?.display_name ?? info?.name;
      if (name) this.names.set(user, name);
      return name;
    } catch (err) {
      logFailure('users.info', err);
      return undefined;
    }
  }

  async receive(event: SlackMessageEvent): Promise<void> {
    const text = stripBotMention(event.text);
    if (!text || !event.user || !this.ctx) return;
    const conversationId = `${event.channel}:${event.thread_ts ?? event.ts}`;
    const inThread = event.thread_ts !== undefined && event.thread_ts !== event.ts;
    let threadContext: string | undefined;
    if (inThread && event.thread_ts) {
      try {
        const result = await this.getApp().client.conversations.replies({
          channel: event.channel,
          ts: event.thread_ts,
          limit: 100,
        });
        const history = result.messages?.filter(message => message.ts !== event.ts);
        if (history?.length)
          threadContext = history
            .map(
              message => `${message.bot_id ? '[Bot]' : `<@${message.user}>`}: ${message.text ?? ''}`
            )
            .join('\n');
      } catch (err) {
        logFailure('conversations.replies', err);
      }
    }
    this.trackTrigger(conversationId, { channel: event.channel, ts: event.ts });
    try {
      const result = await this.ctx.inbound({
        conversationId,
        parentConversationId: inThread ? conversationId : undefined,
        text,
        threadContext,
        sender: {
          platformUserId: event.user,
          displayName: await this.fetchDisplayName(event.user),
        },
      });
      if (result.status === 'rejected') this.clearTriggeringMessage(conversationId);
    } catch (err) {
      logFailure('inbound', err);
      await this.send({
        conversationId,
        text: ':warning: Could not deliver the message. Check the server status and try again.',
      });
    }
  }

  async start(ctx: ChatContext, registerActions: () => void): Promise<void> {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!botToken || !appToken)
      throw new ChatStartError('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required', false);
    this.ctx = ctx;
    this.app = this.createApp(botToken, appToken);
    this.app.event('app_mention', async ({ event }) => {
      if (event.user) await this.receive({ ...event, user: event.user });
    });
    this.app.event('message', async ({ event }) => {
      if (
        !('channel_type' in event) ||
        event.channel_type !== 'im' ||
        ('bot_id' in event && event.bot_id) ||
        !('user' in event) ||
        !event.user ||
        !('text' in event) ||
        !event.text
      )
        return;
      await this.receive({
        channel: event.channel,
        ts: event.ts,
        user: event.user,
        text: event.text,
        thread_ts: 'thread_ts' in event ? event.thread_ts : undefined,
      });
    });
    for (const [kind, name] of [
      ['archon', '/archon'],
      ['workflow', descriptor.workflowCommand.prefix.trimEnd()],
    ] as const) {
      this.app.command(name, async ({ command, ack, respond }) => {
        await ack();
        await this.slashCommand(command, respond, kind);
      });
    }
    this.app.error(async err => {
      logFailure('handler', err);
    });
    // Bolt requires all event and action registration before opening Socket Mode.
    registerActions();
    await this.app.start();
  }

  private async slashCommand(
    command: SlashCommand,
    respond: (message: { response_type: 'ephemeral'; text: string }) => Promise<unknown>,
    kind: 'archon' | 'workflow'
  ): Promise<void> {
    const raw = command.text.trim();
    if (!raw) {
      await respond({
        response_type: 'ephemeral',
        text:
          kind === 'archon'
            ? 'Usage: `/archon <message>` — talk to Archon in this channel.'
            : `Usage: \`${descriptor.workflowCommand.prefix}<subcommand>\` — e.g. \`list\`, \`status\`, \`get <id>\`, \`run <name> <args>\`, \`approve <id>\`, \`reject <id> <reason>\`, \`abandon <id>\`.`,
      });
      return;
    }
    // This is Slack's explicit command syntax, not an interpretation of chat prose.
    if (kind === 'archon' && /^connect\s+github\b/i.test(raw)) {
      await respond({
        response_type: 'ephemeral',
        text: 'Connect GitHub through the Archon Web UI or run `archon auth github`.',
      });
      return;
    }
    let seedTs: string | undefined;
    try {
      const seed = await this.getApp().client.chat.postMessage({
        channel: command.channel_id,
        text:
          kind === 'archon'
            ? `<@${command.user_id}> via /archon: ${raw}`
            : `<@${command.user_id}> ran \`${descriptor.workflowCommand.prefix}${raw}\``,
      });
      seedTs = seed.ts;
    } catch (err) {
      logFailure('slash.seed', err);
    }
    if (!seedTs) {
      await respond({
        response_type: 'ephemeral',
        text: 'Could not start the conversation — is the bot invited here?',
      });
      return;
    }
    await respond({
      response_type: 'ephemeral',
      text: `Running \`${kind === 'archon' ? raw : `${descriptor.workflowCommand.prefix}${raw}`}\` — see thread for output.`,
    });
    await this.receive({
      channel: command.channel_id,
      ts: seedTs,
      user: command.user_id,
      text: kind === 'archon' ? raw : `/workflow ${raw}`,
    });
  }

  async send({ conversationId, text }: ChatSend): Promise<void> {
    const [channel, threadTs] = splitConversationId(conversationId);
    const chunks = text.length <= MAX_MARKDOWN_BLOCK_LENGTH ? [text] : splitMessage(text);
    for (const [index, chunk] of chunks.entries()) {
      const body = chunks.length > 1 ? `${chunk}\n\n_part ${index + 1}/${chunks.length}_` : chunk;
      try {
        await this.getApp().client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          blocks: [{ type: 'markdown', text: body }],
          text: body.slice(0, 150) + (body.length > 150 ? '...' : ''),
        });
      } catch (err) {
        // Keep the existing plain-text fallback for Slack clients rejecting markdown blocks.
        logFailure('chat.markdown', err);
        await this.getApp().client.chat.postMessage({ channel, thread_ts: threadTs, text: body });
      }
    }
  }

  async resultFooter(params: ChatResultFooter): Promise<void> {
    const text = formatCostFooter(params);
    if (!text) return;
    const [channel, threadTs] = splitConversationId(params.conversationId);
    try {
      await this.getApp().client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }],
      });
    } catch (err) {
      logFailure('chat.footer', err);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.app?.stop();
    } finally {
      this.triggers.clear();
      this.names.clear();
    }
  }
}
