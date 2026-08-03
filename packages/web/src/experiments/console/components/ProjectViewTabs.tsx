import type { ReactElement } from 'react';
import { Link } from 'react-router';

interface ProjectViewTabsProps {
  projectId: string;
  active: 'runs' | 'chat';
}

const TABS: readonly { key: 'runs' | 'chat'; label: string; suffix: string }[] = [
  { key: 'runs', label: 'Runs', suffix: '' },
  { key: 'chat', label: 'Chat', suffix: '/chat' },
];

/**
 * Runs | Chat tab control under a project. Active styling mirrors FilterChips
 * (brand-bar underline). Only meaningful when a project is scoped — chat is
 * project-scoped, so this is never rendered on the All-projects view.
 */
export function ProjectViewTabs({ projectId, active }: ProjectViewTabsProps): ReactElement {
  return (
    <div className="flex items-center gap-1">
      {TABS.map(({ key, label, suffix }) => {
        const isActive = key === active;
        return (
          <Link
            key={key}
            to={`/console/p/${projectId}${suffix}`}
            aria-current={isActive ? 'page' : undefined}
            className={`relative rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors ${
              isActive
                ? 'bg-surface-elevated text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            {label}
            {isActive ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full"
              />
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
