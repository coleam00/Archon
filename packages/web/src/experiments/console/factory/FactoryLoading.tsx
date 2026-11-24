import type { ReactElement, ReactNode } from 'react';
import type { EntityView } from '../store/cache';
import { SlowReadError } from './lib/deadline';

/** What a Factory page says while a read that missed its deadline is retried. */
export const SLOW_READ_NOTICE = 'This is taking longer than usual. Trying again…';

/**
 * What a Factory page shows while a read has no data yet: `children`, the skeleton of the
 * final layout (Visual standard, rule 6), and above it, while the read is retried after
 * missing its deadline (`useFactoryRead` retries it), a notice saying so, so a skeleton never
 * pulses on with no word. Any other failure is the page's own to show.
 */
export function FactoryLoading({
  read,
  children,
}: {
  read: Pick<EntityView<unknown>, 'error'>;
  children?: ReactNode;
}): ReactElement {
  return (
    <>
      {read.error instanceof SlowReadError ? (
        <p role="status" className="text-console-13 text-text-tertiary">
          {SLOW_READ_NOTICE}
        </p>
      ) : null}
      {children}
    </>
  );
}
