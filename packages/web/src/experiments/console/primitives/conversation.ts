/** Conversation summary primitive. Normalized from the server conversation row. */
/**
 * The colors a chat can be labelled with, paired with the design token that
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
  /** User-chosen color label, or null for none. */
  color: ConversationColor | null;
  /** Archived chats are hidden from the default list but are never destroyed. */
  archived: boolean;
}

interface RawConversation {
  id: string;
  platform_conversation_id: string;
  platform_type: string;
  title: string | null;
  last_activity_at: string | null;
  color: string | null;
  deleted_at?: string | null;
}

export function toConversationSummary(raw: RawConversation): ConversationSummary {
  return {
    id: raw.platform_conversation_id,
    title: raw.title,
    platformType: raw.platform_type,
    lastActivityAt: raw.last_activity_at,
    color: parseConversationColor(raw.color),
    // Archiving is a soft delete, so the timestamp's presence is the state.
    archived: raw.deleted_at != null,
  };
}

/**
 * Normalise a stored color. Anything unrecognised — written by a newer build,
 * or hand-edited — reads as no color rather than rendering a blank swatch.
 */
export function parseConversationColor(raw: string | null | undefined): ConversationColor | null {
  return CONVERSATION_COLORS.some(c => c.value === raw) ? (raw as ConversationColor) : null;
}

/** The design token that renders a color, or null when the chat has none. */
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

/**
 * Two-letter monogram for a chat's tile, mirroring the project rail's rows.
 *
 * Initials of the first two words when there are two, otherwise the first two
 * letters. Falls back to `??` rather than rendering an empty tile, which reads
 * as a loading state that never resolves.
 */
export function conversationMonogram(c: ConversationSummary): string {
  const label = conversationLabel(c);
  const words = label.split(/\s+/).filter(w => /[a-z0-9]/i.test(w));
  if (words.length >= 2) {
    const a = words[0]?.[0] ?? '';
    const b = words[1]?.[0] ?? '';
    const pair = `${a}${b}`.toUpperCase();
    if (pair.length === 2) return pair;
  }
  const letters = label.replace(/[^a-z0-9]/gi, '');
  return letters.length > 0 ? letters.slice(0, 2).toUpperCase() : '??';
}

/**
 * Case-insensitive substring match on the title, for the rail's filter box.
 * An empty query matches everything, so clearing the box restores the list
 * rather than emptying it.
 */
export function matchesFilter(c: ConversationSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return conversationLabel(c).toLowerCase().includes(q);
}
