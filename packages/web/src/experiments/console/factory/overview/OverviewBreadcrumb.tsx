import type { ReactElement } from 'react';
import type { TrailStep } from '../lib/overview-nav';

/** Where the open view sits: each view above it a link back up, the open one plain. */
export function OverviewBreadcrumb({
  trail,
  onOpen,
}: {
  trail: readonly TrailStep[];
  onOpen: (view: string) => void;
}): ReactElement {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-console-15">
        {trail.map((step, index) => (
          <li key={step.id} className="flex items-center gap-1.5">
            {index === 0 ? null : (
              <span aria-hidden="true" className="text-text-tertiary">
                ›
              </span>
            )}
            {index === trail.length - 1 ? (
              <span aria-current="page" className="font-medium text-text-primary">
                {step.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onOpen(step.id)}
                className="text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
              >
                {step.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
