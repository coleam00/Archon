/** Conversation summary primitive. Normalized from the server conversation row. */
/**
 * The colours a chat can be labelled with, paired with the design token that
 * renders each. Copied from `@archon/core`'s CONVERSATION_COLORS rather than
 * imported — the console may not import production modules (ESLint isolation
 * rule) — so the two lists must change together.
 *
 * Names, not hex: the server stores the name and the UI owns the rendering, so
 * re-theming never has to rewrite stored rows.
 */
export const CONVERSATION_COLORS = [
  { value: 'magenta', label: 'Magenta', token: 'var(--brand-magenta)' },
  { value: 'violet', label: 'Violet', token: 'var(--brand-violet)' },
  { value: 'teal', label: 'Teal', token: 'var(--brand-teal)' },
  { value: 'green', label: 'Green', token: 'var(--success)' },
  { value: 'amber', label: 'Amber', token: 'var(--warning)' },
  { value: 'red', label: 'Red', token: 'var(--error)' },
] as const;

export type ConversationColor = (typeof CONVERSATION_COLORS)[number]['value'];

export interface ConversationSummary {
  /**
   * Platform conversation id (`web-<ts>-<rand>`) — NOT the DB uuid. This is the
   * id the `/api/conversations/:id/messages` and `/api/stream/:id` routes accept.
   */
  id: string;
  title: string | null;
  platformType: string;
  lastActivityAt: string | null;
  /** User-chosen colour label, or null for none. */
  color: ConversationColor | null;
}

interface RawConversation {
  id: string;
  platform_conversation_id: string;
  platform_type: string;
  title: string | null;
  last_activity_at: string | null;
  color: string | null;
}

export function toConversationSummary(raw: RawConversation): ConversationSummary {
  return {
    id: raw.platform_conversation_id,
    title: raw.title,
    platformType: raw.platform_type,
    lastActivityAt: raw.last_activity_at,
    color: parseConversationColor(raw.color),
  };
}

/**
 * Normalise a stored colour. Anything unrecognised — written by a newer build,
 * or hand-edited — reads as no colour rather than rendering a blank swatch.
 */
export function parseConversationColor(raw: string | null | undefined): ConversationColor | null {
  return CONVERSATION_COLORS.some(c => c.value === raw) ? (raw as ConversationColor) : null;
}

/** The design token that renders a colour, or null when the chat has none. */
export function colorToken(color: ConversationColor | null): string | null {
  return CONVERSATION_COLORS.find(c => c.value === color)?.token ?? null;
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
