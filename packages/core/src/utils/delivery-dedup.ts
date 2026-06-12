/**
 * Webhook Delivery Deduplicator
 *
 * Bounded, TTL-based first-seen cache for webhook idempotency keys.
 * Forges can deliver the same logical event more than once: dual
 * subscriptions (repo webhook + App webhook produce different delivery
 * GUIDs for one comment), load-balancer double-forwards, and manual
 * redeliveries. Without ingest dedup, a duplicate delivery queues a
 * byte-identical second workflow run behind the first (#1951).
 *
 * `seen(key)` returns false the first time a key appears within the TTL
 * window and true on repeats, so callers drop the repeat. Entries expire
 * after the TTL (a deliberate redelivery hours later should run again)
 * and the cache evicts oldest-first past a max size, so memory stays
 * bounded regardless of webhook volume.
 */

import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('delivery-dedup');
  return cachedLog;
}

/** Default time window in which a repeated key is treated as a duplicate */
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Default cap on tracked keys; oldest entries are evicted past this */
const DEFAULT_MAX_ENTRIES = 10_000;

export class DeliveryDeduplicator {
  /** Insertion-ordered map of key -> first-seen timestamp (ms) */
  private entries: Map<string, number>;
  private ttlMs: number;
  private maxEntries: number;
  private nowFn: () => number;

  /**
   * Creates a new DeliveryDeduplicator
   * @param ttlMs - How long a key counts as a duplicate (default: 10 minutes)
   * @param maxEntries - Maximum tracked keys before oldest-first eviction (default: 10,000)
   * @param nowFn - Clock source, injectable for deterministic tests (default: Date.now)
   */
  constructor(
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    nowFn: () => number = Date.now
  ) {
    this.entries = new Map<string, number>();
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.nowFn = nowFn;
  }

  /**
   * Record a key and report whether it was already seen within the TTL window.
   * @param key - Idempotency key for the logical event
   * @returns true if the key is a duplicate (caller should drop), false if first-seen
   */
  seen(key: string): boolean {
    const now = this.nowFn();
    const firstSeen = this.entries.get(key);

    if (firstSeen !== undefined && now - firstSeen < this.ttlMs) {
      return true;
    }

    // Expired entry for this key (if any) gets refreshed; delete first so
    // re-insertion moves it to the back of the eviction order.
    this.entries.delete(key);
    this.entries.set(key, now);
    this.prune(now);
    return false;
  }

  /** Number of currently tracked keys (includes not-yet-pruned expired entries) */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop expired entries from the front of the insertion order, then enforce
   * the max-size cap. Map iteration order is insertion order and timestamps
   * are monotonically inserted, so expired entries are always at the front.
   */
  private prune(now: number): void {
    for (const [key, firstSeen] of this.entries) {
      if (now - firstSeen < this.ttlMs) break;
      this.entries.delete(key);
    }

    if (this.entries.size > this.maxEntries) {
      const evictCount = this.entries.size - this.maxEntries;
      const iter = this.entries.keys();
      for (let i = 0; i < evictCount; i++) {
        const next = iter.next();
        if (next.done) break;
        this.entries.delete(next.value);
      }
      getLog().debug({ evictCount, size: this.entries.size }, 'evicted_oldest_entries');
    }
  }
}
