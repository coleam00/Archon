import type { components } from '@/lib/api.generated';
type RawConversation = Pick<
  components['schemas']['Conversation'],
  'id' | 'platform_conversation_id' | 'platform_type' | 'title' | 'last_activity_at'
>;
/** Conversation summary primitive. Normalized from the server conversation row. */
export interface ConversationSummary {
  /**
   * Platform conversation id (`web-<ts>-<rand>`) — NOT the DB uuid. This is the
   * id the `/api/conversations/:id/messages` and `/api/stream/:id` routes accept.
   */
  id: RawConversation['platform_conversation_id'];
  title: RawConversation['title'];
  platformType: RawConversation['platform_type'];
  lastActivityAt: RawConversation['last_activity_at'];
}

export function toConversationSummary(raw: RawConversation): ConversationSummary {
  return {
    id: raw.platform_conversation_id,
    title: raw.title,
    platformType: raw.platform_type,
    lastActivityAt: raw.last_activity_at,
  };
}
