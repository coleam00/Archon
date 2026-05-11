/**
 * Gitea platform adapter using REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 *
 * Community forge adapter — see packages/adapters/src/community/forge/README.md
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { readdir, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
  onConversationClosed,
  ConversationLockManager,
} from '@archon/core';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths, createLogger } from '@archon/paths';
import {
  cloneRepository,
  syncRepository,
  addSafeDirectory,
  toRepoPath,
  toBranchName,
  isWorktreePath,
} from '@archon/git';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { parseAllowedUsers, isGiteaUserAuthorized } from './auth';
import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import type { WebhookEvent } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.gitea');
  return cachedLog;
}

const MAX_LENGTH = 65000; // Gitea comment limit (similar to GitHub)

/** Hidden marker added to bot comments to prevent self-triggering loops */
const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

export class GiteaAdapter implements IPlatformAdapter {
  private baseUrl: string;
  private token: string;
  private webhookSecret: string;
  private allowedUsers: string[];
  private botMention: string;
  private lockManager: ConversationLockManager;
  private readonly retryDelayFn: (attempt: number) => number;

  constructor(
    baseUrl: string,
    token: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
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

    getLog().info({ botMention: this.botMention, baseUrl: this.baseUrl }, 'adapter_initialized');
  }

  /**
   * Check if an error is retryable (transient network issues)
   */
  private isRetryableError(error: unknown): boolean {
    const err = error as Error | undefined;
    const message = err?.message ?? '';
    const causeErr = (error as { cause?: Error }).cause;
    const cause = causeErr?.message ?? '';
    const combined = `${message} ${cause}`.toLowerCase();

    // Retry on transient network errors
    return (
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('fetch failed')
    );
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
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      getLog().error({ conversationId }, 'invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'send_message');

    // Check if message needs splitting
    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed, message);
    } else {
      getLog().debug({ messageLength: message.length }, 'message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

      // Fail-fast: if any chunk fails, stop and propagate error with context
      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.postComment(parsed, chunks[i]);
        } catch (error) {
          const err = error as Error;
          getLog().error(
            { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
            'chunk_post_failed'
          );
          // Wrap error with context about partial delivery
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

  /**
   * Post a single comment to a Gitea issue or PR.
   * Uses issues endpoint for both issues and PRs (Gitea API behavior).
   * Includes retry logic with exponential backoff (3 attempts max).
   * Throws on failure after exhausting retries so caller can handle appropriately.
   */
  private async postComment(
    parsed: { owner: string; repo: string; number: number; isPR: boolean },
    message: string
  ): Promise<void> {
    const markedMessage = `${message}\n\n${BOT_RESPONSE_MARKER}`;
    const maxRetries = 3;
    const conversationId = this.buildConversationId(
      parsed.owner,
      parsed.repo,
      parsed.number,
      parsed.isPR
    );

    // Gitea uses issues endpoint for PR comments too
    const url = `${this.baseUrl}/api/v1/repos/${parsed.owner}/${parsed.repo}/issues/${String(parsed.number)}/comments`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `token ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ body: markedMessage }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Gitea API error: ${String(response.status)} ${response.statusText} - ${body}`
          );
        }

        getLog().debug({ conversationId }, 'comment_posted');
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = this.retryDelayFn(attempt);
          getLog().warn(
            { attempt, maxRetries, conversationId, delayMs: delay },
            'comment_post_retry'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        // Log with full context for debugging
        getLog().error(
          {
            err: error,
            conversationId,
            attempt,
            maxRetries,
            wasRetryable: isRetryable,
            messageLength: message.length,
          },
          'comment_post_failed'
        );
        // Re-throw so caller can handle (e.g., notify user, stop chunk loop)
        throw error;
      }
    }
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
    return 'gitea';
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
  private verifySignature(payload: string, signature: string): boolean {
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
   * Parse webhook event and extract relevant data
   *
   * Handles:
   * - issues.closed / pull_request.closed → cleanup (isCloseEvent: true)
   * - issue_comment.created → bot @mention detection
   * - pull_request_comment.created → bot @mention detection on PR review comments
   *
   * Does NOT handle:
   * - issues.opened / pull_request.opened → returns null (descriptions are not commands)
   */
  private parseEvent(event: WebhookEvent): {
    owner: string;
    repo: string;
    number: number;
    comment: string;
    eventType: 'issue' | 'issue_comment' | 'pull_request';
    isPR: boolean;
    issue?: WebhookEvent['issue'];
    pullRequest?: WebhookEvent['pull_request'];
    isCloseEvent?: boolean;
    isMerged?: boolean;
  } | null {
    const owner = event.repository.owner.login;
    const repo = event.repository.name;

    // Detect issue closed
    if (event.issue && event.action === 'closed' && !event.issue.pull_request) {
      return {
        owner,
        repo,
        number: event.issue.number,
        comment: '',
        eventType: 'issue',
        isPR: false,
        issue: event.issue,
        isCloseEvent: true,
      };
    }

    // Detect PR merged/closed
    if (event.pull_request && event.action === 'closed') {
      return {
        owner,
        repo,
        number: event.pull_request.number,
        comment: '',
        eventType: 'pull_request',
        isPR: true,
        pullRequest: event.pull_request,
        isCloseEvent: true,
        isMerged: event.pull_request.merged === true,
      };
    }

    // issue_comment (covers both issues and PRs in Gitea)
    if (event.comment) {
      const number = event.issue?.number ?? event.pull_request?.number;
      if (!number) return null;

      // In Gitea, issue.pull_request is an object (not null) when comment is on a PR
      const isPR = !!event.issue?.pull_request || !!event.pull_request;

      return {
        owner,
        repo,
        number,
        comment: event.comment.body,
        eventType: 'issue_comment',
        isPR,
        issue: event.issue,
        pullRequest: event.pull_request,
      };
    }

    return null;
  }

  /**
   * Check if text contains @mention for the configured bot
   */
  private hasMention(text: string): boolean {
    const pattern = new RegExp(`@${this.botMention}[\\s,:;]`, 'i');
    return pattern.test(text) || text.trim().toLowerCase() === `@${this.botMention.toLowerCase()}`;
  }

  /**
   * Strip @mention from text for the configured bot
   */
  private stripMention(text: string): string {
    const pattern = new RegExp(`@${this.botMention}[\\s,:;]+`, 'gi');
    return text.replace(pattern, '').trim();
  }

  /**
   * Fetch comment history from issue or PR
   * Returns comments in chronological order (oldest first)
   */
  private async fetchCommentHistory(
    owner: string,
    repo: string,
    number: number
  ): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/issues/${String(number)}/comments`;
      const response = await fetch(url, {
        headers: {
          Authorization: `token ${this.token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Gitea API error: ${String(response.status)}`);
      }

      const comments = (await response.json()) as {
        user?: { login: string } | null;
        body?: string | null;
      }[];

      // Gitea returns comments in chronological order by default
      // Take last 20 for context
      return comments.slice(-20).map(comment => {
        const author = comment.user?.login ?? 'unknown';
        const body = comment.body ?? '';
        return `${author}: ${body}`;
      });
    } catch (error) {
      getLog().error(
        { err: error, owner, repo, issueNumber: number },
        'comment_history_fetch_failed'
      );
      return [];
    }
  }

  /**
   * Build conversationId from owner, repo, number, and type
   * Uses # for issues, ! for PRs
   */
  private buildConversationId(owner: string, repo: string, number: number, isPR: boolean): string {
    const separator = isPR ? '!' : '#';
    return `${owner}/${repo}${separator}${String(number)}`;
  }

  /**
   * Parse conversationId into owner, repo, number, and isPR
   */
  private parseConversationId(
    conversationId: string
  ): { owner: string; repo: string; number: number; isPR: boolean } | null {
    // Try PR format first (!)
    const prRegex = /^([^/]+)\/([^!]+)!(\d+)$/;
    const prMatch = prRegex.exec(conversationId);
    if (prMatch) {
      return { owner: prMatch[1], repo: prMatch[2], number: parseInt(prMatch[3], 10), isPR: true };
    }

    // Try issue format (#)
    const issueRegex = /^([^/]+)\/([^#]+)#(\d+)$/;
    const issueMatch = issueRegex.exec(conversationId);
    if (issueMatch) {
      return {
        owner: issueMatch[1],
        repo: issueMatch[2],
        number: parseInt(issueMatch[3], 10),
        isPR: false,
      };
    }

    return null;
  }

  /**
   * Ensure repository is cloned and ready.
   * Uses @archon/git functions for safe, testable git operations.
   *
   * For new codebases: clone (directory won't exist)
   * For existing codebases: sync if shouldSync=true, skip if shouldSync=false
   *
   * @param shouldSync - Whether to sync if directory exists (pass true to ensure latest code)
   */
  private async ensureRepoReady(
    owner: string,
    repo: string,
    defaultBranch: string,
    repoPath: string,
    shouldSync: boolean
  ): Promise<void> {
    // Check if directory exists
    let directoryExists = false;
    try {
      await access(repoPath);
      directoryExists = true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        // Real error - permission denied, I/O failure, etc.
        getLog().error({ repoPath, errorCode: err.code, err }, 'repo_path_access_failed');
        throw new Error(
          `Cannot access repository at ${repoPath}: ${err.code ?? err.message}. ` +
            'Check permissions and disk health.'
        );
      }
      // ENOENT means directory doesn't exist - we'll clone below
    }

    if (directoryExists) {
      if (shouldSync) {
        getLog().info({ repoPath, defaultBranch }, 'repo_syncing');
        const syncResult = await syncRepository(toRepoPath(repoPath), toBranchName(defaultBranch));
        if (!syncResult.ok) {
          getLog().error({ repoPath, defaultBranch }, 'repo_sync_failed');
          throw new Error(
            `Failed to sync repository to ${defaultBranch}. ` +
              'Try /reset or check if the branch exists.'
          );
        }
      }
      return;
    }

    // Directory doesn't exist - clone the repository
    getLog().info({ owner, repo, repoPath }, 'repo_cloning');

    // Parse URL to get host for authenticated clone
    const urlObj = new URL(this.baseUrl);
    const repoUrl = `${urlObj.protocol}//${urlObj.host}/${owner}/${repo}.git`;

    const cloneResult = await cloneRepository(repoUrl, toRepoPath(repoPath), {
      token: process.env.GITEA_TOKEN,
    });

    if (!cloneResult.ok) {
      getLog().error({ owner, repo, repoPath, error: cloneResult.error }, 'repo_clone_failed');

      if (cloneResult.error.code === 'not_a_repo') {
        throw new Error(
          `Repository ${owner}/${repo} not found or is private. Check repository access.`
        );
      }
      if (cloneResult.error.code === 'permission_denied') {
        throw new Error(
          `Authentication failed for ${owner}/${repo}. Check GITEA_TOKEN permissions.`
        );
      }
      const unknownMsg = (cloneResult.error as { message?: string }).message ?? 'unknown error';
      throw new Error(`Failed to clone ${owner}/${repo}: ${unknownMsg}`);
    }

    await addSafeDirectory(toRepoPath(repoPath));
  }

  /**
   * Auto-detect and load commands from .archon/commands/ (or configured folder)
   */
  private async autoDetectAndLoadCommands(repoPath: string, codebaseId: string): Promise<void> {
    const commandFolders = getCommandFolderSearchPaths();

    for (const folder of commandFolders) {
      try {
        const fullPath = join(repoPath, folder);
        await access(fullPath);

        const files = (await readdir(fullPath)).filter(f => f.endsWith('.md'));
        if (files.length === 0) continue;

        const commands = await codebaseDb.getCodebaseCommands(codebaseId);
        files.forEach(file => {
          commands[file.replace('.md', '')] = {
            path: join(folder, file),
            description: `From ${folder}`,
          };
        });

        await codebaseDb.updateCodebaseCommands(codebaseId, commands);
        getLog().info({ commandCount: files.length, folder }, 'commands_loaded');
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // Folder not existing is expected - silently continue to next folder
        if (err.code === 'ENOENT') {
          continue;
        }
        // Log unexpected errors (database failures, permission issues) but don't fail setup
        getLog().error({ err, folder, errorCode: err.code }, 'commands_load_error');
        continue;
      }
    }
  }

  /**
   * Get or create codebase for repository
   * Returns: codebase record, path to use, and whether it's new
   * Always uses canonical path (not worktree paths) for codebase registration
   */
  private async getOrCreateCodebaseForRepo(
    owner: string,
    repo: string
  ): Promise<{
    codebase: { id: string; name: string; default_cwd: string };
    repoPath: string;
    isNew: boolean;
  }> {
    // Parse Gitea URL for repo URL storage
    const urlObj = new URL(this.baseUrl);
    const repoUrlNoGit = `${urlObj.protocol}//${urlObj.host}/${owner}/${repo}`;
    const repoUrlWithGit = `${repoUrlNoGit}.git`;

    let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
    existing ??= await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);

    // Canonical path includes owner to prevent collisions between repos with same name
    const canonicalPath = join(getArchonWorkspacesPath(), owner, repo);

    if (existing) {
      // Check if existing codebase points to a worktree path - fix it if so
      const looksLikeWorktreePath = existing.default_cwd.includes('/worktrees/');
      if (looksLikeWorktreePath || (await isWorktreePath(existing.default_cwd))) {
        getLog().info({ codebaseName: existing.name, canonicalPath }, 'stale_worktree_path_fixed');
        await codebaseDb.updateCodebase(existing.id, { default_cwd: canonicalPath });
        existing.default_cwd = canonicalPath;
      }

      getLog().info(
        { codebaseName: existing.name, path: existing.default_cwd },
        'existing_codebase_found'
      );
      return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
    }

    // Include owner in name to distinguish repos with same name from different owners
    const codebase = await codebaseDb.createCodebase({
      name: `${owner}/${repo}`,
      repository_url: repoUrlNoGit,
      default_cwd: canonicalPath,
    });

    getLog().info({ codebaseName: codebase.name, path: canonicalPath }, 'codebase_created');
    return { codebase, repoPath: canonicalPath, isNew: true };
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
    merged = false
  ): Promise<void> {
    const conversationId = this.buildConversationId(owner, repo, number, isPR);
    getLog().info({ conversationId, merged }, 'isolation_cleanup_started');

    try {
      await onConversationClosed('gitea', conversationId, { merged });
      getLog().info({ conversationId }, 'isolation_cleanup_complete');
    } catch (error) {
      const err = error as Error;
      // Log full context for debugging - cleanup failures shouldn't break user flow
      getLog().error({ err, conversationId }, 'isolation_cleanup_failed');
    }
  }

  /**
   * Build context-rich message for issue.
   * Includes a hint to use the `tea` CLI for full issue details.
   */
  private buildIssueContext(issue: WebhookEvent['issue'], userComment: string): string {
    if (!issue) return userComment;
    const labels = issue.labels.map(l => l.name).join(', ');

    return `[Gitea Issue Context]
Issue #${String(issue.number)}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body ?? ''}

---

${userComment}

Use 'tea issue view ${String(issue.number)}' for full details if needed.`;
  }

  /**
   * Build context-rich message for pull request.
   * Includes a hint to use the `tea` CLI for full PR details and diff.
   */
  private buildPRContext(pr: WebhookEvent['pull_request'], userComment: string): string {
    if (!pr) return userComment;
    const stats = pr.changed_files
      ? `Changed files: ${String(pr.changed_files)} (+${String(pr.additions ?? 0)}, -${String(pr.deletions ?? 0)})`
      : '';

    return `[Gitea Pull Request Context]
PR #${String(pr.number)}: "${pr.title}"
Author: ${pr.user.login}
Status: ${pr.state}
${stats}

Description:
${pr.body ?? ''}

---

${userComment}

Use 'tea pr view ${String(pr.number)}' for full details if needed.`;
  }

  /**
   * Handle incoming webhook event
   */
  async handleWebhook(payload: string, signature: string): Promise<void> {
    // 1. Verify signature
    if (!this.verifySignature(payload, signature)) {
      getLog().error(
        { signaturePrefix: signature?.substring(0, 15) + '...', payloadSize: payload.length },
        'invalid_webhook_signature'
      );
      return;
    }

    // 2. Parse event
    const event = JSON.parse(payload) as WebhookEvent;

    // 2b. Authorization check - verify sender is in whitelist
    const senderUsername = event.sender?.login;
    if (!isGiteaUserAuthorized(senderUsername, this.allowedUsers)) {
      // Log unauthorized attempt (mask username for privacy)
      const maskedUser = senderUsername ? `${senderUsername.slice(0, 3)}***` : 'unknown';
      getLog().info({ maskedUser }, 'unauthorized_webhook');
      return; // Silent rejection - no error response
    }

    const parsed = this.parseEvent(event);
    if (!parsed) return;

    const {
      owner,
      repo,
      number,
      comment,
      eventType,
      isPR,
      issue,
      pullRequest,
      isCloseEvent,
      isMerged,
    } = parsed;

    // 3. Handle close/merge events (cleanup worktree)
    if (isCloseEvent) {
      const mergeLabel = isMerged ? 'merge' : 'close';
      getLog().info({ event: mergeLabel, owner, repo, number }, 'close_event_received');
      await this.cleanupWorktree(owner, repo, number, isPR, isMerged ?? false);
      return; // Don't process as a message
    }

    // 4. Ignore bot's own comments to prevent self-triggering
    // Primary: Check for hidden marker in comment body (works with user's token)
    const commentBody = event.comment?.body ?? '';
    if (commentBody.includes(BOT_RESPONSE_MARKER)) {
      getLog().debug({ commentAuthor: event.comment?.user?.login }, 'ignoring_marked_comment');
      return;
    }
    // Secondary: Check comment author (works with dedicated bot account)
    const commentAuthor = event.comment?.user?.login;
    if (commentAuthor?.toLowerCase() === this.botMention.toLowerCase()) {
      getLog().debug({ commentAuthor }, 'ignoring_own_comment');
      return;
    }

    // 5. Check @mention
    if (!this.hasMention(comment)) return;

    getLog().info({ eventType, owner, repo, number, isPR }, 'webhook_processing');

    // 6. Build conversationId
    const conversationId = this.buildConversationId(owner, repo, number, isPR);

    // 7. Check if new conversation
    const existingConv = await db.getOrCreateConversation('gitea', conversationId);
    const isNewConversation = !existingConv.codebase_id;

    // 8. Get/create codebase (checks for existing first!)
    const {
      codebase,
      repoPath,
      isNew: isNewCodebase,
    } = await this.getOrCreateCodebaseForRepo(owner, repo);

    // 8b. Link conversation to codebase
    if (isNewConversation) {
      try {
        await db.updateConversation(existingConv.id, {
          codebase_id: codebase.id,
          cwd: repoPath,
        });
      } catch (updateError) {
        if (updateError instanceof ConversationNotFoundError) {
          getLog().error(
            { conversationId: existingConv.id, codebaseId: codebase.id },
            'conversation_codebase_link_failed'
          );
          // Re-throw as this is a critical setup step
          throw new Error('Failed to set up Gitea conversation - please try again');
        }
        throw updateError;
      }
    }

    // 9. Get default branch from repository info
    const defaultBranch = event.repository.default_branch;

    // 10. Ensure repo ready (clone if needed, sync if new conversation)
    await this.ensureRepoReady(owner, repo, defaultBranch, repoPath, isNewCodebase);

    // 11. Auto-load commands if new codebase
    if (isNewCodebase) {
      await this.autoDetectAndLoadCommands(repoPath, codebase.id);
    }

    // 12. Gather isolation hints for orchestrator
    const isolationHints: IsolationHints = {
      workflowType: isPR ? 'pr' : 'issue',
      workflowId: String(number),
    };

    // For PRs: get branch info from the event payload
    if (isPR && pullRequest?.head) {
      isolationHints.prBranch = toBranchName(pullRequest.head.ref);
      isolationHints.prSha = pullRequest.head.sha;

      // Detect if PR is from a fork
      const headRepoFullName = pullRequest.head.repo?.full_name;
      const baseRepoFullName = pullRequest.base?.repo?.full_name;
      isolationHints.isForkPR = headRepoFullName !== baseRepoFullName;

      getLog().info(
        {
          prNumber: number,
          headRef: pullRequest.head.ref,
          headSha: pullRequest.head.sha?.substring(0, 7),
          isFork: isolationHints.isForkPR,
        },
        'pr_head_info'
      );
    }

    // 13. Build message with context
    const strippedComment = this.stripMention(comment);
    let finalMessage = strippedComment;
    let contextToAppend: string | undefined;

    // IMPORTANT: Slash commands must be processed deterministically (not by AI)
    const isSlashCommand = strippedComment.trim().startsWith('/');

    if (isSlashCommand) {
      // For slash commands, use only the first line
      finalMessage = strippedComment.split('\n')[0].trim();
      getLog().debug({ command: finalMessage }, 'slash_command_processing');

      // Add issue/PR reference context
      if (isPR && pullRequest) {
        contextToAppend = `Gitea Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'tea pr view ${String(pullRequest.number)}' for full details if needed.`;
      } else if (issue) {
        contextToAppend = `Gitea Issue #${String(issue.number)}: "${issue.title}"\nUse 'tea issue view ${String(issue.number)}' for full details if needed.`;
      }
    } else {
      // For non-command messages, add rich context
      if (isPR && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
        contextToAppend = `Gitea Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'tea pr view ${String(pullRequest.number)}' for full details if needed.`;
      } else if (issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
        contextToAppend = `Gitea Issue #${String(issue.number)}: "${issue.title}"\nUse 'tea issue view ${String(issue.number)}' for full details if needed.`;
      }
    }

    // 14. Fetch comment history for thread context
    const commentHistory = await this.fetchCommentHistory(owner, repo, number);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
    getLog().debug(
      { commentCount: threadContext ? commentHistory.length : 0, conversationId },
      'thread_context_loaded'
    );

    // 15. Route to orchestrator with isolation hints (with lock for concurrency control)
    await this.lockManager.acquireLock(conversationId, async () => {
      try {
        await handleMessage(this, conversationId, finalMessage, {
          issueContext: contextToAppend,
          threadContext,
          isolationHints,
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
