/**
 * Dashboard event poller — streams workflow runs started in ANY process to the
 * `__dashboard__` SSE stream so the web console's Workflow dock updates live.
 *
 * The in-process `WorkflowEventBridge` only sees runs executed inside the server.
 * Runs started by a separate process — the `archon` CLI, especially
 * `archon workflow run --detach` — write their events to the
 * `remote_agent_workflow_events` table but never reach the server's emitter. This
 * poller tails that table and replays new rows to `__dashboard__`, covering every
 * process that writes events to the DB.
 *
 * Correctness vs SQLite's 1-second `CURRENT_TIMESTAMP` resolution: the cursor uses
 * `created_at >= cursor` (not `>`), so events that arrive late at the boundary
 * second are not skipped; a `seenAtBoundary` id-set suppresses re-emitting rows
 * already sent at that second. Duplicate emissions are harmless anyway — the
 * dashboard client reacts to events by invalidating + refetching (idempotent), so
 * the REST response is always the source of truth.
 */
import { createLogger } from '@archon/paths';
import { listWorkflowEventsSince } from '@archon/core/db/workflow-events';
import { mapWorkflowEventRow } from './workflow-bridge';
import type { SSETransport } from './transport';

const log = createLogger('adapter.web.dashboard-poller');

const DASHBOARD_STREAM = '__dashboard__';
/** Max rows per drain. Large enough that a single timestamp-second won't overflow. */
const DRAIN_LIMIT = 500;

export class DashboardEventPoller {
  private transport: SSETransport | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cursor: Date = new Date(); // start at boot — never replay history
  private seenAtBoundary = new Set<string>();
  private draining = false;
  private redrainRequested = false;

  /** Begin polling. `intervalMs` is the (SQLite) poll cadence / (Postgres) backstop. */
  start(transport: SSETransport, intervalMs: number): void {
    if (this.intervalId) return;
    this.transport = transport;
    this.cursor = new Date();
    this.seenAtBoundary.clear();
    this.intervalId = setInterval(() => {
      void this.drain();
    }, intervalMs);
    // Don't let the interval keep the process alive (the HTTP server does that).
    const timer = this.intervalId as unknown as { unref?: () => void };
    if (typeof timer.unref === 'function') timer.unref();
    log.info({ intervalMs }, 'dashboard_poller.started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.transport = null;
  }

  /**
   * Drain immediately (e.g. woken by a Postgres NOTIFY). Coalesced with in-flight
   * drains. Returns the drain promise (callers may ignore it; tests await it).
   */
  drainNow(): Promise<void> {
    return this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.transport) return;
    // Coalesce: a drain already running absorbs this request (one follow-up pass).
    if (this.draining) {
      this.redrainRequested = true;
      return;
    }
    // Cheap when idle: with no dashboard client, skip the query and keep the cursor
    // fresh so a later-connecting client streams only new events (its initial REST
    // fetch already shows current state — no need to replay the idle gap).
    if (!this.transport.hasActiveStream(DASHBOARD_STREAM)) {
      this.cursor = new Date();
      this.seenAtBoundary.clear();
      return;
    }

    this.draining = true;
    try {
      do {
        this.redrainRequested = false;
        await this.drainOnce();
      } while (this.redrainRequested);
    } catch (err) {
      log.warn({ err }, 'dashboard_poller.drain_failed');
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;

    const rows = await listWorkflowEventsSince(this.cursor, DRAIN_LIMIT);
    if (rows.length === 0) return;

    let maxTs = this.cursor.getTime();
    for (const row of rows) {
      if (this.seenAtBoundary.has(row.id)) continue; // already emitted at the boundary second
      const sse = mapWorkflowEventRow(row);
      if (sse) transport.emitWorkflowEvent(DASHBOARD_STREAM, sse);
      const ts = new Date(row.created_at).getTime();
      if (!Number.isNaN(ts) && ts > maxTs) maxTs = ts;
    }

    // Advance the cursor to the newest created_at seen, and remember the ids at
    // exactly that second so the next `>= cursor` query doesn't re-emit them.
    const nextBoundary = new Set<string>();
    for (const row of rows) {
      if (new Date(row.created_at).getTime() === maxTs) nextBoundary.add(row.id);
    }
    this.cursor = new Date(maxTs);
    this.seenAtBoundary = nextBoundary;
  }
}
