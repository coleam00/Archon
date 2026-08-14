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

export async function listConversations(projectId: string): Promise<ConversationSummary[]> {
  const raw = await requestJson<Parameters<typeof toConversationSummary>[0][]>(
    `/api/conversations?codebaseId=${encodeURIComponent(projectId)}&mine=true`
  );
  return raw.map(toConversationSummary);
}

/**
 * Builder Copilot-only turn options — never used by the ordinary chat composer.
 * `canvasState` is the live (possibly unsaved) workflow, JSON-serialized by the
 * caller, resent every turn so the agent proposes edits against what the
 * author is actually looking at rather than the last saved YAML.
 */
export interface BuilderModeOptions {
  builderMode: true;
  canvasState: string;
}

export async function sendMessage(
  conversationPlatformId: string,
  message: string,
  files?: File[],
  builderOptions?: BuilderModeOptions
): Promise<void> {
  const url = `/api/conversations/${encodeURIComponent(conversationPlatformId)}/message`;

  // The server reads `builderMode`/`canvasState` only on the JSON branch, so
  // pairing them with files would drop them silently and the Copilot would
  // reason about a canvas it was never given. Fail loudly instead — the Copilot
  // never attaches files, so this combination is always a caller bug.
  if (builderOptions !== undefined && files !== undefined && files.length > 0) {
    throw new Error(
      'sendMessage: builder-mode options cannot be combined with file attachments ' +
        '(the multipart branch cannot carry them).'
    );
  }

  if (files === undefined || files.length === 0) {
    await requestJson<{ accepted: boolean; status: string }>(url, {
      method: 'POST',
      body: JSON.stringify({ message, ...builderOptions }),
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
