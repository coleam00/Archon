import { useEffect, useRef } from 'react';
import { useEntity, type EntityView } from '../store/cache';
import { deadlineOf, nextDeadlineMs, SlowReadError, type WithinDeadline } from './lib/deadline';

/** The wait before the first retry of a read that missed its deadline, doubling to the cap. */
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 15_000;

/**
 * A Factory read, kept in the cache under `key`, whose requests each run under a deadline
 * (`read` passes them through `within`), and which retries itself after a miss.
 *
 * - The first attempt gets `FACTORY_READ_DEADLINE_MS`; a retry gets twice the deadline it
 *   missed, so a read that is slow but healthy still lands. The last miss is read at load
 *   time, from the render that showed it: a retry or an invalidation loads after that render.
 * - The retry lives here rather than in what draws the read, so every reader is retried,
 *   including one that shows nothing while it waits (the project tabs' Factory entry,
 *   Answered lately). `FactoryLoading` only says so.
 */
export function useFactoryRead<T>(
  key: string,
  read: (within: WithinDeadline) => Promise<T>
): EntityView<T> {
  const lastError = useRef<Error | undefined>(undefined);
  const view = useEntity<T>(key, () => read(deadlineOf(nextDeadlineMs(lastError.current))));
  lastError.current = view.error;
  useRetryWhenSlow(view);
  return view;
}

/**
 * Reload `view` while it fails by missing its deadline, waiting longer each time. Keyed on
 * the error itself: each failed attempt is a new error, so one failure schedules one retry
 * however often the page renders, and `claimRetry` makes it one between every reader of the
 * key (the Overview's numbers, map and lists all read the items).
 */
function useRetryWhenSlow(view: Pick<EntityView<unknown>, 'error' | 'refetch'>): void {
  const slow = view.error instanceof SlowReadError ? view.error : undefined;
  const refetch = useRef(view.refetch);
  refetch.current = view.refetch;
  const attempts = useRef(0);
  useEffect(() => {
    if (slow === undefined) {
      attempts.current = 0;
      return;
    }
    const wait = Math.min(RETRY_FIRST_MS * 2 ** attempts.current, RETRY_MAX_MS);
    attempts.current += 1;
    const timer = setTimeout(() => {
      if (slow.claimRetry()) refetch.current();
    }, wait);
    return (): void => {
      clearTimeout(timer);
    };
  }, [slow]);
}
