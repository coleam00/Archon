import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { forgeOverview, useProjectForge } from '../lib/project-forge';
import type { ProjectForge } from '../skills/forge';
import { ForgeIcon } from './ForgeIcon';

type ProjectView = 'runs' | 'chat' | 'metrics' | 'forge';

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
  { key: 'runs', label: 'Runs', suffix: '' },
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
 */
export function ProjectViewTabs({ projectId, active }: ProjectViewTabsProps): ReactElement {
  const { data: forge } = useProjectForge(projectId);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-1">
        {[...TABS, ...forgeTab(forge, active)].map(({ key, label, suffix }) => {
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
        })}
      </div>
      <RepoLink forge={forge} />
    </div>
  );
}
