import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import {
  ConversationLockManager,
  classifyAndFormatError,
  handleMessage,
  onConversationClosed,
  toError,
} from '@archon/core';
import * as db from '@archon/core/db/conversations';
import { createLogger } from '@archon/paths';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import { isJiraUserAuthorized, parseAllowedUsers, verifyWebhookToken } from './auth';
import type {
  JiraAdfNode,
  JiraComment,
  JiraCommentsResponse,
  JiraDocument,
  JiraIssue,
  JiraUser,
  JiraWebhookEvent,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.jira');
  return cachedLog;
}

const MAX_MESSAGE_LENGTH = 30000;
const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

export class JiraAdapter implements IPlatformAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly email: string | undefined;
  private readonly webhookSecret: string;
  private readonly apiVersion: '2' | '3';
  private readonly botMention: string;
  private readonly allowedUsers: string[];
  private readonly lockManager: ConversationLockManager;

  constructor(
    baseUrl: string,
    token: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    options?: {
      email?: string;
      apiVersion?: string;
      botMention?: string;
    }
  ) {
    if (!baseUrl) {
      throw new Error('JiraAdapter requires a non-empty baseUrl');
    }
    if (!token) {
      throw new Error('JiraAdapter requires a non-empty token');
    }
    if (!webhookSecret) {
      throw new Error('JiraAdapter requires a non-empty webhookSecret');
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.email = options?.email;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.apiVersion = options?.apiVersion === '3' ? '3' : '2';
    this.botMention = options?.botMention ?? 'Archon';
    this.allowedUsers = parseAllowedUsers(process.env.JIRA_ALLOWED_USERS);

    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'jira.whitelist_enabled');
    } else {
      getLog().info('jira.whitelist_disabled');
    }

    getLog().info(
      { baseUrl: this.baseUrl, apiVersion: this.apiVersion, botMention: this.botMention },
      'jira.adapter_initialized'
    );
  }

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    if (!conversationId.trim()) {
      getLog().error('jira.invalid_conversation_id');
      return;
    }

    if (message.length <= MAX_MESSAGE_LENGTH) {
      await this.postComment(conversationId, message);
      return;
    }

    const chunks = splitIntoParagraphChunks(message, MAX_MESSAGE_LENGTH - 500);
    for (const chunk of chunks) {
      await this.postComment(conversationId, chunk);
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

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  async handleWebhook(payload: string, token: string): Promise<void> {
    if (!verifyWebhookToken(token, this.webhookSecret)) {
      getLog().error({ payloadSize: payload.length }, 'jira.invalid_webhook_token');
      return;
    }

    let event: JiraWebhookEvent;
    try {
      event = JSON.parse(payload) as JiraWebhookEvent;
    } catch (error) {
      getLog().error({ err: error, payloadSize: payload.length }, 'jira.webhook_parse_failed');
      return;
    }

    const issue = event.issue;
    if (!issue?.key) {
      getLog().debug({ eventType: event.webhookEvent }, 'jira.webhook_without_issue');
      return;
    }

    if (!event.comment) {
      if (this.isTerminalIssueUpdate(event)) {
        await this.cleanupIssue(issue.key);
      }
      return;
    }

    const actor = this.getCommentActor(event.comment, event.user);
    if (!isJiraUserAuthorized(actor, this.allowedUsers)) {
      getLog().info({ user: this.maskUser(actor) }, 'jira.unauthorized_webhook');
      return;
    }

    const commentText = this.documentToText(event.comment.body);
    if (!commentText || commentText.includes(BOT_RESPONSE_MARKER)) {
      return;
    }

    if (!this.hasMention(commentText)) {
      return;
    }

    const strippedComment = this.stripMention(commentText);
    if (!strippedComment) {
      return;
    }

    const conversationId = issue.key;
    getLog().info(
      { conversationId, eventType: event.webhookEvent ?? event.issue_event_type_name },
      'jira.webhook_processing'
    );

    try {
      await db.getOrCreateConversation('jira', conversationId);

      const isSlashCommand = strippedComment.trim().startsWith('/');
      const finalMessage = isSlashCommand
        ? (strippedComment.split('\n')[0]?.trim() ?? strippedComment.trim())
        : this.buildIssueContext(issue, strippedComment);
      const issueContext = this.buildBriefIssueContext(issue);
      const commentHistory = await this.fetchCommentHistory(issue.key);
      const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
      const isolationHints: IsolationHints = {
        workflowType: 'issue',
        workflowId: issue.key,
      };

      await this.lockManager.acquireLock(conversationId, async () => {
        try {
          await handleMessage(this, conversationId, finalMessage, {
            issueContext,
            threadContext,
            isolationHints,
          });
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
    } catch (error) {
      const err = toError(error);
      getLog().error({ err, conversationId }, 'jira.webhook_setup_failed');
      try {
        await this.sendMessage(conversationId, classifyAndFormatError(err));
      } catch (sendError) {
        getLog().error(
          { err: toError(sendError), conversationId },
          'jira.webhook_setup_error_send_failed'
        );
      }
    }
  }

  private async postComment(issueKey: string, message: string): Promise<void> {
    const markedMessage = `${message}\n\n${BOT_RESPONSE_MARKER}`;
    const body =
      this.apiVersion === '3' ? { body: this.textToAdf(markedMessage) } : { body: markedMessage };

    await this.jiraApi<unknown>('POST', `/issue/${encodeURIComponent(issueKey)}/comment`, body);
  }

  private async fetchCommentHistory(issueKey: string): Promise<string[]> {
    try {
      const response = await this.jiraApi<JiraCommentsResponse>(
        'GET',
        `/issue/${encodeURIComponent(issueKey)}/comment?maxResults=20&orderBy=created`
      );

      return response.comments.slice(-20).map(comment => {
        const author = this.userDisplayName(this.getCommentActor(comment));
        const body = this.documentToText(comment.body);
        return `${author}: ${body}`;
      });
    } catch (error) {
      getLog().error({ err: error, issueKey }, 'jira.comment_history_fetch_failed');
      return [];
    }
  }

  private async cleanupIssue(issueKey: string): Promise<void> {
    getLog().info({ conversationId: issueKey }, 'jira.isolation_cleanup_started');
    try {
      await onConversationClosed('jira', issueKey, { merged: false });
      getLog().info({ conversationId: issueKey }, 'jira.isolation_cleanup_completed');
    } catch (error) {
      getLog().error({ err: error, conversationId: issueKey }, 'jira.isolation_cleanup_failed');
    }
  }

  private async jiraApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/rest/api/${this.apiVersion}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Jira API ${method} ${path}: ${String(response.status)} ${response.statusText} - ${text}`
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private authHeader(): string {
    if (this.email) {
      return `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`;
    }
    return `Bearer ${this.token}`;
  }

  private hasMention(text: string): boolean {
    const escaped = this.escapeRegExp(this.botMention);
    return new RegExp(`(^|\\s)@${escaped}(?:[\\s,:;]|$)`, 'i').test(text);
  }

  private stripMention(text: string): string {
    const escaped = this.escapeRegExp(this.botMention);
    return text.replace(new RegExp(`(^|\\s)@${escaped}(?:[\\s,:;]+|$)`, 'gi'), ' ').trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private getCommentActor(comment: JiraComment, fallback?: JiraUser): JiraUser | undefined {
    return comment.author ?? comment.updateAuthor ?? fallback;
  }

  private userDisplayName(user: JiraUser | undefined): string {
    return user?.displayName ?? user?.emailAddress ?? user?.accountId ?? user?.name ?? 'unknown';
  }

  private maskUser(user: JiraUser | undefined): string {
    const value = this.userDisplayName(user);
    if (value.length <= 4) {
      return '***';
    }
    return `${value.slice(0, 3)}***`;
  }

  private isTerminalIssueUpdate(event: JiraWebhookEvent): boolean {
    if (event.webhookEvent !== 'jira:issue_updated') {
      return false;
    }

    const changedStatus = event.changelog?.items?.some(item => {
      const field = (item.fieldId ?? item.field ?? '').toLowerCase();
      return field === 'status';
    });
    if (!changedStatus) {
      return false;
    }

    const statusName = event.issue?.fields?.status?.name?.toLowerCase() ?? '';
    const statusCategory = event.issue?.fields?.status?.statusCategory?.key?.toLowerCase() ?? '';
    return statusCategory === 'done' || ['done', 'closed', 'resolved'].includes(statusName);
  }

  private buildBriefIssueContext(issue: JiraIssue): string {
    const fields = issue.fields;
    const summary = fields?.summary ?? '';
    const status = fields?.status?.name ?? 'unknown';
    return `Jira issue ${issue.key}: "${summary}"\nStatus: ${status}`;
  }

  private buildIssueContext(issue: JiraIssue, userComment: string): string {
    const fields = issue.fields;
    const labels = fields?.labels?.join(', ') || 'none';
    const status = fields?.status?.name ?? 'unknown';
    const issueType = fields?.issuetype?.name ?? 'issue';
    const description = this.documentToText(fields?.description);

    return `[Jira Issue Context]
Issue ${issue.key}: "${fields?.summary ?? ''}"
Type: ${issueType}
Status: ${status}
Labels: ${labels}

Description:
${description}

---

${userComment}

Use explicit Archon project routing when needed, for example:
/workflow run workers-fullstack-fix --project workers-fullstack "Implement ${issue.key}"`;
  }

  private documentToText(document: JiraDocument): string {
    if (!document) {
      return '';
    }

    if (typeof document === 'string') {
      return document.trim();
    }

    return this.normalizeText(this.adfNodeToText(document));
  }

  private adfNodeToText(node: JiraAdfNode): string {
    if (node.type === 'text') {
      return node.text ?? '';
    }

    if (node.type === 'mention') {
      const mention = node.attrs?.text ?? node.attrs?.id ?? '';
      return mention.startsWith('@') ? mention : `@${mention}`;
    }

    if (node.type === 'hardBreak') {
      return '\n';
    }

    const children = node.content?.map(child => this.adfNodeToText(child)) ?? [];
    const joined = children.join('');

    switch (node.type) {
      case 'paragraph':
      case 'heading':
      case 'blockquote':
      case 'listItem':
        return `${joined}\n`;
      case 'bulletList':
      case 'orderedList':
      case 'doc':
        return children.join('\n');
      default:
        return joined;
    }
  }

  private normalizeText(text: string): string {
    return text
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private textToAdf(text: string): JiraAdfNode {
    return {
      type: 'doc',
      version: 1,
      content: text.split(/\n{2,}/).map(paragraph => ({
        type: 'paragraph',
        content: this.paragraphToAdfContent(paragraph),
      })),
    };
  }

  private paragraphToAdfContent(paragraph: string): JiraAdfNode[] {
    const lines = paragraph.split('\n');
    const content: JiraAdfNode[] = [];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (line.length > 0) {
        content.push({ type: 'text', text: line });
      }
      if (index < lines.length - 1) {
        content.push({ type: 'hardBreak' });
      }
    }

    return content.length > 0 ? content : [{ type: 'text', text: ' ' }];
  }
}
