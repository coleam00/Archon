import { randomUUID } from 'node:crypto';
import { createLogger } from '@archon/paths';
import type { IDatabase } from './adapters/types';

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_MS = 500;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.concurrency');
  return cachedLog;
}

export interface ProviderConcurrencyWait {
  provider: string;
  limit: number;
}

export interface ProviderConcurrencyAcquired extends ProviderConcurrencyWait {
  slot: number;
  waitMs: number;
}

export interface ProviderConcurrencyObserver {
  onQueued?: (event: ProviderConcurrencyWait) => void;
  onAcquired?: (event: ProviderConcurrencyAcquired) => void;
  onDequeued?: (event: ProviderConcurrencyWait) => void;
  onWaiting?: () => void;
}

export interface ProviderConcurrencyAcquireOptions {
  signal?: AbortSignal;
  observer?: ProviderConcurrencyObserver;
  /** Return false when the live owner (for example a workflow run) is terminal. */
  /** True = live, false = terminal, undefined = ownership status unavailable. */
  shouldContinue?: () => Promise<boolean | undefined>;
}

export interface ProviderConcurrencyLease {
  readonly provider: string;
  readonly slot: number;
  /** Aborts when Archon can no longer prove ownership of the slot. */
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

interface GateTiming {
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError('Provider concurrency wait aborted');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError('Provider concurrency wait aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function notify(callback: (() => void) | undefined, eventName: string): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    getLog().warn({ err: error as Error }, eventName);
  }
}

class DatabaseProviderLease implements ProviderConcurrencyLease {
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryGuardTimer: ReturnType<typeof setTimeout> | undefined;
  private localExpiry: number;
  private released = false;

  constructor(
    private readonly db: IDatabase,
    readonly provider: string,
    readonly slot: number,
    private readonly leaseId: string,
    private readonly timing: GateTiming,
    localExpiry: number
  ) {
    this.signal = this.abortController.signal;
    this.localExpiry = localExpiry;
    this.scheduleExpiryGuard();
    this.scheduleHeartbeat();
  }

  private scheduleExpiryGuard(): void {
    if (this.expiryGuardTimer) clearTimeout(this.expiryGuardTimer);
    const delay = this.localExpiry - this.timing.now() - this.timing.heartbeatMs;
    if (delay <= 0) {
      this.abortController.abort(
        abortError('Provider concurrency lease could not be renewed before expiry')
      );
      return;
    }
    this.expiryGuardTimer = setTimeout(() => {
      if (this.released || this.signal.aborted) return;
      this.abortController.abort(
        abortError('Provider concurrency lease could not be renewed before expiry')
      );
    }, delay);
    this.expiryGuardTimer.unref?.();
  }

  private scheduleHeartbeat(delay = this.timing.heartbeatMs): void {
    if (this.released || this.signal.aborted) return;
    this.heartbeatTimer = setTimeout(() => void this.heartbeat(), delay);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeat(): Promise<void> {
    if (this.released || this.signal.aborted) return;
    try {
      const renewedUntil = await this.renew();
      if (renewedUntil === null) {
        getLog().error(
          { provider: this.provider, slot: this.slot },
          'provider_concurrency.lease_lost'
        );
        this.abortController.abort(abortError('Provider concurrency lease ownership lost'));
        return;
      }
      if (this.released || this.signal.aborted) return;
      this.localExpiry = renewedUntil;
      this.scheduleExpiryGuard();
      this.scheduleHeartbeat();
    } catch (error) {
      getLog().warn(
        { err: error as Error, provider: this.provider, slot: this.slot },
        'provider_concurrency.heartbeat_failed'
      );
      const remaining = this.localExpiry - this.timing.now();
      if (remaining <= this.timing.heartbeatMs) {
        this.abortController.abort(
          abortError('Provider concurrency lease could not be renewed before expiry')
        );
        return;
      }
      this.scheduleHeartbeat(Math.min(this.timing.heartbeatMs, remaining - 1));
    }
  }

  private async renew(): Promise<number | null> {
    const queryStartedAt = this.timing.now();
    const expiry =
      this.db.dialect === 'postgres'
        ? "NOW() + ($4 * INTERVAL '1 millisecond')"
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($4 / 1000.0) || ' seconds')";
    const result = await this.db.query(
      `UPDATE remote_agent_provider_slots
       SET lease_expires_at = ${expiry}
       WHERE provider_id = $1 AND slot_index = $2 AND lease_id = $3`,
      [this.provider, this.slot, this.leaseId, this.timing.leaseMs]
    );
    return result.rowCount === 1 ? queryStartedAt + this.timing.leaseMs : null;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.expiryGuardTimer) clearTimeout(this.expiryGuardTimer);
    try {
      await this.db.query(
        `DELETE FROM remote_agent_provider_slots
         WHERE provider_id = $1 AND slot_index = $2 AND lease_id = $3`,
        [this.provider, this.slot, this.leaseId]
      );
      getLog().debug({ provider: this.provider, slot: this.slot }, 'provider_concurrency.released');
    } catch (error) {
      // Expiry is the recovery path when the database cannot accept the release.
      getLog().warn(
        { err: error as Error, provider: this.provider, slot: this.slot },
        'provider_concurrency.release_failed'
      );
    }
  }
}

/** Cross-process admission gate backed by the install's shared database. */
export class ProviderConcurrencyGate {
  private readonly timing: GateTiming;

  constructor(db: IDatabase, timing: Partial<GateTiming> = {}) {
    this.db = db;
    this.timing = {
      leaseMs: timing.leaseMs ?? DEFAULT_LEASE_MS,
      heartbeatMs: timing.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      pollMs: timing.pollMs ?? DEFAULT_POLL_MS,
      now: timing.now ?? Date.now,
      sleep: timing.sleep ?? defaultSleep,
    };
    if (
      this.timing.leaseMs <= 0 ||
      this.timing.heartbeatMs <= 0 ||
      this.timing.heartbeatMs >= this.timing.leaseMs ||
      this.timing.pollMs <= 0
    ) {
      throw new Error('Invalid provider concurrency gate timing');
    }
  }

  private readonly db: IDatabase;

  async acquire(
    provider: string,
    limit: number,
    options: ProviderConcurrencyAcquireOptions = {}
  ): Promise<ProviderConcurrencyLease> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`Provider concurrency limit for '${provider}' must be a positive integer`);
    }

    const startedAt = this.timing.now();
    let queued = false;
    try {
      waitForSlot: while (true) {
        throwIfAborted(options.signal);
        if (options.shouldContinue) {
          const shouldContinue = await options.shouldContinue();
          if (shouldContinue === false) {
            throw abortError(`Provider concurrency wait stopped for terminal owner '${provider}'`);
          }
          if (shouldContinue === undefined) {
            await this.timing.sleep(this.timing.pollMs, options.signal);
            continue;
          }
        }

        for (let slot = 0; slot < limit; slot += 1) {
          const leaseId = randomUUID();
          const claimedUntil = await this.tryClaim(provider, slot, leaseId, limit);
          if (claimedUntil !== null) {
            const waitMs = this.timing.now() - startedAt;
            const lease = new DatabaseProviderLease(
              this.db,
              provider,
              slot,
              leaseId,
              this.timing,
              claimedUntil
            );
            try {
              throwIfAborted(options.signal);
              if (options.shouldContinue) {
                const shouldContinue = await options.shouldContinue();
                if (shouldContinue === false) {
                  throw abortError(
                    `Provider concurrency wait stopped for terminal owner '${provider}'`
                  );
                }
                if (shouldContinue === undefined) {
                  await lease.release();
                  await this.timing.sleep(this.timing.pollMs, options.signal);
                  continue waitForSlot;
                }
              }
            } catch (error) {
              await lease.release();
              throw error;
            }
            if (queued) {
              notify(
                () => options.observer?.onAcquired?.({ provider, limit, slot, waitMs }),
                'provider_concurrency.acquired_observer_failed'
              );
            }
            if (lease.signal.aborted) {
              await lease.release();
              throw abortError(`Provider concurrency lease was lost before '${provider}' started`);
            }
            getLog().info({ provider, limit, slot, waitMs }, 'provider_concurrency.acquired');
            return lease;
          }
        }

        if (!queued) {
          queued = true;
          notify(
            () => options.observer?.onQueued?.({ provider, limit }),
            'provider_concurrency.queued_observer_failed'
          );
          getLog().info({ provider, limit }, 'provider_concurrency.queued');
        }
        notify(options.observer?.onWaiting, 'provider_concurrency.wait_observer_failed');
        await this.timing.sleep(this.timing.pollMs, options.signal);
      }
    } catch (error) {
      if (queued) {
        notify(
          () => options.observer?.onDequeued?.({ provider, limit }),
          'provider_concurrency.dequeued_observer_failed'
        );
      }
      throw error;
    }
  }

  private async tryClaim(
    provider: string,
    slot: number,
    leaseId: string,
    limit: number
  ): Promise<number | null> {
    const queryStartedAt = this.timing.now();
    // PostgreSQL otherwise tries to infer the reused $1 as both the SELECT's
    // default text type and the VARCHAR provider_id comparison.
    const providerParam = this.db.dialect === 'postgres' ? '$1::varchar(64)' : '$1';
    const expiry =
      this.db.dialect === 'postgres'
        ? "NOW() + ($4 * INTERVAL '1 millisecond')"
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($4 / 1000.0) || ' seconds')";
    const expired =
      this.db.dialect === 'postgres'
        ? 'remote_agent_provider_slots.lease_expires_at <= NOW()'
        : "julianday(remote_agent_provider_slots.lease_expires_at) <= julianday('now')";
    const live =
      this.db.dialect === 'postgres'
        ? 'lease_expires_at > NOW()'
        : "julianday(lease_expires_at) > julianday('now')";
    const result = await this.db.query<{ slot_index: number }>(
      `INSERT INTO remote_agent_provider_slots
         (provider_id, slot_index, lease_id, lease_expires_at)
       SELECT ${providerParam}, $2, $3, ${expiry}
       WHERE (
         SELECT COUNT(*) FROM remote_agent_provider_slots
         WHERE provider_id = ${providerParam} AND ${live}
       ) < $5
       ON CONFLICT (provider_id, slot_index) DO UPDATE SET
         lease_id = EXCLUDED.lease_id,
         lease_expires_at = EXCLUDED.lease_expires_at
       WHERE ${expired}
       RETURNING slot_index`,
      [provider, slot, leaseId, this.timing.leaseMs, limit]
    );
    return result.rowCount === 1 ? queryStartedAt + this.timing.leaseMs : null;
  }
}
