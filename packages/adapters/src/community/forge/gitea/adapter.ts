/**
 * Gitea platform adapter using REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 *
 * Community forge adapter — see packages/adapters/src/community/forge/README.md
 */
import { giteaPolicy } from './policy';
import { createHmac, timingSafeEqual } from 'crypto';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
  onConversationClosed,
  type ConversationLockManager,
} from '@archon/core';
import * as userDb from '@archon/core/db/users';
import * as db from '@archon/core/db/conversations';
import { parseAllowedUsers, isGiteaUserAuthorized } from './auth';
import type { GiteaClient, WebhookEvent } from './types';
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
type CommentEvent = Extract<ParsedWebhookEvent, { kind: 'comment' }>;

export class GiteaAdapter implements IPlatformAdapter {
  readonly capabilities = {
    messagePersistence: 'core',
    defaultWorkflowDispatch: 'foreground',
  } as const;
  private baseUrl: string;
  private token: string;
  private webhookSecret: string;
  private allowedUsers: string[];
  private botMention: string;
  private lockManager: ConversationLocker;
  private readonly retryDelayFn: (attempt: number) => number;

  constructor(
    baseUrl: string,
    token: string,
    webhookSecret: string,
    lockManager: ConversationLocker,
    botMention?: string,
    options?: { retryDelayMs?: (attempt: number) => number }
  ) {
    // Normalize base URL (remove trailing slash)
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botMention = botMention ?? 'Archon';

    // Parse Gitea user whitelist (optional - empty = open access)
    this.allowedUsers = parseAllowedUsers(process.env.GITEA_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'whitelist_enabled');
    } else {
      getLog().info('whitelist_disabled');
    }

    this.retryDelayFn = options?.retryDelayMs ?? ((attempt: number): number => 1000 * attempt);

    getLog().info({ baseUrl: this.baseUrl }, 'adapter_initialized');
  }

  private get client(): GiteaClient {
    return { baseUrl: this.baseUrl, token: this.token };
  }

  /**
   * Send a message to a Gitea issue or PR.
   * Splits long messages into paragraph-based chunks.
   * Throws on failure so caller can handle appropriately.
   */
  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    await sendComment(this.client, conversationId, message, this.retryDelayFn);
  }

  /**
   * Get streaming mode (always batch for Gitea to avoid comment spam)
   */
  getStreamingMode(): 'batch' {
    return 'batch';
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return giteaPolicy.id;
  }

  /**
   * Start the adapter (no-op for webhook-based adapter)
   */
  async start(): Promise<void> {
    getLog().info('webhook_adapter_ready');
  }

  /**
   * Stop the adapter (no-op for webhook-based adapter)
   */
  stop(): void {
    getLog().info('adapter_stopped');
  }

  /**
   * Ensure responses go to a thread.
   * Gitea issues/PRs are inherently threaded - all comments go to the issue.
   * Returns original conversation ID unchanged.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  /**
   * Verify webhook signature using HMAC SHA-256
   * Gitea uses X-Gitea-Signature header with raw hex (no sha256= prefix)
   */
  private verifySignature(payload: Uint8Array, signature: string): boolean {
    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      const digest = hmac.update(payload).digest('hex');

      const digestBuffer = Buffer.from(digest);
      const signatureBuffer = Buffer.from(signature);

      if (digestBuffer.length !== signatureBuffer.length) {
        getLog().error(
          { receivedLength: signatureBuffer.length, computedLength: digestBuffer.length },
          'signature_length_mismatch'
        );
        return false;
      }

      const isValid = timingSafeEqual(digestBuffer, signatureBuffer);

      if (!isValid) {
        getLog().error(
          {
            receivedPrefix: signature.substring(0, 15) + '...',
            computedPrefix: digest.substring(0, 15) + '...',
          },
          'signature_mismatch'
        );
      }

      return isValid;
    } catch (error) {
      getLog().error({ err: error }, 'signature_verification_error');
      return false;
    }
  }

  /**
   * Clean up worktree when an issue/PR is closed
   * Delegates to cleanup service for unified handling
   */
  private async cleanupWorktree(
    owner: string,
    repo: string,
    number: number,
    isPR: boolean,
    merged: boolean
  ): Promise<void> {
    const conversationId = buildConversationId(owner, repo, number, isPR);
    getLog().info({ conversationId, merged }, 'isolation_cleanup_started');

    try {
      await onConversationClosed(giteaPolicy.id, conversationId, { merged });
      getLog().info({ conversationId }, 'isolation_cleanup_complete');
    } catch (error) {
      const err = error as Error;
      // Log full context for debugging - cleanup failures shouldn't break user flow
      getLog().error({ err, conversationId }, 'isolation_cleanup_failed');
    }
  }

  /**
   * Handle incoming webhook event
   */
  async handleWebhook(payload: Uint8Array, signature: string): Promise<void> {
    // Verify signature over the bytes Gitea signed, before any decoding
    if (!this.verifySignature(payload, signature)) {
      getLog().error(
        { signaturePrefix: signature?.substring(0, 15) + '...', payloadSize: payload.byteLength },
        'invalid_webhook_signature'
      );
      return;
    }

    // The default decoder drops a leading BOM, which JSON.parse rejects
    const event = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(payload)
    ) as WebhookEvent;

    if (!isGiteaUserAuthorized(event.sender?.login, this.allowedUsers)) {
      getLog().info({ platform: giteaPolicy.id }, 'unauthorized_webhook');
      return; // Silent rejection - no error response
    }

    const parsed = parseWebhookEvent(event);
    if (!parsed) return;

    if (parsed.kind === 'close') {
      const { owner, repo, number, isPR, merged } = parsed;
      const mergeLabel = merged ? 'merge' : 'close';
      getLog().info({ event: mergeLabel, owner, repo, number }, 'close_event_received');
      await this.cleanupWorktree(owner, repo, number, isPR, merged);
      return;
    }

    if (!this.acceptsComment(event, parsed)) return;
    await this.dispatchComment(event, parsed);
  }

  /** Drop the bot's own comments and comments without an @mention. */
  private acceptsComment(event: WebhookEvent, parsed: CommentEvent): boolean {
    // Primary: Check for hidden marker in comment body (works with user's token)
    const commentBody = event.comment?.body ?? '';
    if (commentBody.includes(BOT_RESPONSE_MARKER)) {
      getLog().debug('ignoring_marked_comment');
      return false;
    }
    // Secondary: Check comment author (works with dedicated bot account)
    const commentAuthor = event.comment?.user?.login;
    if (commentAuthor?.toLowerCase() === this.botMention.toLowerCase()) {
      getLog().debug('ignoring_own_comment');
      return false;
    }
    return hasMention(parsed.comment, this.botMention);
  }

  /** Prepare the repository and conversation for a comment, then route it to the orchestrator. */
  private async dispatchComment(event: WebhookEvent, parsed: CommentEvent): Promise<void> {
    const { owner, repo, number, isPR, issue, pullRequest } = parsed;
    getLog().info({ eventType: 'issue_comment', owner, repo, number, isPR }, 'webhook_processing');

    // Comment author may differ from event.sender for PR-review comments; prefer
    // the comment author when present so individual reviewers get their own row.
    const archonUserId = await resolveArchonUser(event.comment?.user?.login ?? event.sender?.login);
    const conversationId = buildConversationId(owner, repo, number, isPR);

    const {
      codebase,
      repoPath,
      isNew: isNewCodebase,
    } = await getOrCreateCodebaseForRepo(this.baseUrl, owner, repo);
    // Clone if needed, sync if new conversation
    await ensureRepoReady(
      this.baseUrl,
      owner,
      repo,
      event.repository.default_branch,
      codebase,
      isNewCodebase
    );
    await linkConversationToCodebase(conversationId, codebase.id, repoPath);
    if (isNewCodebase) await autoDetectAndLoadCommands(repoPath, codebase.id);

    const isolationHints = buildIsolationHints(parsed, pullRequest);
    const { message, issueContext } = buildCommentMessage(
      stripMention(parsed.comment, this.botMention),
      isPR,
      issue,
      pullRequest
    );

    const commentHistory = await fetchCommentHistory(this.client, owner, repo, number);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
    getLog().debug(
      { commentCount: threadContext ? commentHistory.length : 0, conversationId },
      'thread_context_loaded'
    );

    // Route to orchestrator with isolation hints (with lock for concurrency control)
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
        getLog().error({ err, conversationId }, 'message_handling_error');
        try {
          const userMessage = classifyAndFormatError(err);
          await this.sendMessage(conversationId, userMessage);
        } catch (sendError) {
          getLog().error({ err: toError(sendError), conversationId }, 'error_message_send_failed');
        }
      }
    });
  }
}

/**
 * Resolve a Gitea login to an Archon user, creating it on first sight.
 * Resolution failure must not drop the webhook — warn-log and continue with
 * no user so the conversation/run rows fall back to NULL.
 */
async function resolveArchonUser(login: string | undefined): Promise<string | undefined> {
  if (!login) return undefined;
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity(giteaPolicy.id, login, login);
    return user.id;
  } catch (err) {
    getLog().warn({ err: toError(err), platform: giteaPolicy.id }, 'gitea.user_resolve_failed');
    return undefined;
  }
}

async function linkConversationToCodebase(
  conversationId: string,
  codebaseId: string,
  repoPath: string
): Promise<void> {
  const existingConv = await db.getOrCreateConversation(giteaPolicy.id, conversationId, codebaseId);
  if (existingConv.codebase_id && existingConv.cwd) return;
  try {
    await db.updateConversation(existingConv.id, { codebase_id: codebaseId, cwd: repoPath });
  } catch (updateError) {
    if (updateError instanceof ConversationNotFoundError) {
      getLog().error(
        { conversationId: existingConv.id, codebaseId },
        'conversation_codebase_link_failed'
      );
      // Re-throw as this is a critical setup step
      throw new Error('Failed to set up Gitea conversation - please try again');
    }
    throw updateError;
  }
}
