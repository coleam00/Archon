/**
 * Overdue waits as attention queue items: the sets of waits completed runs left on their
 * items (`returns.waits`, see `schemas/item-wait.ts`) that are still open past a deadline.
 * A deadline raises attention and wakes nothing; the set stays open until an event meets it,
 * a newer run of its workflow replaces it, or it is withdrawn by its `wait:` ref.
 */
import {
  projectRef,
  runProject,
  waitItemRef,
  type AttentionQueueItemWithoutRun,
  type CodebaseCache,
  type OverdueWaitQueueItem,
} from './attention-queue';
import type { StoredItemWait } from './schemas/item-wait';
import { stateProjectKeySchema } from './state-document-store';
import type { IWorkflowStore } from './store';

/** The store reads an overdue wait's queue item needs. */
export type WaitItemStore = Pick<
  IWorkflowStore,
  'listOpenItemWaits' | 'getItem' | 'getWorkflowRun' | 'getCodebase'
>;

/**
 * The queue item a set of open waits is, held by no run, with its project found as an
 * ask's is. Built for any open set; the queue lists only the overdue ones.
 */
export async function waitQueueItem(
  store: Omit<WaitItemStore, 'listOpenItemWaits'>,
  set: readonly [StoredItemWait, ...StoredItemWait[]],
  codebases: CodebaseCache = new Map()
): Promise<OverdueWaitQueueItem> {
  const [first] = set;
  const item = await store.getItem(first.itemId);
  const run = await store.getWorkflowRun(first.runId);
  const project =
    run !== null
      ? await runProject({ store }, run, codebases)
      : item !== null && stateProjectKeySchema.safeParse(item.projectKey).success
        ? projectRef(item.projectKey, null)
        : null;
  return {
    kind: 'overdue_wait',
    ref: waitItemRef(first.runId),
    project,
    ...(item === null ? {} : { item }),
    revision: 1,
    labels: {},
    pausedAt: first.openedAt,
    waitingIn: { runId: first.runId, workflow: first.workflowName },
    waits: set.map(({ event, about }) => ({ event, about })),
    deadline: set.map(wait => wait.deadlineAt).sort()[0] ?? first.deadlineAt,
  };
}

/** The open waits as sets, one per run that left them, in the store's order. */
export function waitSets(
  waits: readonly StoredItemWait[]
): [StoredItemWait, ...StoredItemWait[]][] {
  const sets = new Map<string, [StoredItemWait, ...StoredItemWait[]]>();
  for (const wait of waits) {
    const set = sets.get(wait.runId);
    if (set === undefined) sets.set(wait.runId, [wait]);
    else set.push(wait);
  }
  return [...sets.values()];
}

/**
 * The sets of open waits past their deadline at `now`, as queue items, for
 * `AttentionQueueSource.itemsWithoutRun`. A wait's deadline raises attention and wakes
 * nothing: the set stays open, and a later event still meets it.
 */
export async function overdueWaitItems(
  store: WaitItemStore,
  now: Date = new Date()
): Promise<AttentionQueueItemWithoutRun[]> {
  const codebases: CodebaseCache = new Map();
  const items: AttentionQueueItemWithoutRun[] = [];
  for (const set of waitSets(await store.listOpenItemWaits()))
    if (set.some(wait => Date.parse(wait.deadlineAt) <= now.getTime()))
      items.push(await waitQueueItem(store, set, codebases));
  return items;
}
