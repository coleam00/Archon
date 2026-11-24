import { useRef, useState } from 'react';
import type { EntityView } from '../store/cache';
import { readFailed } from './lib/deadline';

/** A read's failure to show, and a Retry that reads it again. */
export interface ReadRetry {
  /** The failure to show, or undefined while there is none to show (loading, or a held old one). */
  failed: Error | undefined;
  retry: () => void;
}

/**
 * A Retry that visibly retries. The cache keeps a read's error until a load succeeds, after its
 * last reader leaves too, and a reader that comes back loads again with that error still held.
 * So the error held when this reader mounted, or when Retry was pressed, is dismissed: only a
 * failure of a load this reader waited on shows, and while a retry is in flight the page shows
 * its loading shape rather than the old failure. (`loading` cannot tell them apart: it still
 * reads true on the render that brings the error.) A missed deadline is not a failure here
 * (`readFailed`): `FactoryLoading` says so while `useFactoryRead` retries it.
 *
 * Call it in a reader that mounts with the page. Mounting with the page, the page's own mount
 * loads the read again, so an error held then is an earlier visit's. A reader that mounts later,
 * after a read the page already waited on failed, would dismiss that fresh failure, and nothing
 * loads it again.
 */
export function useReadRetry(read: EntityView<unknown>): ReadRetry {
  const dismissed = useRef(read.error);
  const [, rerender] = useState(0);
  const failed = readFailed(read.error);
  return {
    failed: failed === dismissed.current ? undefined : failed,
    retry: (): void => {
      dismissed.current = read.error;
      rerender(count => count + 1);
      read.refetch();
    },
  };
}
