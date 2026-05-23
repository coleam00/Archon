import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import {
  handleMessage,
  classifyAndFormatError,
  toError,
  ConversationLockManager,
} from '@archon/core';
import { createLogger } from '@archon/paths';
import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import { verifyWebhookSecret, parseAllowedAccountIds, isAccountIdAuthorized } from './auth';
import type {
  JiraWebhookEvent,
  JiraAdfNode,
  JiraAdfDocument,
  JiraCommentCreatedEvent,
  JiraCommentListResponse,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.jira');
  return cachedLog;
}

const MAX_COMMENT_LENGTH = 30000;

export class JiraAdapter implements IPlatformAdapter {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly webhookSecret: string;
  private readonly lockManager: ConversationLockManager;
  private readonly botAccountId: string;
  private readonly allowedAccountIds: string[];

  constructor(
    baseUrl: string,
    email: string,
    apiToken: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    botAccountId: string
  ) {
    if (!botAccountId) {
      throw new Error('JiraAdapter requires a non-empty botAccountId (JIRA_BOT_MENTION)');
    }
    if (!baseUrl) throw new Error('JiraAdapter requires a non-empty baseUrl');
    if (!email) throw new Error('JiraAdapter requires a non-empty email');
    if (!apiToken) throw new Error('JiraAdapter requires a non-empty apiToken');
    if (!webhookSecret) throw new Error('JiraAdapter requires a non-empty webhookSecret');

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.email = email;
    this.apiToken = apiToken;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botAccountId = botAccountId;
    this.allowedAccountIds = parseAllowedAccountIds(process.env.JIRA_ALLOWED_ACCOUNT_IDS);

    if (this.allowedAccountIds.length > 0) {
      getLog().info({ accountCount: this.allowedAccountIds.length }, 'jira.allowlist_enabled');
    } else {
      getLog().info('jira.allowlist_disabled');
    }

    getLog().info({ baseUrl: this.baseUrl }, 'jira.adapter_initialized');
  }

  // ---------------------------------------------------------------------------
  // IPlatformAdapter methods
  // ---------------------------------------------------------------------------

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    getLog().debug({ conversationId, messageLength: message.length }, 'jira.send_message');

    if (message.length <= MAX_COMMENT_LENGTH) {
      await this.postComment(conversationId, message);
    } else {
      getLog().debug({ messageLength: message.length }, 'jira.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_COMMENT_LENGTH);

      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.postComment(conversationId, chunks[i]);
        } catch (error) {
          const err = error as Error;
          getLog().error(
            { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
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
  }

  getStreamingMode(): 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'jira';
  }

  async start(): Promise<void> {
    getLog().info('jira.webhook_adapter_ready');
  }

  stop(): void {
    getLog().info('jira.adapter_stopped');
  }

  async ensureThread(originalConversationId: string): Promise<string> {
    return originalConversationId;
  }

  // ---------------------------------------------------------------------------
  // Jira REST API helper
  // ---------------------------------------------------------------------------

  private async jiraApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Jira API ${method} ${path}: ${String(response.status)} ${response.statusText} - ${text}`
      );
    }
    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // ADF building and parsing
  // ---------------------------------------------------------------------------

  private buildAdfDocument(text: string): JiraAdfDocument {
    if (!text) {
      return { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [] }] };
    }

    const paragraphs = text.split(/\n\n+/);
    const content: JiraAdfNode[] = paragraphs.map(para => {
      const lines = para.split('\n');
      const inlineContent: JiraAdfNode[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          inlineContent.push({ type: 'hardBreak' });
        }
        if (lines[i] !== '') {
          inlineContent.push({ type: 'text', text: lines[i] });
        }
      }

      return { type: 'paragraph', content: inlineContent };
    });

    return { version: 1, type: 'doc', content };
  }

  private extractTextFromAdf(node: JiraAdfNode): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return '';
    return (node.content ?? []).map(child => this.extractTextFromAdf(child)).join('');
  }

  private hasMention(node: JiraAdfNode, accountId: string): boolean {
    if (node.type === 'mention' && node.attrs?.id === accountId) return true;
    return (node.content ?? []).some(child => this.hasMention(child, accountId));
  }

  // ---------------------------------------------------------------------------
  // Comment history
  // ---------------------------------------------------------------------------

  private async fetchCommentHistory(issueKey: string): Promise<string[]> {
    try {
      const response = await this.jiraApi<JiraCommentListResponse>(
        'GET',
        `/issue/${issueKey}/comment?maxResults=20`
      );
      return response.comments.map(c => {
        const author = c.author.displayName;
        const body = this.extractTextFromAdf(c.body);
        return `${author}: ${body}`;
      });
    } catch (error) {
      getLog().error({ err: error, issueKey }, 'jira.comment_history_fetch_failed');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Comment posting
  // ---------------------------------------------------------------------------

  private async postComment(issueKey: string, text: string): Promise<void> {
    const adfDoc = this.buildAdfDocument(text);
    await this.jiraApi('POST', `/issue/${issueKey}/comment`, { body: adfDoc });
    getLog().debug({ issueKey }, 'jira.comment_posted');
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

  async handleWebhook(payload: string, secret: string): Promise<void> {
    const log = getLog();

    // 1. Verify secret
    if (!verifyWebhookSecret(secret, this.webhookSecret)) {
      log.error(
        { secretPrefix: secret.substring(0, 8) + '...', payloadSize: payload.length },
        'jira.invalid_webhook_secret'
      );
      return;
    }

    // 2. Parse event
    let event: JiraWebhookEvent;
    try {
      event = JSON.parse(payload) as JiraWebhookEvent;
    } catch (error) {
      log.error({ err: error, payloadSize: payload.length }, 'jira.webhook_parse_failed');
      return;
    }

    // 3. Filter to comment_created only
    if (event.webhookEvent !== 'comment_created') return;

    const commentEvent = event as JiraCommentCreatedEvent;

    // 4. Self-trigger guard
    if (commentEvent.comment.author.accountId === this.botAccountId) {
      log.debug({ authorAccountId: this.botAccountId }, 'jira.ignoring_own_comment');
      return;
    }

    // 5. Authorization check
    if (!isAccountIdAuthorized(commentEvent.comment.author.accountId, this.allowedAccountIds)) {
      const maskedId = commentEvent.comment.author.accountId
        ? `${commentEvent.comment.author.accountId.slice(0, 4)}***`
        : 'unknown';
      log.info({ maskedAccountId: maskedId }, 'jira.unauthorized_webhook');
      return;
    }

    // 6. Check @mention in ADF
    if (!this.hasMention(commentEvent.comment.body, this.botAccountId)) return;

    if (!commentEvent.issue?.key) {
      log.warn({ webhookEvent: 'comment_created' }, 'jira.webhook_missing_issue_key');
      return;
    }

    const issueKey = commentEvent.issue.key;
    log.info({ issueKey }, 'jira.webhook_processing');

    // 7. Extract text and build context
    const rawText = this.extractTextFromAdf(commentEvent.comment.body);

    const issue = commentEvent.issue;
    const priority = issue.fields.priority?.name ?? 'None';
    const labels = issue.fields.labels.join(', ') || 'None';
    const issueContext = `[Jira Issue Context]
Issue ${issue.key}: "${issue.fields.summary}"
Status: ${issue.fields.status.name}
Priority: ${priority}
Labels: ${labels}`;

    // 8. Thread context
    const commentHistory = await this.fetchCommentHistory(issueKey);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;

    // 9. Dispatch
    await this.lockManager.acquireLock(issueKey, async () => {
      try {
        await handleMessage(this, issueKey, rawText, {
          issueContext,
          threadContext,
          isolationHints: { workflowType: 'thread', workflowId: issueKey } as IsolationHints,
        });
      } catch (error) {
        const err = toError(error);
        log.error({ err, issueKey }, 'jira.message_handling_error');
        try {
          await this.sendMessage(issueKey, classifyAndFormatError(err));
        } catch (sendError) {
          log.error({ err: toError(sendError), issueKey }, 'jira.error_message_send_failed');
        }
      }
    });
  }
}
