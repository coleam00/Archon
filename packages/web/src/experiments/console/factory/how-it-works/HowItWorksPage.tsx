/**
 * The sidebar's Factory pages (DESIGN.md, v2 direction: `/console/factory` opens How it works).
 * A pack explains the factory on every project that stages it, so its page lives in the
 * sidebar, not in a project. The pack's view and graph are read through the first project, in
 * the projects read's order, that stages it: the server reads a pack as a project has it
 * installed.
 *
 * The Archon software factory gets its curated How it works picture, hardcoded in the console
 * (`archon-software-factory.ts`), with a switch to its Full workflow, derived from the graph.
 * Any other pack draws its own document (`PackDocument`), then its whole workflow derived from
 * its graph, with the document's problems listed above them. A pack with no document gets no
 * How it works section, only the workflow.
 */
import type { ReactElement, ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import type { Project } from '../../primitives/project';
import * as skill from '../../skills';
import { useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import { DerivedStructure } from '../DerivedFlow';
import { packDisplayName, packIdOfKey } from '../lib/pack-name';
import { GraphSkeleton } from '../GraphSkeleton';
import { factoryPackPath } from '../lib/views';
import { usePackGraph } from '../map-structure';
import { graphWords } from '../lib/graph-view';
import { DocumentProblems } from '../DocumentProblems';
import { PackDocument } from '../PackDocument';
import { ReadFailure } from '../ReadFailure';
import { OverviewBody } from '../overview/OverviewPage';
import { useFullWorkflow } from '../PackMap';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ARCHON_SOFTWARE_FACTORY, isSoftwareFactory } from './archon-software-factory';
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
 * key on hover (DESIGN.md, Where it lives).
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
  if (isSoftwareFactory(pack))
    return <CuratedHowItWorks projectId={staged.project.id} pack={pack} />;
  return <HowItWorks projectId={staged.project.id} pack={pack} />;
}

/**
 * The software factory's page: its curated picture (the default) or its Full workflow, one
 * switch at the right of the title. The picture needs no read; the Full workflow waits for the
 * graph.
 */
function CuratedHowItWorks({ projectId, pack }: { projectId: string; pack: string }): ReactElement {
  const graph = usePackGraph(projectId, pack);
  const [full, choose] = useFullWorkflow();
  return (
    <PackFrame
      {...heading(pack)}
      source="Drawn by hand for the Archon software factory, kept in the console"
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
      <DocumentProblems graph={graph.data} />
      {!full ? (
        <OverviewBody overview={ARCHON_SOFTWARE_FACTORY.howItWorks} />
      ) : graph.data !== undefined ? (
        <DerivedStructure projectId={projectId} pack={pack} view={graphWords(graph.data)} />
      ) : graph.error === undefined ? (
        <GraphSkeleton label="Loading the full workflow" />
      ) : (
        <ReadFailure retry={graph.refetch}>
          The pack's graph could not be read: {graph.error.message}
        </ReadFailure>
      )}
    </PackFrame>
  );
}

const LABEL = 'text-console-12 font-medium uppercase tracking-console-label text-text-tertiary';

function HowItWorks({ projectId, pack }: { projectId: string; pack: string }): ReactElement {
  const graph = usePackGraph(projectId, pack);
  if (graph.data === undefined)
    return (
      <PackFrame {...heading(pack)}>
        {graph.error === undefined ? (
          <GraphSkeleton label="Loading How it works" />
        ) : (
          <ReadFailure retry={graph.refetch}>
            The pack's graph could not be read: {graph.error.message}
          </ReadFailure>
        )}
      </PackFrame>
    );
  const { document } = graph.data;
  return (
    <PackFrame
      {...heading(pack)}
      source={
        document == null ? undefined : (
          <>
            Read from the pack's document <span className="font-mono">{document.path}</span>
          </>
        )
      }
    >
      <DocumentProblems graph={graph.data} />
      {document == null || document.text.trim() === '' ? null : (
        <PackDocument text={document.text} />
      )}
      <section aria-label="The full workflow" className="flex flex-col gap-3">
        <h2 className={LABEL}>The full workflow</h2>
        <DerivedStructure projectId={projectId} pack={pack} view={graphWords(graph.data)} />
      </section>
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
