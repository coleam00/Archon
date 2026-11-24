import type { ReactElement, ReactNode } from 'react';

interface ProjectHeaderProps {
  title: ReactNode;
  /** One line under the title (a path, a window status); cut to one line, never wrapped. */
  subtitle: ReactNode;
  /** The page's control beside the title, such as a search box. */
  aside?: ReactNode;
  /** Under the title row: the project's tabs, or what stands in for them. */
  children?: ReactNode;
}

/**
 * The header of every project page (Runs, Chat, Metrics, Factory). One shape so the tab row
 * sits at the same height on each: the title row centres its control rather than aligning
 * baselines with it, and keeps at least the height of the tallest control (Runs' search box),
 * and the subtitle never wraps.
 */
export function ProjectHeader({
  title,
  subtitle,
  aside,
  children,
}: ProjectHeaderProps): ReactElement {
  return (
    <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
      <div className="flex min-h-9.5 items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-text-primary">{title}</h1>
          <div className="truncate text-xs text-text-tertiary">{subtitle}</div>
        </div>
        {aside}
      </div>
      {children}
    </header>
  );
}
