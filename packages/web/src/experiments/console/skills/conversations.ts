import { requestJson, HttpError } from '../lib/http';
import {
  toConversationSummary,
  type ConversationColor,
  type ConversationSummary,
} from '../primitives/conversation';

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
 *   - renameConversation: PATCH /api/conversations/:id — sets the title,
 *     replacing the server's auto-generated one.
 *   - setConversationColor: PATCH /api/conversations/:id — sets or clears the
 *     color label. An explicit null clears it; omitting it leaves it alone.
 *   - listConversations:  GET /api/conversations?codebaseId=<id>&mine=true
 *     (JSON array). `mine=true` is non-enforcing: it narrows to the signed-in
 *     user's conversations when an identity resolves (Better Auth cookie or
 *     X-Archon-User), so each user gets their own per-project chat on
 *     multi-user installs; with no identity (solo installs) nothing narrows.
 *   - sendMessage:        POST /api/conversations/:id/message. JSON, or
 *     multipart when files are attached (mirrors startRun's multipart path).
 */

interface CreateConversationResponse {
  conversationId: string;
  id: string;
}

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

export async function listConversations(
  projectId: string,
  archived: 'active' | 'archived' | 'all' = 'active'
): Promise<ConversationSummary[]> {
  const raw = await requestJson<Parameters<typeof toConversationSummary>[0][]>(
    `/api/conversations?codebaseId=${encodeURIComponent(projectId)}&mine=true&archived=${archived}`
  );
  return raw.map(toConversationSummary);
}

/**
 * Archive or restore a conversation. Symmetric by design — an archive the user
 * cannot undo is a delete wearing a friendlier word.
 */
export async function setConversationArchived(
  conversationPlatformId: string,
  archived: boolean
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ archived }) }
  );
}

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
 * Rename a conversation. The server auto-titles from the first message; this
 * overwrites that with the user's own wording and it sticks.
 */
export async function renameConversation(
  conversationPlatformId: string,
  title: string
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ title }) }
  );
}

/**
 * Set or clear a conversation's color label. `null` clears it — the server
 * distinguishes an explicit null from an omitted field.
 */
export async function setConversationColor(
  conversationPlatformId: string,
  color: ConversationColor | null
): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationPlatformId)}`,
    { method: 'PATCH', body: JSON.stringify({ color }) }
  );
}
