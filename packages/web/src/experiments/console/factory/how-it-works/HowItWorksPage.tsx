/**
 * The sidebar's Factory pages (DESIGN.md, v2 direction: `/console/factory` opens How it works).
 * A pack explains the factory on every project that stages it, so its page lives in the
 * sidebar, not in a project. The pack's view and graph are read through the first project, in
 * the projects read's order, that stages it: the server reads a pack as a project has it
 * installed.
 *
 * What it draws is `mapSource`'s choice, as on the Overview: the pack's curated How it works
 * picture whenever the server could read its view file, with what the file gets wrong listed
 * above it, else the pack's document and the map derived from its graph.
 */
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Navigate, useParams } from 'react-router';
import type { Project } from '../../primitives/project';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { DerivedStructure } from '../DerivedFlow';
import { packDisplayName, packIdOfKey } from '../lib/pack-name';
import { GraphSkeleton } from '../GraphSkeleton';
import { mapSource } from '../lib/map-source';
import { factoryPackPath } from '../lib/views';
import { usePackGraph } from '../map-structure';
import { OverviewBody } from '../overview/OverviewPage';
import { useFullWorkflow, usePackView } from '../PackMap';
import { SegmentedControl } from '../ui/SegmentedControl';
import { DocumentProblems, ViewProblems } from '../ViewProblems';
import { PackFrame } from './PackFrame';

/** Every pack some project stages, in the projects read's order, each with that first project. */
export function stagedPacks(projects: readonly Project[]): { pack: string; project: Project }[] {
  const staged: { pack: string; project: Project }[] = [];
  for (const project of projects)
    for (const pack of project.itemPacks)
      if (!staged.some(entry => entry.pack === pack)) staged.push({ pack, project });
  return staged;
}

function useProjects(): { data?: Project[]; error?: Error } {
  return useEntity<Project[]>(K.projects, () => skill.listProjects());
}

/** `/console/factory`: How it works of the first staged pack. There is no pack index. */
export function FactoryHome(): ReactElement {
  const projects = useProjects();
  if (projects.data === undefined)
    return (
      <PackFrame title="Factory">
        {projects.error === undefined ? (
          <GraphSkeleton label="Loading the factory" />
        ) : (
          <Failed>The projects could not be read: {projects.error.message}</Failed>
        )}
      </PackFrame>
    );
  const [first] = stagedPacks(projects.data);
  if (first === undefined)
    return (
      <PackFrame title="Factory">
        <p className="text-console-14 text-text-secondary">No project stages a pack.</p>
      </PackFrame>
    );
  return <Navigate replace to={factoryPackPath(first.pack)} />;
}

/**
 * The page's header: the pack's name as a person reads it ("Archon software factory"), the raw
 * key on hover (DESIGN.md, Where it lives). The view file's own title heads the map, as the root
 * of its breadcrumb.
 */
function heading(pack: string): { title: string; titleHint: string } {
  return { title: packDisplayName(packIdOfKey(pack)), titleHint: pack };
}

/** `/console/factory/:pack/how-it-works`. */
export function HowItWorksPage(): ReactElement {
  const { pack = '' } = useParams<{ pack: string }>();
  const projects = useProjects();
  if (projects.data === undefined)
    return (
      <PackFrame {...heading(pack)}>
        {projects.error === undefined ? (
          <GraphSkeleton label="Loading How it works" />
        ) : (
          <Failed>The projects could not be read: {projects.error.message}</Failed>
        )}
      </PackFrame>
    );
  const staged = stagedPacks(projects.data).find(entry => entry.pack === pack);
  if (staged === undefined)
    return (
      <PackFrame {...heading(pack)}>
        <p data-unstaged className="text-console-14 text-text-secondary">
          No project stages the pack <span className="font-mono">{pack}</span>, so there is nothing
          to read it from.
        </p>
      </PackFrame>
    );
  return <HowItWorks projectId={staged.project.id} pack={pack} />;
}

function HowItWorks({ projectId, pack }: { projectId: string; pack: string }): ReactElement {
  const source = mapSource(usePackView(projectId, pack));
  const graph = usePackGraph(projectId, pack);
  const [full, choose] = useFullWorkflow();
  if (source.kind === 'loading')
    return (
      <PackFrame {...heading(pack)}>
        <GraphSkeleton label="Loading How it works" />
      </PackFrame>
    );
  if (source.kind === 'derived') {
    const document = graph.data?.document;
    return (
      <PackFrame {...heading(pack)}>
        {source.note === null ? null : (
          <p data-map-note className="text-console-12 text-warning">
            {source.note}
          </p>
        )}
        <ViewProblems problems={source.problems} drawn={false} />
        <DocumentProblems graph={graph.data} />
        <DerivedStructure projectId={projectId} pack={pack} />
        {document == null || document.text === '' ? null : (
          <div
            data-document
            className="max-w-3xl text-console-14 leading-relaxed text-text-secondary [&_h1]:text-console-17 [&_h1]:font-semibold [&_h1]:text-text-primary [&_h2]:mt-5 [&_h2]:text-console-15 [&_h2]:font-semibold [&_h2]:text-text-primary [&_h3]:mt-3 [&_h3]:font-medium [&_h3]:text-text-primary [&_p]:mt-2"
          >
            <ReactMarkdown>{document.text}</ReactMarkdown>
          </div>
        )}
      </PackFrame>
    );
  }
  return (
    <PackFrame
      {...heading(pack)}
      source={
        <>
          Read from the pack's factory view file{' '}
          <span className="font-mono" title={source.path}>
            ({source.path.split(/[\\/]/).at(-1)})
          </span>
        </>
      }
      actions={
        <SegmentedControl
          label="Which map"
          active={full ? 'full' : 'map'}
          segments={[
            { key: 'map', label: 'How it works', onSelect: choose(false) },
            { key: 'full', label: 'Full workflow', onSelect: choose(true) },
          ]}
        />
      }
    >
      <ViewProblems problems={source.problems} drawn />
      <DocumentProblems graph={graph.data} />
      {full ? (
        <DerivedStructure projectId={projectId} pack={pack} view={source.view} />
      ) : (
        <OverviewBody overview={source.view.howItWorks} />
      )}
    </PackFrame>
  );
}

function Failed({ children }: { children: ReactNode }): ReactElement {
  return (
    <p role="alert" className="text-console-14 text-error">
      {children}
    </p>
  );
}
