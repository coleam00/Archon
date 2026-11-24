import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { NeedsYouContent } from '../components/needs-you/NeedsYouLayout';
import { useProjectAttention } from '../components/ProjectAttention';
import { ProjectHeader } from '../components/ProjectHeader';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { SkeletonBlock, SkeletonGroup } from '../components/Skeleton';
import { ProjectPathSkeleton } from '../factory/FactoryFrame';
import { FactoryLoading } from '../factory/FactoryLoading';
import { readFailed } from '../factory/lib/deadline';
import { currentView } from '../factory/lib/views';
import { useFactoryViews } from '../factory/useFactoryViews';
import { errorDetail } from '../lib/http';
import type { Project } from '../primitives/project';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

/**
 * `/console/p/:projectId/needs-you`: every open ask and paused wait on the project's items
 * and runs, from any workflow, answerable in place, grouped under their item; then the
 * answers given lately. A project tab on every project, factory or not (DESIGN.md, owner
 * change 2), designed as a document page (owner changes 5 and 9).
 */
export function NeedsYouPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { data: project } = useEntity<Project>(K.project(projectId), () =>
    skill.getProject(projectId)
  );
  return (
    <section className="flex h-full flex-col">
      <ProjectHeader
        title={project?.name ?? 'Project'}
        subtitle={project?.path ?? <ProjectPathSkeleton />}
      >
        <ProjectViewTabs projectId={projectId} active="needs-you" />
      </ProjectHeader>
      <div className="flex-1 overflow-y-auto p-6">
        <NeedsYouBody projectId={projectId} />
      </div>
    </section>
  );
}

function NeedsYouBody({ projectId }: { projectId: string }): ReactElement {
  const attention = useProjectAttention();
  const listing = useFactoryViews(projectId);
  // Which read names the asks waits on the views listing; a failed listing reads as no view.
  const known = listing.data !== undefined || readFailed(listing.error) !== undefined;
  const queue = attention.data;
  if (queue !== undefined && known)
    return <NeedsYouContent projectId={projectId} queue={queue} view={currentView(listing.data)} />;
  const failed = queue === undefined ? readFailed(attention.error) : undefined;
  if (failed !== undefined)
    return (
      <p role="alert" className="text-console-14 text-error">
        What needs you could not be loaded: {errorDetail(failed)}
      </p>
    );
  return (
    <FactoryLoading read={attention}>
      <SkeletonGroup
        label="Loading what needs you"
        className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3"
      >
        <span className="lg:col-span-3">
          <SkeletonBlock height="h-28" />
        </span>
        <span className="flex flex-col gap-6 lg:col-span-2">
          {[0, 1].map(index => (
            <SkeletonBlock key={index} height="h-44" />
          ))}
        </span>
        <SkeletonBlock height="h-64" />
      </SkeletonGroup>
    </FactoryLoading>
  );
}
