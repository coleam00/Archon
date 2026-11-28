import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { askReadOf } from '../factory/lib/item-asks';
import { forgeOverview, useProjectForge } from '../lib/project-forge';
import * as skill from '../skills';
import type { ProjectForge } from '../skills/forge';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import type { Project } from '../primitives/project';
import { ForgeIcon } from './ForgeIcon';
import { useItemAsks } from './ItemAsksSection';

type ProjectView = 'runs' | 'overview' | 'board' | 'needs-you' | 'chat' | 'metrics' | 'forge';

interface ProjectViewTabsProps {
  projectId: string;
  active: ProjectView;
}

interface Tab {
  key: ProjectView;
  label: ReactNode;
  suffix: string;
}

const TABS: readonly Tab[] = [
  { key: 'needs-you', label: 'Needs you', suffix: '/needs-you' },
  { key: 'runs', label: 'Runs', suffix: '' },
  { key: 'overview', label: 'Overview', suffix: '/overview' },
  { key: 'board', label: 'Board', suffix: '/board' },
  { key: 'chat', label: 'Chat', suffix: '/chat' },
  { key: 'metrics', label: 'Metrics', suffix: '/metrics' },
];

/** Open issues plus open pull requests, of whichever the forge reports; none when neither. */
function openCount(forge: ProjectForge): number | undefined {
  const stats = forgeOverview(forge)?.stats;
  const counts = [stats?.issues_open, stats?.prs_open].flatMap(stat => stat?.count ?? []);
  return counts.length === 0 ? undefined : counts.reduce((sum, count) => sum + count, 0);
}

/**
 * The tab named after the project's forge. A project with no forge has none; until the
 * forge is known, only the forge page itself shows the tab it is on.
 */
function forgeTab(forge: ProjectForge | undefined, active: ProjectView): Tab[] {
  if (forge === undefined ? active !== 'forge' : forge.kind === 'none') return [];
  const named = forge?.kind === 'forge' ? forge.forge : undefined;
  const count = forge === undefined ? undefined : openCount(forge);
  return [
    {
      key: 'forge',
      suffix: '/forge',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <ForgeIcon icon={named?.icon} />
          {named?.name ?? 'Forge'}
          {count === undefined ? null : (
            <span
              title="Open issues and pull/merge requests"
              className="rounded-full bg-surface-bright px-1.5 font-mono text-console-10 text-text-secondary"
            >
              {count.toLocaleString('en-US')}
            </span>
          )}
        </span>
      ),
    },
  ];
}

/** The repository on its forge: icon, name and default branch, linking to its page. */
function RepoLink({ forge }: { forge: ProjectForge | undefined }): ReactElement | null {
  if (forge?.kind !== 'forge') return null;
  const overview = forgeOverview(forge);
  const className = 'inline-flex min-w-0 items-center gap-1.5 font-mono text-console-12';
  if (overview === undefined)
    return (
      <span className={`${className} text-text-tertiary`}>
        <ForgeIcon icon={forge.forge.icon} />
        <span className="truncate">{`${forge.repo.host}/${forge.repo.path}`}</span>
      </span>
    );
  return (
    <a
      href={overview.url}
      target="_blank"
      rel="noreferrer"
      title={`Open on ${forge.forge.name}`}
      className={`${className} text-text-secondary hover:text-text-primary`}
    >
      <ForgeIcon icon={forge.forge.icon} />
      <span className="truncate">{overview.name}</span>
      {overview.default_branch === undefined ? null : (
        <span className="shrink-0 text-text-tertiary">· {overview.default_branch}</span>
      )}
    </a>
  );
}

/**
 * The tab control under a project, with the project's repository link at its end. Active
 * styling mirrors FilterChips (brand-bar underline). Only meaningful when a project is
 * scoped — chat is project-scoped, so this is never rendered on the All-projects view.
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
  const { data: forge } = useProjectForge(projectId);
  const tabs = [
    ...TABS.filter(tab => (tab.key !== 'board' && tab.key !== 'overview') || hasBoard),
    ...forgeTab(forge, active),
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-1">
        {tabs.map(({ key, label, suffix }) => {
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
        })}
      </div>
      <RepoLink forge={forge} />
    </div>
  );
}
