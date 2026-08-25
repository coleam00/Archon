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
  onQueued?: (event: ProviderConcurrencyWait) => Promise<void> | void;
  onAcquired?: (event: ProviderConcurrencyAcquired) => Promise<void> | void;
}

export interface ProviderConcurrencyAcquireOptions {
  signal?: AbortSignal;
  observer?: ProviderConcurrencyObserver;
  /** Return false when the live owner (for example a workflow run) is terminal. */
  shouldContinue?: () => Promise<boolean>;
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

async function notify(
  callback: (() => Promise<void> | void) | undefined,
  eventName: string
): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch (error) {
    getLog().warn({ err: error as Error }, eventName);
  }
}

class DatabaseProviderLease implements ProviderConcurrencyLease {
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private localExpiry: number;
  private released = false;

  constructor(
    private readonly db: IDatabase,
    readonly provider: string,
    readonly slot: number,
    private readonly leaseId: string,
    private readonly timing: GateTiming
  ) {
    this.signal = this.abortController.signal;
    this.localExpiry = timing.now() + timing.leaseMs;
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(delay = this.timing.heartbeatMs): void {
    if (this.released || this.signal.aborted) return;
    this.heartbeatTimer = setTimeout(() => void this.heartbeat(), delay);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeat(): Promise<void> {
    if (this.released || this.signal.aborted) return;
    try {
      const renewed = await this.renew();
      if (!renewed) {
        getLog().error(
          { provider: this.provider, slot: this.slot },
          'provider_concurrency.lease_lost'
        );
        this.abortController.abort(abortError('Provider concurrency lease ownership lost'));
        return;
      }
      this.localExpiry = this.timing.now() + this.timing.leaseMs;
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

  private async renew(): Promise<boolean> {
    const expiry =
      this.db.dialect === 'postgres'
        ? "NOW() + ($4 * INTERVAL '1 millisecond')"
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($4 / 1000.0) || ' seconds')";
    const now = this.db.dialect === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP';
    const result = await this.db.query(
      `UPDATE remote_agent_provider_slots
       SET lease_expires_at = ${expiry}, updated_at = ${now}
       WHERE provider_id = $1 AND slot_index = $2 AND lease_id = $3`,
      [this.provider, this.slot, this.leaseId, this.timing.leaseMs]
    );
    return result.rowCount === 1;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
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
    while (true) {
      throwIfAborted(options.signal);
      if (options.shouldContinue && !(await options.shouldContinue())) {
        throw abortError(`Provider concurrency wait stopped for terminal owner '${provider}'`);
      }

      for (let slot = 0; slot < limit; slot += 1) {
        const leaseId = randomUUID();
        if (await this.tryClaim(provider, slot, leaseId)) {
          const waitMs = this.timing.now() - startedAt;
          if (queued) {
            await notify(
              () => options.observer?.onAcquired?.({ provider, limit, slot, waitMs }),
              'provider_concurrency.acquired_observer_failed'
            );
          }
          getLog().info({ provider, limit, slot, waitMs }, 'provider_concurrency.acquired');
          return new DatabaseProviderLease(this.db, provider, slot, leaseId, this.timing);
        }
      }

      if (!queued) {
        queued = true;
        await notify(
          () => options.observer?.onQueued?.({ provider, limit }),
          'provider_concurrency.queued_observer_failed'
        );
        getLog().info({ provider, limit }, 'provider_concurrency.queued');
      }
      await this.timing.sleep(this.timing.pollMs, options.signal);
    }
  }

  private async tryClaim(provider: string, slot: number, leaseId: string): Promise<boolean> {
    const expiry =
      this.db.dialect === 'postgres'
        ? "NOW() + ($4 * INTERVAL '1 millisecond')"
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($4 / 1000.0) || ' seconds')";
    const now = this.db.dialect === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP';
    const expired =
      this.db.dialect === 'postgres'
        ? 'remote_agent_provider_slots.lease_expires_at <= NOW()'
        : "julianday(remote_agent_provider_slots.lease_expires_at) <= julianday('now')";
    const result = await this.db.query<{ slot_index: number }>(
      `INSERT INTO remote_agent_provider_slots
         (provider_id, slot_index, lease_id, lease_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, ${expiry}, ${now}, ${now})
       ON CONFLICT (provider_id, slot_index) DO UPDATE SET
         lease_id = EXCLUDED.lease_id,
         lease_expires_at = EXCLUDED.lease_expires_at,
         updated_at = ${now}
       WHERE ${expired}
       RETURNING slot_index`,
      [provider, slot, leaseId, this.timing.leaseMs]
    );
    return result.rowCount === 1;
  }
}
