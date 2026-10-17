/**
 * Bounded-concurrency map with a sliding-window pool (#2121 slice 2, PR-C).
 *
 * Runs `fn` over `items` with at most `limit` invocations in flight at once, refilling
 * the window as each task settles (a sliding window — NOT fixed batches). Results are
 * returned in INPUT ORDER regardless of settle order, each wrapped as a
 * `PromiseSettledResult` so one rejection never aborts the rest (error isolation,
 * `Promise.allSettled` semantics).
 *
 * Pure and dependency-free: the fan-out executor uses it to bound how many child
 * sub-runs execute concurrently (the top-level DAG layer loop is an UNBOUNDED
 * `Promise.allSettled` — a fan-out over a runtime-length list must NOT inherit that,
 * or an author could spawn a runaway N-wide layer, #1961).
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  if (items.length === 0) return results;

  // Clamp: at least one worker, never more workers than items. A non-finite/<=0
  // `limit` is coerced to serial rather than throwing — a bad cap must not crash a run.
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));

  await runPool(items, workerCount, fn, results, () => false);
  return results;
}

/**
 * Like {@link mapWithLimit}, but a worker whose fulfilled value satisfies `holdsSlot`
 * keeps its slot and claims no further item. The fan-out executor uses it so a paused
 * child keeps its `max_parallel` slot (#4044): a paused child is unfinished work that
 * may hold edits in a shared checkout, so the next item must not start beside it.
 *
 * Indices no worker claimed stay `undefined`. `slots <= 0` starts no worker.
 */
export async function mapWithHeldSlots<T, R>(
  items: readonly T[],
  slots: number,
  fn: (item: T, index: number) => Promise<R>,
  holdsSlot: (value: R) => boolean
): Promise<(PromiseSettledResult<R> | undefined)[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(items.length).fill(undefined);
  const workerCount = Math.max(0, Math.min(Math.floor(slots) || 0, items.length));
  await runPool(items, workerCount, fn, results, holdsSlot);
  return results;
}

async function runPool<T, R>(
  items: readonly T[],
  workerCount: number,
  fn: (item: T, index: number) => Promise<R>,
  results: (PromiseSettledResult<R> | undefined)[],
  holdsSlot: (value: R) => boolean
): Promise<void> {
  // Shared cursor. `cursor++` is atomic in JS's single-threaded model (no await
  // between the read and the increment), so no two workers ever claim the same index.
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const value = await fn(items[index], index);
        results[index] = { status: 'fulfilled', value };
        if (holdsSlot(value)) return;
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
