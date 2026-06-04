/**
 * Postgres real-time bridge: `LISTEN archon_dashboard_event` and wake the
 * DashboardEventPoller to drain immediately on each notification — so out-of-process
 * (CLI) workflow runs stream to the console with near-zero latency on Postgres.
 *
 * The notification carries no payload to emit; it only triggers `poller.drainNow()`.
 * That keeps the cursor + row→SSE mapping + dedup in ONE place (the poller), so a
 * dropped or coalesced notification can never desync state — the cursor drain is
 * authoritative, and the poller's interval backstop reconciles anything missed
 * across a `LISTEN` reconnect.
 */
import { createLogger } from '@archon/paths';
import type { DbNotificationListener } from '@archon/core/db/adapters/types';
import type { DashboardEventPoller } from './dashboard-event-poller';

const log = createLogger('adapter.web.pg-notify');
const CHANNEL = 'archon_dashboard_event';
const MAX_BACKOFF_MS = 30_000;

export class PgNotifyListener {
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly notifier: DbNotificationListener,
    private readonly poller: DashboardEventPoller,
    private readonly initialBackoffMs = 1000
  ) {
    this.backoffMs = initialBackoffMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const unsubscribe = await this.notifier.listen(
        CHANNEL,
        () => {
          void this.poller.drainNow();
        },
        () => {
          this.scheduleReconnect();
        }
      );
      // stop() may have run while we were awaiting listen() — don't leave a live
      // subscription (it would keep calling drainNow() after shutdown).
      if (this.stopped) {
        this.safeUnsubscribe(unsubscribe);
        return;
      }
      this.unsubscribe = unsubscribe;
      this.backoffMs = this.initialBackoffMs; // reset on a successful connect
      log.info({ channel: CHANNEL }, 'pg_notify.listening');
    } catch (err) {
      log.warn({ err }, 'pg_notify.connect_failed');
      this.scheduleReconnect();
    }
  }

  /** Run an unsubscribe, surfacing (not swallowing) an unexpected failure. */
  private safeUnsubscribe(unsubscribe: () => void): void {
    try {
      unsubscribe();
    } catch (err) {
      log.debug({ err }, 'pg_notify.unsubscribe_error');
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.unsubscribe) {
      this.safeUnsubscribe(this.unsubscribe);
      this.unsubscribe = null;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    log.warn({ delayMs: delay }, 'pg_notify.reconnect_scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    const t = this.reconnectTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.unsubscribe) {
      this.safeUnsubscribe(this.unsubscribe);
      this.unsubscribe = null;
    }
  }
}
