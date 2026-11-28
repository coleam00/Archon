import type { ReactElement } from 'react';
import { Link, type To } from 'react-router';

/** One segment: a link (a view kept in the URL) or a button (state kept on the page). */
export type Segment =
  | { key: string; label: string; to: To }
  | { key: string; label: string; onSelect: () => void };

/**
 * A choice between two or more views of one thing, as one bordered group: the board's
 * Pipeline | Table. The active segment is raised.
 */
export function SegmentedControl({
  label,
  segments,
  active,
}: {
  /** What the choice is about, for a screen reader. */
  label: string;
  segments: readonly Segment[];
  active: string;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
    >
      {segments.map(segment => {
        const on = segment.key === active;
        const className = `rounded px-2.5 py-1 text-console-13 transition-colors duration-150 ease-out ${
          on
            ? 'bg-surface-elevated font-medium text-text-primary'
            : 'text-text-tertiary hover:text-text-primary'
        }`;
        return 'to' in segment ? (
          <Link
            key={segment.key}
            to={segment.to}
            aria-current={on ? 'page' : undefined}
            className={className}
          >
            {segment.label}
          </Link>
        ) : (
          <button
            key={segment.key}
            type="button"
            aria-pressed={on}
            onClick={segment.onSelect}
            className={className}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
