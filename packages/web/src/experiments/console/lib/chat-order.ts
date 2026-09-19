/**
 * A hand-arranged order for a project's chats.
 *
 * Sorting by recency is self-maintaining but puts whatever was touched last on
 * top, which is not always what matters. A manual order is stable by
 * definition, so a chat stays where it was put.
 *
 * Held in localStorage per project. It is a view preference, not data, and it
 * deliberately does not follow between devices.
 */

const KEY_PREFIX = 'archon.console.chatOrder.';

export function chatOrderKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function readChatOrder(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(chatOrderKey(projectId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or newer-build value must not crash the rail.
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function writeChatOrder(projectId: string, order: readonly string[]): void {
  try {
    localStorage.setItem(chatOrderKey(projectId), JSON.stringify(order));
  } catch {
    // Best-effort: failing to remember an order must not break the rail.
  }
}

/**
 * Apply a manual order to a list that is already sorted by recency.
 *
 * Ids in the order come first, in that order. Anything not in it — a chat
 * created since, or one never dragged — keeps its recency position behind them,
 * so a new chat is never hidden by an order that predates it.
 */
export function applyChatOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[]
): T[] {
  const byId = new Map(items.map(i => [i.id, i]));
  const ranked: T[] = [];
  for (const id of order) {
    const hit = byId.get(id);
    if (hit !== undefined) {
      ranked.push(hit);
      byId.delete(id);
    }
  }
  // Map preserves insertion order, so the remainder is still recency-sorted.
  return [...ranked, ...byId.values()];
}

/**
 * The order after dragging `dragId` onto `targetId`.
 *
 * Built from the list as currently displayed, so dragging while filtered still
 * produces a coherent full order rather than one that only describes the rows
 * that happened to be visible.
 */
export function reorder(
  displayed: readonly { id: string }[],
  dragId: string,
  targetId: string
): string[] {
  const ids = displayed.map(i => i.id);
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}
