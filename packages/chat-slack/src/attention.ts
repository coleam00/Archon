import type {
  ChatAttentionNotice,
  ChatAttentionNoticeRequest,
  ChatAttentionNoticeResponse,
  ChatContext,
  ChatRunAction,
} from '@archon/chat-contract';
import type { BlockAction, ViewSubmitAction } from '@slack/bolt';
import {
  NOTICE_ACTION_PATTERN,
  NOTICE_COMPOSE,
  NOTICE_PICK,
  NOTICE_SUBMIT,
  buildAttentionNoticeBlocks,
  buildComposeView,
  buildNoticeTerminalBlocks,
  buildSettledNoticeBlocks,
  parseNoticeAction,
} from './blocks';
import { SlackAdapter, splitConversationId, type SlackMessageRef } from './adapter';
import { resolutionNote } from './workflow-bridge';
import { logFailure } from './log';

const UNUSABLE_CONTROL =
  ':warning: This control could not be read. Answer in the Archon web console.';

type OpenNotice = Exclude<ChatAttentionNotice, { type: 'terminal' }>;

/** Where a notice control was used: the notice message, when Slack names it, and who acted. */
interface Origin {
  user: string;
  notice?: SlackMessageRef;
}

/**
 * Renders attention notices on configured routes and sends their answers to the host.
 * The host owns authorization and refuses answers to an occurrence that is no longer open,
 * so every control carries the run action it stands for and the notice's pause identity.
 */
export class SlackAttentionNotices {
  // Notice text for the answered or closed edit; after a restart that edit shows less.
  private readonly open = new Map<string, OpenNotice>();

  constructor(
    private readonly adapter: SlackAdapter,
    private readonly ctx: ChatContext
  ) {}

  attach(): void {
    const app = this.adapter.getApp();
    app.action<BlockAction>(NOTICE_ACTION_PATTERN, async ({ ack, body, action }) => {
      await ack();
      await this.onControl(body, action);
    });
    app.view<ViewSubmitAction>(NOTICE_COMPOSE, async ({ ack, body, view }) => {
      await ack();
      await this.onCompose(body.user.id, view.private_metadata, view.state.values);
    });
  }

  detach(): void {
    this.open.clear();
  }

  async notice({
    destination,
    conversationId,
    notice,
  }: ChatAttentionNoticeRequest): Promise<ChatAttentionNoticeResponse> {
    const client = this.adapter.getApp().client;
    if (notice.type === 'terminal') {
      const [channel, threadTs] = splitConversationId(conversationId ?? destination);
      const { blocks, fallbackText } = buildNoticeTerminalBlocks(notice);
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: fallbackText, blocks });
      await this.closeRun(notice.runId, `:lock: Closed, run ${notice.status}`);
      return {};
    }
    const [channel, threadTs] = splitConversationId(destination);
    const { blocks, fallbackText } = buildAttentionNoticeBlocks(notice);
    const { ts } = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: fallbackText,
      blocks,
    });
    if (!ts) return {};
    this.remember(`${channel}:${ts}`, notice);
    return { conversationId: `${channel}:${threadTs ?? ts}` };
  }

  private remember(key: string, notice: OpenNotice): void {
    if (this.open.size >= 1000) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.open.set(key, notice);
  }

  private async closeRun(runId: string, outcome: string): Promise<void> {
    const closing = [...this.open].filter(([, notice]) => notice.runId === runId);
    await Promise.all(
      closing.map(([key]) => {
        const [channel, ts] = splitConversationId(key);
        return ts ? this.settle({ channel, ts }, runId, outcome) : undefined;
      })
    );
  }

  private async onControl(
    body: BlockAction,
    action: BlockAction['actions'][number]
  ): Promise<void> {
    // A menu change only updates Slack's state; Submit reads the selection.
    if (action.action_id === NOTICE_PICK || action.type !== 'button') return;
    const notice =
      body.channel && body.message ? { channel: body.channel.id, ts: body.message.ts } : undefined;
    const origin: Origin = { user: body.user.id, notice };
    if (action.action_id === NOTICE_COMPOSE) {
      if (!parseNoticeAction(action.value, origin.user)) {
        await this.ephemeral(origin, UNUSABLE_CONTROL);
        return;
      }
      try {
        await this.adapter.getApp().client.views.open({
          trigger_id: body.trigger_id,
          view: buildComposeView(JSON.stringify({ value: action.value, notice })),
        });
      } catch (error) {
        logFailure('attention.compose_open_failed', error);
        await this.ephemeral(
          origin,
          ':warning: Could not open the answer form. Answer in the Archon web console.'
        );
      }
      return;
    }
    const runAction = parseNoticeAction(action.value, origin.user);
    if (!runAction) {
      await this.ephemeral(origin, UNUSABLE_CONTROL);
      return;
    }
    if (action.action_id === NOTICE_SUBMIT && runAction.action === 'answer') {
      const picked = body.state?.values[NOTICE_PICK]?.[NOTICE_PICK]?.selected_options ?? [];
      runAction.response.choose = picked.map(option => option.value);
    }
    await this.dispatch(runAction, origin);
  }

  private async onCompose(
    user: string,
    metadata: string,
    values: ViewSubmitAction['view']['state']['values']
  ): Promise<void> {
    const { value, notice } = parseComposeMetadata(metadata);
    const runAction = parseNoticeAction(value, user);
    const text = values[NOTICE_COMPOSE]?.[NOTICE_COMPOSE]?.value ?? '';
    if (runAction?.action !== 'answer' && runAction?.action !== 'respond') {
      await this.ephemeral({ user, notice }, UNUSABLE_CONTROL);
      return;
    }
    runAction.response.text = text;
    await this.dispatch(runAction, { user, notice });
  }

  private async dispatch(action: ChatRunAction, origin: Origin): Promise<void> {
    try {
      const response = await this.ctx.runAction(action);
      switch (response.status) {
        case 'rejected':
          return;
        case 'forbidden':
          await this.ephemeral(origin, response.message);
          return;
        case 'refused':
          await this.reply(
            origin,
            `:warning: ${response.message}` +
              (response.abandonHint ? `\n${response.abandonHint}` : '')
          );
          return;
        case 'done': {
          if (!origin.notice) return;
          const note = resolutionNote(response.result);
          await this.settle(
            origin.notice,
            action.runId,
            `${settledVerb(action)} by <@${origin.user}>${note ? ` (${note})` : ''}`
          );
          return;
        }
      }
    } catch (error) {
      logFailure('attention.run_action', error);
      await this.reply(
        origin,
        ':warning: Could not send the answer. Check the run status and the server logs.'
      );
    }
  }

  private async settle(ref: SlackMessageRef, runId: string, outcome: string): Promise<void> {
    const key = `${ref.channel}:${ref.ts}`;
    const notice = this.open.get(key);
    this.open.delete(key);
    const { blocks, fallbackText } = buildSettledNoticeBlocks(notice, runId, outcome);
    try {
      await this.adapter
        .getApp()
        .client.chat.update({ channel: ref.channel, ts: ref.ts, text: fallbackText, blocks });
    } catch (error) {
      logFailure('attention.settle_failed', error);
    }
  }

  private async reply(origin: Origin, text: string): Promise<void> {
    if (!origin.notice) {
      await this.ephemeral(origin, text);
      return;
    }
    try {
      await this.adapter.getApp().client.chat.postMessage({
        channel: origin.notice.channel,
        thread_ts: origin.notice.ts,
        text,
      });
    } catch (error) {
      logFailure('attention.reply_failed', error);
    }
  }

  private async ephemeral(origin: Origin, text: string): Promise<void> {
    if (!origin.notice) {
      logFailure('attention.no_target', new Error('Slack rendering unavailable'));
      return;
    }
    try {
      await this.adapter
        .getApp()
        .client.chat.postEphemeral({ channel: origin.notice.channel, user: origin.user, text });
    } catch (error) {
      logFailure('attention.ephemeral_failed', error);
    }
  }
}

function parseComposeMetadata(metadata: string): { value?: string; notice?: SlackMessageRef } {
  try {
    const raw: unknown = JSON.parse(metadata);
    if (typeof raw !== 'object' || raw === null) return {};
    const value = 'value' in raw && typeof raw.value === 'string' ? raw.value : undefined;
    const notice =
      'notice' in raw &&
      typeof raw.notice === 'object' &&
      raw.notice !== null &&
      'channel' in raw.notice &&
      typeof raw.notice.channel === 'string' &&
      'ts' in raw.notice &&
      typeof raw.notice.ts === 'string'
        ? { channel: raw.notice.channel, ts: raw.notice.ts }
        : undefined;
    return { value, notice };
  } catch {
    return {};
  }
}

function settledVerb(action: ChatRunAction): string {
  switch (action.action) {
    case 'answer':
      return action.response.choose.length > 0
        ? `:white_check_mark: Chose ${action.response.choose.join(', ')}`
        : ':white_check_mark: Answered';
    case 'respond':
      return action.response.decision === 'reject'
        ? ':x: Rejected'
        : action.response.text
          ? ':white_check_mark: Replied'
          : action.response.decision === 'approve'
            ? ':white_check_mark: Approved'
            : `:white_check_mark: Chose ${action.response.decision}`;
    case 'approve':
      return ':white_check_mark: Approved';
    case 'reject':
      return ':x: Rejected';
    case 'resume':
      return ':arrow_forward: Resumed';
    case 'cancel':
      return ':no_entry: Cancelled';
  }
}
