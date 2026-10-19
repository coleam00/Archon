import type { ConversationLockSnapshot } from '@archon/core';

export function makeIdleLockStats(): ConversationLockSnapshot {
  return {
    active: 0,
    maxConcurrent: 10,
    queuedTotal: 0,
    activeConversations: [],
    queuedConversations: [],
  };
}
