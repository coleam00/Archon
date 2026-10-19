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
 * Read-only view of conversation processing in this process. Timestamps are the
 * real acquisition and enqueue times; ages are measured from one clock read, so
 * they agree within a snapshot. Nothing in Archon acts on an age.
 */
export interface ConversationLockSnapshot {
  active: number;
  maxConcurrent: number;
  queuedTotal: number;
  /** Conversations holding a processing slot. */
  activeConversations: { conversationId: string; acquiredAt: string; ageMs: number }[];
  /** Conversations with messages waiting; empty queues are omitted. */
  queuedConversations: {
    conversationId: string;
    queuedMessages: number;
    oldestEnqueuedAt: string;
    oldestAgeMs: number;
  }[];
}

/** The active owner and when it acquired its slot, kept on one entry. */
interface ActiveConversation {
  promise: Promise<void>;
  acquiredAt: number;
}

/**
 * Manages conversation locks for concurrent message processing
 */
export class ConversationLockManager {
  private activeConversations: Map<string, ActiveConversation>;
  private messageQueues: Map<string, QueuedMessage[]>;
  private maxConcurrent: number;
  private readonly now: () => number;

  /**
   * Creates a new ConversationLockManager
   * @param maxConcurrent - Maximum number of concurrent conversations (default: 10)
   * @param now - Clock in epoch milliseconds; tests inject a controlled one
   */
  constructor(maxConcurrent = 10, now: () => number = Date.now) {
    this.activeConversations = new Map<string, ActiveConversation>();
    this.messageQueues = new Map<string, QueuedMessage[]>();
    this.maxConcurrent = maxConcurrent;
    this.now = now;
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
    const acquiredAt = this.now();
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

    this.activeConversations.set(conversationId, { promise, acquiredAt });

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
      timestamp: this.now(),
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
    const waitTime = this.now() - next.timestamp;
    getLog().debug({ conversationId, waitTimeMs: waitTime }, 'queued_message_processing');

    await this.acquireLock(conversationId, next.handler);
  }

  /**
   * Get current concurrency statistics
   * @returns Current state for observability
   */
  getStats(): ConversationLockSnapshot {
    const now = this.now();
    const activeConversations = Array.from(this.activeConversations.entries()).map(
      ([conversationId, { acquiredAt }]) => ({
        conversationId,
        acquiredAt: new Date(acquiredAt).toISOString(),
        ageMs: now - acquiredAt,
      })
    );
    // Queues are FIFO, so the first entry is the oldest. An emptied queue lingers
    // until the next processQueue pass; it carries no waiting message.
    const queuedConversations = Array.from(this.messageQueues.entries()).flatMap(
      ([conversationId, queue]) => {
        const oldest = queue[0];
        if (!oldest) return [];
        return [
          {
            conversationId,
            queuedMessages: queue.length,
            oldestEnqueuedAt: new Date(oldest.timestamp).toISOString(),
            oldestAgeMs: now - oldest.timestamp,
          },
        ];
      }
    );

    return {
      active: this.activeConversations.size,
      maxConcurrent: this.maxConcurrent,
      queuedTotal: this.getQueuedCount(),
      activeConversations,
      queuedConversations,
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
