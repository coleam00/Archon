import type { ReactElement, ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { ForgeIcon } from '../components/ForgeIcon';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { relativeTime } from '../lib/format';
import {
  useProjectForge,
  type ForgeItem,
  type ForgeOverview,
  type ForgeProject,
} from '../lib/project-forge';
import { rerunPath } from '../lib/rerun';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import type { ProjectForge } from '../skills/forge';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

type Stats = ForgeOverview['stats'];
type Stat = NonNullable<Stats[keyof Stats]>;

/**
 * The workflow each row's action starts, and the input that takes the item. A shortcut:
 * the action is offered only when the project has the workflow.
 */
const ITEM_ACTIONS = {
  pr: { label: 'Review', workflow: 'archon-review', input: 'scope' },
  issue: { label: 'Ship', workflow: 'archon-ship', input: 'target' },
} as const;

/** `/console/p/:projectId/forge`: the project's repository on its forge. */
export function ForgePage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: project } = useEntity<Project>(K.project(projectId), () =>
    skill.getProject(projectId)
  );
  const forge = useProjectForge(projectId);
  if (forge.data?.kind === 'none') return <Navigate to={`/console/p/${projectId}`} replace />;
  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <h1 className="truncate text-base font-medium text-text-primary">
          {project?.name ?? 'Project'}
        </h1>
        <ProjectViewTabs projectId={projectId} active="forge" />
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-7.5 pt-5.5 md:px-7.5">
        <ForgeBody projectId={projectId} project={project} forge={forge.data} error={forge.error} />
      </div>
    </section>
  );
}

function ForgeBody({
  projectId,
  project,
  forge,
  error,
}: {
  projectId: string;
  project: Project | undefined;
  forge: Exclude<ProjectForge, { kind: 'none' }> | undefined;
  error: Error | undefined;
}): ReactElement {
  if (forge === undefined)
    return error === undefined ? (
      <EmptyState title="Loading the repository…" />
    ) : (
      <EmptyState title="The repository could not be loaded" hint={error.message} />
    );
  if (forge.kind === 'unresolved')
    return (
      <EmptyState
        title={`Archon could not tell which forge serves this project (${forge.error.kind})`}
        hint={forge.error.message}
      />
    );
  if (forge.overview.status === 'failed') {
    const { error: failure, remedy } = forge.overview;
    return (
      <EmptyState
        title={`${forge.forge.name} could not be read (${failure.kind})`}
        hint={remedy === undefined ? failure.message : `${failure.message} ${remedy}`}
      />
    );
  }
  return (
    <ForgeOverviewView
      projectId={projectId}
      project={project}
      forge={forge}
      overview={forge.overview.value}
      syncedAt={forge.overview.syncedAt}
    />
  );
}

function ForgeOverviewView({
  projectId,
  project,
  forge,
  overview,
  syncedAt,
}: {
  projectId: string;
  project: Project | undefined;
  forge: ForgeProject;
  overview: ForgeOverview;
  syncedAt: string;
}): ReactElement {
  const { stats, actor } = overview;
  const you = actor === undefined ? 'you' : `@${actor.login}`;
  const days = Math.round((Date.parse(syncedAt) - Date.parse(overview.since)) / 86_400_000);
  // The draft card falls back to another workflow when the project lacks the one a link
  // names, so an action is offered only for a workflow the project has.
  const { data: workflows } = useEntity(
    project === undefined ? 'noop:forge-workflows' : K.workflows(project.path),
    () => (project === undefined ? Promise.resolve(undefined) : skill.listWorkflows(project.path))
  );
  const available = new Set(workflows?.workflows.map(workflow => workflow.name));
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <RepoCard forge={forge} overview={overview} syncedAt={syncedAt} />
      <TileGroup
        title="Issues"
        tiles={[
          ['Open', stats.issues_open],
          ['Without a label', stats.issues_unlabeled],
          ['Bugs', stats.issues_bugs],
          [`Assigned to ${you}`, stats.issues_assigned_to_actor],
        ]}
      />
      <TileGroup
        title="Pull/merge requests"
        tiles={[
          ['Open', stats.prs_open],
          ['Drafts', stats.prs_draft],
          [`Review requested from ${you}`, stats.prs_review_requested_from_actor],
        ]}
      />
      <TileGroup
        title={`Last ${days.toString()} days`}
        tiles={[
          ['Merged', stats.prs_merged_since],
          ['Issues closed', stats.issues_closed_since],
        ]}
      />
      <ItemList
        title="Newest open pull/merge requests"
        items={overview.pull_requests}
        projectId={projectId}
        available={available}
      />
      <ItemList
        title="Newest open issues"
        items={overview.issues}
        projectId={projectId}
        available={available}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-console-11 font-semibold uppercase tracking-wider text-text-tertiary">
        {title}
      </h2>
      {children}
    </section>
  );
}

const external = { target: '_blank', rel: 'noreferrer' } as const;

function RepoCard({
  forge,
  overview,
  syncedAt,
}: {
  forge: ForgeProject;
  overview: ForgeOverview;
  syncedAt: string;
}): ReactElement {
  const facts: [string, ReactNode][] = [];
  if (overview.stars !== undefined) facts.push(['Stars', overview.stars.toLocaleString('en-US')]);
  if (overview.forks !== undefined) facts.push(['Forks', overview.forks.toLocaleString('en-US')]);
  if (overview.latest_release !== undefined)
    facts.push([
      'Latest release',
      overview.latest_release === null ? (
        'None yet'
      ) : (
        <a
          href={overview.latest_release.url}
          {...external}
          className="text-accent-bright underline"
        >
          {overview.latest_release.name}
        </a>
      ),
    ]);
  if (overview.default_branch !== undefined)
    facts.push(['Default branch', overview.default_branch]);
  return (
    <div className="flex flex-col gap-3 rounded-console-12 border border-border bg-surface-elevated p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-console-15 font-medium text-text-primary">
            <ForgeIcon icon={forge.forge.icon} className="size-4" />
            <span className="truncate">{overview.name}</span>
          </div>
          {overview.description ? (
            <p className="mt-1 text-console-13 text-text-secondary">{overview.description}</p>
          ) : null}
        </div>
        <a
          href={overview.url}
          {...external}
          className="shrink-0 rounded border border-border px-2.5 py-1 text-console-12 text-text-primary hover:bg-surface-hover"
        >
          Open on {forge.forge.name}
        </a>
      </div>
      {facts.length === 0 ? null : (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-console-12">
          {facts.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className="text-text-tertiary">{label}</dt>
              <dd className="font-mono text-text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-console-11 text-text-tertiary">
        Synced {relativeTime(syncedAt)} through the {forge.plugin.name} plugin{' '}
        {forge.plugin.version}
      </p>
    </div>
  );
}

/** Tiles for the stats the forge reports. A stat it lacks has no tile; zero is a tile. */
function TileGroup({
  title,
  tiles,
}: {
  title: string;
  tiles: readonly (readonly [label: string, stat: Stat | undefined])[];
}): ReactElement | null {
  const reported = tiles.flatMap(([label, stat]) => (stat === undefined ? [] : [{ label, stat }]));
  if (reported.length === 0) return null;
  return (
    <Section title={title}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {reported.map(({ label, stat }) => (
          <div
            key={label}
            className="flex flex-col gap-1 rounded-console-12 border border-border bg-surface-elevated px-4 py-3"
          >
            <a
              href={stat.url}
              {...external}
              title={`${label}: open this list`}
              className="font-mono text-console-18 font-medium text-text-primary hover:text-accent-bright"
            >
              {stat.count.toLocaleString('en-US')}
            </a>
            <span className="text-console-12 text-text-tertiary">{label}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ItemList({
  title,
  items,
  projectId,
  available,
}: {
  title: string;
  items: readonly ForgeItem[] | undefined;
  projectId: string;
  available: ReadonlySet<string>;
}): ReactElement | null {
  if (items === undefined) return null;
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <p className="text-console-12 text-text-tertiary">None open.</p>
      ) : (
        <ul className="divide-y divide-border rounded-console-12 border border-border bg-surface-elevated">
          {items.map(item => (
            <ItemRow
              key={item.ref.number}
              item={item}
              projectId={projectId}
              available={available}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ItemRow({
  item,
  projectId,
  available,
}: {
  item: ForgeItem;
  projectId: string;
  available: ReadonlySet<string>;
}): ReactElement {
  const action = ITEM_ACTIONS[item.kind];
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          {...external}
          className="flex items-baseline gap-2 text-console-13 text-text-primary hover:text-accent-bright"
        >
          <span className="shrink-0 font-mono text-text-tertiary">#{item.ref.number}</span>
          <span className="truncate">{item.title}</span>
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-console-11 text-text-tertiary">
          {item.author?.login ? <span>{item.author.login}</span> : null}
          <span>updated {relativeTime(item.updatedAt)}</span>
          {item.is_draft === true ? (
            <span className="rounded border border-border px-1.5 text-text-secondary">Draft</span>
          ) : null}
          {item.labels?.map(label => (
            <span key={label} className="rounded-full bg-surface-bright px-1.5 text-text-secondary">
              {label}
            </span>
          ))}
        </div>
      </div>
      {available.has(action.workflow) ? (
        <Link
          to={rerunPath({
            projectId,
            workflow: action.workflow,
            userMessage: '',
            suppliedInputs: { [action.input]: item.url },
          })}
          title={`Start ${action.workflow} on #${item.ref.number.toString()}`}
          className="shrink-0 rounded border border-border px-2.5 py-1 text-console-12 text-text-primary hover:bg-surface-hover"
        >
          {action.label}
        </Link>
      ) : null}
    </li>
  );
}
