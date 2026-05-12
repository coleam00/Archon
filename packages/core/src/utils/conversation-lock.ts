/**
 * Conversation Lock Manager
 *
 * Manages non-blocking concurrent conversation handling with:
 * - Global concurrency limit (max N conversations simultaneously)
 * - Per-conversation ordering (messages process sequentially per conversation)
 * - Explicit queueing with observability
 */

import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('conversation-lock');
  return cachedLog;
}

/**
 * Represents a queued message waiting for processing
 */
interface QueuedMessage {
  handler: () => Promise<void>;
  timestamp: number;
}

/**
 * Result of acquiring a lock, indicating whether the message was started or queued
 */
export interface LockAcquisitionResult {
  status: 'started' | 'queued-conversation' | 'queued-capacity';
}

/**
 * Manages conversation locks for concurrent message processing
 */
export class ConversationLockManager {
  private activeConversations: Map<string, Promise<void>>;
  private messageQueues: Map<string, QueuedMessage[]>;
  private maxConcurrent: number;

  /**
   * Creates a new ConversationLockManager
   * @param maxConcurrent - Maximum number of concurrent conversations (default: 10)
   */
  constructor(maxConcurrent = 10) {
    this.activeConversations = new Map<string, Promise<void>>();
    this.messageQueues = new Map<string, QueuedMessage[]>();
    this.maxConcurrent = maxConcurrent;
    getLog().info({ maxConcurrent }, 'initialized');
  }

  /**
   * Acquire lock for conversation and execute handler
   * Non-blocking: returns immediately, handler executes async
   * @param conversationId - Unique conversation identifier
   * @param handler - Async function to execute
   */
  async acquireLock(
    conversationId: string,
    handler: () => Promise<void>
  ): Promise<LockAcquisitionResult> {
    // Check if conversation already active - queue if yes
    if (this.activeConversations.has(conversationId)) {
      this.queueMessage(conversationId, handler);
      return { status: 'queued-conversation' };
    }

    // Check if at max capacity - queue if yes
    if (this.activeConversations.size >= this.maxConcurrent) {
      getLog().info({ maxConcurrent: this.maxConcurrent, conversationId }, 'queued_at_capacity');
      this.queueMessage(conversationId, handler);
      return { status: 'queued-capacity' };
    }

    // Execute immediately
    getLog().debug(
      { conversationId, active: this.activeConversations.size + 1, queued: this.getQueuedCount() },
      'conversation_started'
    );

    // Store Promise in Map BEFORE awaiting (prevents race conditions)
    const promise = handler()
      .catch(error => {
        getLog().error({ err: error, conversationId }, 'conversation_handler_error');
      })
      .finally(() => {
        // Clean up active conversation
        this.activeConversations.delete(conversationId);
        getLog().debug(
          { conversationId, active: this.activeConversations.size, queued: this.getQueuedCount() },
          'conversation_completed'
        );

        // Process next queued message for this conversation
        this.processQueue(conversationId).catch(error => {
          getLog().error({ err: error, conversationId }, 'queue_processing_error');
        });

        // Also check if we can process any other queued conversations (global capacity freed up)
        this.processGlobalQueue().catch(error => {
          getLog().error({ err: error }, 'global_queue_processing_error');
        });
      });

    this.activeConversations.set(conversationId, promise);

    // Fire-and-forget: don't await here, return immediately
    return { status: 'started' };
  }

  /**
   * Add message to conversation queue
   * @param conversationId - Unique conversation identifier
   * @param handler - Async function to queue
   */
  private queueMessage(conversationId: string, handler: () => Promise<void>): void {
    const queue = this.messageQueues.get(conversationId) ?? [];
    if (!this.messageQueues.has(conversationId)) {
      this.messageQueues.set(conversationId, queue);
    }
    queue.push({
      handler,
      timestamp: Date.now(),
    });
    getLog().debug({ conversationId, queueLength: queue.length }, 'message_queued');
  }

  /**
   * Process next queued message for conversation if any exist
   * @param conversationId - Unique conversation identifier
   */
  private async processQueue(conversationId: string): Promise<void> {
    const queue = this.messageQueues.get(conversationId);
    if (!queue || queue.length === 0) {
      this.messageQueues.delete(conversationId);
      return;
    }

    const next = queue.shift();
    if (!next) return;
    const waitTime = Date.now() - next.timestamp;
    getLog().debug({ conversationId, waitTimeMs: waitTime }, 'queued_message_processing');

    await this.acquireLock(conversationId, next.handler);
  }

  /**
   * Get current concurrency statistics
   * @returns Current state for observability
   */
  getStats(): {
    active: number;
    queuedTotal: number;
    queuedByConversation: { conversationId: string; queuedMessages: number }[];
    maxConcurrent: number;
    activeConversationIds: string[];
  } {
    const queuedByConversation = Array.from(this.messageQueues.entries()).map(([id, queue]) => ({
      conversationId: id,
      queuedMessages: queue.length,
    }));

    return {
      active: this.activeConversations.size,
      queuedTotal: Array.from(this.messageQueues.values()).reduce((sum, q) => sum + q.length, 0),
      queuedByConversation,
      maxConcurrent: this.maxConcurrent,
      activeConversationIds: Array.from(this.activeConversations.keys()),
    };
  }

  /**
   * Helper to get total queued count
   */
  private getQueuedCount(): number {
    return Array.from(this.messageQueues.values()).reduce((sum, q) => sum + q.length, 0);
  }

  /**
   * Process queued messages from any conversation when global capacity available
   */
  private async processGlobalQueue(): Promise<void> {
    // Check if we have capacity
    if (this.activeConversations.size >= this.maxConcurrent) {
      return;
    }

    // Find first conversation with queued messages that's not currently active
    for (const [convId, queue] of this.messageQueues.entries()) {
      if (queue.length > 0 && !this.activeConversations.has(convId)) {
        await this.processQueue(convId);
        break; // Process one at a time
      }
    }
  }
}
