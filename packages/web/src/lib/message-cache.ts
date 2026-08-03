import type { ChatMessage } from '@/lib/types';

const MAX_CACHED_CONVERSATIONS = 20;
const messageCache = new Map<string, ChatMessage[]>();

/**
 * Module-level flag indicating a send is in flight.
 * Survives component remounts (e.g., navigate after new-chat creation)
 * so the hydration merge in ChatInterface knows not to discard the
 * optimistic thinking placeholder.
 */
let sendInFlight = false;
export function setSendInFlight(v: boolean): void {
  sendInFlight = v;
}
export function isSendInFlight(): boolean {
  return sendInFlight;
}

export function getCachedMessages(id: string): ChatMessage[] {
  const msgs = messageCache.get(id);
  if (msgs) {
    // Move to end (most recently used) by re-inserting
    messageCache.delete(id);
    messageCache.set(id, msgs);
  }
  return msgs ?? [];
}

export function setCachedMessages(id: string, msgs: ChatMessage[]): void {
  // Delete first so re-insert moves it to the end (most recently used)
  messageCache.delete(id);
  messageCache.set(id, msgs);

  // Evict oldest entries if over capacity
  if (messageCache.size > MAX_CACHED_CONVERSATIONS) {
    const oldest = messageCache.keys().next();
    if (!oldest.done) {
      messageCache.delete(oldest.value);
    }
  }
}
