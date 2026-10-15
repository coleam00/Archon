import type { Conversation } from '../types';

/**
 * Operator surfaces whose conversations belong to the user who created them.
 * Chat and forge platforms (Slack, Discord, Telegram, GitHub, GitLab, Gitea) own
 * their own access model, and a webhook author often resolves to no Archon user,
 * so privacy there would hide a team's conversations from everyone.
 */
const PRIVATE_PLATFORM_TYPES: readonly string[] = ['web', 'cli'];

/**
 * Which conversations a caller may reach. A required union rather than an
 * optional user id: `undefined` meaning "no filter" is how a failed identity
 * resolution used to widen a narrowed request to the whole install.
 */
export type ConversationVisibility = { kind: 'all' } | { kind: 'owner'; userId: string };

/**
 * The by-id form of the rule `visibilityWhere` applies to a list. An ownerless
 * row (`user_id IS NULL`) never equals a resolved id, so it matches nobody.
 */
export function isConversationVisible(
  conversation: Pick<Conversation, 'platform_type' | 'user_id'>,
  visibility: ConversationVisibility
): boolean {
  if (visibility.kind === 'all') return true;
  if (!PRIVATE_PLATFORM_TYPES.includes(conversation.platform_type)) return true;
  return conversation.user_id === visibility.userId;
}

/**
 * SQL fragment (leading ` AND`, or empty) for `remote_agent_conversations`
 * columns. Appends its bind values to `params`.
 */
export function visibilityWhere(visibility: ConversationVisibility, params: unknown[]): string {
  if (visibility.kind === 'all') return '';
  // Neither dialect binds arrays, so each platform gets its own placeholder.
  const platforms = PRIVATE_PLATFORM_TYPES.map(platform => {
    params.push(platform);
    return `$${String(params.length)}`;
  });
  params.push(visibility.userId);
  return ` AND (platform_type NOT IN (${platforms.join(', ')}) OR user_id = $${String(params.length)})`;
}
