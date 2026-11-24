import type { ReactElement } from 'react';
import { Link } from 'react-router';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import type { Project } from '../primitives/project';

type ProjectView = 'runs' | 'overview' | 'board' | 'chat' | 'metrics';

interface ProjectViewTabsProps {
  projectId: string;
  active: ProjectView;
}

const TABS: readonly { key: ProjectView; label: string; suffix: string }[] = [
  { key: 'runs', label: 'Runs', suffix: '' },
  { key: 'overview', label: 'Overview', suffix: '/overview' },
  { key: 'board', label: 'Board', suffix: '/board' },
  { key: 'chat', label: 'Chat', suffix: '/chat' },
  { key: 'metrics', label: 'Metrics', suffix: '/metrics' },
];

/**
 * Runs | Overview | Board | Chat | Metrics tab control under a project. Active styling mirrors
 * FilterChips (brand-bar underline). Only meaningful when a project is scoped —
 * chat is project-scoped, so this is never rendered on the All-projects view.
 *
 * Overview and Board are listed only for a project with an item on a pack stage. That comes with the
 * project list the rail already holds, so a project without one costs no request.
 */
export function ProjectViewTabs({ projectId, active }: ProjectViewTabsProps): ReactElement {
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const hasBoard = (projects?.find(project => project.id === projectId)?.itemPacks.length ?? 0) > 0;
  return (
    <div className="flex items-center gap-1">
      {TABS.filter(tab => (tab.key !== 'board' && tab.key !== 'overview') || hasBoard).map(
        ({ key, label, suffix }) => {
          const isActive = key === active;
          return (
            <Link
              key={key}
              to={`/console/p/${projectId}${suffix}`}
              aria-current={isActive ? 'page' : undefined}
              className={`relative rounded px-2 py-1 text-console-11 font-medium uppercase tracking-wider transition-colors ${
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
        }
      )}
    </div>
  );
}
