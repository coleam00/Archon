import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { askReadOf } from '../factory/lib/item-asks';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import type { Project } from '../primitives/project';
import { useItemAsks } from './ItemAsksSection';

type ProjectView = 'runs' | 'overview' | 'board' | 'needs-you' | 'chat' | 'metrics';

interface ProjectViewTabsProps {
  projectId: string;
  active: ProjectView;
}

const TABS: readonly { key: ProjectView; label: string; suffix: string }[] = [
  { key: 'needs-you', label: 'Needs you', suffix: '/needs-you' },
  { key: 'runs', label: 'Runs', suffix: '' },
  { key: 'overview', label: 'Overview', suffix: '/overview' },
  { key: 'board', label: 'Board', suffix: '/board' },
  { key: 'chat', label: 'Chat', suffix: '/chat' },
  { key: 'metrics', label: 'Metrics', suffix: '/metrics' },
];

/**
 * Needs you | Runs | Overview | Board | Chat | Metrics tab control under a project. Active styling mirrors
 * FilterChips (brand-bar underline). Only meaningful when a project is scoped —
 * chat is project-scoped, so this is never rendered on the All-projects view.
 *
 * Overview and Board are listed only for a project with an item on a pack stage. That comes with the
 * project list the rail already holds, so a project without one costs no request.
 *
 * The Needs you badge counts the project's open asks by `askReadOf`, the rule the Board and the
 * Overview read them by, and shows "?" when they could not be read, so a failed read never looks
 * like none (#263).
 */
export function ProjectViewTabs({ projectId, active }: ProjectViewTabsProps): ReactElement {
  const { data: projects } = useEntity<Project[]>(K.projects, () => skill.listProjects());
  const { data: attention, error: attentionError } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const asks = askReadOf(attention, attentionError, useItemAsks(attention, projectId));
  const openAsks = typeof asks === 'string' ? 0 : asks.asks.length;
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
              {key === 'needs-you' && asks === 'failed' && attentionError !== undefined ? (
                <span
                  data-needs-count
                  className="ml-1 text-text-tertiary"
                  title={`The asks could not be read: ${attentionError.message}`}
                >
                  ?
                </span>
              ) : null}
              {key === 'needs-you' && openAsks > 0 ? (
                <span data-needs-count className="ml-1 text-warning">
                  {String(openAsks)}
                </span>
              ) : null}
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
