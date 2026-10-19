/**
 * GitHub platform adapter using Octokit REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 */
import { githubPolicy } from './policy';
import { Octokit } from '@octokit/rest';
import { randomUUID } from 'crypto';
import { verifyGitHubWebhookSignature } from './webhook-signature';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
  onConversationClosed,
  type ConversationLockManager,
  DeliveryDeduplicator,
} from '@archon/core';
import * as db from '@archon/core/db/conversations';
import * as userDb from '@archon/core/db/users';
import { parseAllowedUsers as parseGitHubAllowedUsers, isGitHubUserAuthorized } from './auth';
import { isCheckRunCompletedEvent, type WebhookEvent } from './types';
import type { GitHubAdapterAuth, GitHubApi, GitHubApiCall } from './types';
import { getLog } from './log';
import { signalCheckRunWaits } from './check-run-signal';
import { BOT_RESPONSE_MARKER, CommentDelivery, buildConversationId } from './comment-delivery';
import { ensureRepoReady } from './repository-readiness';
import { autoDetectAndLoadCommands, getOrCreateCodebaseForRepo } from './registration';
import {
  buildCommentMessage,
  buildIsolationHints,
  deliveryDedupKey,
  fetchCommentHistory,
  hasMention,
  parseWebhookEvent,
  stripMention,
  type ParsedWebhookEvent,
} from './webhook-intake';

type ConversationLocker = Pick<ConversationLockManager, 'acquireLock'>;
type CommentEvent = Extract<ParsedWebhookEvent, { kind: 'comment' }>;

export class GitHubAdapter implements IPlatformAdapter {
  readonly capabilities = {
    messagePersistence: 'core',
    defaultWorkflowDispatch: 'foreground',
  } as const;
  /**
   * PAT-mode Octokit: a singleton constructed at startup. Null in App mode —
   * App-mode callers use `resolveOctokit(owner, repo)` to get a per-installation
   * Octokit from the auth provider. Tests reach in via `@ts-expect-error` and
   * assign a mock object to this field.
   */
  private octokit: GitHubApi | null;
  private readonly auth: GitHubAdapterAuth;
  private webhookSecret: string;
  private allowedUsers: string[];
  private botMention: string;
  private lockManager: ConversationLocker;
  /**
   * Ingest idempotency: drops repeat deliveries of one logical comment event
   * (dual repo+App subscriptions, LB double-forwards, redeliveries) before
   * they reach the lock manager, which orders but does not dedup.
   */
  private readonly deliveryDedup = new DeliveryDeduplicator();
  private readonly comments: CommentDelivery;
  private readonly callApi: GitHubApiCall = (owner, repo, fn) =>
    this.withTokenRefresh(owner, repo, fn);

  constructor(
    auth: GitHubAdapterAuth,
    webhookSecret: string,
    lockManager: ConversationLocker,
    botMention?: string,
    options?: {
      retryDelayMs?: (attempt: number) => number;
      getUserToken?: (userId: string) => Promise<string | undefined>;
    }
  ) {
    this.auth = auth;
    this.octokit = auth.kind === 'pat' ? new Octokit({ auth: auth.token }) : null;
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botMention = botMention ?? 'Archon';

    // Parse GitHub user whitelist (optional - empty = open access)
    this.allowedUsers = parseGitHubAllowedUsers(process.env.GITHUB_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'github.whitelist_enabled');
    } else {
      getLog().info('github.whitelist_disabled');
    }

    this.comments = new CommentDelivery({
      appMode: auth.kind === 'app',
      callApi: this.callApi,
      retryDelayMs: options?.retryDelayMs ?? ((attempt: number): number => 1000 * attempt),
      getUserToken: options?.getUserToken,
    });

    getLog().info({ authMode: auth.kind }, 'github.adapter_initialized');
  }

  /**
   * Auth mode discriminator exposed for the server bootstrap so that the
   * internal /git-credential endpoint can be conditionally registered.
   */
  getAuthMode(): 'pat' | 'app' {
    return this.auth.kind;
  }

  /**
   * Resolve a fresh installation token for the (owner, repo). App mode only —
   * throws in PAT mode so the server's internal endpoint surface fails fast if
   * mis-registered.
   */
  async getInstallationToken(owner: string, repo: string): Promise<string> {
    if (this.auth.kind !== 'app') {
      throw new Error('getInstallationToken is only available in App mode');
    }
    return this.auth.provider.getInstallationToken(owner, repo);
  }

  /**
   * Resolve the right Octokit for an outbound API call. In PAT mode this is
   * the constructor-created singleton; in App mode it's a per-installation
   * Octokit fetched from the auth provider (which caches by installation id).
   */
  private async resolveOctokit(owner: string, repo: string): Promise<GitHubApi> {
    if (this.auth.kind === 'pat') {
      // Non-null in PAT mode by construction; tests overwrite this field directly.
      if (!this.octokit) {
        throw new Error('Octokit unavailable in PAT mode — adapter not initialized');
      }
      return this.octokit;
    }
    return this.auth.provider.getOctokitForInstallation(owner, repo);
  }

  /**
   * In App mode the bot account is `<slug>[bot]`; in PAT mode it's whatever the
   * operator configured as `botMention` (defaults to the PAT-owner's GitHub
   * username when the operator names it accordingly). Used for the secondary
   * self-filter — distinct from @mention parsing which always uses botMention.
   */
  private get botLogin(): string {
    return this.auth.kind === 'app' ? `${this.auth.provider.slug}[bot]` : this.botMention;
  }

  /**
   * Wrap an Octokit call with a single retry on 401. In App mode a stale cached
   * token (e.g. revoked mid-session) surfaces as 401; we evict + retry once.
   * In PAT mode 401 is unrecoverable (operator must rotate the PAT), so we
   * surface immediately.
   */
  private async withTokenRefresh<T>(
    owner: string,
    repo: string,
    fn: (octokit: GitHubApi) => Promise<T>
  ): Promise<T> {
    const octokit = await this.resolveOctokit(owner, repo);
    try {
      return await fn(octokit);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 401 || this.auth.kind !== 'app') {
        throw err;
      }
      // Evict BOTH caches (token + lookup) so an App-reinstall scenario doesn't
      // serve the stale installation id from the lookupCache for the full 1h.
      this.auth.provider.invalidateRepo(owner, repo);
      const fresh = await this.resolveOctokit(owner, repo);
      try {
        return await fn(fresh);
      } catch (retryErr) {
        // Second consecutive failure — surface a distinct ERROR log so this
        // path is greppable in incident triage. Bound by design: no third
        // retry, the error propagates from here.
        const retryStatus = (retryErr as { status?: number }).status;
        getLog().error(
          {
            err: retryErr,
            owner,
            repo,
            firstStatus: status,
            retryStatus,
          },
          'github.token_refresh_retry_failed'
        );
        throw retryErr;
      }
    }
  }

  /**
   * Send a message to a GitHub issue or PR.
   * Splits long messages into paragraph-based chunks.
   * Throws on failure so caller can handle appropriately.
   */
  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    await this.comments.send(conversationId, message);
  }

  /**
   * Get streaming mode (always batch for GitHub to avoid comment spam)
   */
  getStreamingMode(): 'batch' {
    return 'batch';
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return githubPolicy.id;
  }

  /**
   * Start the adapter (no-op for webhook-based adapter)
   */
  async start(): Promise<void> {
    getLog().info('github.webhook_adapter_ready');
  }

  /**
   * Stop the adapter (no-op for webhook-based adapter)
   */
  stop(): void {
    getLog().info('github.adapter_stopped');
  }

  /**
   * Ensure responses go to a thread.
   * GitHub issues/PRs are inherently threaded - all comments go to the issue.
   * Returns original conversation ID unchanged.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  /**
   * Verify webhook signature using HMAC SHA-256
   */
  private verifySignature(payload: string, signature: string): boolean {
    const valid = verifyGitHubWebhookSignature(payload, signature, this.webhookSecret);
    if (!valid) getLog().warn('github.signature_mismatch');
    return valid;
  }

  /**
   * Clean up worktree when an issue/PR is closed
   * Delegates to cleanup service for unified handling
   */
  private async cleanupWorktree(
    owner: string,
    repo: string,
    number: number,
    merged: boolean
  ): Promise<void> {
    const conversationId = buildConversationId(owner, repo, number);
    getLog().info({ conversationId, merged }, 'github.isolation_cleanup_started');

    try {
      await onConversationClosed(githubPolicy.id, conversationId, { merged });
      getLog().info({ conversationId }, 'github.isolation_cleanup_completed');
    } catch (error) {
      const err = error as Error;
      // Log full context for debugging - cleanup failures shouldn't break user flow
      getLog().error({ err, conversationId }, 'github.isolation_cleanup_failed');
    }
  }

  /** Receive conversational events and durable-wait signals independently of source plugins. */
  async receiveWebhook(
    payload: string,
    signature: string,
    deliveryId?: string,
    eventName?: string
  ): Promise<'accepted' | 'invalid_signature' | 'malformed'> {
    if (!this.verifySignature(payload, signature)) {
      getLog().warn(
        { attemptId: randomUUID(), reason: 'invalid_signature' },
        'github.webhook_rejected'
      );
      return 'invalid_signature';
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload) as unknown;
    } catch {
      getLog().warn({ reason: 'invalid_json' }, 'github.webhook_rejected');
      return 'malformed';
    }
    if (eventName === 'check_run') {
      if (isCheckRunCompletedEvent(decoded)) await signalCheckRunWaits(decoded);
    } else {
      // Chat execution is asynchronous; source-plugin receipt acceptance has its own endpoint.
      void this.handleWebhook(payload, signature, deliveryId, eventName).catch((error: unknown) => {
        getLog().error(
          { err: error as Error, deliveryId, eventName },
          'github.conversational_webhook_failed'
        );
      });
    }
    return 'accepted';
  }

  /**
   * Handle incoming webhook event
   * @param deliveryId - GitHub's X-GitHub-Delivery GUID; dedup fallback when
   *   the payload carries no comment identity
   * @param githubEvent - GitHub's X-GitHub-Event delivery type
   */
  async handleWebhook(
    payload: string,
    signature: string,
    deliveryId?: string,
    githubEvent?: string
  ): Promise<void> {
    if (!this.verifySignature(payload, signature)) {
      getLog().error(
        { attemptId: randomUUID(), reason: 'invalid_signature' },
        'github.invalid_webhook_signature'
      );
      return;
    }

    const decoded = JSON.parse(payload) as unknown;
    if (githubEvent === 'check_run') {
      if (isCheckRunCompletedEvent(decoded)) {
        await signalCheckRunWaits(decoded);
      } else {
        getLog().debug('github.check_run_ignored');
      }
      return;
    }
    const event = decoded as WebhookEvent;

    if (!isGitHubUserAuthorized(event.sender?.login, this.allowedUsers)) {
      getLog().info({ platform: githubPolicy.id }, 'github.unauthorized_webhook');
      return; // Silent rejection - no error response
    }

    const parsed = parseWebhookEvent(event, githubEvent);
    if (!parsed) return;
    const { owner, repo, number } = parsed;

    // App-mode optimisation: the webhook payload already includes the
    // installation id. Priming the lookup cache skips one HTTP round trip
    // (`GET /repos/{owner}/{repo}/installation`) before the first outbound API
    // call to this repo after a restart. No-op when payload lacks installation.
    if (this.auth.kind === 'app' && event.installation?.id !== undefined) {
      this.auth.provider.primeInstallationLookup(owner, repo, event.installation.id);
    }

    if (parsed.kind === 'close') {
      const mergeLabel = parsed.merged ? 'merge' : 'close';
      getLog().info({ event: mergeLabel, owner, repo, number }, 'github.close_event_received');
      await this.cleanupWorktree(owner, repo, number, parsed.merged);
      return;
    }

    if (!this.acceptsComment(event, parsed, deliveryId)) return;
    await this.dispatchComment(event, parsed);
  }

  /** Drop the bot's own comments, comments without an @mention, and repeat deliveries. */
  private acceptsComment(
    event: WebhookEvent,
    parsed: CommentEvent,
    deliveryId: string | undefined
  ): boolean {
    // Primary: Check for hidden marker in comment body (works with user's PAT)
    const commentBody = event.comment?.body ?? '';
    if (commentBody.includes(BOT_RESPONSE_MARKER)) {
      getLog().debug('github.ignoring_marked_comment');
      return false;
    }
    // Secondary: Check comment author. In App mode the bot account is
    // `<slug>[bot]`; in PAT mode it's whatever the operator named via
    // botMention. Comparing against `botLogin` (not `botMention`) keeps the
    // filter narrow — comments posted under a user's own GitHub login from a
    // user-to-server token would otherwise be misfiltered.
    const commentAuthor = event.comment?.user?.login;
    if (commentAuthor?.toLowerCase() === this.botLogin.toLowerCase()) {
      getLog().debug('github.ignoring_own_comment');
      return false;
    }

    if (!hasMention(parsed.comment, this.botMention)) return false;

    // seen() claims the key BEFORE the downstream work: dual-subscription
    // duplicates arrive near-simultaneously, so marking only after success
    // would let both pass and double-process. Tradeoff: a redelivery whose
    // first attempt failed within the TTL is dropped — acceptable for this
    // fire-and-forget route, where failures are logged rather than retried.
    const dedupKey = deliveryDedupKey(event, parsed, deliveryId);
    if (dedupKey && this.deliveryDedup.seen(dedupKey)) {
      const { owner, repo, number } = parsed;
      getLog().info(
        { eventType: 'issue_comment', owner, repo, number, deliveryId },
        'github.duplicate_delivery_dropped'
      );
      return false;
    }
    return true;
  }

  /** Prepare the repository and conversation for a comment, then route it to the orchestrator. */
  private async dispatchComment(event: WebhookEvent, parsed: CommentEvent): Promise<void> {
    const { owner, repo, number, issue, pullRequest } = parsed;
    getLog().info({ eventType: 'issue_comment', owner, repo, number }, 'github.webhook_processing');

    // Comment author may differ from event.sender for PR-review comments; prefer
    // the comment author when present so individual reviewers get their own row.
    const archonUserId = await resolveArchonUser(event.comment?.user?.login ?? event.sender?.login);
    const conversationId = buildConversationId(owner, repo, number);
    this.comments.rememberActor(conversationId, archonUserId);

    const {
      codebase,
      repoPath,
      isNew: isNewCodebase,
    } = await getOrCreateCodebaseForRepo(owner, repo);
    const defaultBranch = await this.fetchDefaultBranch(owner, repo, conversationId);
    if (defaultBranch === undefined) return;

    // Clone if needed, sync if new conversation
    await ensureRepoReady(this.auth, owner, repo, defaultBranch, codebase, isNewCodebase);
    await linkConversationToCodebase(conversationId, codebase.id, repoPath);
    // Defaults are loaded at runtime, not copied
    if (isNewCodebase) await autoDetectAndLoadCommands(repoPath, codebase.id);

    const isPR = !!pullRequest || !!issue?.pull_request;
    const isolationHints = await buildIsolationHints(this.callApi, parsed, isPR);
    const { message, issueContext } = buildCommentMessage(
      stripMention(parsed.comment, this.botMention),
      issue,
      pullRequest
    );

    const commentHistory = await fetchCommentHistory(this.callApi, owner, repo, number);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
    getLog().debug(
      { commentCount: threadContext ? commentHistory.length : 0, conversationId },
      'github.thread_context_loaded'
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
        await this.reportFailure(conversationId, error, 'github.message_handling_error');
      }
    });
  }

  /** The repository's default branch, or undefined after telling the user the lookup failed. */
  private async fetchDefaultBranch(
    owner: string,
    repo: string,
    conversationId: string
  ): Promise<string | undefined> {
    try {
      const { data: repoData } = await this.withTokenRefresh(owner, repo, octokit =>
        octokit.rest.repos.get({ owner, repo })
      );
      return repoData.default_branch;
    } catch (error) {
      await this.reportFailure(conversationId, error, 'github.repo_metadata_fetch_failed', {
        owner,
        repo,
      });
      return undefined;
    }
  }

  /** Log a failure and post its user-facing explanation to the thread. */
  private async reportFailure(
    conversationId: string,
    error: unknown,
    event: string,
    context: Record<string, string> = {}
  ): Promise<void> {
    const err = toError(error);
    getLog().error({ err, ...context, conversationId }, event);
    try {
      await this.sendMessage(conversationId, classifyAndFormatError(err));
    } catch (sendError) {
      getLog().error(
        { err: toError(sendError), conversationId },
        'github.error_message_send_failed'
      );
    }
  }
}

/**
 * Resolve a GitHub login to an Archon user, creating it on first sight.
 * Resolution failure must not drop the webhook — warn-log and continue with
 * no user so the conversation/run rows fall back to NULL.
 */
async function resolveArchonUser(login: string | undefined): Promise<string | undefined> {
  if (!login) return undefined;
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity(githubPolicy.id, login, login);
    return user.id;
  } catch (err) {
    getLog().warn({ err: toError(err), platform: githubPolicy.id }, 'github.user_resolve_failed');
    return undefined;
  }
}

async function linkConversationToCodebase(
  conversationId: string,
  codebaseId: string,
  repoPath: string
): Promise<void> {
  const existingConv = await db.getOrCreateConversation(
    githubPolicy.id,
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
        'github.conversation_codebase_link_failed'
      );
      // Re-throw as this is a critical setup step
      throw new Error('Failed to set up GitHub conversation - please try again');
    }
    throw updateError;
  }
}
