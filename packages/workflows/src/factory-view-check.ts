/**
 * A pack's view file (`schemas/factory-view.ts`) reconciled with the pack graph. The file is
 * the How it works explainer only; where its picture names stages, it may only name what the
 * graph has and draw edges the graph's arrows back. A name or an edge the graph lacks costs only
 * itself: it leaves the served view and is reported `dropped`. The pack's words, groups and
 * declarations are not the file's: the graph serves them from the workflows' `display:` blocks
 * and the pack's document, and `archon validate` checks them. Every problem is an error for
 * `check:factory-view`; a console shows them and draws what is left. Read time (`packViewOf`,
 * through `servedFactoryView`) and the check run this one pass.
 */
import type { PackGraph } from './pack-graph';
import { PACK_SHARED_DIRECTORY } from './packaged-workflow';
import {
  FACTORY_VIEW_FILE,
  type FactoryView,
  type FactoryViewProblem,
} from './schemas/factory-view';

/** Where in a pack its view file is, as `readPackDeclarations` takes it. */
export const FACTORY_VIEW_PATH = `${PACK_SHARED_DIRECTORY}/${FACTORY_VIEW_FILE}`;

type ProblemPath = FactoryViewProblem['path'];
type GraphStage = PackGraph['stages'][number];

/**
 * One reconcile in progress: `view` is the copy being pruned, and `add` records what happened
 * at a path of the file as written (so a path names the entry the author wrote).
 */
interface Reconciling {
  view: FactoryView;
  graph: PackGraph;
  /** Graph stages by `workflow` name, the name the picture uses. */
  stages: ReadonlyMap<string, GraphStage>;
  add(kind: FactoryViewProblem['kind'], path: ProblemPath, message: string): void;
}

const pairKey = (from: string, to: string): string => `${from}\0${to}`;

/** The stage pairs the graph's arrows join, by `workflow` name. */
function joinedPairs(graph: PackGraph): ReadonlySet<string> {
  const workflowOf = new Map(graph.stages.map(stage => [stage.name, stage.workflow]));
  const joined = new Set<string>();
  // Arrows name stages by `name` (`owner/name:workflow` when installed). Every arrow counts,
  // active or only declared: the view draws the pack as designed.
  for (const arrow of graph.arrows) {
    const from = workflowOf.get(arrow.from.stage);
    const to = workflowOf.get(arrow.to);
    if (from !== undefined && to !== undefined) joined.add(pairKey(from, to));
  }
  return joined;
}

const noStage = (stage: string, graph: PackGraph): string =>
  `names stage "${stage}", which pack "${graph.pack}" does not have`;

type Picture = FactoryView['howItWorks']['views'][string];

/** A How it works card's stages the graph has; a card left with none stays, bound to nothing. */
function reconcilePictureCards(
  r: Reconciling,
  at: ProblemPath,
  picture: Picture,
  stagesOf: Map<string, readonly string[]>
): Picture['cards'] {
  return picture.cards.map((card, c) => {
    if (card.stages === undefined) return card;
    const stages = card.stages.filter((stage, s) => {
      if (r.stages.has(stage)) return true;
      r.add('dropped', [...at, 'cards', c, 'stages', s], noStage(stage, r.graph));
      return false;
    });
    if (stages.length === 0) {
      const { stages: _gone, ...unbound } = card;
      return unbound;
    }
    stagesOf.set(card.id, stages);
    return { ...card, stages };
  });
}

/**
 * How it works stays a hand-drawn picture, but where its cards name stages it may not disagree
 * with the pack. A `feeds` or `loops-back` edge between two stage cards follows a graph arrow,
 * or leaves the picture. A `calls` edge asks someone and hands no work on, so it is not compared.
 */
function reconcileHowItWorks(r: Reconciling): void {
  const joined = joinedPairs(r.graph);
  for (const [viewId, picture] of Object.entries(r.view.howItWorks.views)) {
    const at: ProblemPath = ['howItWorks', 'views', viewId];
    const stagesOf = new Map<string, readonly string[]>();
    const cards = reconcilePictureCards(r, at, picture, stagesOf);
    const edges = picture.edges.filter((edge, e) => {
      const from = stagesOf.get(edge.from);
      const to = stagesOf.get(edge.to);
      if (edge.kind === 'calls' || from === undefined || to === undefined) return true;
      if (from.some(a => to.some(b => joined.has(pairKey(a, b))))) return true;
      r.add(
        'dropped',
        [...at, 'edges', e],
        `joins stages ${from.join(', ')} to ${to.join(', ')}, which no arrow of the pack graph connects`
      );
      return false;
    });
    r.view.howItWorks.views[viewId] = { ...picture, cards, edges };
  }
}

/**
 * `view` with every picture card's stage and edge the graph lacks taken out, and the problems in
 * the order they were found. `view` is not changed.
 */
export function reconcileFactoryView(
  view: FactoryView,
  graph: PackGraph
): { view: FactoryView; problems: FactoryViewProblem[] } {
  const problems: FactoryViewProblem[] = [];
  const r: Reconciling = {
    view: structuredClone(view),
    graph,
    stages: new Map(graph.stages.map(stage => [stage.workflow, stage])),
    add: (kind, path, message) => problems.push({ kind, path, message }),
  };
  reconcileHowItWorks(r);
  return { view: r.view, problems };
}
