/**
 * A pack's factory view (`schemas/factory-view.ts`) reconciled with the pack graph (DESIGN.md,
 * COMBINED direction: "A stale entry drops only itself, and says so"). The view is
 * presentation only, so it may only name what the graph has. A pack changes under its file (a
 * stage renamed, a document without groups), so a name the graph lacks costs only the entry
 * that names it: the entry leaves the served view and is reported `dropped`. That covers a
 * stage, step, outcome, option, group stage or `merged` stage the graph lacks, a progress loop
 * or step of a stage the graph has but without it, and a How it works edge between stages no
 * arrow connects.
 *
 * Meaning entries are the exception: a `rounds`, `returns`, `approves` or `change` entry
 * naming a workflow the graph lacks is kept, and the workflow is served as `retired`
 * (reported `retired`), because old runs carry the old name and board cards read their rounds
 * from them. What the graph has and the file gives no words (a stage, step, outcome value, or
 * option a hand-off leaves on) is `unworded`, and an in-flow stage the file's groups leave out
 * is `ungrouped`. Every problem is an error for `check:factory-view`; a console shows them and
 * draws what is left. Read time (`packViewOf`, through `servedFactoryView`) and the check run
 * this one pass.
 */
import type { PackGraph } from './pack-graph';
import { reconcileProgress } from './factory-view-progress-check';
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
type StageWords = FactoryView['stages'][string];
type Drilldown = NonNullable<StageWords['drilldown']>;

/**
 * One reconcile in progress: `view` is the copy being pruned, and `add` records what happened
 * at a path of the file as written (so a path names the entry the author wrote).
 */
export interface Reconciling {
  view: FactoryView;
  graph: PackGraph;
  /** Graph stages by `workflow` name, the name the view uses. */
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

const splitKey = (key: string): { stage: string; name: string } => {
  const at = key.lastIndexOf(':');
  return { stage: key.slice(0, at), name: key.slice(at + 1) };
};

const noStage = (stage: string, graph: PackGraph): string =>
  `names stage "${stage}", which pack "${graph.pack}" does not have`;

const noStep = (stage: string, id: string): string =>
  `names step "${id}", which stage "${stage}" does not have`;

/** A stage's step words for steps it has. */
function reconcileStepWords(r: Reconciling, name: string, words: StageWords, steps: Set<string>) {
  for (const id of Object.keys(words.steps ?? {}))
    if (!steps.has(id)) {
      delete words.steps?.[id];
      r.add('dropped', ['stages', name, 'steps', id], noStep(name, id));
    }
}

/**
 * A drill-down card's covered steps the stage has; a card covering none is dropped. A step two
 * cards cover is the file contradicting itself, which no drift causes.
 */
function reconcileCard(
  r: Reconciling,
  at: ProblemPath,
  card: Drilldown['phases'][number]['cards'][number],
  steps: Set<string>,
  covered: Map<string, string>
): Drilldown['phases'][number]['cards'] {
  const name = String(at[1]);
  const covers = card.covers.filter((id, k) => {
    if (!steps.has(id)) {
      r.add('dropped', [...at, 'covers', k], noStep(name, id));
      return false;
    }
    const first = covered.get(id);
    if (first !== undefined)
      r.add('invalid', [...at, 'covers', k], `covers step "${id}", which card "${first}" covers`);
    else covered.set(id, card.title);
    return true;
  });
  if (covers.length > 0) return [{ ...card, covers }];
  r.add('dropped', at, `card "${card.title}" covers no step stage "${name}" has`);
  return [];
}

/** A stage's drill-down; a phase or drill-down left with no card goes with its last card. */
function reconcileDrilldown(r: Reconciling, name: string, words: StageWords, steps: Set<string>) {
  if (words.drilldown === undefined) return;
  const covered = new Map<string, string>();
  const phases = words.drilldown.phases.flatMap((phase, p) => {
    const at: ProblemPath = ['stages', name, 'drilldown', 'phases', p];
    const cards = phase.cards.flatMap((card, c) =>
      reconcileCard(r, [...at, 'cards', c], card, steps, covered)
    );
    if (cards.length > 0) return [{ ...phase, cards }];
    r.add('dropped', at, `phase "${phase.label}" has no card left`);
    return [];
  });
  if (phases.length > 0) words.drilldown = { ...words.drilldown, phases };
  else {
    delete words.drilldown;
    r.add('dropped', ['stages', name, 'drilldown'], 'has no phase left');
  }
}

/** Each `stages` entry's stage, its step names and the steps its drill-down covers. */
function reconcileStages(r: Reconciling): void {
  for (const [name, words] of Object.entries(r.view.stages)) {
    const stage = r.stages.get(name);
    if (stage === undefined) {
      delete r.view.stages[name];
      r.add('dropped', ['stages', name], noStage(name, r.graph));
      continue;
    }
    const steps = new Set(stage.nodes.map(node => node.id));
    reconcileStepWords(r, name, words, steps);
    reconcileDrilldown(r, name, words, steps);
  }
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

/** Why an `outcomes` key names what the graph lacks, or undefined. */
function outcomeMissing(r: Reconciling, key: string): string | undefined {
  const { stage: name, name: outcome } = splitKey(key);
  const stage = r.stages.get(name);
  if (stage === undefined) return noStage(name, r.graph);
  if (outcome === '*' || stage.outcome?.values.some(entry => entry.value === outcome) === true)
    return undefined;
  return `names outcome "${outcome}", which stage "${name}" does not declare`;
}

/** Why an `answers` key names what the graph lacks, or undefined. */
function answerMissing(r: Reconciling, key: string): string | undefined {
  const { stage: name, name: option } = splitKey(key);
  const stage = r.stages.get(name);
  if (stage === undefined) return noStage(name, r.graph);
  if (optionBacked(r.graph, stage, option)) return undefined;
  return `names option "${option}" of stage "${name}", but no asks-settled hand-off of the pack leaves on it`;
}

/** The entries of an `outcomes` or `answers` object naming what the graph has. */
function reconcileKeyed(
  r: Reconciling,
  key: 'outcomes' | 'answers',
  missing: (r: Reconciling, entry: string) => string | undefined
): void {
  const entries = r.view[key];
  if (entries === undefined) return;
  for (const name of Object.keys(entries)) {
    const why = missing(r, name);
    if (why === undefined) continue;
    delete entries[name];
    r.add('dropped', [key, name], why);
  }
}

/**
 * The file's groups keep the stages the graph has, each in one group; a group left with none
 * is dropped, and the map falls back to the graph's groups when no group is left.
 */
function reconcileGroups(r: Reconciling): void {
  const { groups } = r.view;
  if (groups === undefined) return;
  const holder = new Map<string, string>();
  const kept = groups.flatMap((group, g) => {
    const stages = group.stages.filter((stage, s) => {
      const at: ProblemPath = ['groups', g, 'stages', s];
      const first = holder.get(stage);
      if (!r.stages.has(stage)) r.add('dropped', at, noStage(stage, r.graph));
      else if (first !== undefined)
        r.add('invalid', at, `names stage "${stage}", which group "${first}" holds already`);
      else {
        holder.set(stage, group.name);
        return true;
      }
      return false;
    });
    if (stages.length > 0) return [{ ...group, stages }];
    r.add('dropped', ['groups', g], `group "${group.name}" has no stage of the pack left`);
    return [];
  });
  if (kept.length > 0) r.view.groups = kept;
  else delete r.view.groups;
}

/** The stage `merged` names; without it the map takes the last in-flow stage. */
function reconcileMerged(r: Reconciling): void {
  if (r.view.merged === undefined || r.stages.has(r.view.merged)) return;
  r.add('dropped', ['merged'], noStage(r.view.merged, r.graph));
  delete r.view.merged;
}

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

/** The label an outcome value reads as: its exact entry's, else its stage's `stage:*` entry's. */
export function outcomeLabelOf(
  view: Pick<FactoryView, 'outcomes'>,
  workflow: string,
  value: string
): string | undefined {
  return view.outcomes?.[`${workflow}:${value}`]?.label ?? view.outcomes?.[`${workflow}:*`]?.label;
}

/** The label an ask option of a stage reads as on a map arrow: its exact entry's only. */
function answerLabelOf(
  view: Pick<FactoryView, 'answers'>,
  workflow: string,
  option: string
): string | undefined {
  return view.answers?.[`${workflow}:${option}`]?.label;
}

/** The options the graph's asks-settled arrows out of `stage` leave on, each once, in order. */
const optionsOf = (graph: PackGraph, stage: GraphStage): string[] => [
  ...new Set(
    graph.arrows.flatMap(({ from }) =>
      'settled' in from && from.stage === stage.name && from.option !== undefined
        ? [from.option]
        : []
    )
  ),
];

/**
 * An in-flow stage with no words, a step of it with none, and an outcome value or an ask option
 * of it with no label: a console would show the raw id ("Build · build", "take-as-is"). Only
 * in-flow stages: no item stands at the rest.
 */
function unworded(r: Reconciling): void {
  for (const stage of r.graph.stages.filter(entry => entry.inFlow)) {
    const { workflow } = stage;
    const words = r.view.stages[workflow];
    if (words === undefined)
      r.add('unworded', ['stages', workflow], `stage "${workflow}" has no words`);
    for (const node of stage.nodes)
      if (words?.steps?.[node.id] === undefined)
        r.add(
          'unworded',
          ['stages', workflow, 'steps', node.id],
          `step "${node.id}" of stage "${workflow}" has no words`
        );
    for (const { value } of stage.outcome?.values ?? [])
      if (outcomeLabelOf(r.view, workflow, value) === undefined)
        r.add(
          'unworded',
          ['outcomes', `${workflow}:${value}`],
          `outcome "${value}" of stage "${workflow}" has no label`
        );
    unwordedOptions(r, stage);
  }
}

/** The options an in-flow stage's asks-settled arrows leave on that have no label. */
function unwordedOptions(r: Reconciling, stage: GraphStage): void {
  const { workflow } = stage;
  for (const option of optionsOf(r.graph, stage))
    if (answerLabelOf(r.view, workflow, option) === undefined)
      r.add(
        'unworded',
        ['answers', `${workflow}:${option}`],
        `option "${option}" of stage "${workflow}" has no label`
      );
}

/**
 * Where the file declares groups, every in-flow stage is in one, apart from the stage items
 * leave the map by, which the map draws on its own.
 */
function ungrouped(r: Reconciling): void {
  const { groups } = r.view;
  if (groups === undefined) return;
  const inFlow = r.graph.stages.filter(stage => stage.inFlow).map(stage => stage.workflow);
  const merged = r.view.merged ?? inFlow.at(-1);
  const held = new Set(groups.flatMap(group => group.stages));
  for (const workflow of inFlow)
    if (workflow !== merged && !held.has(workflow))
      r.add('ungrouped', ['groups'], `stage "${workflow}" is in none of the file's groups`);
}

/**
 * `view` with every entry naming what `graph` lacks taken out (meaning entries kept, their
 * workflows retired), and the problems in the order they were found. `view` is not changed.
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
  reconcileStages(r);
  reconcileKeyed(r, 'outcomes', outcomeMissing);
  reconcileKeyed(r, 'answers', answerMissing);
  reconcileGroups(r);
  reconcileMerged(r);
  reconcileHowItWorks(r);
  reconcileProgress(r, view);
  unworded(r);
  ungrouped(r);
  return { view: r.view, problems };
}
