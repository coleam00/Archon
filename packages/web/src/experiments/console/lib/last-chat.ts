/**
 * The chat a project was last reading, so a reload or a trip to another
 * project comes back to it rather than to whichever chat is newest.
 *
 * localStorage, like the console's other UI preferences. Per project, so one
 * project's choice never selects a chat in another.
 */

const KEY_PREFIX = 'archon.console.lastChat.';

export function lastChatKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function readLastChat(projectId: string): string | null {
  try {
    const raw = localStorage.getItem(lastChatKey(projectId));
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    // Storage throws with cookies disabled and in some private-browsing modes.
    return null;
  }
}

export function writeLastChat(projectId: string, conversationId: string | null): void {
  try {
    if (conversationId === null) localStorage.removeItem(lastChatKey(projectId));
    else localStorage.setItem(lastChatKey(projectId), conversationId);
  } catch {
    // Best-effort: failing to remember must never break navigating.
  }
}

/**
 * Which chat to open: the remembered one when it still exists, otherwise the
 * most recent. A remembered id that has been archived or deleted must not win,
 * or the project opens on nothing.
 */
export function chooseOpenChat(
  remembered: string | null,
  available: readonly { id: string }[]
): string | null {
  if (remembered !== null && available.some(c => c.id === remembered)) return remembered;
  return available[0]?.id ?? null;
}
