import { splitIntoParagraphChunks } from '../../../utils/message-splitting';
import { gitlabApi } from './api';
import { getLog } from './log';
import type { GitLabClient } from './types';

const MAX_LENGTH = 65000; // Practical limit for GitLab notes
const MAX_ATTEMPTS = 3;

/** Hidden marker added to bot comments to prevent self-triggering loops */
export const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

interface NoteTarget {
  projectPath: string;
  iid: number;
  isMR: boolean;
}

// Conversation ID: group/project#123 (issues), group/project!456 (MRs)

export function buildConversationId(projectPath: string, iid: number, isMR: boolean): string {
  const separator = isMR ? '!' : '#';
  return `${projectPath}${separator}${String(iid)}`;
}

export function parseConversationId(conversationId: string): NoteTarget | null {
  const match = /^(.+?)([#!])(\d+)$/.exec(conversationId);
  if (!match) return null;
  return {
    projectPath: match[1],
    iid: parseInt(match[3], 10),
    isMR: match[2] === '!',
  };
}

function isRetryableError(error: unknown): boolean {
  const err = error as Error | undefined;
  const message = err?.message ?? '';
  const causeErr = (error as { cause?: Error }).cause;
  const cause = causeErr?.message ?? '';
  const combined = `${message} ${cause}`.toLowerCase();

  return (
    combined.includes('timeout') ||
    combined.includes('econnrefused') ||
    combined.includes('econnreset') ||
    combined.includes('etimedout') ||
    combined.includes('fetch failed') ||
    combined.includes('429') ||
    combined.includes('502') ||
    combined.includes('503') ||
    combined.includes('504')
  );
}

/** Post a message as notes on an issue or MR, split into paragraph-based chunks when long. */
export async function sendComment(
  client: GitLabClient,
  conversationId: string,
  message: string
): Promise<void> {
  const target = parseConversationId(conversationId);
  if (!target) {
    getLog().error({ conversationId }, 'gitlab.invalid_conversation_id');
    return;
  }

  getLog().debug({ conversationId, messageLength: message.length }, 'gitlab.send_message');

  if (message.length <= MAX_LENGTH) {
    await postComment(client, target, message);
    return;
  }
  getLog().debug({ messageLength: message.length }, 'gitlab.message_splitting');
  const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 500);

  for (let i = 0; i < chunks.length; i++) {
    try {
      await postComment(client, target, chunks[i]);
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, chunkIndex: i + 1, totalChunks: chunks.length, conversationId },
        'gitlab.chunk_post_failed'
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

async function postComment(
  client: GitLabClient,
  target: NoteTarget,
  message: string
): Promise<void> {
  const markedMessage = `${message}\n\n${BOT_RESPONSE_MARKER}`;
  const conversationId = buildConversationId(target.projectPath, target.iid, target.isMR);
  const encodedProject = encodeURIComponent(target.projectPath);

  const notesPath = target.isMR
    ? `/projects/${encodedProject}/merge_requests/${String(target.iid)}/notes`
    : `/projects/${encodedProject}/issues/${String(target.iid)}/notes`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await gitlabApi(client, 'POST', notesPath, { body: markedMessage });
      getLog().debug({ conversationId }, 'gitlab.comment_posted');
      return;
    } catch (error) {
      const isRetryable = isRetryableError(error);
      if (attempt < MAX_ATTEMPTS && isRetryable) {
        const delay = 1000 * attempt;
        getLog().warn(
          { attempt, maxRetries: MAX_ATTEMPTS, conversationId, delayMs: delay },
          'gitlab.comment_post_retry'
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
        'gitlab.comment_post_failed'
      );
      throw error;
    }
  }
}
