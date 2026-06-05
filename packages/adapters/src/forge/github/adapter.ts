/**
 * GitHub platform adapter using Octokit REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 */
import { Octokit } from '@octokit/rest';
import { createHmac, timingSafeEqual } from 'crypto';
import { readdir, access } from 'fs/promises';
import { join } from 'path';
import type { IPlatformAdapter, MessageMetadata, GitHubAuth } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import {
  ConversationNotFoundError,
  handleMessage,
  classifyAndFormatError,
  toError,
  getLinkedIssueNumbers,
  onConversationClosed,
  ConversationLockManager,
  AppNotInstalledError,
  installCredentialHelper,
} from '@archon/core';
import {
  ensureProjectStructure,
  getCommandFolderSearchPaths,
  getProjectSourcePath,
} from '@archon/paths';
import {
  isWorktreePath,
  cloneRepository,
  syncRepository,
  addSafeDirectory,
  toRepoPath,
  toBranchName,
} from '@archon/git';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as userDb from '@archon/core/db/users';
import { resolveDefaultAssistant } from '@archon/core/config/resolve-assistant';
import { createLogger } from '@archon/paths';
import { parseAllowedUsers as parseGitHubAllowedUsers, isGitHubUserAuthorized } from './auth';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { WebhookEvent } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.github');
  return cachedLog;
}

const MAX_LENGTH = 65000; // GitHub comment limit (~65,536, leave buffer for safety)

/** Hidden marker added to bot comments to prevent self-triggering loops */
const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

export class GitHubAdapter implements IPlatformAdapter {
  /**
   * PAT-mode Octokit: a singleton constructed at startup. Null in App mode —
   * App-mode callers use `resolveOctokit(owner, repo)` to get a per-installation
   * Octokit from the auth provider. Tests reach in via `@ts-expect-error` and
   * assign a mock object to this field.
   */
  private octokit: Octokit | null;
  private readonly auth: GitHubAuth;
  private webhookSecret: string;
  private allowedUsers: string[];
  private botMention: string;
  private lockManager: ConversationLockManager;
  private readonly retryDelayFn: (attempt: number) => number;
  /**
   * Resolve the originating user's personal GitHub token (App mode only).
   * Injected by the server when per-user GitHub is enabled; undefined otherwise.
   * When present, outbound comments are authored under the user's identity.
   */
  private readonly getUserToken?: (userId: string) => Promise<string | undefined>;
  /**
   * conversationId → originating Archon userId (the last human to trigger this
   * thread). Populated in handleWebhook; read in postComment to route the reply
   * through that user's token. App mode only; lost on restart (graceful: falls
   * back to the installation/bot identity).
   */
  private readonly actorByConversation = new Map<string, string>();
  /** userId → short-lived Octokit built from the user's token (amortizes construction). */
  private readonly userOctokitCache = new Map<string, { octokit: Octokit; expiresAt: number }>();

  constructor(
    auth: GitHubAuth,
    webhookSecret: string,
    lockManager: ConversationLockManager,
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
    this.getUserToken = options?.getUserToken;

    // Parse GitHub user whitelist (optional - empty = open access)
    this.allowedUsers = parseGitHubAllowedUsers(process.env.GITHUB_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      getLog().info({ userCount: this.allowedUsers.length }, 'github.whitelist_enabled');
    } else {
      getLog().info('github.whitelist_disabled');
    }

    this.retryDelayFn = options?.retryDelayMs ?? ((attempt: number): number => 1000 * attempt);

    getLog().info(
      { botMention: this.botMention, authMode: auth.kind },
      'github.adapter_initialized'
    );
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
  private async resolveOctokit(owner: string, repo: string): Promise<Octokit> {
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
    fn: (octokit: Octokit) => Promise<T>
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
   * Build a short-lived Octokit authenticated as the given user, or null when
   * per-user routing is unavailable (PAT mode, no resolver, or the user isn't
   * connected). The underlying token store refreshes on read, so a brief TTL
   * bounds staleness without re-fetching the token per comment.
   */
  private async getUserOctokit(userId: string): Promise<Octokit | null> {
    if (this.auth.kind !== 'app' || !this.getUserToken) return null;
    const cached = this.userOctokitCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.octokit;
    let token: string | undefined;
    try {
      token = await this.getUserToken(userId);
    } catch (err) {
      getLog().warn({ err: toError(err), userId }, 'github.user_token_resolve_failed');
      return null;
    }
    if (!token) return null;
    const octokit = new Octokit({ auth: token });
    this.userOctokitCache.set(userId, { octokit, expiresAt: Date.now() + 5 * 60 * 1000 });
    return octokit;
  }

  /**
   * Check if an error is retryable (transient network issues)
   */
  private isRetryableError(error: unknown): boolean {
    interface StatusBearingError {
      status?: unknown;
      response?: { status?: unknown };
      cause?: {
        status?: unknown;
        response?: { status?: unknown };
      };
    }

    const statusError = error as StatusBearingError;
    const status = [
      statusError.status,
      statusError.response?.status,
      statusError.cause?.status,
      statusError.cause?.response?.status,
    ].find((value): value is number => typeof value === 'number');

    // Prefer structured status classification when available.
    if (typeof status === 'number') {
      return status === 429 || status === 502 || status === 503 || status === 504;
    }

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
   * Send a message to a GitHub issue or PR.
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
      getLog().error({ conversationId }, 'github.invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'github.send_message');

    // Check if message needs splitting
    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed, message);
    } else {
      getLog().debug({ messageLength: message.length }, 'github.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

      // Fail-fast: if any chunk fails, stop and propagate error with context
      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.postComment(parsed, chunks[i]);
        } catch (error) {
          const err = error as Error;
          getLog().error(
            { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
            'github.chunk_post_failed'
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
   * Post a single comment to a GitHub issue or PR.
   * Includes retry logic with exponential backoff (3 attempts max).
   * Throws on failure after exhausting retries so caller can handle appropriately.
   */
  private async postComment(
    parsed: { owner: string; repo: string; number: number },
    message: string
  ): Promise<void> {
    const markedMessage = `${message}\n\n${BOT_RESPONSE_MARKER}`;
    const maxRetries = 3;
    const conversationId = this.buildConversationId(parsed.owner, parsed.repo, parsed.number);
    const commentParams = {
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body: markedMessage,
    };
    const actorUserId =
      this.auth.kind === 'app' ? this.actorByConversation.get(conversationId) : undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Prefer the originating user's token so the comment shows under their
        // avatar. On 401 (revoked/expired) evict and fall back to the bot's
        // installation token rather than failing the reply.
        if (actorUserId) {
          const userOctokit = await this.getUserOctokit(actorUserId);
          if (userOctokit) {
            try {
              await userOctokit.rest.issues.createComment(commentParams);
              getLog().debug({ conversationId, attribution: 'user' }, 'github.comment_posted');
              return;
            } catch (err) {
              if ((err as { status?: number }).status !== 401) throw err;
              this.userOctokitCache.delete(actorUserId);
              getLog().warn({ conversationId }, 'github.user_token_comment_fallback');
            }
          }
        }
        await this.withTokenRefresh(parsed.owner, parsed.repo, octokit =>
          octokit.rest.issues.createComment(commentParams)
        );
        getLog().debug({ conversationId, attribution: 'bot' }, 'github.comment_posted');
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = this.retryDelayFn(attempt);
          getLog().warn(
            { attempt, maxRetries, conversationId, delayMs: delay },
            'github.comment_post_retry'
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
          'github.comment_post_failed'
        );
        // Re-throw so caller can handle (e.g., notify user, stop chunk loop)
        throw error;
      }
    }
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
    return 'github';
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
    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      const digest = 'sha256=' + hmac.update(payload).digest('hex');

      const digestBuffer = Buffer.from(digest);
      const signatureBuffer = Buffer.from(signature);

      if (digestBuffer.length !== signatureBuffer.length) {
        getLog().error(
          { receivedLength: signatureBuffer.length, computedLength: digestBuffer.length },
          'github.signature_length_mismatch'
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
          'github.signature_mismatch'
        );
      }

      return isValid;
    } catch (error) {
      const err = error as Error;
      getLog().error({ err }, 'github.signature_verification_error');
      return false;
    }
  }

  /**
   * Parse webhook event and extract relevant data
   *
   * Handles:
   * - issues.closed / pull_request.closed → cleanup (isCloseEvent: true)
   * - issue_comment.created → bot @mention detection
   *
   * Does NOT handle:
   * - issues.opened / pull_request.opened → returns null (see #96)
   */
  private parseEvent(event: WebhookEvent): {
    owner: string;
    repo: string;
    number: number;
    comment: string;
    eventType: 'issue' | 'issue_comment' | 'pull_request';
    issue?: WebhookEvent['issue'];
    pullRequest?: WebhookEvent['pull_request'];
    isCloseEvent?: boolean;
    isMerged?: boolean;
  } | null {
    const owner = event.repository.owner.login;
    const repo = event.repository.name;

    // Detect issue closed
    if (event.issue && event.action === 'closed') {
      return {
        owner,
        repo,
        number: event.issue.number,
        comment: '',
        eventType: 'issue',
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
        pullRequest: event.pull_request,
        isCloseEvent: true,
        isMerged: event.pull_request.merged === true,
      };
    }

    // issue_comment (covers both issues and PRs)
    if (event.comment) {
      const number = event.issue?.number ?? event.pull_request?.number;
      if (!number) return null;
      return {
        owner,
        repo,
        number,
        comment: event.comment.body,
        eventType: 'issue_comment',
        issue: event.issue,
        pullRequest: event.pull_request,
      };
    }

    // Note: We intentionally do NOT handle issues.opened or pull_request.opened
    // events here. Issue/PR descriptions often contain example commands or
    // documentation about how to use the bot - these are NOT command invocations.
    // Only actual comments (issue_comment events) trigger bot responses.
    // See issue #96 for details.

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
      const { data: comments } = await this.withTokenRefresh(owner, repo, octokit =>
        octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: number,
          per_page: 20, // Last 20 comments for context
          sort: 'created',
          direction: 'desc',
        })
      );

      // Reverse to get chronological order (oldest first)
      return [...comments].reverse().map(comment => {
        const author = comment.user?.login ?? 'unknown';
        const body = comment.body ?? '';
        return `${author}: ${body}`;
      });
    } catch (error) {
      getLog().error(
        { err: error, owner, repo, issueNumber: number },
        'github.comment_history_fetch_failed'
      );
      return [];
    }
  }

  /**
   * Build conversationId from owner, repo, and number
   */
  private buildConversationId(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${String(number)}`;
  }

  /**
   * Parse conversationId into owner, repo, and number
   */
  private parseConversationId(
    conversationId: string
  ): { owner: string; repo: string; number: number } | null {
    const regex = /^([^/]+)\/([^#]+)#(\d+)$/;
    const match = regex.exec(conversationId);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  /**
   * Ensure repository is cloned and ready
   * For new codebases: clone (directory won't exist)
   * For existing codebases: sync if shouldSync=true, skip if shouldSync=false
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
        getLog().error({ repoPath, errorCode: err.code, err }, 'github.repo_path_access_failed');
        throw new Error(
          `Cannot access repository at ${repoPath}: ${err.code ?? err.message}. ` +
            'Check permissions and disk health.'
        );
      }
      // ENOENT means directory doesn't exist - we'll clone below
    }

    if (directoryExists) {
      if (shouldSync) {
        getLog().info({ repoPath, defaultBranch }, 'github.repo_syncing');
        const syncResult = await syncRepository(toRepoPath(repoPath), toBranchName(defaultBranch));
        if (!syncResult.ok) {
          getLog().error(
            { error: syncResult.error, repoPath, defaultBranch },
            'github.repo_sync_failed'
          );
          throw new Error(
            `Failed to sync repository to ${defaultBranch}. ` +
              `Try /reset or check if the branch exists. Details: ${syncResult.error.code === 'branch_not_found' ? `Branch '${defaultBranch}' not found` : 'message' in syncResult.error ? syncResult.error.message : syncResult.error.code}`
          );
        }
      }
      return;
    }

    // Directory doesn't exist - clone the repository
    getLog().info({ owner, repo, repoPath }, 'github.repo_cloning');

    // Create project structure (source/, worktrees/, artifacts/, logs/) before
    // cloning so worktree paths resolve correctly on first webhook clone.
    await ensureProjectStructure(owner, repo);

    // Resolve the right auth token per mode. App mode talks to the auth
    // provider (installation token, ~1h validity); PAT mode reads env directly.
    let ghToken: string | undefined;
    if (this.auth.kind === 'app') {
      try {
        ghToken = await this.auth.provider.getInstallationToken(owner, repo);
      } catch (err) {
        if (err instanceof AppNotInstalledError) {
          getLog().error({ err, owner, repo }, 'github.repo_clone_app_not_installed');
          throw err;
        }
        throw err;
      }
    } else {
      ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    }
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    const cloneResult = await cloneRepository(
      repoUrl,
      toRepoPath(repoPath),
      ghToken ? { token: ghToken } : undefined
    );

    if (!cloneResult.ok) {
      getLog().error(
        { error: cloneResult.error, owner, repo, repoPath },
        'github.repo_clone_failed'
      );

      if (cloneResult.error.code === 'not_a_repo') {
        throw new Error(
          `Repository ${owner}/${repo} not found or is private. Check repository access.`
        );
      } else if (cloneResult.error.code === 'permission_denied') {
        const authHint =
          this.auth.kind === 'app'
            ? 'Check that the Archon GitHub App is installed on the org and has the Contents:Read permission.'
            : 'Check GITHUB_TOKEN permissions.';
        throw new Error(`Authentication failed for ${owner}/${repo}. ${authHint}`);
      }
      throw new Error(
        `Failed to clone ${owner}/${repo}: ${'message' in cloneResult.error ? cloneResult.error.message : cloneResult.error.code}`
      );
    }

    await addSafeDirectory(toRepoPath(repoPath));

    // App mode: install the git credential helper on the newly cloned worktree
    // so workflows that outlive the 1h installation-token expiry can refresh
    // credentials in-place. Non-fatal — workflows that complete in <1h still
    // succeed via the URL-embedded token from the clone above. The result
    // discriminator tells us whether the install actually happened so we
    // don't log a false "installed" line in builds where the helper script
    // isn't on disk.
    if (this.auth.kind === 'app') {
      const result = await installCredentialHelper(repoPath);
      switch (result.kind) {
        case 'installed':
          getLog().info(
            { repoPath, owner, repo, helperPath: result.helperPath },
            'github_auth.credential_helper_installed'
          );
          break;
        case 'skipped':
          getLog().warn(
            { repoPath, owner, repo, reason: result.reason, sourcePath: result.sourcePath },
            'github_auth.credential_helper_skipped'
          );
          break;
        case 'failed':
          getLog().warn(
            { err: result.error, repoPath, owner, repo },
            'github_auth.credential_helper_install_failed'
          );
          break;
      }
    }
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
        getLog().info({ commandCount: files.length, folder }, 'github.commands_loaded');
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // Folder not existing is expected - silently continue to next folder
        if (err.code === 'ENOENT') {
          continue;
        }
        // Log unexpected errors (database failures, permission issues) but don't fail setup
        getLog().error({ err, folder, errorCode: err.code }, 'github.commands_load_error');
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
    // Try both with and without .git suffix to match existing clones
    const repoUrlNoGit = `https://github.com/${owner}/${repo}`;
    const repoUrlWithGit = `${repoUrlNoGit}.git`;

    let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
    existing ??= await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);

    // Canonical path uses the project source/ subdirectory so that worktrees/,
    // artifacts/, and logs/ live as siblings of the cloned repo (not nested
    // inside it). Mirrors the CLI /clone path; see issue #1547.
    const canonicalPath = getProjectSourcePath(owner, repo);

    if (existing) {
      // Check if existing codebase points to a worktree path - fix it if so
      // Either it's an actual worktree, or it looks like one (contains /worktrees/ in path)
      const looksLikeWorktreePath = existing.default_cwd.includes('/worktrees/');
      if (looksLikeWorktreePath || (await isWorktreePath(existing.default_cwd))) {
        getLog().info(
          { codebaseName: existing.name, canonicalPath },
          'github.stale_worktree_path_fixed'
        );
        await codebaseDb.updateCodebase(existing.id, { default_cwd: canonicalPath });
        existing.default_cwd = canonicalPath;
      }

      getLog().info(
        { codebaseName: existing.name, path: existing.default_cwd },
        'github.existing_codebase_found'
      );
      return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
    }

    // Include owner in name to distinguish repos with same name from different owners
    // resolve() converts relative paths to absolute (cross-platform)
    const codebase = await codebaseDb.createCodebase({
      name: `${owner}/${repo}`,
      repository_url: repoUrlNoGit, // Store without .git for consistency
      default_cwd: canonicalPath,
      ai_assistant_type: await resolveDefaultAssistant(canonicalPath),
    });

    getLog().info({ codebaseName: codebase.name, path: canonicalPath }, 'github.codebase_created');
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
    merged = false
  ): Promise<void> {
    const conversationId = this.buildConversationId(owner, repo, number);
    getLog().info({ conversationId, merged }, 'github.isolation_cleanup_started');

    try {
      await onConversationClosed('github', conversationId, { merged });
      getLog().info({ conversationId }, 'github.isolation_cleanup_completed');
    } catch (error) {
      const err = error as Error;
      // Log full context for debugging - cleanup failures shouldn't break user flow
      getLog().error({ err, conversationId }, 'github.isolation_cleanup_failed');
    }
  }

  /**
   * Build context-rich message for issue
   */
  private buildIssueContext(issue: WebhookEvent['issue'], userComment: string): string {
    if (!issue) return userComment;
    const labels = issue.labels.map(l => l.name).join(', ');

    return `[GitHub Issue Context]
Issue #${String(issue.number)}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body ?? ''}

---

${userComment}`;
  }

  /**
   * Build context-rich message for pull request
   */
  private buildPRContext(pr: WebhookEvent['pull_request'], userComment: string): string {
    if (!pr) return userComment;
    const stats = pr.changed_files
      ? `Changed files: ${String(pr.changed_files)} (+${String(pr.additions ?? 0)}, -${String(pr.deletions ?? 0)})`
      : '';

    return `[GitHub Pull Request Context]
PR #${String(pr.number)}: "${pr.title}"
Author: ${pr.user.login}
Status: ${pr.state}
${stats}

Description:
${pr.body ?? ''}

Use 'gh pr diff ${String(pr.number)}' to see detailed changes.

---

${userComment}`;
  }

  /**
   * Handle incoming webhook event
   */
  async handleWebhook(payload: string, signature: string): Promise<void> {
    // 1. Verify signature
    if (!this.verifySignature(payload, signature)) {
      getLog().error(
        { signaturePrefix: signature?.substring(0, 15) + '...', payloadSize: payload.length },
        'github.invalid_webhook_signature'
      );
      return;
    }

    // 2. Parse event
    const event = JSON.parse(payload) as WebhookEvent;

    // 2b. Authorization check - verify sender is in whitelist
    const senderUsername = event.sender?.login;
    if (!isGitHubUserAuthorized(senderUsername, this.allowedUsers)) {
      // Log unauthorized attempt (mask username for privacy)
      const maskedUser = senderUsername ? `${senderUsername.slice(0, 3)}***` : 'unknown';
      getLog().info({ maskedUser }, 'github.unauthorized_webhook');
      return; // Silent rejection - no error response
    }

    const parsed = this.parseEvent(event);
    if (!parsed) return;

    const { owner, repo, number, comment, eventType, issue, pullRequest, isCloseEvent, isMerged } =
      parsed;

    // App-mode optimisation: the webhook payload already includes the
    // installation id. Priming the lookup cache skips one HTTP round trip
    // (`GET /repos/{owner}/{repo}/installation`) before the first outbound API
    // call to this repo after a restart. No-op when payload lacks installation.
    if (this.auth.kind === 'app' && event.installation?.id !== undefined) {
      this.auth.provider.primeInstallationLookup(owner, repo, event.installation.id);
    }

    // 3. Handle close/merge events (cleanup worktree)
    if (isCloseEvent) {
      const mergeLabel = isMerged ? 'merge' : 'close';
      getLog().info({ event: mergeLabel, owner, repo, number }, 'github.close_event_received');
      await this.cleanupWorktree(owner, repo, number, isMerged ?? false);
      return; // Don't process as a message
    }

    // 4. Ignore bot's own comments to prevent self-triggering
    // Primary: Check for hidden marker in comment body (works with user's PAT)
    const commentBody = event.comment?.body ?? '';
    if (commentBody.includes(BOT_RESPONSE_MARKER)) {
      getLog().debug(
        { commentAuthor: event.comment?.user?.login },
        'github.ignoring_marked_comment'
      );
      return;
    }
    // Secondary: Check comment author. In App mode the bot account is
    // `<slug>[bot]`; in PAT mode it's whatever the operator named via
    // botMention. Comparing against `botLogin` (not `botMention`) keeps the
    // filter narrow — comments posted under a user's own GitHub login from a
    // user-to-server token would otherwise be misfiltered.
    const commentAuthor = event.comment?.user?.login;
    if (commentAuthor?.toLowerCase() === this.botLogin.toLowerCase()) {
      getLog().debug({ commentAuthor }, 'github.ignoring_own_comment');
      return;
    }

    // 5. Check @mention
    if (!this.hasMention(comment)) return;

    getLog().info({ eventType, owner, repo, number }, 'github.webhook_processing');

    // 5b. Resolve GitHub login → Archon user (auto-create on first sight).
    // Comment author may differ from event.sender for PR-review comments; prefer
    // the comment author when present so individual reviewers get their own row.
    // Resolution failure must not drop the webhook — warn-log and continue with
    // archonUserId undefined so the conversation/run rows fall back to NULL.
    const attributedLogin = event.comment?.user?.login ?? senderUsername;
    let archonUserId: string | undefined;
    if (attributedLogin) {
      try {
        const user = await userDb.findOrCreateUserByPlatformIdentity(
          'github',
          attributedLogin,
          attributedLogin
        );
        archonUserId = user.id;
      } catch (err) {
        getLog().warn(
          { err: toError(err), githubLogin: attributedLogin },
          'github.user_resolve_failed'
        );
      }
    }

    // 4. Build conversationId
    const conversationId = this.buildConversationId(owner, repo, number);

    // Remember the triggering user so the bot's reply on this thread can be
    // authored under their GitHub identity (App mode + per-user tokens only).
    if (this.auth.kind === 'app' && this.getUserToken && archonUserId) {
      this.actorByConversation.set(conversationId, archonUserId);
    }

    // 5. Check if new conversation
    const existingConv = await db.getOrCreateConversation('github', conversationId);
    const isNewConversation = !existingConv.codebase_id;

    // 6. Get/create codebase (checks for existing first!)
    const {
      codebase,
      repoPath,
      isNew: isNewCodebase,
    } = await this.getOrCreateCodebaseForRepo(owner, repo);

    // 6b. Link conversation to codebase (fixes #97)
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
            'github.conversation_codebase_link_failed'
          );
          // Re-throw as this is a critical setup step
          throw new Error('Failed to set up GitHub conversation - please try again');
        }
        throw updateError;
      }
    }

    // 7. Get default branch
    let defaultBranch: string;
    try {
      const { data: repoData } = await this.withTokenRefresh(owner, repo, octokit =>
        octokit.rest.repos.get({ owner, repo })
      );
      defaultBranch = repoData.default_branch;
    } catch (error) {
      const err = toError(error);
      getLog().error({ err, owner, repo, conversationId }, 'github.repo_metadata_fetch_failed');
      try {
        const userMessage = classifyAndFormatError(err);
        await this.sendMessage(conversationId, userMessage);
      } catch (sendError) {
        getLog().error(
          { err: toError(sendError), conversationId },
          'github.error_message_send_failed'
        );
      }
      return;
    }

    // 8. Ensure repo ready (clone if needed, sync if new conversation)
    await this.ensureRepoReady(owner, repo, defaultBranch, repoPath, isNewCodebase);

    // 9. Auto-load commands if new codebase (defaults loaded at runtime, not copied)
    if (isNewCodebase) {
      await this.autoDetectAndLoadCommands(repoPath, codebase.id);
    }

    // 10. Gather isolation hints for orchestrator
    // The orchestrator now handles all isolation decisions
    const isPR = eventType === 'pull_request' || !!pullRequest || !!issue?.pull_request;

    // Build isolation hints for orchestrator
    const isolationHints: IsolationHints = {
      workflowType: isPR ? 'pr' : 'issue',
      workflowId: String(number),
    };

    // For PRs: get linked issues and branch info
    if (isPR) {
      // Get linked issues for worktree sharing
      const linkedIssues = await getLinkedIssueNumbers(owner, repo, number);
      if (linkedIssues.length > 0) {
        isolationHints.linkedIssues = linkedIssues;
        getLog().info({ prNumber: number, linkedIssues }, 'github.pr_linked_issues');
      }

      // Fetch PR head branch, SHA, and fork status for isolation
      try {
        const { data: prData } = await this.withTokenRefresh(owner, repo, octokit =>
          octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: number,
          })
        );
        isolationHints.prBranch = toBranchName(prData.head.ref);
        isolationHints.prSha = prData.head.sha;

        // Detect if PR is from a fork (different repo than base)
        // For fork PRs: head.repo is different from base.repo
        // For same-repo PRs: head.repo.full_name === base.repo.full_name
        // Note: head.repo can be null if the fork was deleted after PR creation
        // In that case, we treat it as a fork (can't push to deleted repo anyway)
        const headRepoFullName = prData.head.repo?.full_name;
        const baseRepoFullName = prData.base.repo.full_name;
        isolationHints.isForkPR = headRepoFullName !== baseRepoFullName;

        getLog().info(
          {
            prNumber: number,
            headRef: prData.head.ref,
            headSha: prData.head.sha.substring(0, 7),
            isFork: isolationHints.isForkPR,
          },
          'github.pr_head_info'
        );
      } catch (error) {
        const err = error as Error;
        // Log at appropriate level based on error type
        const isNonTransient =
          err.message.includes('rate limit') ||
          err.message.includes('403') ||
          err.message.includes('401') ||
          err.message.includes('Bad credentials');

        const logData = { err, owner, repo, prNumber: number };
        if (isNonTransient) {
          getLog().error(logData, 'github.pr_head_fetch_failed');
        } else {
          getLog().warn(logData, 'github.pr_head_fetch_failed');
        }

        // Mark degraded mode - worktree isolation will use fallback naming
        isolationHints.prFetchFailed = true;
      }
    }

    // 11. Build message with context
    const strippedComment = this.stripMention(comment);
    let finalMessage = strippedComment;
    let contextToAppend: string | undefined;

    // IMPORTANT: Slash commands must be processed deterministically (not by AI)
    const isSlashCommand = strippedComment.trim().startsWith('/');

    if (isSlashCommand) {
      // For slash commands, use only the first line
      finalMessage = strippedComment.split('\n')[0].trim();
      getLog().debug({ command: finalMessage }, 'github.slash_command_processing');

      // Add issue/PR reference context
      if (eventType === 'issue' && issue) {
        contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
      } else if (eventType === 'pull_request' && pullRequest) {
        contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
      } else if (eventType === 'issue_comment') {
        if (pullRequest) {
          contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
        } else if (issue) {
          contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
        }
      }
    } else {
      // For non-command messages, add rich context and issue/PR reference for workflows
      if (eventType === 'issue' && issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
        contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
      } else if (eventType === 'issue_comment' && issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
        contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
      } else if (eventType === 'pull_request' && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
        contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
      } else if (eventType === 'issue_comment' && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
        contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
      }
    }

    // 12. Fetch comment history for thread context
    const commentHistory = await this.fetchCommentHistory(owner, repo, number);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
    getLog().debug(
      { commentCount: threadContext ? commentHistory.length : 0, conversationId },
      'github.thread_context_loaded'
    );

    // 13. Route to orchestrator with isolation hints (with lock for concurrency control)
    await this.lockManager.acquireLock(conversationId, async () => {
      try {
        await handleMessage(this, conversationId, finalMessage, {
          issueContext: contextToAppend,
          threadContext,
          isolationHints,
          userId: archonUserId,
        });
      } catch (error) {
        const err = toError(error);
        getLog().error({ err, conversationId }, 'github.message_handling_error');
        try {
          const userMessage = classifyAndFormatError(err);
          await this.sendMessage(conversationId, userMessage);
        } catch (sendError) {
          getLog().error(
            { err: toError(sendError), conversationId },
            'github.error_message_send_failed'
          );
        }
      }
    });
  }
}
