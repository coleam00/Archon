/** Conversation summary primitive. Normalized from the server conversation row. */
export interface ConversationSummary {
  /**
   * Platform conversation id (`web-<ts>-<rand>`) — NOT the DB uuid. This is the
   * id the `/api/conversations/:id/messages` and `/api/stream/:id` routes accept.
   */
  id: string;
  title: string | null;
  platformType: string;
  lastActivityAt: string | null;
}

interface RawConversation {
  id: string;
  platform_conversation_id: string;
  platform_type: string;
  title: string | null;
  last_activity_at: string | null;
}

export function toConversationSummary(raw: RawConversation): ConversationSummary {
  return {
    id: raw.platform_conversation_id,
    title: raw.title,
    platformType: raw.platform_type,
    lastActivityAt: raw.last_activity_at,
  };
}

/**
 * Pick the conversation the chat page should show.
 *
 * An explicit deep-link id (the `:conversationId` param of
 * `/p/:projectId/chat/:conversationId`) always wins — the messages API accepts
 * any platform id, so it is deliberately NOT validated against the project's
 * conversation list: worker conversations from chat-dispatched runs aren't
 * listed there, and silently falling back to the latest web conversation would
 * land the user in a different chat than the one they deep-linked to (#1882).
 * A bad id surfaces through the messages request failing instead.
 *
 * Without a deep link, fall back to the most-recent web conversation (the
 * pre-deep-link behavior), else null until the first send creates one.
 */
export function pickActiveConversationId(
  conversations: ConversationSummary[] | undefined,
  deepLinkId: string | undefined
): string | null {
  if (deepLinkId !== undefined) return deepLinkId;
  const web = (conversations ?? []).find(c => c.platformType === 'web');
  return web !== undefined ? web.id : null;
}
