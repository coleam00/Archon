import { createLogger } from '@archon/paths';
import type { IWorkflowStore, WorkflowEventCursor, WorkflowEventPage } from './store';
import { WorkflowEventCursorError } from './store';
import type {
  WorkflowEventDoorbell,
  WorkflowRunDelivery,
  WorkflowRunSubscription,
  WorkflowRunSubscriptionOptions,
} from './engine-port';

// Only failures log, so the logger is not cached.
function getLog(): ReturnType<typeof createLogger> {
  return createLogger('workflow.subscription');
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const PAGE_LIMIT = 500;
/** Consecutive failed ticks after which a read failure logs as an error, as the dashboard poller does. */
const FAILURE_ESCALATION_THRESHOLD = 5;

export type RunSubscriptionStore = Pick<
  IWorkflowStore,
  'getWorkflowEventHead' | 'readWorkflowEventsAfter' | 'getRunAncestry'
>;

/**
 * Is `eventRunId` the subscribed run or one of its descendants? Walks up from the event's
 * run, so the cost is bounded by tree depth, not by how many sibling sub-runs exist.
 */
async function isRunInSubscriptionScope(
  eventRunId: string,
  targetRunId: string,
  getRunAncestry: RunSubscriptionStore['getRunAncestry']
): Promise<boolean> {
  if (eventRunId === targetRunId) return true;
  const ancestry = await getRunAncestry(eventRunId);
  return ancestry.some(ancestor => ancestor.id === targetRunId);
}

export type WorkflowEventFeedFollower = FeedFollower<WorkflowEventCursor>;

export interface WorkflowEventFeedFollowOptions {
  pollIntervalMs: number;
  /** Wakes a read early; polling continues whether or not it attaches. */
  doorbell?: WorkflowEventDoorbell;
  /** Called with each page before its deliveries are handled. */
  beginPage?: (page: WorkflowEventPage) => void;
  /** Called after each tick that read and handled every delivery up to the head. */
  onCaughtUp?: () => void;
  /** Called when a `WorkflowEventCursorError` stops the tail. */
  onStopped?: () => void;
  /** Fields every failure log carries, naming the follower. */
  logFields: Record<string, unknown>;
}

export interface FeedPage<C, D> {
  deliveries: readonly D[];
  next: C;
  caughtUp: boolean;
}

export interface FeedFollower<C> {
  /** The cursor after the last handled delivery. */
  cursor(): C;
  /** Stops polling and waits for in-flight work; `drain` reads to head once more. Idempotent. */
  close(options?: { drain?: boolean }): Promise<void>;
}

/**
 * Tail the store's commit-ordered feed from `start`, handing every delivery to `handle`
 * in order. The cursor advances only past a handled delivery, so a read or handler
 * failure retries from the last one handled. A `WorkflowEventCursorError` stops the tail:
 * a cursor the store did not issue never becomes readable.
 */
export async function followFeed<C, D extends { cursor: C }>(
  read: (cursor: C, limit: number) => Promise<FeedPage<C, D>>,
  start: C,
  handle: (delivery: D) => Promise<void>,
  options: Omit<WorkflowEventFeedFollowOptions, 'beginPage'> & {
    beginPage?: (page: FeedPage<C, D>) => void;
  }
): Promise<FeedFollower<C>> {
  let cursor = start;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let rang = false;
  let closing: Promise<void> | undefined;

  const drainToHead = async (stopOnClose = false): Promise<boolean> => {
    for (;;) {
      const page = await read(cursor, PAGE_LIMIT);
      options.beginPage?.(page);
      for (const delivery of page.deliveries) {
        await handle(delivery);
        // Advance per row so a tick that fails mid-page resumes after the last delivery.
        cursor = delivery.cursor;
      }
      cursor = page.next;
      if (page.caughtUp || (stopOnClose && closing !== undefined)) return page.caughtUp;
    }
  };

  const tick = async (): Promise<void> => {
    try {
      const caughtUp = await drainToHead(true);
      consecutiveFailures = 0;
      if (caughtUp) options.onCaughtUp?.();
    } catch (error) {
      consecutiveFailures += 1;
      const fields = { ...options.logFields, err: error as Error, consecutiveFailures };
      if (error instanceof WorkflowEventCursorError) {
        // Never becomes readable, so the tail stops; a draining close() reports it.
        getLog().error(fields, 'workflow.subscription_read_failed');
        options.onStopped?.();
        return;
      }
      if (consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD) {
        getLog().error(fields, 'workflow.subscription_read_failed');
      } else {
        getLog().warn(fields, 'workflow.subscription_read_failed');
      }
    }
    inFlight = undefined;
    schedule(rang ? 0 : options.pollIntervalMs);
    rang = false;
  };

  function schedule(delayMs: number): void {
    if (closing) return;
    timer = setTimeout(() => {
      inFlight = tick();
    }, delayMs);
  }

  let unsubscribeDoorbell: (() => void) | null | undefined;
  try {
    unsubscribeDoorbell = await options.doorbell?.(() => {
      if (closing) return;
      if (inFlight) {
        rang = true;
        return;
      }
      clearTimeout(timer);
      inFlight = tick();
    });
  } catch (error) {
    // The doorbell only reduces latency; polling alone still reaches every event.
    getLog().debug(
      { ...options.logFields, err: error as Error },
      'workflow.subscription_doorbell_unavailable'
    );
  }

  schedule(options.pollIntervalMs);

  return {
    cursor: () => cursor,
    close(closeOptions = {}): Promise<void> {
      closing ??= (async (): Promise<void> => {
        clearTimeout(timer);
        unsubscribeDoorbell?.();
        await inFlight;
        if (closeOptions.drain === true) await drainToHead();
      })();
      return closing;
    },
  };
}

export function followWorkflowEventFeed(
  store: Pick<IWorkflowStore, 'readWorkflowEventsAfter'>,
  start: WorkflowEventCursor,
  handle: (delivery: WorkflowRunDelivery) => Promise<void>,
  options: WorkflowEventFeedFollowOptions
): Promise<WorkflowEventFeedFollower> {
  return followFeed<WorkflowEventCursor, WorkflowRunDelivery>(
    async (cursor, limit) => {
      const page = await store.readWorkflowEventsAfter(cursor, { limit });
      return { next: page.next, deliveries: page.events, caughtUp: page.events.length < limit };
    },
    start,
    handle,
    {
      ...options,
      beginPage: page => options.beginPage?.({ events: page.deliveries, next: page.next }),
    }
  );
}

/**
 * Follow `runId` and every descendant run through the store's commit-ordered feed.
 * Resolves once the starting cursor is fixed, so a caller that awaits it before starting
 * the run cannot miss the run's first event.
 */
export async function subscribeToRunTree(
  store: RunSubscriptionStore,
  runId: string,
  listener: (delivery: WorkflowRunDelivery) => void,
  options: WorkflowRunSubscriptionOptions = {}
): Promise<WorkflowRunSubscription> {
  const start = options.after ?? (await store.getWorkflowEventHead());
  // A run's parent is fixed at creation, so one walk per run id serves the whole
  // subscription. A failed walk is never cached: it fails the tick, which is retried.
  const membership = new Map<string, boolean>();

  const isMember = async (eventRunId: string): Promise<boolean> => {
    const known = membership.get(eventRunId);
    if (known !== undefined) return known;
    const member = await isRunInSubscriptionScope(eventRunId, runId, id =>
      store.getRunAncestry(id)
    );
    membership.set(eventRunId, member);
    return member;
  };

  const follower = await followWorkflowEventFeed(
    store,
    start,
    async delivery => {
      if (!(await isMember(delivery.event.workflow_run_id))) return;
      try {
        listener(delivery);
      } catch (error) {
        getLog().warn(
          { err: error as Error, runId, eventId: delivery.event.id },
          'workflow.subscription_listener_failed'
        );
      }
    },
    { pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, logFields: { runId } }
  );

  return { close: () => follower.close({ drain: true }) };
}
