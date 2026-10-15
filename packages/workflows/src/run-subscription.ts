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

/** A position in the feed and a stop; what both the run-tree tail and the attention watch hold. */
export interface WorkflowEventFeedFollower {
  /** The cursor after the last handled delivery. */
  cursor(): WorkflowEventCursor;
  /** Stops polling and waits for an in-flight read; with `drain`, reads to the head once more. Idempotent. */
  close(options?: { drain?: boolean }): Promise<void>;
}

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

/**
 * Tail the store's commit-ordered feed from `start`, handing every delivery to `handle`
 * in order. The cursor advances only past a handled delivery, so a read or handler
 * failure retries from the last one handled. A `WorkflowEventCursorError` stops the tail:
 * a cursor the store did not issue never becomes readable.
 */
export async function followWorkflowEventFeed(
  store: Pick<IWorkflowStore, 'readWorkflowEventsAfter'>,
  start: WorkflowEventCursor,
  handle: (delivery: WorkflowRunDelivery) => Promise<void>,
  options: WorkflowEventFeedFollowOptions
): Promise<WorkflowEventFeedFollower> {
  let cursor = start;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let rang = false;
  let closing: Promise<void> | undefined;

  const drainToHead = async (): Promise<void> => {
    for (;;) {
      const page = await store.readWorkflowEventsAfter(cursor, { limit: PAGE_LIMIT });
      options.beginPage?.(page);
      for (const delivery of page.events) {
        await handle(delivery);
        // Advance per row so a tick that fails mid-page resumes after the last delivery.
        cursor = delivery.cursor;
      }
      cursor = page.next;
      if (page.events.length < PAGE_LIMIT) return;
    }
  };

  const tick = async (): Promise<void> => {
    try {
      await drainToHead();
      consecutiveFailures = 0;
      options.onCaughtUp?.();
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
