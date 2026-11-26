/**
 * A pack's words and meaning, read from its graph (DESIGN.md, COMBINED direction: "No
 * hand-synced view file"): the one place the graph's `display:` blocks and its document's
 * front matter become what the console's map, stage modal and board cards read. The engine
 * serves them as the pack wrote them and gives them no meaning; the meaning is the console's,
 * here:
 *
 * - a stage's `display` gives its label, short line, blurb and drill-down (`phases`); its
 *   nodes' `display.label` its step names, an included node's under its expanded id;
 * - an outcome value's `display` gives its label and story, and the stage's `display.story`
 *   the story of a run whose outcome tells none (`stage:*`);
 * - `display.answers` labels an ask option (`stage:option`);
 * - a mark `means: returns` is a step outcome that sends an item back, `means: approves` one
 *   that approves its round; any other `means` is not the console's and is left alone;
 * - `results.round` and `results.allowance` number a stage's runs as check rounds, and
 *   `results.change` names the change a run proposed;
 * - each `display.replaces` entry is a retired workflow whose runs stand at the stage that
 *   declares it, with its own marks, `results` and `loops.round` (a loop whose iterations are
 *   rounds). One naming a stage the pack still has is left out: `archon validate` refuses it.
 * - the document's `words` name what the board counts, and its `exit` is the stage items leave
 *   the map by.
 *
 * Pure, and derived once per graph object (`graphWords`), so a reader holding the same graph
 * holds the same words.
 */
import type { PackGraph } from '../../skills/items';

type GraphStage = PackGraph['stages'][number];
type StageDisplay = NonNullable<GraphStage['display']>;
type OutcomeDisplay = NonNullable<NonNullable<GraphStage['outcome']>['values'][number]['display']>;

/** A step whose recorded outcome decides something about the item's round. */
export interface DecisionPoint {
  workflow: string;
  node: string;
  outcome: string;
}

/**
 * Where a workflow's runs give an item's check rounds: each iteration of `loop` is a round, or
 * each run is one, numbered and bounded by its result at `round` and `allowance`.
 */
export type RoundsSource =
  | { workflow: string; loop: string }
  | { workflow: string; round: string; allowance?: string };

/** Where a workflow's runs name the change they proposed, in their result. */
export interface ChangeSource {
  workflow: string;
  pointer: string;
}

/** A retired workflow and the stage its runs stand at. */
export interface RetiredWorkflow {
  workflow: string;
  stage: string | null;
}

export type DrilldownPhase = NonNullable<StageDisplay['phases']>[number];

export interface StageWords {
  label: string;
  short?: string;
  blurb?: string;
  /** Step names by recorded step id. */
  steps: Record<string, string>;
  drilldown?: { phases: DrilldownPhase[] };
}

/** The words the board counts with, by the names the console looks them up by. */
export interface CountWords {
  round?: string;
  rounds?: string;
  sentBack?: string;
  parked?: string;
  workOrder?: string;
  workOrders?: string;
}

export interface FactoryWords {
  /** By `workflow` name; a stage the pack gives no `display` is absent. */
  stages: Record<string, StageWords>;
  /** By `stage:outcome`, and `stage:*` for the stage's own story. */
  outcomes: Record<string, OutcomeDisplay>;
  /** By `stage:option`. */
  answers: Record<string, { label: string }>;
  words: CountWords;
  retired: RetiredWorkflow[];
  rounds: RoundsSource[];
  returns: DecisionPoint[];
  approves: DecisionPoint[];
  change: ChangeSource[];
  /** The stage items leave the map by, when the document names one in flow. */
  merged?: string;
}

/** What a run's declarations give, for one workflow name (a stage's or a retired one's). */
interface Declared {
  marks?: StageDisplay['marks'];
  results?: StageDisplay['results'];
  loops?: Record<string, string>;
}

function meaningOf(workflow: string, declared: Declared, into: FactoryWords): void {
  for (const mark of declared.marks ?? []) {
    const point = { workflow, node: mark.node, outcome: mark.outcome };
    if (mark.means === 'returns') into.returns.push(point);
    else if (mark.means === 'approves') into.approves.push(point);
  }
  const results = declared.results ?? {};
  const loop = declared.loops?.round;
  if (loop !== undefined) into.rounds.push({ workflow, loop });
  else if (results.round !== undefined)
    into.rounds.push({
      workflow,
      round: results.round,
      ...(results.allowance === undefined ? {} : { allowance: results.allowance }),
    });
  if (results.change !== undefined) into.change.push({ workflow, pointer: results.change });
}

function stageWordsOf(stage: GraphStage, display: StageDisplay): StageWords {
  const steps: Record<string, string> = {};
  for (const node of stage.nodes)
    if (node.display !== undefined) steps[node.id] = node.display.label;
  return {
    label: display.label,
    ...(display.short === undefined ? {} : { short: display.short }),
    ...(display.blurb === undefined ? {} : { blurb: display.blurb }),
    steps,
    ...(display.phases === undefined ? {} : { drilldown: { phases: display.phases } }),
  };
}

/** One stage's words and declarations, and those of the retired workflows it replaces. */
function addStage(stage: GraphStage, live: ReadonlySet<string>, into: FactoryWords): void {
  const { workflow, display } = stage;
  for (const value of stage.outcome?.values ?? [])
    if (value.display !== undefined) into.outcomes[`${workflow}:${value.value}`] = value.display;
  if (display === undefined) return;
  into.stages[workflow] = stageWordsOf(stage, display);
  if (display.story !== undefined) into.outcomes[`${workflow}:*`] = { story: display.story };
  for (const [option, answer] of Object.entries(display.answers ?? {}))
    into.answers[`${workflow}:${option}`] = answer;
  meaningOf(workflow, display, into);
  // A replaces entry naming a live stage is left alone: `archon validate` refuses it.
  for (const replaced of display.replaces ?? [])
    if (!live.has(replaced.workflow)) {
      into.retired.push({ workflow: replaced.workflow, stage: workflow });
      meaningOf(replaced.workflow, replaced, into);
    }
}

function wordsOf(graph: PackGraph): FactoryWords {
  const live = new Set(graph.stages.map(stage => stage.workflow));
  const into: FactoryWords = {
    stages: {},
    outcomes: {},
    answers: {},
    words: { ...graph.document?.words },
    retired: [],
    rounds: [],
    returns: [],
    approves: [],
    change: [],
    ...(graph.document?.exit === undefined ? {} : { merged: graph.document.exit }),
  };
  for (const stage of graph.stages) addStage(stage, live, into);
  return into;
}

const derived = new WeakMap<PackGraph, FactoryWords>();

/** The graph's words and meaning, derived once per graph object. */
export function graphWords(graph: PackGraph): FactoryWords {
  const held = derived.get(graph);
  if (held !== undefined) return held;
  const words = wordsOf(graph);
  derived.set(graph, words);
  return words;
}
