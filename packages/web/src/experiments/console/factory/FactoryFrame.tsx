import type { ReactElement, ReactNode } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { SkeletonGroup, SkeletonLine } from '../components/Skeleton';
import { TabLink } from '../components/TabLink';
import { ProjectHeader } from '../components/ProjectHeader';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import type { FactoryViews } from '../skills/factory';
import type { EntityView } from '../store/cache';
import { K } from '../store/keys';
import { ClampedSummary } from './ClampedSummary';
import { useFactoryRead } from './useFactoryRead';
import { useFactoryViews } from './useFactoryViews';
import { SlowReadError } from './lib/deadline';
import { readFailure } from './lib/read-failure';
import { ReadFailure } from './ReadFailure';
import { useReadRetry } from './useReadRetry';
import { currentView, factoryPath, type FactoryViewListed } from './lib/views';
import { BackLink } from './BackLink';
import { FactoryLoading, SLOW_READ_NOTICE } from './FactoryLoading';

/** The sub-navigation entry a page sits under; item, stage and step pages sit under none. */
type FactorySection = 'overview' | 'board' | 'settings' | null;

interface FactoryFrameProps {
  section: FactorySection;
  /** Let the page use the full width, as the board's columns need; others keep a reading width. */
  wide?: boolean;
  /**
   * From md up, give the page the height left under the sub-navigation, so its own parts
   * scroll instead of the page (the board's columns). The frame still scrolls when a window
   * is too short for the page's minimum height. Below md the page scrolls as others do.
   */
  fill?: boolean;
  /** The page body, drawn under the view's header once a view applies. */
  children: (view: FactoryViewListed) => ReactNode;
}

/**
 * Every Factory page's frame: the project heading and tabs, then the factory view's title,
 * summary and sub-navigation, any declaration that failed, and the page. A project no view
 * applies to gets an empty state instead.
 */
export function FactoryFrame({
  section,
  wide = false,
  fill = false,
  children,
}: FactoryFrameProps): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const project = useFactoryRead<Project>(K.project(projectId), within =>
    within(signal => skill.getProject(projectId, { signal }))
  );
  const listing = useFactoryViews(projectId);
  const view = currentView(listing.data);
  return (
    <section className="flex h-full flex-col">
      <ProjectHeader
        title={project.data?.name ?? 'Project'}
        subtitle={
          project.data?.path ??
          (project.error instanceof SlowReadError ? SLOW_READ_NOTICE : <ProjectPathSkeleton />)
        }
      >
        <ProjectViewTabs projectId={projectId} active="factory" />
      </ProjectHeader>
      <div
        // A filled page (the board) gives its columns the height a reading page spends on air:
        // a smaller gap under the heading and less padding under the page.
        className={`flex-1 overflow-y-auto p-4 md:p-6 ${fill ? 'md:flex md:min-h-0 md:flex-col md:pb-4' : ''}`}
      >
        <div
          className={`flex flex-col ${fill ? 'gap-4 md:min-h-0 md:flex-1' : 'gap-6'} ${wide ? '' : 'max-w-5xl'}`}
        >
          {view === undefined ? (
            <>
              <FactoryErrors errors={listing.data?.errors ?? []} />
              <FactoryAbsent projectId={projectId} listing={listing} />
            </>
          ) : (
            <FactoryViewed
              projectId={projectId}
              view={view}
              section={section}
              errors={listing.data?.errors ?? []}
            >
              {children}
            </FactoryViewed>
          )}
        </div>
      </div>
    </section>
  );
}

/** A project with a view: its heading, any declaration that failed, then the page. */
function FactoryViewed({
  projectId,
  view,
  section,
  errors,
  children,
}: {
  projectId: string;
  view: FactoryViewListed;
  section: FactorySection;
  errors: FactoryViews['errors'];
  children: FactoryFrameProps['children'];
}): ReactElement {
  return (
    <>
      <FactoryHeading projectId={projectId} view={view} section={section} />
      <FactoryErrors errors={errors} />
      {children(view)}
    </>
  );
}

/** A project no view applies to, or whose views have not loaded. */
function FactoryAbsent({
  projectId,
  listing: read,
}: {
  projectId: string;
  listing: EntityView<FactoryViews>;
}): ReactNode {
  const listing = read.data;
  const { failed, retry } = useReadRetry(read);
  if (failed !== undefined)
    return (
      <ReadFailure retry={retry}>
        The factory view could not be read: {readFailure(failed)}
      </ReadFailure>
    );
  if (listing === undefined)
    return (
      <FactoryLoading read={read}>
        <SkeletonGroup label="Loading the factory view" className="flex max-w-5xl flex-col gap-3">
          <SkeletonLine width="short" />
          <SkeletonLine />
        </SkeletonGroup>
      </FactoryLoading>
    );
  // A broken project file already shows above; an empty state under it would contradict it.
  if (listing.errors.some(error => error.source === 'project-file')) return null;
  return (
    <EmptyState
      title="No factory view applies to this project"
      hint="A project shows its factory once it runs a pack that declares a factory view, or ships its own in .archon/packs/."
      action={<BackLink to={`/console/p/${projectId}`} label="Back to runs" />}
    />
  );
}

const SECTIONS: readonly {
  key: Exclude<FactorySection, null>;
  label: string;
  rest: string;
}[] = [
  { key: 'overview', label: 'Overview', rest: '' },
  { key: 'board', label: 'Board', rest: '/board' },
  { key: 'settings', label: 'Settings', rest: '/settings' },
];

/**
 * The view's title and the sub-navigation on one line, which wraps where it must (a phone, a
 * long title), so the board keeps the height. The tab has three pages, Overview, Board and
 * Settings: Needs you is the project tab beside it and How it works the sidebar Factory page.
 */
function FactoryHeading({
  projectId,
  view,
  section,
}: {
  projectId: string;
  view: FactoryViewListed;
  section: FactorySection;
}): ReactElement {
  return (
    <div className="flex max-w-5xl flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h2 className="min-w-0 text-console-22 font-semibold tracking-console-heading text-text-primary [overflow-wrap:anywhere]">
          {view.declaration.title}
        </h2>
        <nav aria-label="Factory" className="flex flex-wrap items-center gap-1">
          {SECTIONS.map(({ key, label, rest }) => (
            <TabLink key={key} to={factoryPath(projectId, rest)} active={key === section}>
              {label}
            </TabLink>
          ))}
        </nav>
      </div>
      {/* The summary introduces the factory once, on the Overview; the other pages need
          their first screen for the board, the item or the graph. */}
      {section === 'overview' ? (
        // Keyed by the text, so a new summary measures again and opens clamped.
        <ClampedSummary key={view.declaration.summary} text={view.declaration.summary} lines={2} />
      ) : null}
    </div>
  );
}

/** The project's path while the project is read: one short line (Visual standard, rule 6). */
export function ProjectPathSkeleton(): ReactElement {
  return (
    <span role="status" className="flex h-4 items-center">
      <span className="sr-only">Loading the project</span>
      <SkeletonLine width="short" />
    </span>
  );
}

/** View and overview files that failed, each with its file, so a broken one is never silent. */
export function FactoryErrors({ errors }: { errors: FactoryViews['errors'] }): ReactNode {
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex max-w-5xl flex-col gap-2 rounded-console-12 border border-error/30 bg-error/10 px-4 py-3"
    >
      <p className="text-console-12 font-medium text-error">
        {errors.length === 1
          ? 'A factory file could not be read'
          : `${errors.length.toString()} factory files could not be read`}
      </p>
      <ul className="flex flex-col gap-1">
        {errors.map(error => (
          <li key={`${error.source}:${error.path}`} className="text-console-12 text-text-secondary">
            <span className="break-all font-mono text-console-12 text-text-primary">
              {error.path}
            </span>
            <span className="block break-words">{error.error}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
