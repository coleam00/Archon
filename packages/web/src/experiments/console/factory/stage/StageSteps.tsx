import { useMemo, type ReactElement } from 'react';
import { WorkflowGraphCanvas } from '../../components/RunGraphPanel';
import type {
  WorkflowGraphNodeWithStatus,
  WorkflowNodeKind,
} from '../../primitives/workflow-graph';
import type { PackGraph } from '../../skills/items';
import { useCardList } from '../FactoryCards';
import { GraphSkeleton } from '../GraphSkeleton';
import type { CuratedView } from '../lib/curated-view';
import type { StageRead } from '../lib/map-live';
import type { FactoryStage } from '../lib/stage-steps';
import { stepLabel } from '../lib/step-label';
import type { MapStructure } from '../map-structure';
import { ReadFailure } from '../ReadFailure';
import { ItemLink } from './StageItems';

/**
 * The real steps of each graph stage the map stage stands for, from the pack graph, as a
 * graph (the console's workflow graph): a step is a node with its kind and its name in plain
 * words, with no page of its own; the step an item runs at is lit. Under each stage's name, the items a
 * run of it works now. While the graph is read the list is a skeleton; a failed read says why
 * with a Retry.
 */
export function StageSteps({
  projectId,
  view,
  stage,
  structure,
  live,
}: {
  projectId: string;
  view: CuratedView;
  stage: FactoryStage;
  structure: MapStructure;
  live: StageRead;
}): ReactElement {
  const { graph } = structure;
  const data = graph.data;
  if (data === undefined)
    return graph.error !== undefined ? (
      <ReadFailure retry={graph.refetch}>
        Could not read the pack's steps: {graph.error.message}
      </ReadFailure>
    ) : (
      <GraphSkeleton label="Loading the steps" />
    );
  return (
    <>
      {stage.workflows.map(workflow => (
        <section
          key={workflow}
          data-workflow={workflow}
          className="flex flex-col gap-2 [contain:inline-size]"
        >
          <h4 className="font-mono text-console-15 font-semibold text-text-primary">{workflow}</h4>
          <RunningNow projectId={projectId} workflow={workflow} live={live} />
          <WorkflowGraph view={view} workflow={workflow} graph={data} live={live} />
        </section>
      ))}
    </>
  );
}

/** The items a run of this graph stage works now, named and linked to their run logs. */
function RunningNow({
  projectId,
  workflow,
  live,
}: {
  projectId: string;
  workflow: string;
  live: StageRead;
}): ReactElement | null {
  if (typeof live === 'string') return null;
  const running = live.items.filter(
    read =>
      read.standing.state === 'running' &&
      read.runs.find(run => run.id === read.standing.runId)?.pack?.workflow === workflow
  );
  if (running.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h5 className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        Running now
      </h5>
      <ul className="flex flex-wrap gap-1.5">
        {running.map(read => (
          <li key={read.item.id}>
            <ItemLink projectId={projectId} read={read} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const KINDS: readonly WorkflowNodeKind[] = [
  'prompt',
  'command',
  'bash',
  'script',
  'approval',
  'wait',
  'loop',
  'cancel',
];
const kindOf = (kind: string): WorkflowNodeKind =>
  KINDS.find(known => known === kind) ?? (kind === 'loop_group' ? 'loop' : 'prompt');

/** One graph stage's workflow drawn as the console's workflow graph, the running step lit. */
function WorkflowGraph({
  view,
  workflow,
  graph,
  live,
}: {
  view: CuratedView;
  workflow: string;
  graph: PackGraph;
  live: StageRead;
}): ReactElement {
  const progressOf = useCardList(typeof live === 'string' ? [] : live.items);
  const stage = graph.stages.find(entry => entry.workflow === workflow);
  const ids = new Set<string>();
  if (typeof live !== 'string')
    for (const read of live.items) {
      const running = progressOf(read).running;
      if (running?.stepId != null && running.workflow === workflow) ids.add(running.stepId);
    }
  const litKey = [...ids].sort().join('|');
  const nodes = useMemo<WorkflowGraphNodeWithStatus[]>(() => {
    const lit = new Set(litKey === '' ? [] : litKey.split('|'));
    return (stage?.nodes ?? []).map(node => ({
      id: node.id,
      dependsOn: node.dependsOn,
      kind: kindOf(node.kind),
      status: lit.has(node.id) ? 'running' : 'pending',
    }));
  }, [stage, litKey]);
  if (stage === undefined)
    return (
      <p className="text-console-13 text-text-tertiary">
        The pack graph has no stage <span className="font-mono">{workflow}</span>.
      </p>
    );
  return (
    <div
      role="group"
      aria-label={`The steps of ${workflow}`}
      className="overflow-hidden rounded-console-12 border border-border"
    >
      <WorkflowGraphCanvas
        nodes={nodes}
        live
        fill={false}
        detailed
        plain
        labelOf={id => stepLabel(view, workflow, id)}
      />
    </div>
  );
}
