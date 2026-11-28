/**
 * Whether a run that needs an owner to move has one: what the attention queue observes
 * before it lists a run as `owner_lost`. Observing never changes a run.
 */
import type { AttentionRead } from './schemas/attention-degraded';
import type { AwaitingExecution } from './schemas/start-executor';
import type { WorkflowRun } from './schemas/workflow-run';
import type { RunOwnerObservation } from './schemas/workflow-run-listing';

/**
 * The runs that need an owner to move (`IWorkflowStore.listUnfinishedRuns`), what this
 * process observes about a running or paused run's execution owner, and about a pending
 * admitted start's executor (`awaitingExecution`; without it no pending run is listed).
 * A run the store cannot read is reported `run_unreadable`.
 */
export interface OwnerObserver {
  runs(): Promise<AttentionRead<WorkflowRun>[]>;
  observe(run: WorkflowRun): Promise<RunOwnerObservation | null>;
  awaitingExecution?(run: WorkflowRun): Promise<AwaitingExecution | null>;
}

/** What proves a run's owner gone; `start` is set for a pending start no process runs. */
export interface LostOwner {
  start?: { requestId: string; hostId: string };
}

/**
 * How long one owner observation may take before it reads as `unknown`, and how many run at
 * once. A dead owner on this host answers at once (no endpoint); a live one answers within
 * the endpoint's own IPC timeout, twice at most. A busy machine can make a live owner slow,
 * and slow must never read as gone, so an observation past the deadline lists nothing.
 */
export const OWNER_OBSERVATION_DEADLINE_MS = 5_000;
export const OWNER_OBSERVATION_CONCURRENCY = 8;

/** What a settled `withinDeadline` returns when the deadline passed first. */
const EXPIRED = Symbol('expired');

/** `observation`, or `EXPIRED` once `OWNER_OBSERVATION_DEADLINE_MS` passes first. */
async function withinDeadline<T>(observation: Promise<T>): Promise<T | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof EXPIRED>(resolve => {
    timer = setTimeout(() => resolve(EXPIRED), OWNER_OBSERVATION_DEADLINE_MS);
  });
  try {
    return await Promise.race([observation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What proves `run`'s owner gone, or null when nothing does: its owner is reachable or
 * unknown, it needs no owner now, or the observation ran past its deadline.
 */
async function lostOwner(observer: OwnerObserver, run: WorkflowRun): Promise<LostOwner | null> {
  if (run.status === 'pending') {
    const before = await withinDeadline(observer.awaitingExecution?.(run) ?? Promise.resolve(null));
    const awaiting = before === EXPIRED ? null : before;
    return awaiting?.state === 'unowned'
      ? { start: { requestId: awaiting.requestId, hostId: awaiting.hostId } }
      : null;
  }
  const observed = await withinDeadline(observer.observe(run));
  return observed === 'unreachable' ? {} : null;
}

/**
 * What this process observes about the owner of each of `runs`, in their order, by the one
 * rule attention, `workflow wait` and `workflow resume` share: `reachable`, `unreachable` or
 * `unknown`; null only where the run needs no owner now. An observation that ran past its
 * deadline reads `unknown`, like one that could not be made.
 */
export function observeRunOwners(
  observer: OwnerObserver,
  runs: readonly WorkflowRun[]
): Promise<(RunOwnerObservation | null)[]> {
  return observeEach(runs, async run => {
    const observed = await withinDeadline(observer.observe(run));
    return observed === EXPIRED ? 'unknown' : observed;
  });
}

/**
 * The lost owner of each of `runs`, in their order; null where nothing proves the owner gone.
 */
export async function observeLostOwners(
  observer: OwnerObserver,
  runs: readonly WorkflowRun[]
): Promise<(LostOwner | null)[]> {
  return observeEach(runs, run => lostOwner(observer, run));
}

/** `observeOne` over `runs`, in their order, `OWNER_OBSERVATION_CONCURRENCY` at a time. */
async function observeEach<T>(
  runs: readonly WorkflowRun[],
  observeOne: (run: WorkflowRun) => Promise<T>
): Promise<T[]> {
  const found: T[] = new Array<T>(runs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < runs.length; index = next++) {
      const run = runs[index];
      if (run !== undefined) found[index] = await observeOne(run);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(OWNER_OBSERVATION_CONCURRENCY, runs.length) }, worker)
  );
  return found;
}
