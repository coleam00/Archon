/**
 * GitLab platform adapter using REST API v4 and Webhooks
 * Handles issue and MR comments with @mention detection
 *
 * Community forge adapter — see packages/adapters/src/community/forge/README.md
 */
import { gitlabPolicy } from './policy';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
  onConversationClosed,
  type ConversationLockManager,
} from '@archon/core';
import * as db from '@archon/core/db/conversations';
import * as userDb from '@archon/core/db/users';
import { parseAllowedUsers, isGitLabUserAuthorized, verifyWebhookToken } from './auth';
import type { GitLabClient, GitLabWebhookEvent } from './types';
import { getLog } from './log';
import { BOT_RESPONSE_MARKER, buildConversationId, sendComment } from './comment-delivery';
import { ensureRepoReady } from './repository-readiness';
import { autoDetectAndLoadCommands, getOrCreateCodebaseForRepo } from './registration';
import {
  buildCommentMessage,
  buildIsolationHints,
  fetchCommentHistory,
  hasMention,
  parseWebhookEvent,
  stripMention,
  type ParsedWebhookEvent,
} from './webhook-intake';

type ConversationLocker = Pick<ConversationLockManager, 'acquireLock'>;
type NoteEvent = Extract<ParsedWebhookEvent, { kind: 'note' }>;

export class GitLabAdapter implements IPlatformAdapter {
  readonly capabilities = {
    messagePersistence: 'core',
    defaultWorkflowDispatch: 'foreground',
  } as const;
  private readonly gitlabUrl: string;
  private readonly token: string;
  private readonly webhookSecret: string;
  private readonly allowedUsers: string[];
  private readonly botMention: string;
  private readonly lockManager: ConversationLocker;

  constructor(
    token: string,
    webhookSecret: string,
    lockManager: ConversationLocker,
    gitlabUrl?: string,
    botMention?: string
  ) {
    if (!token) {
      throw new Error('GitLabAdapter requires a non-empty token');
    }
    if (!webhookSecret) {
      throw new Error('GitLabAdapter requires a non-empty webhookSecret');
    }

    this.gitlabUrl = (gitlabUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
    this.token = token;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botMention = botMention ?? 'Archon';

    this.allowedUsers = parseAllowedUsers(process.env.GITLAB_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'gitlab.whitelist_enabled');
    } else {
      getLog().info('gitlab.whitelist_disabled');
    }

    getLog().info({ gitlabUrl: this.gitlabUrl }, 'gitlab.adapter_initialized');
  }

  private get client(): GitLabClient {
    return { gitlabUrl: this.gitlabUrl, token: this.token };
  }

  // ---------------------------------------------------------------------------
  // IPlatformAdapter methods
  // ---------------------------------------------------------------------------

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    await sendComment(this.client, conversationId, message);
  }

  getStreamingMode(): 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return gitlabPolicy.id;
  }

  async start(): Promise<void> {
    getLog().info('gitlab.webhook_adapter_ready');
  }

  stop(): void {
    getLog().info('gitlab.adapter_stopped');
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  private async cleanupWorktree(
    projectPath: string,
    iid: number,
    isMR: boolean,
    merged: boolean
  ): Promise<void> {
    const conversationId = buildConversationId(projectPath, iid, isMR);
    getLog().info({ conversationId, merged }, 'gitlab.isolation_cleanup_started');

    try {
      await onConversationClosed(gitlabPolicy.id, conversationId, { merged });
      getLog().info({ conversationId }, 'gitlab.isolation_cleanup_completed');
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, conversationId }, 'gitlab.isolation_cleanup_failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

  async handleWebhook(payload: string, token: string): Promise<void> {
    if (!verifyWebhookToken(token, this.webhookSecret)) {
      getLog().error({ payloadSize: payload.length }, 'gitlab.invalid_webhook_token');
      return;
    }

    let event: GitLabWebhookEvent;
    try {
      event = JSON.parse(payload) as GitLabWebhookEvent;
    } catch (error) {
      getLog().error({ err: error, payloadSize: payload.length }, 'gitlab.webhook_parse_failed');
      return;
    }

    const senderUsername = event.user?.username;
    if (!isGitLabUserAuthorized(senderUsername, this.allowedUsers)) {
      getLog().info({ platform: gitlabPolicy.id }, 'gitlab.unauthorized_webhook');
      return;
    }

    const parsed = parseWebhookEvent(event);
    if (!parsed) return;
    const { projectPath, iid, isMR } = parsed;

    if (parsed.kind === 'close') {
      const mergeLabel = parsed.merged ? 'merge' : 'close';
      getLog().info({ event: mergeLabel, projectPath, iid }, 'gitlab.close_event_received');
      await this.cleanupWorktree(projectPath, iid, isMR, parsed.merged);
      return;
    }

    if (!this.acceptsNote(parsed, senderUsername)) return;

    getLog().info({ eventType: 'note', projectPath, iid, isMR }, 'gitlab.webhook_processing');
    const archonUserId = await resolveArchonUser(senderUsername);

    // Setup failures are reported to the thread so the user gets feedback
    try {
      await this.dispatchNote(event, parsed, archonUserId);
    } catch (error) {
      const err = toError(error);
      const conversationId = buildConversationId(projectPath, iid, isMR);
      getLog().error({ err, conversationId }, 'gitlab.webhook_setup_failed');
      await this.reportToThread(conversationId, err, 'gitlab.webhook_setup_error_send_failed');
    }
  }

  /** Drop the bot's own notes and notes without an @mention. */
  private acceptsNote(parsed: NoteEvent, senderUsername: string | undefined): boolean {
    if (parsed.comment.includes(BOT_RESPONSE_MARKER)) {
      getLog().debug('gitlab.ignoring_marked_comment');
      return false;
    }
    if (senderUsername?.toLowerCase() === this.botMention.toLowerCase()) {
      getLog().debug('gitlab.ignoring_own_comment');
      return false;
    }
    return hasMention(parsed.comment, this.botMention);
  }

  /** Prepare the repository and conversation for a note, then route it to the orchestrator. */
  private async dispatchNote(
    event: GitLabWebhookEvent,
    parsed: NoteEvent,
    archonUserId: string | undefined
  ): Promise<void> {
    const { projectPath, iid, isMR, issue, mergeRequest } = parsed;
    const conversationId = buildConversationId(projectPath, iid, isMR);

    const {
      codebase,
      repoPath,
      isNew: isNewCodebase,
    } = await getOrCreateCodebaseForRepo(this.gitlabUrl, projectPath);
    await ensureRepoReady(
      this.client,
      projectPath,
      event.project.default_branch,
      codebase,
      isNewCodebase
    );
    await linkConversationToCodebase(conversationId, codebase.id, repoPath);
    if (isNewCodebase) await autoDetectAndLoadCommands(repoPath, codebase.id);

    const isolationHints = buildIsolationHints(parsed, mergeRequest);
    const { message, issueContext } = buildCommentMessage(
      stripMention(parsed.comment, this.botMention),
      isMR,
      issue,
      mergeRequest
    );

    const commentHistory = await fetchCommentHistory(this.client, parsed);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
    getLog().debug(
      { commentCount: threadContext ? commentHistory.length : 0, conversationId },
      'gitlab.thread_context_loaded'
    );

    await this.lockManager.acquireLock(conversationId, async () => {
      try {
        await handleMessage(this, conversationId, message, {
          issueContext,
          threadContext,
          isolationHints,
          actor: archonUserId ? { kind: 'user', userId: archonUserId } : { kind: 'unidentified' },
        });
      } catch (error) {
        const err = toError(error);
        getLog().error({ err, conversationId }, 'gitlab.message_handling_error');
        await this.reportToThread(conversationId, err, 'gitlab.error_message_send_failed');
      }
    });
  }

  /** Post a failure's user-facing explanation to the thread; a failed post is only logged. */
  private async reportToThread(
    conversationId: string,
    err: Error,
    sendFailedEvent: string
  ): Promise<void> {
    try {
      await this.sendMessage(conversationId, classifyAndFormatError(err));
    } catch (sendError) {
      getLog().error({ err: toError(sendError), conversationId }, sendFailedEvent);
    }
  }
}

/**
 * Resolve a GitLab username to an Archon user, creating it on first sight.
 * Resolution failure must not drop the webhook — warn-log and continue with
 * no user so the conversation/run rows fall back to NULL.
 */
async function resolveArchonUser(username: string | undefined): Promise<string | undefined> {
  if (!username) return undefined;
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity(
      gitlabPolicy.id,
      username,
      username
    );
    return user.id;
  } catch (err) {
    getLog().warn({ err: toError(err), platform: gitlabPolicy.id }, 'gitlab.user_resolve_failed');
    return undefined;
  }
}

async function linkConversationToCodebase(
  conversationId: string,
  codebaseId: string,
  repoPath: string
): Promise<void> {
  const existingConv = await db.getOrCreateConversation(
    gitlabPolicy.id,
    conversationId,
    codebaseId
  );
  if (existingConv.codebase_id && existingConv.cwd) return;
  try {
    await db.updateConversation(existingConv.id, { codebase_id: codebaseId, cwd: repoPath });
  } catch (updateError) {
    if (updateError instanceof ConversationNotFoundError) {
      getLog().error(
        { conversationId: existingConv.id, codebaseId },
        'gitlab.conversation_codebase_link_failed'
      );
      throw new Error('Failed to set up GitLab conversation - please try again');
    }
    throw updateError;
  }
}
