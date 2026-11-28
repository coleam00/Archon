import type { ReactElement } from 'react';
import { ensureUtc, formatDateTime, relativeTime } from '../lib/format';
import { useNow } from '../lib/use-now';

/** How long ago a run started or ended; the full local time is the hover text. */
export function RelativeRunTime({
  at,
  verb,
  className,
}: {
  at: string;
  verb: 'Started' | 'Ended';
  className: string;
}): ReactElement {
  const now = useNow(30_000);
  return (
    <time className={className} dateTime={ensureUtc(at)} title={`${verb} ${formatDateTime(at)}`}>
      {relativeTime(at, now)}
    </time>
  );
}
