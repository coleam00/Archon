/**
 * Dashboard event poller — streams workflow runs started in ANY process to the
 * `__dashboard__` SSE stream so the web console's Workflow dock updates live.
 *
 * The in-process `WorkflowEventBridge` only sees runs executed inside the server.
 * Runs started by a separate process — the `archon` CLI, especially
 * `archon workflow run --detach` — commit their events to the store but never
 * reach the server's emitter. This poller follows the store's commit-ordered
 * event feed and replays new dashboard-relevant rows to `__dashboard__`, covering
 * every process that writes events to the store.
 */
import { createLogger } from '@archon/paths';
import type { IWorkflowStore, WorkflowEventCursor } from '@archon/workflows/store';
import { mapWorkflowEventRow, DASHBOARD_SOURCE_EVENT_TYPES } from './workflow-bridge';
import { DASHBOARD_STREAM } from './transport';

const log = createLogger('adapter.web.dashboard-poller');

/** Max rows per feed page; a drain keeps paging until the feed is exhausted. */
const PAGE_LIMIT = 500;
/** Escalate from warn → error after this many consecutive failed drains (a sustained outage). */
const FAILURE_ESCALATION_THRESHOLD = 5;

export type DashboardEventFeed = Pick<
  IWorkflowStore,
  'getWorkflowEventHead' | 'readWorkflowEventsAfter'
>;

/**
 * The narrow slice of `SSETransport` the poller needs — decouples it from the
 * concrete transport and removes the cast in tests.
 */
export interface DashboardTransport {
  hasActiveStream(conversationId: string): boolean;
  emitWorkflowEvent(conversationId: string, event: string): void;
}

export class DashboardEventPoller {
  private transport: DashboardTransport | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cursor: WorkflowEventCursor | null = null;
  private draining = false;
  private redrainRequested = false;
  private consecutiveFailures = 0;

  constructor(private readonly feed: DashboardEventFeed) {}

  /**
   * Begin polling from the feed's current head — history is never replayed.
   * `intervalMs` is the (SQLite) poll cadence / (Postgres) backstop.
   * A failed head read never fails startup: the first drain reads the head instead.
   */
  async start(transport: DashboardTransport, intervalMs: number): Promise<void> {
    if (this.intervalId) return;
    try {
      this.cursor = await this.feed.getWorkflowEventHead();
    } catch (err) {
      log.warn({ err }, 'dashboard_poller.start_head_failed');
    }
    this.transport = transport;
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

  /** Drain immediately (e.g. woken by a Postgres NOTIFY). Returns the drain promise. */
  drainNow(): Promise<void> {
    return this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.transport) return;
    // Coalesce: a drain already running absorbs this request (one follow-up pass),
    // so a burst of NOTIFYs collapses into a single trailing drain.
    if (this.draining) {
      this.redrainRequested = true;
      return;
    }

    this.draining = true;
    try {
      do {
        this.redrainRequested = false;
        await this.drainOnce();
      } while (this.redrainRequested);
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      // A sustained DB outage (vs a transient blip) escalates so it's alertable
      // instead of an indistinguishable warn every interval forever.
      if (this.consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD) {
        log.error(
          { err, consecutiveFailures: this.consecutiveFailures },
          'dashboard_poller.drain_failing_persistently'
        );
      } else {
        log.warn({ err }, 'dashboard_poller.drain_failed');
      }
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    if (this.cursor === null) {
      this.cursor = await this.feed.getWorkflowEventHead();
      return;
    }
    // With no dashboard client, keep the cursor at the head so a later-connecting
    // client streams only new events (its initial REST fetch already shows current
    // state — no need to replay the idle gap). The stream is checked again after the
    // head read: a client that connected during it drains from the old cursor, since
    // the head may already cover an event committed after that client connected.
    if (!transport.hasActiveStream(DASHBOARD_STREAM)) {
      const head = await this.feed.getWorkflowEventHead();
      if (!transport.hasActiveStream(DASHBOARD_STREAM)) {
        this.cursor = head;
        return;
      }
    }

    // `next` advances past rows the type filter dropped, so a page can be empty
    // while more events follow it: only a cursor that stops moving means exhausted.
    for (;;) {
      const page = await this.feed.readWorkflowEventsAfter(this.cursor, {
        limit: PAGE_LIMIT,
        eventTypes: DASHBOARD_SOURCE_EVENT_TYPES,
      });
      for (const { event } of page.events) {
        const sse = mapWorkflowEventRow(event);
        if (sse) transport.emitWorkflowEvent(DASHBOARD_STREAM, sse);
      }
      if (page.next === this.cursor) return;
      this.cursor = page.next;
    }
  }
}
