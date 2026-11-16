/**
 * Wait until a run on one item needs someone.
 *
 * Each run is watched by `waitForRunAttention`, so a run reports exactly what
 * `workflow wait <run-id>` reports for it. This service only decides which runs to watch
 * and when to stop; it never mutates a run and never chooses between runs.
 */
import {
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import {
  DEFAULT_ATTENTION_POLL_INTERVAL_MS,
  waitForRunAttention,
  type RunAttentionReadStore,
  type RunAttentionWaitOptions,
  type RunWaitResult,
  type UnknownOwnerLiveness,
} from './run-attention-watch';

export interface ItemAttentionWaitOptions
  extends Pick<RunAttentionWaitOptions, 'doorbell' | 'deadlineMs' | 'pollIntervalMs'> {
  /** Called once per watched run, after its watches are attached. */
  onAttached?: (
    runId: string,
    observedStatus: WorkflowRunStatus,
    ownerLiveness?: UnknownOwnerLiveness
  ) => void | Promise<void>;
}

export type ItemRunWaitResult = Exclude<RunWaitResult, { kind: 'aborted' }>;

export interface ItemRunWait {
  runId: string;
  result: ItemRunWaitResult;
}

/**
 * Watch every run on the item that is not terminal in `initial` (the item's runs at call
 * time, start order), and every run that first appears in `reread` while waiting, in
 * whatever state it is first seen. A run already terminal at call time is history and
 * never ends the wait.
 *
 * The first run that needs attention, ends, loses its owner or disappears stops the
 * others. Every result is returned, in the order the runs were first seen, so runs that
 * settle together are all reported. At the deadline, each watched run reports `deadline`.
 * A `reread` failure stops every watch and is thrown.
 */
export async function waitForItemAttention(
  store: RunAttentionReadStore,
  initial: readonly WorkflowRun[],
  reread: () => Promise<readonly WorkflowRun[]>,
  opts: ItemAttentionWaitOptions = {}
): Promise<ItemRunWait[]> {
  const deadlineAt = opts.deadlineMs === undefined ? undefined : Date.now() + opts.deadlineMs;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_ATTENTION_POLL_INTERVAL_MS;
  const stop = new AbortController();
  const seen = new Set(initial.map(run => run.id));
  const watches: Promise<Watched>[] = [];
  const watch = (runId: string): void => {
    watches.push(watchRun(store, runId, stop, { ...opts, pollIntervalMs }, deadlineAt));
  };

  for (const run of initial) if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status)) watch(run.id);
  try {
    while (await nextPoll(stop.signal, pollIntervalMs, deadlineAt)) {
      for (const run of await reread()) {
        if (seen.has(run.id)) continue;
        seen.add(run.id);
        watch(run.id);
      }
    }
  } catch (error) {
    stop.abort();
    await Promise.all(watches);
    throw error;
  }
  return reported(await Promise.all(watches));
}

/** A watch settles to a value, never a rejection, so no failure goes unhandled meanwhile. */
type Watched = { runId: string; result: RunWaitResult } | { error: unknown };

/** Watch one run; a result other than a deadline, or a failure, stops every other watch. */
async function watchRun(
  store: RunAttentionReadStore,
  runId: string,
  stop: AbortController,
  opts: ItemAttentionWaitOptions & { pollIntervalMs: number },
  deadlineAt: number | undefined
): Promise<Watched> {
  try {
    const result = await waitForRunAttention(store, runId, {
      doorbell: opts.doorbell,
      signal: stop.signal,
      pollIntervalMs: opts.pollIntervalMs,
      ...(deadlineAt === undefined ? {} : { deadlineMs: Math.max(0, deadlineAt - Date.now()) }),
      onAttached: (status, liveness) => opts.onAttached?.(runId, status, liveness),
    });
    if (result.kind !== 'deadline' && result.kind !== 'aborted') stop.abort();
    return { runId, result };
  } catch (error) {
    stop.abort();
    return { error };
  }
}

/** Every watched run's result except the stopped ones; a failed watch is thrown. */
function reported(watched: readonly Watched[]): ItemRunWait[] {
  const results: ItemRunWait[] = [];
  for (const outcome of watched) {
    if ('error' in outcome) throw outcome.error;
    if (outcome.result.kind !== 'aborted')
      results.push({ runId: outcome.runId, result: outcome.result });
  }
  return results;
}

/** Sleep one poll interval; false once stopped or past the deadline. */
async function nextPoll(
  signal: AbortSignal,
  pollIntervalMs: number,
  deadlineAt: number | undefined
): Promise<boolean> {
  if (signal.aborted) return false;
  const delay =
    deadlineAt === undefined ? pollIntervalMs : Math.min(pollIntervalMs, deadlineAt - Date.now());
  if (delay <= 0) return false;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, delay);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
  return !signal.aborted && (deadlineAt === undefined || Date.now() < deadlineAt);
}
