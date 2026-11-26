/**
 * The factory's structure, read from the pack graph (`GET /api/packs/{pack}/graph`): the steps
 * of a stage and the arrows between stages, each worded by the outcome or answer it carries:
 * the pack's label for the outcome or ask option where it gives one (its workflow's `display:`,
 * `graph-view.ts`). An outcome the pack does not word reads as its value in words
 * (`outcomeWords`); `archon validate` warns on it.
 *
 * Pure.
 */
import type { PackGraph } from '../../skills/items';
import { stageWords } from './stage-words';

/**
 * What of the view the projection reads: the map's stages with the graph stages they stand
 * for, and each graph stage's name in the graph's arrows (`owner/name:workflow` when installed).
 */
export interface StructureView {
  stages: readonly { id: string; label: string; workflows: readonly string[] }[];
  runNames: Readonly<Record<string, string>>;
  /** The file's label of each `workflow:outcome` or `workflow:*` that has one. */
  outcomeLabels: Readonly<Record<string, string>>;
  /** The file's label of each `workflow:option` that has one. */
  answerLabels: Readonly<Record<string, string>>;
}

/** One arrow the map draws, between two stages, labelled with what it carries. */
export interface MapArrow {
  from: string;
  to: string;
  /** The outcome and answer values its graph arrows carry, each once, joined with ", ". */
  label: string;
}

/** What an arrow of the graph says: its outcome, or what settles the ask it follows. */
export function wordsOf(from: PackGraph['arrows'][number]['from']): string {
  if ('outcome' in from) return from.outcome;
  if (from.option !== undefined) return from.option;
  return from.settled === 'any' ? 'asked' : from.settled;
}

/** The view's arrow words: what `arrowWords` and `outcomeWords` read. */
export type ArrowLabels = Pick<StructureView, 'outcomeLabels' | 'answerLabels'>;

type OutcomeLabels = Pick<StructureView, 'outcomeLabels'>;

/**
 * The file's label for an outcome of `workflow`: the exact `workflow:outcome` entry, then the
 * stage's `workflow:*`; undefined when it gives none. The one lookup of outcome labels: the
 * map's arrows, its stage modal and the board's cards all word an outcome through it.
 */
export function outcomeLabel(
  labels: OutcomeLabels,
  workflow: string,
  outcome: string | null
): string | undefined {
  return (
    (outcome === null ? undefined : labels.outcomeLabels[`${workflow}:${outcome}`]) ??
    labels.outcomeLabels[`${workflow}:*`]
  );
}

/**
 * What an outcome of `workflow` says: its label (`outcomeLabel`), else its value in words
 * (`send-back` reads "Send back"), as `stageWords` words a stage; `check:factory-view` reports
 * an in-flow outcome the file does not word. `workflow` null (a run no pack places) has no label.
 */
export function outcomeWords(
  labels: OutcomeLabels,
  workflow: string | null,
  outcome: string
): string {
  return (
    (workflow === null ? undefined : outcomeLabel(labels, workflow, outcome)) ?? stageWords(outcome)
  );
}

/**
 * What an arrow out of `workflow` says, on the curated map and the full workflow alike: its
 * outcome's words (`outcomeWords`), or its ask option's label (the exact `workflow:option` entry
 * only, so a new option is never hidden under another's words), else `wordsOf`.
 */
export function arrowWords(
  labels: ArrowLabels,
  workflow: string,
  from: PackGraph['arrows'][number]['from']
): string {
  if ('outcome' in from) return outcomeWords(labels, workflow, from.outcome);
  return (
    (from.option === undefined ? undefined : labels.answerLabels[`${workflow}:${from.option}`]) ??
    wordsOf(from)
  );
}

/** The map stage of each graph stage the view lists: the first listing it. */
function stageByGraphName(view: StructureView): Map<string, string> {
  const stages = new Map<string, string>();
  for (const stage of view.stages)
    for (const workflow of stage.workflows) {
      const name = view.runNames[workflow];
      if (name === undefined || stages.has(name)) continue;
      stages.set(name, stage.id);
    }
  return stages;
}

/**
 * Every pair of stages the graph connects, once each, in the graph's order, labelled with the
 * values its arrows carry in the graph's order (`arrowWords`). The map lays its pills and lanes
 * out in this order.
 *
 * Every arrow counts, active or not: an install without trigger files still runs the pack's
 * declared hand-offs. Two kinds are left out. An arrow over a `depends_on` link restarts a stage
 * on another item that waits there, so it moves no item between stages. An arrow into or out of
 * a workflow no stage lists (a drain) joins no two stages.
 */
export function mapArrows(view: StructureView, graph: PackGraph): MapArrow[] {
  const stageOf = stageByGraphName(view);
  const workflowOf = new Map(
    Object.entries(view.runNames).map(([workflow, name]) => [name, workflow])
  );
  const drawn = new Map<string, { from: string; to: string; words: string[] }>();
  for (const arrow of graph.arrows) {
    if (arrow.linked?.kind === 'depends_on') continue;
    const from = stageOf.get(arrow.from.stage);
    const to = stageOf.get(arrow.to);
    if (from === undefined || to === undefined) continue;
    const key = JSON.stringify([from, to]);
    const pair = drawn.get(key) ?? { from, to, words: [] };
    const word = arrowWords(view, workflowOf.get(arrow.from.stage) ?? '', arrow.from);
    if (!pair.words.includes(word)) pair.words.push(word);
    drawn.set(key, pair);
  }
  return [...drawn.values()].map(({ from, to, words }) => ({
    from,
    to,
    label: words.join(', '),
  }));
}

/** One arrow out of a stage, labelled with what it carries. */
export interface HandOff {
  /** The arrow's label; undefined for an unlabelled one. */
  label: string | undefined;
  /** The stage it goes to, by id and by its label. */
  to: string;
  toLabel: string;
}

/**
 * Where items go from a stage: every arrow the map draws out of it into another stage. This is
 * where a map pill's outcomes past its two lines are listed in full. An arrow back into the
 * stage itself goes nowhere and is left out.
 */
export function stageHandOffs(
  view: Pick<StructureView, 'stages'>,
  arrows: readonly MapArrow[],
  stageId: string
): HandOff[] {
  return arrows
    .filter(arrow => arrow.from === stageId && arrow.to !== stageId)
    .map(arrow => ({
      label: arrow.label,
      to: arrow.to,
      // A view stage's label is already `stageLabel`'s (curated-view.ts); the fallback is its
      // no-label branch, so a chip never names a stage by its raw id.
      toLabel: view.stages.find(stage => stage.id === arrow.to)?.label ?? stageWords(arrow.to),
    }));
}

/** One graph stage of a map stage and its steps, by step id in the graph's order. */
export interface StageWorkflowSteps {
  workflow: string;
  /** Undefined when the graph has no such stage. */
  steps: string[] | undefined;
}

/** The steps of each graph stage a map stage lists, from the graph. */
export function stageSteps(
  stage: { workflows: readonly string[] },
  graph: PackGraph
): StageWorkflowSteps[] {
  return stage.workflows.map(workflow => {
    const found = graph.stages.find(entry => entry.workflow === workflow);
    return { workflow, steps: found?.nodes.map(node => node.id) };
  });
}
