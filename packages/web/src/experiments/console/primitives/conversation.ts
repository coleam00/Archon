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

/** Fallback shown before the server's auto-title lands on a fresh chat. */
export const UNTITLED_CHAT = 'Untitled chat';

/**
 * What to show in the switcher. A conversation has no title until the server
 * generates one from the first message, so a brand-new chat would otherwise
 * render as a blank row.
 */
export function conversationLabel(c: ConversationSummary): string {
  const title = c.title?.trim() ?? '';
  return title.length > 0 ? title : UNTITLED_CHAT;
}

/**
 * Most recently active first, so the switcher opens on what the user was last
 * doing. Conversations that have never been active sort last rather than
 * jumping to the top on an unparsable date.
 */
export function byMostRecent(a: ConversationSummary, b: ConversationSummary): number {
  const at = a.lastActivityAt ?? '';
  const bt = b.lastActivityAt ?? '';
  if (at === bt) return 0;
  if (at === '') return 1;
  if (bt === '') return -1;
  return at < bt ? 1 : -1;
}
