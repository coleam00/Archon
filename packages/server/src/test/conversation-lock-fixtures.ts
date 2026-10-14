import type { ConversationLockManager } from '@archon/core';

export function makeIdleLockStats(): ReturnType<ConversationLockManager['getStats']> {
  return {
    active: 0,
    queuedTotal: 0,
    queuedByConversation: [],
    maxConcurrent: 10,
    activeConversationIds: [],
  };
}
