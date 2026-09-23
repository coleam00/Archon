/**
 * Conversation Lock Manager
 *
 * Manages non-blocking concurrent conversation handling with:
 * - Global concurrency limit (max N conversations simultaneously)
 * - Per-conversation ordering (messages process sequentially per conversation)
 * - Explicit queueing with observability
 * - Drain: stop admitting new turns so a deploy can replace the process
 */

import { createLogger } from '@archon/paths';

import type { IPlatformAdapter } from '../types';

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
 * Result of acquiring a lock, indicating whether the message was started, queued,
 * or refused because the server is draining
 */
export interface LockAcquisitionResult {
  status: 'started' | 'queued-conversation' | 'queued-capacity' | 'refused-draining';
}

/**
 * What a draining manager is holding open, for an operator watching a deploy wait.
 * `refusedCount` is cumulative across the whole drain, including re-requests.
 */
export interface DrainStatus {
  requestedAt: string;
  expiresAt: string;
  refusedCount: number;
}

/**
 * The one sentence every caller shows someone whose message drain refused. Nothing
 * retries a refused message, so it has to say the work was not accepted and what to
 * do about it — a vaguer notice would read as "received" and lose the message.
 */
export const DRAIN_REFUSAL_NOTICE =
  'Archon is restarting and is not accepting new work right now. Nothing was started — ' +
  'please try again in a moment.';

/**
 * Tells a sender their message was refused because the server is draining for a
 * restart, when — and only when — that is what happened. Nothing queued the message
 * and nothing will retry it, so silence here would be exactly the drop drain exists
 * to avoid; a failure to deliver the notice is logged rather than thrown, because the
 * caller has already finished with the message and has nothing left to undo.
 *
 * Every platform that acquires a lock shares this so the decision, the wording and
 * the log line cannot drift apart per adapter.
 */
export async function notifyDrainRefusal(
  platform: string,
  adapter: Pick<IPlatformAdapter, 'sendMessage'>,
  conversationId: string,
  result: LockAcquisitionResult
): Promise<void> {
  if (result.status !== 'refused-draining') return;
  try {
    await adapter.sendMessage(conversationId, DRAIN_REFUSAL_NOTICE);
  } catch (sendError) {
    getLog().error({ err: sendError, platform, conversationId }, 'drain_notice_send_failed');
  }
}

/** Internal drain bookkeeping; `expiresAtMs` is compared against an injectable clock. */
interface DrainState {
  requestedAt: string;
  expiresAtMs: number;
  refusedCount: number;
}

function toDrainStatus(state: DrainState): DrainStatus {
  return {
    requestedAt: state.requestedAt,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    refusedCount: state.refusedCount,
  };
}

/**
 * Manages conversation locks for concurrent message processing
 */
export class ConversationLockManager {
  private activeConversations: Map<string, Promise<void>>;
  private messageQueues: Map<string, QueuedMessage[]>;
  private maxConcurrent: number;
  private drainState: DrainState | undefined;

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
   *
   * This is the server's external admission point, so it is where drain refuses.
   * @param conversationId - Unique conversation identifier
   * @param handler - Async function to execute
   */
  async acquireLock(
    conversationId: string,
    handler: () => Promise<void>
  ): Promise<LockAcquisitionResult> {
    const draining = this.currentDrain();
    if (draining) {
      draining.refusedCount += 1;
      getLog().info(
        { conversationId, refusedCount: draining.refusedCount },
        'refused_while_draining'
      );
      return { status: 'refused-draining' };
    }
    return this.admit(conversationId, handler);
  }

  /**
   * Admit a message: run it now, or queue it behind the conversation or the global
   * capacity limit. Callers that already passed admission — the queue drains — reach
   * this directly so drain never strips a message the manager already accepted.
   */
  private async admit(
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

    // admit(), not acquireLock(): this message was accepted before drain began and the
    // sender was told so. Refusing it here would be the silent drop drain exists to
    // prevent — and it is what lets drain terminate, since queues only shrink.
    await this.admit(conversationId, next.handler);
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
   * Stop admitting new conversation turns so the process can be replaced.
   *
   * Unrelated to `drainResourceStartHost`, which drains queued triggers *into*
   * execution. This stops work entering.
   *
   * The budget is mandatory and expires on its own: a deploy that dies mid-drain must
   * not leave a box that refuses work forever. Re-requesting replaces the budget and
   * keeps the refusal count, so a deploy can extend its own wait.
   *
   * @param budgetSeconds - How long drain stays in effect before lapsing
   */
  beginDrain(budgetSeconds: number): DrainStatus {
    if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
      throw new RangeError(`drain budget must be a positive number of seconds: ${budgetSeconds}`);
    }
    const now = Date.now();
    const existing = this.currentDrain(now);
    const state: DrainState = {
      requestedAt: existing?.requestedAt ?? new Date(now).toISOString(),
      expiresAtMs: now + budgetSeconds * 1000,
      refusedCount: existing?.refusedCount ?? 0,
    };
    this.drainState = state;
    getLog().warn(
      { budgetSeconds, active: this.activeConversations.size, queued: this.getQueuedCount() },
      'drain_requested'
    );
    return toDrainStatus(state);
  }

  /** Resume admitting work. Idempotent — a deploy's failure path calls it blind. */
  cancelDrain(): void {
    if (!this.drainState) return;
    this.drainState = undefined;
    getLog().warn('drain_cancelled');
  }

  /**
   * @param nowMs - Injectable clock; the budget lapses lazily on read rather than on a
   *   timer, so nothing has to be unref'd or cleared.
   */
  getDrainStatus(nowMs = Date.now()): DrainStatus | undefined {
    const state = this.currentDrain(nowMs);
    return state ? toDrainStatus(state) : undefined;
  }

  isDraining(nowMs = Date.now()): boolean {
    return this.currentDrain(nowMs) !== undefined;
  }

  /** The live drain state, lapsing an expired budget. Mutable so refusals can count. */
  private currentDrain(nowMs = Date.now()): DrainState | undefined {
    const state = this.drainState;
    if (!state) return undefined;
    if (nowMs >= state.expiresAtMs) {
      this.drainState = undefined;
      getLog().warn(
        { requestedAt: state.requestedAt, refusedCount: state.refusedCount },
        'drain_budget_expired'
      );
      return undefined;
    }
    return state;
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
