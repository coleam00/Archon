import { Octokit } from '@octokit/rest';
import { toError } from '@archon/core';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import { getLog } from './log';
import type { GitHubApiCall } from './types';

const MAX_LENGTH = 65000; // GitHub comment limit (~65,536, leave buffer for safety)
const MAX_ATTEMPTS = 3;

/** Hidden marker added to bot comments to prevent self-triggering loops */
export const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

interface CommentTarget {
  owner: string;
  repo: string;
  number: number;
}

// A type alias, not an interface: Octokit's parameters need the implicit index signature.
type CommentParams = {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
};

export function buildConversationId(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${String(number)}`;
}

export function parseConversationId(conversationId: string): CommentTarget | null {
  const regex = /^([^/]+)\/([^#]+)#(\d+)$/;
  const match = regex.exec(conversationId);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Check if an error is retryable (transient network issues)
 */
export function isRetryableError(error: unknown): boolean {
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

export interface CommentDeliveryOptions {
  /** Per-user attribution is an App-mode feature; PAT mode always posts as the token owner. */
  appMode: boolean;
  /** REST API root the per-user client calls (`GitHubHost.apiBaseUrl`). */
  apiBaseUrl: string;
  callApi: GitHubApiCall;
  retryDelayMs: (attempt: number) => number;
  /**
   * Resolve the originating user's personal GitHub token (App mode only).
   * Injected by the server when per-user GitHub is enabled; undefined otherwise.
   * When present, outbound comments are authored under the user's identity.
   */
  getUserToken?: (userId: string) => Promise<string | undefined>;
}

/** Posts comments to issues and PRs: chunking, retries and per-user attribution. */
export class CommentDelivery {
  /**
   * conversationId → originating Archon userId (the last human to trigger this
   * thread). Read when posting to route the reply through that user's token.
   * App mode only; lost on restart (graceful: falls back to the
   * installation/bot identity).
   */
  private readonly actorByConversation = new Map<string, string>();
  /** userId → short-lived Octokit built from the user's token (amortizes construction). */
  private readonly userOctokitCache = new Map<string, { octokit: Octokit; expiresAt: number }>();

  constructor(private readonly options: CommentDeliveryOptions) {}

  /** Remember the triggering user so the reply on this thread is authored under their identity. */
  rememberActor(conversationId: string, userId: string | undefined): void {
    if (this.options.appMode && this.options.getUserToken && userId) {
      this.actorByConversation.set(conversationId, userId);
    }
  }

  /**
   * Send a message to a GitHub issue or PR.
   * Splits long messages into paragraph-based chunks.
   * Throws on failure so caller can handle appropriately.
   */
  async send(conversationId: string, message: string): Promise<void> {
    const target = parseConversationId(conversationId);
    if (!target) {
      getLog().error({ conversationId }, 'github.invalid_conversation_id');
      return;
    }

    getLog().debug({ conversationId, messageLength: message.length }, 'github.send_message');

    if (message.length <= MAX_LENGTH) {
      await this.post(target, message);
      return;
    }
    getLog().debug({ messageLength: message.length }, 'github.message_splitting');
    const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

    // Fail-fast: if any chunk fails, stop and propagate error with context
    for (let i = 0; i < chunks.length; i++) {
      try {
        await this.post(target, chunks[i]);
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

  /**
   * Post a single comment to a GitHub issue or PR.
   * Includes retry logic with exponential backoff (3 attempts max).
   * Throws on failure after exhausting retries so caller can handle appropriately.
   */
  private async post(target: CommentTarget, message: string): Promise<void> {
    const conversationId = buildConversationId(target.owner, target.repo, target.number);
    const params = {
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
      body: `${message}\n\n${BOT_RESPONSE_MARKER}`,
    };
    const actorUserId = this.options.appMode
      ? this.actorByConversation.get(conversationId)
      : undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.postOnce(params, conversationId, actorUserId);
        return;
      } catch (error) {
        const isRetryable = isRetryableError(error);
        if (attempt < MAX_ATTEMPTS && isRetryable) {
          const delay = this.options.retryDelayMs(attempt);
          getLog().warn(
            { attempt, maxRetries: MAX_ATTEMPTS, conversationId, delayMs: delay },
            'github.comment_post_retry'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        getLog().error(
          {
            err: error,
            conversationId,
            attempt,
            maxRetries: MAX_ATTEMPTS,
            wasRetryable: isRetryable,
            messageLength: message.length,
          },
          'github.comment_post_failed'
        );
        throw error;
      }
    }
  }

  private async postOnce(
    params: CommentParams,
    conversationId: string,
    actorUserId: string | undefined
  ): Promise<void> {
    if (actorUserId && (await this.postAsUser(actorUserId, params, conversationId))) return;
    await this.options.callApi(params.owner, params.repo, octokit =>
      octokit.rest.issues.createComment(params)
    );
    getLog().debug({ conversationId, attribution: 'bot' }, 'github.comment_posted');
  }

  /**
   * Prefer the originating user's token so the comment shows under their
   * avatar. On 401 (revoked/expired) evict and fall back to the bot's
   * installation token rather than failing the reply.
   */
  private async postAsUser(
    userId: string,
    params: CommentParams,
    conversationId: string
  ): Promise<boolean> {
    const userOctokit = await this.getUserOctokit(userId);
    if (!userOctokit) return false;
    try {
      await userOctokit.rest.issues.createComment(params);
      getLog().debug({ conversationId, attribution: 'user' }, 'github.comment_posted');
      return true;
    } catch (err) {
      if ((err as { status?: number }).status !== 401) throw err;
      this.userOctokitCache.delete(userId);
      getLog().warn({ conversationId }, 'github.user_token_comment_fallback');
      return false;
    }
  }

  /**
   * Build a short-lived Octokit authenticated as the given user, or null when
   * per-user routing is unavailable (no resolver, or the user isn't
   * connected). The underlying token store refreshes on read, so a brief TTL
   * bounds staleness without re-fetching the token per comment.
   */
  private async getUserOctokit(userId: string): Promise<Octokit | null> {
    const { getUserToken } = this.options;
    if (!getUserToken) return null;
    const cached = this.userOctokitCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.octokit;
    let token: string | undefined;
    try {
      token = await getUserToken(userId);
    } catch (err) {
      getLog().warn({ err: toError(err), userId }, 'github.user_token_resolve_failed');
      return null;
    }
    if (!token) return null;
    const octokit = new Octokit({ auth: token, baseUrl: this.options.apiBaseUrl });
    this.userOctokitCache.set(userId, { octokit, expiresAt: Date.now() + 5 * 60 * 1000 });
    return octokit;
  }
}
