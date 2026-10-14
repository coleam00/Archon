import { createLogger } from '@archon/paths';
import type { IWorkflowStore, WorkflowEventCursor } from './store';
import { WorkflowEventCursorError } from './store';
import type {
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
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let cursor: WorkflowEventCursor = options.after ?? (await store.getWorkflowEventHead());
  // A run's parent is fixed at creation, so one walk per run id serves the whole
  // subscription. A failed walk is never cached: it fails the tick, which is retried.
  const membership = new Map<string, boolean>();
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;

  const isMember = async (eventRunId: string): Promise<boolean> => {
    const known = membership.get(eventRunId);
    if (known !== undefined) return known;
    const member = await isRunInSubscriptionScope(eventRunId, runId, id =>
      store.getRunAncestry(id)
    );
    membership.set(eventRunId, member);
    return member;
  };

  const drainToHead = async (): Promise<void> => {
    for (;;) {
      const page = await store.readWorkflowEventsAfter(cursor, { limit: PAGE_LIMIT });
      for (const delivery of page.events) {
        if (await isMember(delivery.event.workflow_run_id)) {
          try {
            listener(delivery);
          } catch (error) {
            getLog().warn(
              { err: error as Error, runId, eventId: delivery.event.id },
              'workflow.subscription_listener_failed'
            );
          }
        }
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
    } catch (error) {
      consecutiveFailures += 1;
      const fields = { err: error as Error, runId, consecutiveFailures };
      if (error instanceof WorkflowEventCursorError) {
        // A cursor this store did not issue never becomes readable; close() reports it.
        getLog().error(fields, 'workflow.subscription_read_failed');
        return;
      }
      if (consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD) {
        getLog().error(fields, 'workflow.subscription_read_failed');
      } else {
        getLog().warn(fields, 'workflow.subscription_read_failed');
      }
    }
    schedule();
  };

  function schedule(): void {
    if (closing) return;
    timer = setTimeout(() => {
      inFlight = tick();
    }, pollIntervalMs);
  }

  schedule();

  return {
    close(): Promise<void> {
      closing ??= (async (): Promise<void> => {
        clearTimeout(timer);
        await inFlight;
        await drainToHead();
      })();
      return closing;
    },
  };
}
