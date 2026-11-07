import type { paths } from '../../../lib/api.generated';
import { requestJson, buildApiUrl, HttpError } from '../lib/http';
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
 *     (JSON array). `mine=true` narrows every platform to the caller's own
 *     conversations when an identity resolves, which it always does where
 *     conversations are private (web auth, or a proxy setting
 *     ARCHON_WEB_AUTH_HEADER); with no identity (solo installs) nothing narrows.
 *   - sendMessage:        POST /api/conversations/:id/message. JSON, or
 *     multipart when files are attached (mirrors startRun's multipart path).
 */

type CreateConversationResponse =
  paths['/api/conversations']['post']['responses'][200]['content']['application/json'];

export async function createConversation(
  projectId: string,
  message?: string
): Promise<CreateConversationResponse> {
  return requestJson('/api/conversations', 'post', {
    body: message !== undefined ? { codebaseId: projectId, message } : { codebaseId: projectId },
  });
}

export async function listConversations(projectId: string): Promise<ConversationSummary[]> {
  const raw = await requestJson('/api/conversations', 'get', {
    query: { codebaseId: projectId, mine: 'true' },
  });
  return raw.map(toConversationSummary);
}

type SendMessageJson =
  paths['/api/conversations/{id}/message']['post']['requestBody']['content']['application/json'];

export async function sendMessage(
  conversationPlatformId: string,
  message: string,
  files?: File[]
): Promise<void> {
  const params = { id: conversationPlatformId };
  const url = buildApiUrl('/api/conversations/{id}/message', 'post', { params });

  if (files === undefined || files.length === 0) {
    await requestJson('/api/conversations/{id}/message', 'post', {
      params,
      body: { message } satisfies SendMessageJson,
    });
    return;
  }

  // Multipart path: don't set Content-Type — the browser adds the boundary.
  const form = new FormData();
  const fields = { message } satisfies SendMessageMultipart;
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const filesKey = 'files' satisfies keyof SendMessageMultipart;
  for (const file of files) {
    form.append(filesKey, file, file.name);
  }
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const error: SendMessageError['error'] | undefined =
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'string'
        ? parsed.error
        : undefined;
    const raw = error ?? (text.length > 0 ? text : `HTTP ${res.status.toString()}`);
    const msg = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
    const path = new URL(url, window.location.origin).pathname;
    throw new HttpError(res.status, path, msg);
  }
}

type SendMessageMultipart =
  paths['/api/conversations/{id}/message']['post']['requestBody']['content']['multipart/form-data'];
type SendMessageError =
  paths['/api/conversations/{id}/message']['post']['responses'][400]['content']['application/json'];
