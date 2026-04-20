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
import jsYaml from 'js-yaml';

/**
 * Gate action-id + modal callback-id encoding. runId and nodeId are packed
 * with a non-colliding separator so the Slack callback can recover them
 * without depending on out-of-band state. Separator `|` is safe: workflow
 * runIds are UUIDs and node ids are YAML keys (no pipes).
 */
const GATE_SEP = '|';
const GATE_ACTION_APPROVE = 'gate_approve';
const GATE_ACTION_REQUEST_CHANGES = 'gate_request_changes';
const GATE_ACTION_ANSWER_QUESTIONS = 'gate_answer_questions';
const GATE_MODAL_CALLBACK = 'gate_changes_modal';
const QUESTIONS_MODAL_CALLBACK = 'gate_questions_modal';
const QUESTIONS_BLOCK_REGEX = /```archon-questions\n([\s\S]*?)```/m;

type QuestionType = 'yes_no' | 'yes_no_text' | 'select' | 'checkboxes' | 'text';
interface QuestionOption {
  value: string;
  label: string;
}
interface QuestionDef {
  id: string;
  type: QuestionType;
  label: string;
  required?: boolean;
  options?: QuestionOption[];
  open_text_label?: string;
}

function encodeGateActionId(prefix: string, runId: string, nodeId: string): string {
  return `${prefix}${GATE_SEP}${runId}${GATE_SEP}${nodeId}`;
}

function decodeGateActionId(
  actionId: string | undefined
): { runId: string; nodeId: string } | null {
  if (!actionId) return null;
  const parts = actionId.split(GATE_SEP);
  if (parts.length !== 3) return null;
  const [, runId, nodeId] = parts;
  if (!runId || !nodeId) return null;
  return { runId, nodeId };
}

/**
 * Block type used for Slack message blocks. We don't import @slack/types
 * directly — the adapter package only declares @slack/bolt, and the exact
 * block shape is validated at runtime by Slack's API. An opaque record keeps
 * the compile boundary narrow while still allowing typed construction.
 */
type SlackBlock = Record<string, unknown>;

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
   *
   * When `metadata.interactiveGate` is set, the final chunk is followed by
   * an Approve / Request changes action block. All other adapters ignore the
   * field, so the text body already includes the `/workflow approve` fallback
   * and remains complete on every platform.
   */
  async sendMessage(channelId: string, message: string, metadata?: MessageMetadata): Promise<void> {
    getLog().debug({ channelId, messageLength: message.length }, 'slack.send_message');

    // Parse channelId - may include thread_ts as "channel:thread_ts"
    const [channel, threadTs] = channelId.includes(':')
      ? channelId.split(':')
      : [channelId, undefined];

    const gate = metadata?.interactiveGate;

    if (message.length <= MAX_MARKDOWN_BLOCK_LENGTH) {
      await this.sendWithMarkdownBlock(channel, message, threadTs, gate);
    } else {
      getLog().debug({ messageLength: message.length }, 'slack.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_MARKDOWN_BLOCK_LENGTH - 500);

      // Attach gate buttons only to the LAST chunk so a long gate prompt still
      // ends with a single actionable row.
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        await this.sendWithMarkdownBlock(channel, chunks[i], threadTs, isLast ? gate : undefined);
      }
    }
  }

  /**
   * Send a message using Slack's markdown block for proper formatting.
   * Falls back to plain text if block fails.
   *
   * When `gate` is provided, append an Actions block with Approve / Request
   * changes buttons whose action_ids carry the runId + nodeId. This lets the
   * user resolve interactive-loop gates with one click instead of typing
   * `/workflow approve <uuid>`.
   */
  private async sendWithMarkdownBlock(
    channel: string,
    message: string,
    threadTs?: string,
    gate?: { runId: string; nodeId: string }
  ): Promise<void> {
    const { cleanedMessage, questions } = this.extractQuestionsBlock(message);
    const blocks: SlackBlock[] = [{ type: 'markdown', text: cleanedMessage }];
    if (gate && questions) {
      blocks.push(this.buildQuestionsActionsBlock(gate, questions));
    } else if (gate) {
      blocks.push(this.buildGateActionsBlock(gate));
    }
    try {
      // Cast through `unknown`: SlackBlock is an opaque record by design
      // (see type definition). Slack's runtime validates the exact shape, and
      // the pre-refactor markdown block was already being cast implicitly.
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks,
        // Fallback text for notifications/accessibility
        text: cleanedMessage.substring(0, 150) + (cleanedMessage.length > 150 ? '...' : ''),
      } as unknown as Parameters<typeof this.app.client.chat.postMessage>[0]);
      getLog().debug(
        {
          messageLength: cleanedMessage.length,
          gate: Boolean(gate),
          hasQuestions: Boolean(questions),
        },
        'slack.markdown_block_sent'
      );
    } catch (error) {
      // Fallback to plain text. Gate buttons are sacrificed in this fallback
      // path; the message body still contains the `/workflow approve ...`
      // instructions so the user retains a way to resolve the gate.
      const err = error as Error;
      getLog().warn({ err, channel, threadTs }, 'slack.markdown_block_failed');
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: cleanedMessage,
      });
    }
  }

  /**
   * Build the Actions block with Approve (primary) and Request changes
   * (neutral) buttons. Action ids pack the workflow run + node so the click
   * callback can resolve the target without consulting DB state.
   */
  private buildGateActionsBlock(gate: { runId: string; nodeId: string }): SlackBlock {
    return {
      type: 'actions',
      block_id: encodeGateActionId('gate_block', gate.runId, gate.nodeId),
      elements: [
        {
          type: 'button',
          action_id: encodeGateActionId(GATE_ACTION_APPROVE, gate.runId, gate.nodeId),
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          value: 'approve',
        },
        {
          type: 'button',
          action_id: encodeGateActionId(GATE_ACTION_REQUEST_CHANGES, gate.runId, gate.nodeId),
          text: { type: 'plain_text', text: 'Request changes', emoji: true },
          value: 'request_changes',
        },
      ],
    };
  }

  /**
   * Extract and strip the `archon-questions` fenced block from a message.
   * Returns the cleaned message (always stripped) and parsed questions (null if
   * invalid or absent).
   */
  private extractQuestionsBlock(message: string): {
    cleanedMessage: string;
    questions: QuestionDef[] | null;
  } {
    const match = QUESTIONS_BLOCK_REGEX.exec(message);
    if (!match) return { cleanedMessage: message, questions: null };

    const cleanedMessage = message.replace(QUESTIONS_BLOCK_REGEX, '').trim();
    const questions = this.parseQuestionsYaml(match[1]);
    return { cleanedMessage, questions };
  }

  private parseQuestionsYaml(raw: string): QuestionDef[] | null {
    try {
      const parsed = jsYaml.load(raw);
      if (!this.isValidQuestionDefArray(parsed)) return null;
      return parsed;
    } catch (e) {
      const err = e as Error;
      getLog().warn({ reason: err.message }, 'slack.questions_schema_invalid');
      return null;
    }
  }

  private isValidQuestionDefArray(value: unknown): value is QuestionDef[] {
    if (!Array.isArray(value) || value.length === 0) {
      getLog().warn({ reason: 'not a non-empty array' }, 'slack.questions_schema_invalid');
      return false;
    }
    const validTypes: QuestionType[] = ['yes_no', 'yes_no_text', 'select', 'checkboxes', 'text'];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        getLog().warn({ reason: 'item is not an object' }, 'slack.questions_schema_invalid');
        return false;
      }
      const q = item as Record<string, unknown>;
      if (typeof q.id !== 'string' || typeof q.label !== 'string') {
        getLog().warn({ reason: 'missing id or label' }, 'slack.questions_schema_invalid');
        return false;
      }
      if (!validTypes.includes(q.type as QuestionType)) {
        getLog().warn(
          { reason: `unknown type: ${String(q.type)}` },
          'slack.questions_schema_invalid'
        );
        return false;
      }
      if ((q.type === 'select' || q.type === 'checkboxes') && !Array.isArray(q.options)) {
        getLog().warn({ reason: `${q.type} missing options` }, 'slack.questions_schema_invalid');
        return false;
      }
    }
    return true;
  }

  /**
   * Build an actions block with a single "Answer questions" button.
   * The questions array is encoded in the action value so the click handler
   * can reconstruct the modal without DB state.
   */
  private buildQuestionsActionsBlock(
    gate: { runId: string; nodeId: string },
    questions: QuestionDef[]
  ): SlackBlock {
    return {
      type: 'actions',
      block_id: encodeGateActionId('gate_questions_block', gate.runId, gate.nodeId),
      elements: [
        {
          type: 'button',
          action_id: encodeGateActionId(GATE_ACTION_ANSWER_QUESTIONS, gate.runId, gate.nodeId),
          style: 'primary',
          text: { type: 'plain_text', text: 'Answer questions', emoji: true },
          value: JSON.stringify(questions),
        },
      ],
    };
  }

  /**
   * Build modal input blocks for all supported question types.
   */
  private buildQuestionsModalBlocks(questions: QuestionDef[]): SlackBlock[] {
    const blocks: SlackBlock[] = [];
    for (const q of questions) {
      const isRequired = q.required !== false;
      switch (q.type) {
        case 'yes_no':
          blocks.push({
            type: 'input',
            block_id: q.id,
            optional: !isRequired,
            label: { type: 'plain_text', text: q.label },
            element: {
              type: 'radio_buttons',
              action_id: `${q.id}_input`,
              options: [
                { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
                { text: { type: 'plain_text', text: 'No' }, value: 'no' },
              ],
            },
          });
          break;
        case 'yes_no_text':
          blocks.push({
            type: 'input',
            block_id: q.id,
            optional: !isRequired,
            label: { type: 'plain_text', text: q.label },
            element: {
              type: 'radio_buttons',
              action_id: `${q.id}_input`,
              options: [
                { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
                { text: { type: 'plain_text', text: 'No' }, value: 'no' },
              ],
            },
          });
          blocks.push({
            type: 'input',
            block_id: `${q.id}_text`,
            optional: true,
            label: {
              type: 'plain_text',
              text: q.open_text_label ?? 'Additional details (optional)',
            },
            element: {
              type: 'plain_text_input',
              action_id: `${q.id}_text_input`,
              multiline: true,
            },
          });
          break;
        case 'select':
          blocks.push({
            type: 'input',
            block_id: q.id,
            optional: !isRequired,
            label: { type: 'plain_text', text: q.label },
            element: {
              type: 'static_select',
              action_id: `${q.id}_input`,
              options: (q.options ?? []).map(o => ({
                text: { type: 'plain_text', text: o.label },
                value: o.value,
              })),
            },
          });
          break;
        case 'checkboxes':
          blocks.push({
            type: 'input',
            block_id: q.id,
            optional: !isRequired,
            label: { type: 'plain_text', text: q.label },
            element: {
              type: 'checkboxes',
              action_id: `${q.id}_input`,
              options: (q.options ?? []).map(o => ({
                text: { type: 'plain_text', text: o.label },
                value: o.value,
              })),
            },
          });
          break;
        case 'text':
          blocks.push({
            type: 'input',
            block_id: q.id,
            optional: !isRequired,
            label: { type: 'plain_text', text: q.label },
            element: {
              type: 'plain_text_input',
              action_id: `${q.id}_input`,
              multiline: true,
            },
          });
          break;
      }
    }
    return blocks;
  }

  /**
   * Format modal submission values into deterministic text for `$LOOP_USER_INPUT`.
   */
  private formatQuestionsAnswersForLoop(
    questions: QuestionDef[],
    values: Record<
      string,
      Record<
        string,
        {
          value?: string | null;
          selected_option?: { value?: string } | null;
          selected_options?: { value?: string }[];
        }
      >
    >
  ): string {
    const lines: string[] = ['Answers:'];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const blockValues = values[q.id];
      const actionValues = blockValues?.[`${q.id}_input`];
      let answer: string;

      switch (q.type) {
        case 'yes_no':
          answer = actionValues?.selected_option?.value ?? '(no answer)';
          break;
        case 'yes_no_text': {
          const yn = actionValues?.selected_option?.value ?? '(no answer)';
          const textBlock = values[`${q.id}_text`];
          const openText = textBlock?.[`${q.id}_text_input`]?.value?.trim();
          answer = openText ? `${yn} \u2014 "${openText}"` : yn;
          break;
        }
        case 'select':
          answer = actionValues?.selected_option?.value ?? '(no answer)';
          break;
        case 'checkboxes': {
          const selected = actionValues?.selected_options?.map(o => o.value).filter(Boolean) ?? [];
          answer = selected.length > 0 ? selected.join(', ') : '(no answer)';
          break;
        }
        case 'text':
          answer = actionValues?.value?.trim() || '(no answer)';
          break;
        default:
          answer = '(no answer)';
      }
      lines.push(`${i + 1}. ${q.id}: ${answer}`);
    }
    return lines.join('\n');
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
   * Post an :eyes: reaction to the incoming message so the user knows the
   * bot received the request immediately — before thread-history fetch,
   * orchestration, lock acquisition, or first LLM token.
   *
   * Intentionally silent on failure:
   * - `reactions:write` scope is optional; missing-scope workspaces still
   *   get a working bot, just without the visual receipt.
   * - We never want a reaction error to block message processing.
   */
  async acknowledgeReceipt(event: SlackMessageEvent): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: 'eyes',
      });
      getLog().debug({ channel: event.channel, ts: event.ts }, 'slack.receipt_ack_sent');
    } catch (error) {
      const err = error as Error & { data?: { error?: string } };
      // `already_reacted` just means we're re-processing; not worth a warn.
      if (err.data?.error === 'already_reacted') {
        getLog().debug({ channel: event.channel }, 'slack.receipt_ack_already_reacted');
        return;
      }
      getLog().warn(
        { err, slackError: err.data?.error, channel: event.channel },
        'slack.receipt_ack_failed'
      );
    }
  }

  /**
   * Start the bot (connects via Socket Mode)
   */
  async start(): Promise<void> {
    this.registerGateHandlers();

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

  /**
   * Register Bolt handlers for gate buttons + the "Request changes" modal.
   *
   * Behavior:
   * - Approve click → synthesize a message event with text "approved" in the
   *   gate's thread; the natural-language approval path in handleMessage
   *   resumes the paused workflow run.
   * - Request changes click → open a modal; text entered on submit is
   *   synthesized as a thread message (treated as feedback by the loop).
   *
   * Action IDs are matched with the `gate_approve`/`gate_request_changes`
   * prefixes (exact action_ids are per-run and per-node). We register pattern
   * matchers so every live gate uses the same handler without per-run
   * subscriptions.
   */
  private registerGateHandlers(): void {
    // Approve button.
    this.app.action(
      { type: 'block_actions', action_id: new RegExp(`^${GATE_ACTION_APPROVE}\\|`) },
      async ({ ack, body, action, client }) => {
        await ack();
        await this.handleGateClick({
          body,
          action,
          client,
          verb: 'approve',
        });
      }
    );

    // Request changes button — opens a modal to collect feedback text.
    this.app.action(
      { type: 'block_actions', action_id: new RegExp(`^${GATE_ACTION_REQUEST_CHANGES}\\|`) },
      async ({ ack, body, action, client }) => {
        await ack();
        await this.handleRequestChangesClick({ body, action, client });
      }
    );

    // Answer questions button — opens a modal with typed inputs.
    this.app.action(
      { type: 'block_actions', action_id: new RegExp(`^${GATE_ACTION_ANSWER_QUESTIONS}\\|`) },
      async ({ ack, body, action, client }) => {
        await ack();
        await this.handleAnswerQuestionsClick({ body, action, client });
      }
    );

    // Modal submission — feedback text is synthesized as a thread message.
    this.app.view(GATE_MODAL_CALLBACK, async ({ ack, view, body }) => {
      await ack();
      await this.handleGateModalSubmit({ view, body });
    });

    // Questions modal submission — answers formatted and synthesized as thread message.
    this.app.view(QUESTIONS_MODAL_CALLBACK, async ({ ack, view, body }) => {
      await ack();
      await this.handleQuestionsModalSubmit({ view, body });
    });
  }

  /**
   * Handle Approve click: synthesize an "approved" message in the original
   * thread so the natural-language resume path fires.
   */
  private async handleGateClick(params: {
    body: unknown;
    action: unknown;
    // Typed as `unknown` because Bolt's client union is verbose; we only
    // call two well-known methods on it. Actual runtime value is a WebClient.
    client: unknown;
    verb: 'approve';
  }): Promise<void> {
    const { body, action, client } = params;
    const ctx = this.extractClickContext(body, action);
    const ids = decodeGateActionId((action as { action_id?: string }).action_id);
    if (!ctx) {
      getLog().warn({ ids }, 'slack.gate_click_missing_context');
      return;
    }
    getLog().info(
      { runId: ids?.runId, nodeId: ids?.nodeId, userId: ctx.userId },
      'slack.gate_approve_clicked'
    );

    // Best-effort: replace the actions row with a status context so the
    // buttons can't be clicked twice. Failure here is non-fatal.
    const webClient = client as {
      chat: { update: (args: Record<string, unknown>) => Promise<unknown> };
    };
    try {
      await webClient.chat.update({
        channel: ctx.channel,
        ts: ctx.messageTs,
        text: `Approved by <@${ctx.userId}>`,
        blocks: [
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `:white_check_mark: Approved by <@${ctx.userId}>`,
              },
            ],
          },
        ],
      });
    } catch (error) {
      getLog().warn({ err: error }, 'slack.gate_update_message_failed');
    }

    await this.dispatchSyntheticMessage({
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      userId: ctx.userId,
      text: 'approved',
    });
  }

  /**
   * Handle Request changes click: open a modal with a multiline textarea.
   * channel + thread + user are packed into `private_metadata` so the modal
   * submission handler can post a synthetic reply in the correct thread.
   */
  private async handleRequestChangesClick(params: {
    body: unknown;
    action: unknown;
    // See handleGateClick for rationale.
    client: unknown;
  }): Promise<void> {
    const { body, action, client } = params;
    const ctx = this.extractClickContext(body, action);
    const triggerId = this.extractTriggerId(body);
    const ids = decodeGateActionId((action as { action_id?: string }).action_id);
    if (!ctx || !triggerId) {
      getLog().warn({ ids }, 'slack.gate_changes_click_missing_context');
      return;
    }
    getLog().info(
      { runId: ids?.runId, nodeId: ids?.nodeId, userId: ctx.userId },
      'slack.gate_request_changes_clicked'
    );

    const privateMetadata = JSON.stringify({
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      userId: ctx.userId,
    });

    const webClient = client as {
      views: { open: (args: Record<string, unknown>) => Promise<unknown> };
    };
    try {
      await webClient.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: GATE_MODAL_CALLBACK,
          private_metadata: privateMetadata,
          title: { type: 'plain_text', text: 'Request changes' },
          submit: { type: 'plain_text', text: 'Send' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'feedback_block',
              label: {
                type: 'plain_text',
                text: 'What should change?',
              },
              element: {
                type: 'plain_text_input',
                action_id: 'feedback_input',
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text: 'e.g., drop the telemetry task, reorder DB migration first, tighten scope to auth only',
                },
              },
            },
          ],
        },
      });
    } catch (error) {
      getLog().error({ err: error }, 'slack.gate_modal_open_failed');
    }
  }

  /**
   * Handle modal submission: post the user's feedback text as a synthetic
   * thread message so the workflow's interactive loop receives it.
   */
  private async handleGateModalSubmit(params: { view: unknown; body: unknown }): Promise<void> {
    const { view, body } = params;
    const v = view as {
      private_metadata?: string;
      state?: { values?: Record<string, Record<string, { value?: string }>> };
    };

    let meta: { channel?: string; threadTs?: string; userId?: string } = {};
    try {
      meta = v.private_metadata ? (JSON.parse(v.private_metadata) as typeof meta) : {};
    } catch {
      getLog().warn('slack.gate_modal_bad_private_metadata');
      return;
    }
    const feedback = v.state?.values?.feedback_block?.feedback_input?.value?.trim();
    if (!meta.channel || !meta.threadTs || !feedback) {
      getLog().warn('slack.gate_modal_missing_fields');
      return;
    }

    // Prefer user id from body (authoritative) over private_metadata.
    const userId = (body as { user?: { id?: string } }).user?.id ?? meta.userId ?? 'unknown';

    await this.dispatchSyntheticMessage({
      channel: meta.channel,
      threadTs: meta.threadTs,
      userId,
      text: feedback,
    });
  }

  /**
   * Handle "Answer questions" click: open a modal with typed inputs built
   * from the question schema stored in the button's value.
   */
  private async handleAnswerQuestionsClick(params: {
    body: unknown;
    action: unknown;
    client: unknown;
  }): Promise<void> {
    const { body, action, client } = params;
    const ctx = this.extractClickContext(body, action);
    const triggerId = this.extractTriggerId(body);
    const ids = decodeGateActionId((action as { action_id?: string }).action_id);
    if (!ctx || !triggerId) {
      getLog().warn({ ids }, 'slack.questions_click_missing_context');
      return;
    }

    let questions: QuestionDef[];
    try {
      questions = JSON.parse((action as { value?: string }).value ?? '[]') as QuestionDef[];
    } catch {
      getLog().warn({ ids }, 'slack.questions_click_bad_value');
      return;
    }

    getLog().info(
      {
        runId: ids?.runId,
        nodeId: ids?.nodeId,
        userId: ctx.userId,
        questionCount: questions.length,
      },
      'slack.questions_modal_opening'
    );

    const privateMetadata = JSON.stringify({
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      userId: ctx.userId,
      questions,
    });

    const webClient = client as {
      views: { open: (args: Record<string, unknown>) => Promise<unknown> };
    };
    try {
      await webClient.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: QUESTIONS_MODAL_CALLBACK,
          private_metadata: privateMetadata,
          title: { type: 'plain_text', text: 'Scoping questions' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: this.buildQuestionsModalBlocks(questions),
        },
      });
    } catch (error) {
      getLog().error({ err: error }, 'slack.questions_modal_open_failed');
    }
  }

  /**
   * Handle questions modal submission: format answers and synthesize a thread
   * message so the workflow loop receives structured input.
   */
  private async handleQuestionsModalSubmit(params: {
    view: unknown;
    body: unknown;
  }): Promise<void> {
    const { view, body } = params;
    const v = view as {
      private_metadata?: string;
      state?: {
        values?: Record<
          string,
          Record<
            string,
            {
              value?: string | null;
              selected_option?: { value?: string } | null;
              selected_options?: { value?: string }[];
            }
          >
        >;
      };
    };

    let meta: { channel?: string; threadTs?: string; userId?: string; questions?: QuestionDef[] } =
      {};
    try {
      meta = v.private_metadata ? (JSON.parse(v.private_metadata) as typeof meta) : {};
    } catch {
      getLog().warn('slack.questions_modal_bad_private_metadata');
      return;
    }
    if (!meta.channel || !meta.threadTs || !meta.questions || !v.state?.values) {
      getLog().warn('slack.questions_modal_missing_fields');
      return;
    }

    const userId = (body as { user?: { id?: string } }).user?.id ?? meta.userId ?? 'unknown';
    const formattedAnswers = this.formatQuestionsAnswersForLoop(meta.questions, v.state.values);

    await this.dispatchSyntheticMessage({
      channel: meta.channel,
      threadTs: meta.threadTs,
      userId,
      text: formattedAnswers,
    });
  }

  /**
   * Extract channel, message ts, thread, and user from a block_actions body.
   * Returns null if any required field is missing (shouldn't happen in
   * practice; a defensive nullcheck keeps the handler resilient to future
   * Bolt payload changes).
   */
  private extractClickContext(
    body: unknown,
    _action: unknown
  ): { channel: string; messageTs: string; threadTs: string; userId: string } | null {
    const b = body as {
      channel?: { id?: string };
      message?: { ts?: string; thread_ts?: string };
      container?: { thread_ts?: string };
      user?: { id?: string };
    };
    const channel = b.channel?.id;
    const messageTs = b.message?.ts;
    const threadTs = b.message?.thread_ts ?? b.container?.thread_ts ?? messageTs;
    const userId = b.user?.id;
    if (!channel || !messageTs || !threadTs || !userId) return null;
    return { channel, messageTs, threadTs, userId };
  }

  private extractTriggerId(body: unknown): string | undefined {
    return (body as { trigger_id?: string }).trigger_id;
  }

  /**
   * Invoke the registered message handler with a synthetic event so button
   * clicks and modal submissions reuse the normal handleMessage pipeline
   * (including conversation-lock serialization and isolation context).
   */
  private async dispatchSyntheticMessage(params: {
    channel: string;
    threadTs: string;
    userId: string;
    text: string;
  }): Promise<void> {
    if (!this.messageHandler) {
      getLog().warn('slack.gate_synthetic_no_handler');
      return;
    }
    const event: SlackMessageEvent = {
      text: params.text,
      user: params.userId,
      channel: params.channel,
      // `ts` of a synthetic reply: reuse thread_ts; the orchestrator does not
      // persist this field, and no Slack API call depends on it.
      ts: params.threadTs,
      thread_ts: params.threadTs,
    };
    try {
      await this.messageHandler(event);
    } catch (error) {
      getLog().error({ err: error }, 'slack.gate_synthetic_dispatch_failed');
    }
  }
}
