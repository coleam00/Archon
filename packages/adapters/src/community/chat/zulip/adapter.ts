import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import zulip from 'zulip-js';
import type { ZulipMessage, ZulipReplyContext } from './types';
import { parseAllowedUserIds, isZulipUserAuthorized } from './auth';
import { splitIntoParagraphChunks } from '../../../utils/message-splitting';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.zulip');
  return cachedLog;
}

const MAX_LENGTH = 9800;
const REPLY_CONTEXTS_MAX = 1000;
/** Max missed messages handled per boot, so a long outage can't trigger a flood of replies. */
const BACKFILL_MAX = 50;
/** Cap on the in-memory set of recently handled message ids (dedupes backfill vs live queue). */
const PROCESSED_IDS_MAX = 2000;
/** Minimum milliseconds between consecutive status-message edits (debounce guard). */
const STATUS_MIN_INTERVAL_MS = 500;
/**
 * Event types the bot's queue subscribes to. `update_message` is required so that a message
 * edited to ADD an @mention (the user forgot it the first time) is picked up — edits do not
 * arrive as `message` events.
 */
const QUEUE_EVENT_TYPES = JSON.stringify(['message', 'update_message']);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Returns current UTC time formatted as HH:MM:SS. */
function formatUtcTime(): string {
  const now = new Date();
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export class ZulipAdapter implements IPlatformAdapter {
  private readonly serverUrl: string;
  private readonly botEmail: string;
  private readonly apiKey: string;
  private streamingMode: 'stream' | 'batch';
  private allowedUserIds: number[];
  private replyContexts = new Map<string, ZulipReplyContext>();
  private processedMessageIds = new Set<number>();
  // conversationId -> incoming message ids awaiting a reply; marked read only once a reply
  // is actually posted, so a failed send leaves the message unread for the next boot to retry.
  private pendingReadIds = new Map<string, number[]>();
  // conversationId -> FIFO queue of status messages awaiting their answer or error.
  // Each entry holds the Zulip message_id and accumulated text (full replacement on edit).
  private statusMessageQueues = new Map<string, { id: number; text: string }[]>();
  // Last timestamp (Date.now()) a status message was edited, keyed by conversationId.
  private statusLastEdit = new Map<string, number>();
  private client: Awaited<ReturnType<typeof zulip>> | null = null;
  private messageHandler: ((msg: ZulipMessage) => Promise<void>) | null = null;
  private running = false;
  private botFullName = '';

  constructor(
    serverUrl: string,
    botEmail: string,
    apiKey: string,
    mode: 'stream' | 'batch' = 'batch'
  ) {
    this.serverUrl = serverUrl;
    this.botEmail = botEmail;
    this.apiKey = apiKey;
    this.streamingMode = mode;
    this.allowedUserIds = parseAllowedUserIds(process.env.ZULIP_ALLOWED_USER_IDS);
    // zulip-js@1 has no /users/me endpoint — bot full name must be supplied via env
    this.botFullName = process.env.ZULIP_BOT_FULL_NAME ?? '';

    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'zulip.whitelist_enabled');
    } else {
      getLog().info('zulip.whitelist_disabled');
    }
    if (!this.botFullName) {
      getLog().warn(
        'zulip.bot_full_name_not_set — set ZULIP_BOT_FULL_NAME; stream @mention detection disabled'
      );
    }
    getLog().info({ mode }, 'zulip.adapter_initialized');
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'zulip';
  }

  getConversationId(msg: ZulipMessage): string {
    if (msg.type === 'stream') {
      return `stream:${msg.stream_id}:${msg.subject ?? ''}`;
    }
    const recipients = msg.display_recipient as { id: number }[];
    const ids = recipients
      .map(r => r.id)
      .sort((a, b) => a - b)
      .join(':');
    return `private:${ids}`;
  }

  stripBotMention(content: string): string {
    if (!this.botFullName) return content;
    const pattern = new RegExp(`@\\*\\*${escapeRegex(this.botFullName)}\\*\\*\\s*`, 'g');
    return content.replace(pattern, '').trim();
  }

  /** Zulip topics serve as threads — no additional threading needed. */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  onMessage(handler: (msg: ZulipMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendMessage(
    conversationId: string,
    text: string,
    metadata?: MessageMetadata
  ): Promise<void> {
    if (!this.client) {
      getLog().error({ conversationId }, 'zulip.send_before_start');
      return;
    }
    const ctx = this.replyContexts.get(conversationId);
    if (!ctx) {
      getLog().error({ conversationId }, 'zulip.no_reply_context');
      return;
    }

    const isError = metadata?.isError === true;

    const statusQueue = this.statusMessageQueues.get(conversationId);
    if (statusQueue && statusQueue.length > 0) {
      const statusEntry = statusQueue.shift();
      // `length > 0` above guarantees a value, but the codebase forbids `!` non-null assertions
      // (eslint `no-non-null-assertion`), so we keep this defensive narrowing for the type-checker.
      if (statusEntry === undefined) return;
      const queueNowEmpty = statusQueue.length === 0;
      if (queueNowEmpty) {
        this.statusMessageQueues.delete(conversationId);
        this.statusLastEdit.delete(conversationId);
      }

      const doneLabel = isError ? 'Done thinking (FAILED).' : 'Done thinking.';
      const newText = `${statusEntry.text}\n${formatUtcTime()} ${doneLabel}`;

      const now = Date.now();
      const lastEdit = this.statusLastEdit.get(conversationId) ?? 0;
      if (now - lastEdit >= STATUS_MIN_INTERVAL_MS) {
        if (!queueNowEmpty) this.statusLastEdit.set(conversationId, now);
        await this.updateMessage(statusEntry.id, newText);
      } else {
        getLog().warn(
          { conversationId, messageId: statusEntry.id },
          'zulip.status_debounce_skipped'
        );
      }
    }

    if (isError) {
      await this.postChunk(ctx, text);
      await this.markOldestPendingRead(conversationId);
      return;
    }

    // Partial-delivery contract: Zulip has no atomic multi-post API and we don't retract earlier
    // chunks if a later one fails. A throw mid-loop therefore leaves the user with a truncated
    // answer in the topic — the throw bubbles up to the caller's logging, and the inbound message
    // is intentionally NOT marked read (see markOldestPendingRead) so the next boot can retry.
    const chunks = text.length > MAX_LENGTH ? splitIntoParagraphChunks(text, MAX_LENGTH) : [text];
    for (const chunk of chunks) {
      await this.postChunk(ctx, chunk);
    }

    await this.markOldestPendingRead(conversationId);
  }

  /**
   * Mark exactly one pending inbound message (the oldest, FIFO) read for this conversation —
   * the message this reply answers. Each inbound message produces one terminal `sendMessage`
   * (answer or error) and pushes one id via `handleIncomingMessage`, mirroring the status-message
   * FIFO. Draining the whole list per reply would ack still-unanswered messages: with two queued,
   * the first reply would mark both read, and a crash before the second reply posts would lose it.
   */
  private async markOldestPendingRead(conversationId: string): Promise<void> {
    const pending = this.pendingReadIds.get(conversationId);
    if (!pending || pending.length === 0) return;
    const id = pending.shift();
    if (pending.length === 0) this.pendingReadIds.delete(conversationId);
    if (id !== undefined) await this.markRead(id);
  }

  /** Post a single chunk to the correct Zulip conversation (stream or DM). */
  private async postChunk(ctx: ZulipReplyContext, content: string): Promise<void> {
    if (ctx.type === 'stream') {
      await this.zulipPost('messages', {
        type: 'stream',
        to: String(ctx.stream_id),
        topic: ctx.topic,
        content,
      });
    } else {
      await this.zulipPost('messages', {
        type: 'private',
        to: JSON.stringify(ctx.user_ids),
        content,
      });
    }
  }

  /**
   * Start the Zulip bot: connect, register the event queue, run backfill + poll in background.
   *
   * Queue registration uses `apply_markdown:false` so we receive RAW markdown — mentions arrive
   * as `@**FullName**` literals (the default `apply_markdown:true` returns rendered HTML, in
   * which the mention text never appears literally and so cannot be matched).
   *
   * The queue is registered via a direct POST (see `zulipPost`) rather than
   * `client.queues.register`: under Bun, zulip-js@1's POST path does not serialize the body,
   * which would silently drop `event_types`/`apply_markdown` (the server would then default to
   * all event types + rendered HTML, breaking mention detection).
   */
  async start(): Promise<void> {
    this.client = await zulip({
      realm: this.serverUrl,
      username: this.botEmail,
      apiKey: this.apiKey,
    });

    const firstQueue = await this.zulipPost('register', {
      event_types: QUEUE_EVENT_TYPES,
      apply_markdown: 'false',
    });
    const queueId = String(firstQueue.queue_id);
    const lastEventId = Number(firstQueue.last_event_id ?? -1);
    this.running = true;
    getLog().info({ botFullName: this.botFullName }, 'zulip.bot_started');

    // Catch up on messages that arrived while the bot was offline (e.g. a maintenance
    // window) before/alongside the live loop. Both run in the background — start() must
    // return promptly (same pattern as TelegramAdapter). The dedup set + mark-read keep
    // backfill and the live queue from answering the same message twice.
    void this.backfillUnansweredMessages().catch(err => {
      getLog().error({ err }, 'zulip.backfill_fatal_error');
    });
    void this.pollEventsFrom(queueId, lastEventId).catch(err => {
      getLog().error({ err }, 'zulip.poll_fatal_error');
    });
  }

  /**
   * Answer messages that arrived while the bot was offline. The event queue is forward-only,
   * so without this any message sent during downtime would be silently dropped. Zulip's
   * "unread" state is the source of truth for "unanswered": fetch unread @mentions + unread
   * DMs, process them oldest-first through the normal path, and mark each read (in
   * handleIncomingMessage) so the next restart won't re-answer it.
   */
  private async backfillUnansweredMessages(): Promise<void> {
    const client = this.client;
    if (!client) return;

    // Returns `undefined` on failure (vs `[]` = "fetched OK, none unread") so the caller can't
    // mistake a downgraded API for a clean backfill cycle and silently swallow missed messages.
    const fetchUnread = async (
      kind: 'mentioned' | 'private'
    ): Promise<ZulipMessage[] | undefined> => {
      try {
        const res = await client.messages.retrieve({
          anchor: 'newest',
          num_before: BACKFILL_MAX,
          num_after: 0,
          narrow: [
            { operator: 'is', operand: 'unread' },
            { operator: 'is', operand: kind },
          ],
          apply_markdown: false,
        });
        return (res.messages as ZulipMessage[]) ?? [];
      } catch (error) {
        getLog().error({ err: error, kind }, 'zulip.backfill_fetch_failed');
        return undefined;
      }
    };

    const [mentions, dms] = await Promise.all([fetchUnread('mentioned'), fetchUnread('private')]);
    if (mentions === undefined || dms === undefined) {
      // At least one fetch failed — bail on this cycle. The messages stay `unread` in Zulip, so
      // the next restart's backfill (or the live event queue, once recovered) will retry them.
      getLog().error('zulip.backfill_aborted');
      return;
    }

    // De-duplicate (a DM can also be a mention) and process oldest-first, capped.
    const byId = new Map<number, ZulipMessage>();
    for (const m of [...mentions, ...dms]) byId.set(m.id, m);
    const missed = [...byId.values()].sort((a, b) => a.id - b.id).slice(-BACKFILL_MAX);

    if (missed.length === 0) {
      getLog().info('zulip.backfill_none');
      return;
    }
    getLog().info({ count: missed.length }, 'zulip.backfill_started');
    for (const msg of missed) {
      try {
        await this.handleIncomingMessage(msg);
      } catch (error) {
        getLog().error({ err: error, messageId: msg.id }, 'zulip.backfill_message_failed');
      }
    }
    getLog().info({ count: missed.length }, 'zulip.backfill_completed');
  }

  /**
   * POST (or PATCH) to the Zulip REST API directly, form-encoded. We bypass zulip-js's POST
   * helper (isomorphic-fetch + isomorphic-form-data): under Bun its multipart body is not
   * serialized, so the server receives no params ("Missing 'content' argument") and zulip-js
   * returns the error object instead of throwing — making every send/register fail silently.
   * Throws on any non-success response so callers can surface the failure. (zulip-js GETs are
   * fine: they serialize params into the query string.)
   */
  private async zulipPost(
    endpoint: string,
    params: Record<string, string>,
    method: 'POST' | 'PATCH' = 'POST'
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.serverUrl.replace(/\/+$/, '')}/api/v1/${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.botEmail}:${this.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.result !== 'success') {
      const detail = typeof body.msg === 'string' ? body.msg : '';
      throw new Error(`Zulip ${method} /${endpoint} failed: HTTP ${res.status} ${detail}`.trim());
    }
    return body;
  }

  /**
   * Mark a message read so it is not re-answered after a restart. Failures are logged, not
   * thrown — at worst a missed mark-read causes one duplicate answer on the next boot.
   */
  private async markRead(messageId: number): Promise<void> {
    try {
      await this.zulipPost('messages/flags', {
        messages: JSON.stringify([messageId]),
        op: 'add',
        flag: 'read',
      });
    } catch (error) {
      getLog().warn({ err: error, messageId }, 'zulip.mark_read_failed');
    }
  }

  /**
   * Edit an existing Zulip message (replaces full content). Used to append status lines.
   * Failures are logged and swallowed — status edits are best-effort.
   */
  private async updateMessage(messageId: number, content: string): Promise<void> {
    try {
      await this.zulipPost(`messages/${messageId}`, { content }, 'PATCH');
    } catch (error) {
      getLog().warn({ err: error, messageId }, 'zulip.status_message_update_failed');
    }
  }

  /**
   * Post the initial "Starting thinking..." status message for a conversation.
   * Captures the returned message_id and pushes it onto the per-conversation FIFO queue.
   * Best-effort: failures are logged and do not block normal message processing.
   */
  private async createStatusMessage(conversationId: string): Promise<void> {
    const ctx = this.replyContexts.get(conversationId);
    if (!ctx) return;

    const initialText = `${formatUtcTime()} Starting thinking...`;
    let response: Record<string, unknown>;
    try {
      if (ctx.type === 'stream') {
        response = await this.zulipPost('messages', {
          type: 'stream',
          to: String(ctx.stream_id),
          topic: ctx.topic,
          content: initialText,
        });
      } else {
        response = await this.zulipPost('messages', {
          type: 'private',
          to: JSON.stringify(ctx.user_ids),
          content: initialText,
        });
      }
    } catch (error) {
      getLog().warn({ err: error, conversationId }, 'zulip.status_message_create_failed');
      return;
    }

    const messageId = typeof response.id === 'number' ? response.id : undefined;
    if (messageId === undefined) {
      getLog().warn({ conversationId, response }, 'zulip.status_message_no_id');
      return;
    }

    const queue = this.statusMessageQueues.get(conversationId) ?? [];
    queue.push({ id: messageId, text: initialText });
    this.statusMessageQueues.set(conversationId, queue);
    getLog().debug({ conversationId, messageId }, 'zulip.status_message_created');
  }

  /** Record a handled message id, evicting the oldest (FIFO) past the cap. */
  private rememberProcessed(id: number): void {
    if (this.processedMessageIds.size >= PROCESSED_IDS_MAX) {
      const oldest = this.processedMessageIds.values().next().value;
      if (oldest !== undefined) this.processedMessageIds.delete(oldest);
    }
    this.processedMessageIds.add(id);
  }

  stop(): void {
    this.running = false;
    getLog().info('zulip.bot_stopped');
  }

  /**
   * Drive the Zulip event queue: pull events, dispatch messages, and re-register on errors.
   *
   * Re-registration on a queue error uses the same direct POST (`zulipPost`) + `QUEUE_EVENT_TYPES`
   * as `start()` — `client.queues.register` (zulip-js) drops its body under Bun, which would
   * silently re-register a default queue (all event types, `apply_markdown:true` → rendered HTML)
   * and lose `@**mention**` detection. Keeping `update_message` in the event-types list is what
   * preserves edited-message @mention pickup after a recovery.
   */
  private async pollEventsFrom(initialQueueId: string, initialLastEventId: number): Promise<void> {
    // client is guaranteed non-null here — called only from start()
    const client = this.client;
    if (!client) return;

    let queueId = initialQueueId;
    let lastEventId = initialLastEventId;

    while (this.running) {
      try {
        const eventsResult = await client.events.retrieve({
          queue_id: queueId,
          last_event_id: lastEventId,
          dont_block: false,
        });

        for (const event of eventsResult.events) {
          lastEventId = event.id;
          if (event.type === 'message' && event.message) {
            // zulip-js ships no types; message shape matches ZulipMessage per Zulip API docs
            await this.handleIncomingMessage(event.message as ZulipMessage);
          } else if (event.type === 'update_message' && typeof event.message_id === 'number') {
            // A message edited to ADD an @mention arrives only as update_message — re-evaluate it.
            await this.handleEditedMessage(event.message_id);
          }
        }
      } catch (error) {
        if (!this.running) break;
        const err = error as Error;
        getLog().error({ err }, 'zulip.poll_error');
        // Re-register the queue (e.g. expired after inactivity). See the method docstring for
        // why we go through `zulipPost` and reuse `QUEUE_EVENT_TYPES` instead of the zulip-js
        // helper — both points are load-bearing for @mention and edited-message handling.
        try {
          const queueResult = await this.zulipPost('register', {
            event_types: QUEUE_EVENT_TYPES,
            apply_markdown: 'false',
          });
          queueId = String(queueResult.queue_id);
          lastEventId = Number(queueResult.last_event_id ?? -1);
        } catch (reregisterError) {
          getLog().error({ err: reregisterError }, 'zulip.reregister_error');
          await sleep(1000);
        }
      }
    }
  }

  /**
   * Handle a message edit (update_message event). The case we care about: a user forgot to
   * @mention the bot and edited the message to add it — which never arrives as a `message`
   * event. Fetch the current (edited) message and run it through the normal path; the
   * mention/auth/self/dedup checks there decide whether to answer. Already-handled ids skip.
   */
  private async handleEditedMessage(messageId: number): Promise<void> {
    if (this.processedMessageIds.has(messageId)) return;
    const client = this.client;
    if (!client) return;
    let edited: ZulipMessage | undefined;
    try {
      const res = await client.messages.retrieve({
        anchor: messageId,
        num_before: 0,
        num_after: 0,
        narrow: [],
        apply_markdown: false,
      });
      edited = (res.messages as ZulipMessage[])[0];
    } catch (error) {
      getLog().error({ err: error, messageId }, 'zulip.fetch_edited_failed');
      return;
    }
    if (edited?.id === messageId) await this.handleIncomingMessage(edited);
  }

  private async handleIncomingMessage(msg: ZulipMessage): Promise<void> {
    // Skip anything already handled this run (dedupes backfill vs the live queue).
    if (this.processedMessageIds.has(msg.id)) return;

    // Ignore bot's own messages
    if (msg.sender_email === this.botEmail) return;

    // Authorization check
    if (!isZulipUserAuthorized(msg.sender_id, this.allowedUserIds)) {
      const maskedId = `${String(msg.sender_id).slice(0, 4)}***`;
      getLog().info({ maskedUserId: maskedId }, 'zulip.unauthorized_message');
      return;
    }

    // Stream messages require @mention; private messages always respond
    if (msg.type === 'stream') {
      const mention = `@**${this.botFullName}**`;
      if (!msg.content.includes(mention)) return;
    }

    const conversationId = this.getConversationId(msg);

    // Store reply context so sendMessage can route responses correctly.
    // FIFO eviction at REPLY_CONTEXTS_MAX entries prevents unbounded growth in
    // deployments with many topics (Map iteration order is insertion order).
    if (this.replyContexts.size >= REPLY_CONTEXTS_MAX) {
      const oldestKey = this.replyContexts.keys().next().value;
      if (oldestKey !== undefined) this.replyContexts.delete(oldestKey);
    }
    if (msg.type === 'stream' && msg.stream_id !== undefined && msg.subject !== undefined) {
      this.replyContexts.set(conversationId, {
        type: 'stream',
        stream_id: msg.stream_id,
        topic: msg.subject,
      });
    } else if (msg.type === 'private') {
      const recipients = msg.display_recipient as { id: number }[];
      this.replyContexts.set(conversationId, {
        type: 'private',
        user_ids: recipients.map(r => r.id),
      });
    } else {
      getLog().warn({ conversationId }, 'zulip.incomplete_stream_message');
      return;
    }

    // Mark processed BEFORE any await so a concurrent live delivery of the same id
    // (during backfill) short-circuits at the dedup check above.
    this.rememberProcessed(msg.id);

    // Post "Starting thinking..." immediately after reply target is known.
    await this.createStatusMessage(conversationId);

    // Defer mark-read until the reply is actually posted (sendMessage). The handler is
    // fire-and-forget — it returns before the AI response is sent — so marking read here
    // would mark a message answered before (or even if) the reply ever goes out. Queue the
    // id against this conversation; sendMessage marks it read once a reply succeeds.
    const pending = this.pendingReadIds.get(conversationId) ?? [];
    pending.push(msg.id);
    this.pendingReadIds.set(conversationId, pending);

    if (this.messageHandler) {
      await this.messageHandler(msg);
    }
  }
}
