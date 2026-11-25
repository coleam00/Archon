/**
 * Whether a pack's factory view (`schemas/factory-view.ts`) agrees with the pack graph. The view
 * is presentation only, so it may only name what the graph has: a stage, step, outcome, option
 * or group the graph lacks is an `error`, as is a map or How it works edge between stages the
 * graph does not connect. What the graph has and the view leaves out is a `warning`: an
 * in-flow stage no map card places or no words describe, and a group with no words. Read time
 * (`readPackView`) and `bun run check:factory-view` both run this.
 */
import type { PackGraph } from './pack-graph';
import { PACK_SHARED_DIRECTORY } from './packaged-workflow';
import {
  FACTORY_VIEW_FILE,
  type FactoryView,
  type FactoryViewProblem,
} from './schemas/factory-view';

/** Where in a pack its factory view is, as `readPackDeclarations` takes it. */
export const FACTORY_VIEW_PATH = `${PACK_SHARED_DIRECTORY}/${FACTORY_VIEW_FILE}`;

type ProblemPath = FactoryViewProblem['path'];
type GraphStage = PackGraph['stages'][number];

/** The graph read for checking: its stages by `workflow` name and the stage pairs arrows join. */
interface GraphIndex {
  graph: PackGraph;
  stages: ReadonlyMap<string, GraphStage>;
  /** `from\0to` by `workflow` name, for every arrow whose two ends are stages of the pack. */
  joined: ReadonlySet<string>;
}

const pairKey = (from: string, to: string): string => `${from}\0${to}`;

/**
 * Arrows name stages by `name` (`owner/name:workflow` when installed); the view names them by
 * `workflow`. Every arrow counts, active or only declared: the view draws the pack as designed.
 */
function indexGraph(graph: PackGraph): GraphIndex {
  const workflowOf = new Map(graph.stages.map(stage => [stage.name, stage.workflow]));
  const joined = new Set<string>();
  for (const arrow of graph.arrows) {
    const from = workflowOf.get(arrow.from.stage);
    const to = workflowOf.get(arrow.to);
    if (from !== undefined && to !== undefined) joined.add(pairKey(from, to));
  }
  return { graph, stages: new Map(graph.stages.map(s => [s.workflow, s])), joined };
}

const splitKey = (key: string): { stage: string; name: string } => {
  const at = key.lastIndexOf(':');
  return { stage: key.slice(0, at), name: key.slice(at + 1) };
};

const unknownStage = (path: ProblemPath, stage: string, graph: PackGraph): FactoryViewProblem => ({
  severity: 'error',
  path,
  message: `names stage "${stage}", which pack "${graph.pack}" does not have`,
});

/** Each `stages` entry's stage, its step names and the steps its drill-down covers. */
function stageErrors(view: FactoryView, index: GraphIndex): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  for (const [name, words] of Object.entries(view.stages)) {
    const stage = index.stages.get(name);
    if (stage === undefined) {
      errors.push(unknownStage(['stages', name], name, index.graph));
      continue;
    }
    const steps = new Set(stage.nodes.map(node => node.id));
    const step = (path: ProblemPath, id: string): void => {
      if (!steps.has(id))
        errors.push({
          severity: 'error',
          path,
          message: `names step "${id}", which stage "${name}" does not have`,
        });
    };
    for (const id of Object.keys(words.steps ?? {})) step(['stages', name, 'steps', id], id);
    const covered = new Map<string, string>();
    words.drilldown?.phases.forEach((phase, p) => {
      phase.cards.forEach((card, c) => {
        card.covers.forEach((id, k) => {
          const path: ProblemPath = [
            'stages',
            name,
            'drilldown',
            'phases',
            p,
            'cards',
            c,
            'covers',
            k,
          ];
          step(path, id);
          const first = covered.get(id);
          if (first !== undefined)
            errors.push({
              severity: 'error',
              path,
              message: `covers step "${id}", which card "${first}" covers`,
            });
          else covered.set(id, card.title);
        });
      });
    });
  }
  return errors;
}

/**
 * Whether an asks-settled arrow of `stage` leaves on `option`. An arrow with no option backs
 * every option unless it is on `withdrawn`: an `answered` or `any` binding starts on whatever
 * answer was chosen, while a withdrawal chooses none.
 */
const optionBacked = (graph: PackGraph, stage: GraphStage, option: string): boolean =>
  graph.arrows.some(
    ({ from }) =>
      'settled' in from &&
      from.stage === stage.name &&
      (from.option === option || (from.option === undefined && from.settled !== 'withdrawn'))
  );

/** Each `outcomes` key's stage and outcome, and each `answers` key's stage and option. */
function keyErrors(view: FactoryView, index: GraphIndex): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  for (const key of Object.keys(view.outcomes ?? {})) {
    const { stage: name, name: outcome } = splitKey(key);
    const stage = index.stages.get(name);
    if (stage === undefined) errors.push(unknownStage(['outcomes', key], name, index.graph));
    else if (outcome !== '*' && !stage.outcome?.values.some(entry => entry.value === outcome))
      errors.push({
        severity: 'error',
        path: ['outcomes', key],
        message: `names outcome "${outcome}", which stage "${name}" does not declare`,
      });
  }
  for (const key of Object.keys(view.answers ?? {})) {
    const { stage: name, name: option } = splitKey(key);
    const stage = index.stages.get(name);
    if (stage === undefined) errors.push(unknownStage(['answers', key], name, index.graph));
    else if (!optionBacked(index.graph, stage, option))
      errors.push({
        severity: 'error',
        path: ['answers', key],
        message: `names option "${option}" of stage "${name}", but no asks-settled hand-off of the pack leaves on it`,
      });
  }
  return errors;
}

/** Each `groups` key is a group the pack document declares. */
function groupErrors(view: FactoryView, graph: PackGraph): FactoryViewProblem[] {
  const known = new Set(graph.groups.map(group => group.name));
  // The graph serves no groups while its document has a problem, so say that instead.
  const why =
    graph.groups.length === 0 && (graph.document?.problems.length ?? 0) > 0
      ? `; the pack document's groups do not read: ${graph.document?.problems.join('; ') ?? ''}`
      : '';
  return Object.keys(view.groups ?? {})
    .filter(name => !known.has(name))
    .map(name => ({
      severity: 'error' as const,
      path: ['groups', name],
      message: `names group "${name}", which pack "${graph.pack}" does not declare${why}`,
    }));
}

/** An edge between cards that stand for stages must follow an arrow from one's to the other's. */
function edgeError(
  path: ProblemPath,
  from: readonly string[],
  to: readonly string[],
  index: GraphIndex
): FactoryViewProblem[] {
  if (from.some(a => to.some(b => index.joined.has(pairKey(a, b))))) return [];
  return [
    {
      severity: 'error',
      path,
      message: `joins stages ${from.join(', ')} to ${to.join(', ')}, which no arrow of the pack graph connects`,
    },
  ];
}

/** The map's card stages and the edges between its cards. */
function mapErrors(view: FactoryView, index: GraphIndex): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  const stagesOf = new Map(view.map.cards.map(card => [card.id, card.stages]));
  view.map.cards.forEach((card, c) => {
    card.stages.forEach((stage, s) => {
      if (!index.stages.has(stage))
        errors.push(unknownStage(['map', 'cards', c, 'stages', s], stage, index.graph));
    });
  });
  view.map.edges?.forEach((edge, e) => {
    const from = stagesOf.get(edge.from);
    const to = stagesOf.get(edge.to);
    if (from !== undefined && to !== undefined)
      errors.push(...edgeError(['map', 'edges', e], from, to, index));
  });
  return errors;
}

/**
 * How it works stays a hand-drawn picture, but where its cards name stages it may not disagree
 * with the pack: a `feeds` or `loops-back` edge between two stage cards follows a graph arrow.
 * A `calls` edge asks someone and hands no work on, so it is not compared.
 */
function howItWorksErrors(view: FactoryView, index: GraphIndex): FactoryViewProblem[] {
  const errors: FactoryViewProblem[] = [];
  for (const [viewId, picture] of Object.entries(view.howItWorks.views)) {
    const stagesOf = new Map<string, readonly string[]>();
    picture.cards.forEach((card, c) => {
      if (card.stages === undefined) return;
      stagesOf.set(card.id, card.stages);
      card.stages.forEach((stage, s) => {
        if (!index.stages.has(stage))
          errors.push(
            unknownStage(
              ['howItWorks', 'views', viewId, 'cards', c, 'stages', s],
              stage,
              index.graph
            )
          );
      });
    });
    picture.edges.forEach((edge, e) => {
      const from = stagesOf.get(edge.from);
      const to = stagesOf.get(edge.to);
      if (edge.kind !== 'calls' && from !== undefined && to !== undefined)
        errors.push(...edgeError(['howItWorks', 'views', viewId, 'edges', e], from, to, index));
    });
  }
  return errors;
}

/** What the graph has that the view leaves out. Only in-flow stages: no item stands at the rest. */
function warnings(view: FactoryView, graph: PackGraph): FactoryViewProblem[] {
  const placed = new Set(view.map.cards.flatMap(card => card.stages));
  const warns: FactoryViewProblem[] = [];
  for (const stage of graph.stages.filter(entry => entry.inFlow)) {
    if (!placed.has(stage.workflow))
      warns.push({
        severity: 'warning',
        path: ['map', 'cards'],
        message: `stage "${stage.workflow}" is on no map card`,
      });
    if (view.stages[stage.workflow] === undefined)
      warns.push({
        severity: 'warning',
        path: ['stages'],
        message: `stage "${stage.workflow}" has no words`,
      });
  }
  for (const group of graph.groups)
    if (view.groups?.[group.name] === undefined)
      warns.push({
        severity: 'warning',
        path: ['groups'],
        message: `group "${group.name}" has no words`,
      });
  return warns;
}

/** Every name `view` uses that `graph` lacks (errors), then what it leaves out (warnings). */
export function checkFactoryView(view: FactoryView, graph: PackGraph): FactoryViewProblem[] {
  const index = indexGraph(graph);
  return [
    ...stageErrors(view, index),
    ...keyErrors(view, index),
    ...groupErrors(view, graph),
    ...mapErrors(view, index),
    ...howItWorksErrors(view, index),
    ...warnings(view, graph),
  ];
}
