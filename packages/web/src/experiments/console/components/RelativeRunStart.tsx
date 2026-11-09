import { useEffect, useState, type ReactElement } from 'react';
import { ensureUtc, formatDateTime, relativeTime } from '../lib/format';

export function RelativeRunStart({
  startedAt,
  className,
}: {
  startedAt: string;
  className: string;
}): ReactElement {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 30_000);
    return (): void => clearInterval(timer);
  }, []);

  return (
    <time
      className={className}
      dateTime={ensureUtc(startedAt)}
      title={`Started ${formatDateTime(startedAt)}`}
    >
      {relativeTime(startedAt)}
    </time>
  );
}
