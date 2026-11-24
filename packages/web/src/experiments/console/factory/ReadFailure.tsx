import type { ReactElement, ReactNode } from 'react';

/**
 * A failed read on a Factory page: what could not be read and why (`children`), and a Retry
 * that reads it again, so a failure never dead-ends (owner change of 2026-11-19, point 5).
 * Whatever else the page drew stays drawn.
 */
export function ReadFailure({
  retry,
  children,
}: {
  retry: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 text-console-13 text-error [overflow-wrap:anywhere]">{children}</p>
      <button
        type="button"
        onClick={retry}
        className="rounded-md border border-border bg-surface px-2.5 py-1 text-console-13 text-text-primary transition-colors duration-150 ease-out hover:bg-surface-hover"
      >
        Retry
      </button>
    </div>
  );
}
