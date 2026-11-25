import type { ReactElement } from 'react';
import { GraphSkeleton } from '../GraphSkeleton';
import type { CuratedView } from '../lib/curated-view';
import { stageSteps } from '../lib/graph-structure';
import type { StageRead } from '../lib/map-live';
import type { FactoryStage } from '../lib/stage-steps';
import { engineIdTitle, stepLabel } from '../lib/step-label';
import type { MapStructure } from '../map-structure';
import { ReadFailure } from '../ReadFailure';
import { ItemLink } from './StageItems';

/**
 * The real steps of each graph stage the map stage stands for, from the pack graph, as a
 * plain list: a step is text, with no page of its own. Under each stage's name, the items a
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
  if (graph.data === undefined)
    return graph.error !== undefined ? (
      <ReadFailure retry={graph.refetch}>
        Could not read the pack's steps: {graph.error.message}
      </ReadFailure>
    ) : (
      <GraphSkeleton label="Loading the steps" />
    );
  return (
    <>
      {stageSteps(stage, graph.data).map(({ workflow, steps }) => (
        <section
          key={workflow}
          data-workflow={workflow}
          className="flex flex-col gap-2 [contain:inline-size]"
        >
          <h4 className="font-mono text-console-15 font-semibold text-text-primary">{workflow}</h4>
          <RunningNow projectId={projectId} workflow={workflow} live={live} />
          {steps === undefined ? (
            <p className="text-console-13 text-text-tertiary">
              The pack graph has no stage <span className="font-mono">{workflow}</span>.
            </p>
          ) : (
            <ol aria-label={`The steps of ${workflow}`} className="flex flex-col gap-1">
              {steps.map((step, index) => {
                const name = stepLabel(view, workflow, step);
                return (
                  <li
                    key={step}
                    data-step={step}
                    title={engineIdTitle(name, step)}
                    className="flex flex-wrap items-baseline gap-x-2 text-console-14 text-text-secondary"
                  >
                    <span className="w-6 shrink-0 text-right tabular-nums text-text-tertiary">
                      {index + 1}.
                    </span>
                    <span>{name}</span>
                  </li>
                );
              })}
            </ol>
          )}
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
