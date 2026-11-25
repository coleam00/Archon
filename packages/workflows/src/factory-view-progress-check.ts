/**
 * Whether a factory view's progress declarations (`schemas/factory-view-progress.ts`) agree
 * with the pack graph. `checkFactoryView` runs this with the rest of the view's check.
 *
 * - A declaration's `workflow` is a graph stage, or one the view lists in `retired`.
 * - A `retired` entry the graph has is an error, as is a duplicate.
 * - For a graph stage, a decision point's `node` is one of the stage's step ids and a loop-form
 *   rounds source's `loop` is one of its loop groups. A retired workflow's steps cannot be
 *   compared with a graph that lacks them, so they are not checked.
 * - A decision point's `outcome` is checked only as non-empty: the graph declares a stage's
 *   outcome values, not the values each step records.
 * - "Returned" has two owners that must agree: `returns` counts sends-back, and an outcome's
 *   `reads: "returned"` says how the item reads after its run. A stage with either has both.
 */
import type { PackGraph } from './pack-graph';
import type { FactoryView, FactoryViewProblem } from './schemas/factory-view';
import { sourcesOf, type FactoryDecisionPoint } from './schemas/factory-view-progress';

type ProblemPath = FactoryViewProblem['path'];
type GraphStage = PackGraph['stages'][number];

const error = (path: ProblemPath, message: string): FactoryViewProblem => ({
  severity: 'error',
  path,
  message,
});

/** `retired` names only workflows the graph lacks, each once. */
function retiredErrors(view: FactoryView, stages: ReadonlyMap<string, GraphStage>) {
  const errors: FactoryViewProblem[] = [];
  const seen = new Set<string>();
  view.retired?.forEach((name, r) => {
    if (seen.has(name)) errors.push(error(['retired', r], `retires "${name}" twice`));
    seen.add(name);
    if (stages.has(name))
      errors.push(error(['retired', r], `retires "${name}", which the pack graph has`));
  });
  return errors;
}

/** The stage a declaration names, or `retired`; an error for a workflow that is neither. */
function stageOrRetired(
  view: FactoryView,
  stages: ReadonlyMap<string, GraphStage>,
  pack: string,
  path: ProblemPath,
  workflow: string,
  errors: FactoryViewProblem[]
): GraphStage | 'retired' | undefined {
  const stage = stages.get(workflow);
  if (stage !== undefined) return stage;
  if (view.retired?.includes(workflow) === true) return 'retired';
  errors.push(
    error(
      path,
      `names workflow "${workflow}", which pack "${pack}" does not have and the view does not retire`
    )
  );
  return undefined;
}

function pointErrors(
  view: FactoryView,
  stages: ReadonlyMap<string, GraphStage>,
  pack: string,
  key: 'returns' | 'approves',
  points: readonly FactoryDecisionPoint[]
): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  points.forEach((point, p) => {
    const stage = stageOrRetired(view, stages, pack, [key, p, 'workflow'], point.workflow, errors);
    if (typeof stage === 'object' && !stage.nodes.some(node => node.id === point.node))
      errors.push(
        error(
          [key, p, 'node'],
          `names step "${point.node}", which stage "${point.workflow}" does not have`
        )
      );
  });
  return errors;
}

function sourceErrors(
  view: FactoryView,
  stages: ReadonlyMap<string, GraphStage>,
  pack: string
): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  const single = (key: 'rounds' | 'change'): boolean =>
    view[key] !== undefined && !Array.isArray(view[key]);
  const pathOf = (key: 'rounds' | 'change', index: number): ProblemPath =>
    single(key) ? [key] : [key, index];
  const once = (key: 'rounds' | 'change', workflows: readonly string[]): void => {
    workflows.forEach((workflow, index) => {
      if (workflows.indexOf(workflow) !== index)
        errors.push(error(pathOf(key, index), `names workflow "${workflow}" twice`));
    });
  };
  const rounds = sourcesOf(view.rounds);
  once(
    'rounds',
    rounds.map(source => source.workflow)
  );
  rounds.forEach((source, index) => {
    const path = pathOf('rounds', index);
    const stage = stageOrRetired(
      view,
      stages,
      pack,
      [...path, 'workflow'],
      source.workflow,
      errors
    );
    if ('loop' in source && typeof stage === 'object')
      if (!stage.nodes.some(node => node.loopGroup === source.loop))
        errors.push(
          error(
            [...path, 'loop'],
            `names loop "${source.loop}", which stage "${source.workflow}" does not have`
          )
        );
  });
  const change = sourcesOf(view.change);
  once(
    'change',
    change.map(source => source.workflow)
  );
  change.forEach((source, index) => {
    stageOrRetired(
      view,
      stages,
      pack,
      [...pathOf('change', index), 'workflow'],
      source.workflow,
      errors
    );
  });
  return errors;
}

/** Every stage with a `reads: "returned"` outcome has a `returns` point, and the reverse. */
function returnedAgreement(
  view: FactoryView,
  stages: ReadonlyMap<string, GraphStage>
): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  const counted = new Set((view.returns ?? []).map(point => point.workflow));
  const reads = new Set<string>();
  for (const [key, outcome] of Object.entries(view.outcomes ?? {})) {
    if (outcome.reads !== 'returned') continue;
    const stage = key.slice(0, key.lastIndexOf(':'));
    reads.add(stage);
    if (!counted.has(stage))
      errors.push(
        error(
          ['outcomes', key],
          `reads as returned, but no \`returns\` point of stage "${stage}" counts it`
        )
      );
  }
  (view.returns ?? []).forEach((point, p) => {
    if (stages.has(point.workflow) && !reads.has(point.workflow))
      errors.push(
        error(
          ['returns', p, 'workflow'],
          `counts a return of stage "${point.workflow}", but none of its outcomes reads "returned"`
        )
      );
  });
  return errors;
}

/** What is wrong with `view`'s progress declarations against `graph`. */
export function progressErrors(view: FactoryView, graph: PackGraph): FactoryViewProblem[] {
  const stages = new Map(graph.stages.map(stage => [stage.workflow, stage]));
  return [
    ...retiredErrors(view, stages),
    ...pointErrors(view, stages, graph.pack, 'returns', view.returns ?? []),
    ...pointErrors(view, stages, graph.pack, 'approves', view.approves ?? []),
    ...sourceErrors(view, stages, graph.pack),
    ...returnedAgreement(view, stages),
  ];
}
