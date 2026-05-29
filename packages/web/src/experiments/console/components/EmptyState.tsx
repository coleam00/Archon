import type { ReactElement, ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** Minimal empty state — one sentence + optional single button. No illustrations. */
export function EmptyState({ title, hint, action }: EmptyStateProps): ReactElement {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-text-secondary">{title}</p>
      {hint !== undefined ? <p className="text-xs text-text-tertiary">{hint}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
