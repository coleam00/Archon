import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import { getLog } from './log';
import type { GiteaClient } from './types';

const MAX_LENGTH = 65000; // Gitea comment limit (similar to GitHub)
const MAX_ATTEMPTS = 3;

/** Hidden marker added to bot comments to prevent self-triggering loops */
export const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

interface CommentTarget {
  owner: string;
  repo: string;
  number: number;
  isPR: boolean;
}

/**
 * Build conversationId from owner, repo, number, and type
 * Uses # for issues, ! for PRs
 */
export function buildConversationId(
  owner: string,
  repo: string,
  number: number,
  isPR: boolean
): string {
  const separator = isPR ? '!' : '#';
  return `${owner}/${repo}${separator}${String(number)}`;
}

/**
 * Parse conversationId into owner, repo, number, and isPR
 */
export function parseConversationId(conversationId: string): CommentTarget | null {
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
 * Check if an error is retryable (transient network issues)
 */
function isRetryableError(error: unknown): boolean {
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
export async function sendComment(
  client: GiteaClient,
  conversationId: string,
  message: string,
  retryDelayMs: (attempt: number) => number
): Promise<void> {
  const target = parseConversationId(conversationId);
  if (!target) {
    getLog().error({ conversationId }, 'invalid_conversation_id');
    return;
  }

  getLog().debug({ conversationId, messageLength: message.length }, 'send_message');

  if (message.length <= MAX_LENGTH) {
    await postComment(client, target, message, retryDelayMs);
    return;
  }
  getLog().debug({ messageLength: message.length }, 'message_splitting');
  const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

  // Fail-fast: if any chunk fails, stop and propagate error with context
  for (let i = 0; i < chunks.length; i++) {
    try {
      await postComment(client, target, chunks[i], retryDelayMs);
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

/**
 * Post a single comment to a Gitea issue or PR.
 * Uses issues endpoint for both issues and PRs (Gitea API behavior).
 * Includes retry logic with exponential backoff (3 attempts max).
 * Throws on failure after exhausting retries so caller can handle appropriately.
 */
async function postComment(
  client: GiteaClient,
  target: CommentTarget,
  message: string,
  retryDelayMs: (attempt: number) => number
): Promise<void> {
  const conversationId = buildConversationId(target.owner, target.repo, target.number, target.isPR);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await postOnce(client, target, `${message}\n\n${BOT_RESPONSE_MARKER}`);
      getLog().debug({ conversationId }, 'comment_posted');
      return;
    } catch (error) {
      const isRetryable = isRetryableError(error);
      if (attempt < MAX_ATTEMPTS && isRetryable) {
        const delay = retryDelayMs(attempt);
        getLog().warn(
          { attempt, maxRetries: MAX_ATTEMPTS, conversationId, delayMs: delay },
          'comment_post_retry'
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
        'comment_post_failed'
      );
      throw error;
    }
  }
}

async function postOnce(client: GiteaClient, target: CommentTarget, body: string): Promise<void> {
  // Gitea uses issues endpoint for PR comments too
  const url = `${client.baseUrl}/api/v1/repos/${target.owner}/${target.repo}/issues/${String(target.number)}/comments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${client.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gitea API error: ${String(response.status)} ${response.statusText} - ${text}`);
  }
}
