import { requestJson, HttpError } from '../lib/http';
import { toConversationSummary, type ConversationSummary } from '../primitives/conversation';

/**
 * Conversation verbs for the project-scoped agent chat.
 *
 * This is the second place (after startRun.ts) where the legacy "conversation"
 * concept lives in the console. A chat makes the conversation a first-class
 * entity, so these verbs are the sanctioned home for create / list / send.
 *
 *   - createConversation: POST /api/conversations. When `message` is supplied
 *     the backend dispatches it to the orchestrator atomically and the response
 *     also carries dispatch fields (ignored here). `conversationId` is the
 *     platform id used by every other conversation route.
 *   - listConversations:  GET /api/conversations?codebaseId=<id>&mine=true
 *     (JSON array). `mine=true` is non-enforcing: it narrows to the signed-in
 *     user's conversations when an identity resolves (Better Auth cookie or
 *     X-Archon-User), so each user gets their own per-project chat on
 *     multi-user installs; with no identity (solo installs) nothing narrows.
 *   - sendMessage:        POST /api/conversations/:id/message. JSON, or
 *     multipart when files are attached (mirrors startRun's multipart path).
 */

/**
 * Response payload from createConversation.
 */
interface CreateConversationResponse {
  /** Generated platform conversation ID. */
  conversationId: string;
  /** Internal database UUID. */
  id: string;
}

/**
 * Creates a new project conversation, optionally with an atomic first message.
 *
 * @param projectId - Codebase ID / project identifier
 * @param message - Optional initial message to send atomically
 * @returns Object with created conversationId and database UUID
 */
export async function createConversation(
  projectId: string,
  message?: string
): Promise<CreateConversationResponse> {
  return requestJson<CreateConversationResponse>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(
      message !== undefined ? { codebaseId: projectId, message } : { codebaseId: projectId }
    ),
  });
}

/**
 * Lists conversations associated with a project.
 *
 * @param projectId - Codebase ID / project identifier
 * @returns Array of conversation summary objects
 */
export async function listConversations(projectId: string): Promise<ConversationSummary[]> {
  const raw = await requestJson<Parameters<typeof toConversationSummary>[0][]>(
    `/api/conversations?codebaseId=${encodeURIComponent(projectId)}&mine=true`
  );
  return raw.map(toConversationSummary);
}

/**
 * Sends a text message and optional file attachments to an existing conversation.
 *
 * @param conversationPlatformId - Target platform conversation ID
 * @param message - Message text
 * @param files - Optional array of file attachments
 */
export async function sendMessage(
  conversationPlatformId: string,
  message: string,
  files?: File[]
): Promise<void> {
  const url = `/api/conversations/${encodeURIComponent(conversationPlatformId)}/message`;

  if (files === undefined || files.length === 0) {
    await requestJson<{ accepted: boolean; status: string }>(url, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    return;
  }

  // Multipart path: don't set Content-Type — the browser adds the boundary.
  const form = new FormData();
  form.append('message', message);
  for (const file of files) {
    form.append('files', file, file.name);
  }
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(text) as { error?: string };
    } catch {
      /* not JSON */
    }
    const raw = parsed.error ?? (text.length > 0 ? text : `HTTP ${res.status.toString()}`);
    const msg = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
    const path = new URL(url, window.location.origin).pathname;
    throw new HttpError(res.status, path, msg);
  }
}

/**
 * Updates the title of an existing conversation.
 *
 * @param conversationPlatformId - Platform ID of the conversation
 * @param title - New title string
 * @returns Success response indicator
 */
export async function updateConversationTitle(
  conversationPlatformId: string,
  title: string
): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }
  );
}

/**
 * Permanently deletes a conversation by platform ID.
 *
 * @param conversationPlatformId - Platform ID of the conversation to delete
 * @returns Success response indicator
 */
export async function deleteConversation(
  conversationPlatformId: string
): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    {
      method: 'DELETE',
    }
  );
}

/**
 * Halts an in-flight conversation turn or active workflow run.
 *
 * @param conversationPlatformId - Platform ID of the conversation to stop
 * @returns Success response indicator
 */
export async function stopConversationRun(
  conversationPlatformId: string
): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}/stop`,
    {
      method: 'POST',
    }
  );
}
