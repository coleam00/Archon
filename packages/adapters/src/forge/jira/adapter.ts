/**
 * Jira Cloud platform adapter (webhook-driven).
 *
 * Listens for `comment_created` webhooks, detects an @mention of the bot, and
 * routes the request through the orchestrator. Unlike the GitHub adapter, it
 * does NOT pre-bind a codebase: a Jira issue has no inherent repo, so the
 * conversation is handed to the orchestrator with ticket context only, and the
 * existing free-text router lets the AI match the ticket to a registered
 * codebase (emitting `/invoke-workflow <workflow> --project <name>`).
 *
 * Outbound comments are posted as ADF (Jira Cloud REST v3) via basic auth.
 */
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import {
  handleMessage,
  classifyAndFormatError,
  toError,
  ConversationLockManager,
} from '@archon/core';
import * as db from '@archon/core/db/conversations';
import { createLogger } from '@archon/paths';
import { parseJiraAllowedUsers, isJiraUserAuthorized, timingSafeCompareSecret } from './auth';
import { toAdf, adfToPlainText } from './adf';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { JiraWebhookEvent, JiraIssue, JiraCommentList, AdfNode } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.jira');
  return cachedLog;
}

/**
 * Escape regex metacharacters so a configured bot mention (sourced from
 * `JIRA_BOT_MENTION` / `BOT_DISPLAY_NAME` / `config.botName`) can be safely
 * interpolated into a RegExp. Without this a mention like `c++` would throw at
 * match time and the mention would silently never be detected.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Jira comment bodies are capped at ~32k chars; leave a safety buffer. */
const MAX_LENGTH = 30000;

/**
 * Invisible (zero-width) sentinel appended to bot comments. Used as a fallback
 * self-loop guard when the bot's accountId could not be resolved at startup.
 */
const BOT_RESPONSE_MARKER = '​​archon-bot-response​​';

/** Jira issue keys: project key (uppercase letters/digits, leading letter) + number. */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export class JiraAdapter implements IPlatformAdapter {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly webhookSecret: string;
  private readonly allowedUsers: string[];
  private readonly botMention: string;
  private readonly lockManager: ConversationLockManager;
  private readonly retryDelayFn: (attempt: number) => number;

  /** Resolved in start() via GET /myself; used for primary self-loop guard. */
  private botAccountId: string | undefined;
  /** When true, self-identity lookup failed — fall back to marker detection. */
  private useMarkerFallback = false;

  constructor(
    baseUrl: string,
    user: string,
    apiToken: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    botMention?: string,
    options?: { retryDelayMs?: (attempt: number) => number }
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${user}:${apiToken}`).toString('base64')}`;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botMention = botMention ?? 'Archon';

    this.allowedUsers = parseJiraAllowedUsers(process.env.JIRA_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'jira.whitelist_enabled');
    } else {
      getLog().info('jira.whitelist_disabled');
    }

    this.retryDelayFn = options?.retryDelayMs ?? ((attempt: number): number => 1000 * attempt);

    getLog().info({ botMention: this.botMention }, 'jira.adapter_initialized');
  }

  getStreamingMode(): 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'jira';
  }

  /**
   * Resolve the bot's own accountId for the self-loop guard. On failure we do
   * not throw (one adapter must not block server startup) — instead we fall
   * back to detecting an invisible marker appended to our own comments.
   */
  async start(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
      const me = (await res.json()) as { accountId?: string };
      if (!me.accountId) {
        throw new Error('no accountId in /myself response');
      }
      this.botAccountId = me.accountId;
      getLog().info('jira.webhook_adapter_ready');
    } catch (error) {
      this.useMarkerFallback = true;
      getLog().warn({ err: toError(error) }, 'jira.self_identity_failed');
    }
  }

  stop(): void {
    getLog().info('jira.adapter_stopped');
  }

  /**
   * Jira issues are inherently threaded (all comments attach to the issue), so
   * there is nothing to create — return the original conversation ID.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  // ── Conversation ID helpers ───────────────────────────────────────────────

  private buildConversationId(issueKey: string): string {
    return issueKey;
  }

  private parseConversationId(conversationId: string): { issueKey: string } | null {
    if (!ISSUE_KEY_RE.test(conversationId)) return null;
    return { issueKey: conversationId };
  }

  // ── Mention helpers (mirror the GitHub adapter) ───────────────────────────

  private hasMention(text: string): boolean {
    const escaped = escapeRegExp(this.botMention);
    const pattern = new RegExp(`@${escaped}[\\s,:;]`, 'i');
    return pattern.test(text) || text.trim().toLowerCase() === `@${this.botMention.toLowerCase()}`;
  }

  private stripMention(text: string): string {
    const pattern = new RegExp(`@${escapeRegExp(this.botMention)}[\\s,:;]+`, 'gi');
    return text.replace(pattern, '').trim();
  }

  // ── Error classification (mirror the GitHub adapter) ──────────────────────

  private isRetryableError(error: unknown): boolean {
    const statusError = error as { status?: unknown };
    const status = typeof statusError.status === 'number' ? statusError.status : undefined;
    if (typeof status === 'number') {
      return status === 429 || status === 502 || status === 503 || status === 504;
    }

    const message = (error as Error | undefined)?.message ?? '';
    const combined = message.toLowerCase();
    return (
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('fetch failed')
    );
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      getLog().error({ conversationId }, 'jira.invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'jira.send_message');

    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed.issueKey, message);
      return;
    }

    getLog().debug({ messageLength: message.length }, 'jira.message_splitting');
    const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.postComment(parsed.issueKey, chunks[i]);
      } catch (error) {
        getLog().error(
          { err: toError(error), chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
          'jira.chunk_post_failed'
        );
        const partialError = new Error(
          `Failed to post comment chunk ${String(i + 1)}/${String(chunks.length)}. ` +
            `${String(i)} chunk(s) were posted before failure.`
        );
        partialError.cause = error;
        throw partialError;
      }
    }
  }

  /**
   * Post a single ADF comment to a Jira issue, with retry on transient errors.
   * Always appends an invisible marker node so the comment can be recognized as
   * bot-authored even when accountId-based detection is unavailable.
   */
  private async postComment(issueKey: string, message: string): Promise<void> {
    const doc = toAdf(message);
    // Append an invisible marker paragraph for the fallback self-loop guard.
    doc.content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: BOT_RESPONSE_MARKER } as AdfNode],
    });

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ body: doc }),
        });
        if (!res.ok) {
          const err = new Error(`Jira API returned HTTP ${String(res.status)}`) as Error & {
            status: number;
          };
          err.status = res.status;
          throw err;
        }
        getLog().debug({ issueKey }, 'jira.comment_posted');
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = this.retryDelayFn(attempt);
          getLog().warn(
            { attempt, maxRetries, issueKey, delayMs: delay },
            'jira.comment_post_retry'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        getLog().error(
          { err: toError(error), issueKey, attempt, maxRetries, wasRetryable: isRetryable },
          'jira.comment_post_failed'
        );
        throw error;
      }
    }
  }

  // ── Inbound context fetching ──────────────────────────────────────────────

  /** Fetch issue fields for orchestrator context. Returns null on failure. */
  private async fetchIssue(issueKey: string): Promise<JiraIssue | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,description,issuetype,status`,
        { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
      );
      if (!res.ok) {
        getLog().warn({ issueKey, status: res.status }, 'jira.issue_fetch_failed');
        return null;
      }
      return (await res.json()) as JiraIssue;
    } catch (error) {
      getLog().warn({ err: toError(error), issueKey }, 'jira.issue_fetch_failed');
      return null;
    }
  }

  /**
   * Fetch recent comments for thread context, formatted `author: body` in
   * chronological order (oldest first). Returns [] on failure.
   *
   * @param excludeCommentId - id of the comment that triggered the webhook; it
   *   is dropped so the stripped mention text isn't duplicated into the context.
   */
  private async fetchCommentHistory(
    issueKey: string,
    excludeCommentId?: string
  ): Promise<string[]> {
    try {
      const res = await fetch(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=20`,
        { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
      );
      if (!res.ok) {
        getLog().warn({ issueKey, status: res.status }, 'jira.comment_history_fetch_failed');
        return [];
      }
      const data = (await res.json()) as JiraCommentList;
      // orderBy=-created returns newest first; reverse for chronological order.
      return [...(data.comments ?? [])]
        .reverse()
        .filter(comment => excludeCommentId === undefined || comment.id !== excludeCommentId)
        .map(comment => {
          const author = comment.author?.displayName ?? comment.author?.accountId ?? 'unknown';
          const body = adfToPlainText(comment.body);
          return `${author}: ${body}`;
        });
    } catch (error) {
      getLog().warn({ err: toError(error), issueKey }, 'jira.comment_history_fetch_failed');
      return [];
    }
  }

  /** Build a context block from issue fields (mirrors GitHub's buildIssueContext). */
  private buildIssueContext(issue: JiraIssue): string {
    const fields = issue.fields;
    const description = adfToPlainText(fields.description ?? undefined);
    return `[Jira Issue Context]
Issue ${issue.key}: "${fields.summary ?? ''}"
Type: ${fields.issuetype?.name ?? 'unknown'}
Status: ${fields.status?.name ?? 'unknown'}

Description:
${description}`;
  }

  // ── Webhook entry point ───────────────────────────────────────────────────

  /**
   * Handle an incoming Jira webhook. `secret` is the `?secret=` query param.
   * Fire-and-forget contract: all failures are logged, never thrown to caller.
   */
  async handleWebhook(payload: string, secret: string | undefined): Promise<void> {
    // 1. Verify shared secret (constant-time). Logged at warn, not error: an
    // internet-exposed endpoint gets scanned, so a wrong/missing secret is
    // expected background noise rather than an operational fault.
    if (!timingSafeCompareSecret(secret, this.webhookSecret)) {
      getLog().warn({ payloadSize: payload.length }, 'jira.webhook_rejected');
      return;
    }

    // 2. Parse + filter event
    let event: JiraWebhookEvent;
    try {
      event = JSON.parse(payload) as JiraWebhookEvent;
    } catch (error) {
      getLog().error({ err: toError(error) }, 'jira.webhook_parse_failed');
      return;
    }

    if (event.webhookEvent !== 'comment_created') {
      getLog().debug({ webhookEvent: event.webhookEvent }, 'jira.event_ignored');
      return;
    }

    const issueKey = event.issue?.key;
    const comment = event.comment;
    if (!issueKey || !comment) {
      getLog().debug('jira.event_missing_issue_or_comment');
      return;
    }

    // 3. Self-loop guard
    if (this.useMarkerFallback) {
      if (adfToPlainText(comment.body).includes(BOT_RESPONSE_MARKER)) {
        getLog().debug({ issueKey }, 'jira.ignoring_marked_comment');
        return;
      }
    } else if (comment.author?.accountId && comment.author.accountId === this.botAccountId) {
      getLog().debug({ issueKey }, 'jira.ignoring_own_comment');
      return;
    }

    // 4. Authorization
    if (
      !isJiraUserAuthorized(
        { accountId: comment.author?.accountId, email: comment.author?.emailAddress },
        this.allowedUsers
      )
    ) {
      const id = comment.author?.accountId ?? comment.author?.emailAddress ?? 'unknown';
      getLog().info({ maskedUser: `${id.slice(0, 3)}***` }, 'jira.unauthorized_webhook');
      return;
    }

    // 5. Extract comment text + mention check
    const rawText = adfToPlainText(comment.body);
    if (!this.hasMention(rawText)) return;

    getLog().info({ issueKey }, 'jira.webhook_processing');
    let text = this.stripMention(rawText);

    // 6. Slash normalization: an explicit `/workflow run X` without `--project`
    // can't resolve a codebase (the conversation has none bound), so rewrite it
    // to free text and let the AI router pick the project from ticket context.
    if (/^\/workflow\s+run\b/.test(text) && !text.includes('--project')) {
      text = text.replace(/^\/workflow\s+run\s+/, '').trim();
      getLog().debug({ issueKey }, 'jira.slash_run_rewritten_to_freetext');
    }

    // 7. Fetch ticket + thread context
    const issue = await this.fetchIssue(issueKey);
    const issueContext = issue ? this.buildIssueContext(issue) : undefined;
    const commentHistory = await this.fetchCommentHistory(issueKey, comment.id);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;

    // 8. Ensure the conversation exists (WITHOUT a codebase) before taking the
    // lock. handleMessage also get-or-creates it, but doing it here keeps the
    // lock keyed to a row that is guaranteed to exist; the call is idempotent.
    const conversationId = this.buildConversationId(issueKey);
    await db.getOrCreateConversation('jira', conversationId);

    await this.lockManager.acquireLock(conversationId, async () => {
      try {
        await handleMessage(this, conversationId, text, { issueContext, threadContext });
      } catch (error) {
        const err = toError(error);
        getLog().error({ err, conversationId }, 'jira.message_handling_error');
        try {
          await this.sendMessage(conversationId, classifyAndFormatError(err));
        } catch (sendError) {
          getLog().error(
            { err: toError(sendError), conversationId },
            'jira.error_message_send_failed'
          );
        }
      }
    });
  }
}
