/**
 * The curated map's model: the pack's factory view file (`FactoryView`) joined with its pack
 * graph, in the shape the map, its stage modal and their libs draw (ported from v1, where the
 * same shape was the view file itself). Pure, and the only place the two are joined.
 *
 * - A map **stage** is one card of the file's `map.cards`, standing for one or more graph
 *   stages (`workflows`, by their `workflow` name). A card of one graph stage takes that
 *   stage's words; a card of several takes its own (`factory-view.ts`).
 * - A **column** is a document group of the graph (as the board's columns are), holding the
 *   cards whose first graph stage it holds, in card order. A card whose stages no group holds
 *   is a column of its own. The file's last card is where items leave the map: it is a column
 *   of its own, and the board's Done is counted on it (`map-live.ts`). The pack names no stage
 *   that items leave by, so the map's reading order stands for it.
 * - A card's **drill-down** is the drill-downs of its graph stages, phase after phase, in the
 *   card's order; each card of it covers steps of the graph stage it was written under.
 */
import type { PackGraph } from '../../skills/items';
import type { FactoryView } from '../api';

type Drilldown = NonNullable<FactoryView['stages'][string]['drilldown']>;
type ViewDrilldownCard = Drilldown['phases'][number]['cards'][number];

/** One card of a stage's drill-down, its covered steps named with the graph stage they are of. */
export interface CuratedDrilldownCard extends Omit<ViewDrilldownCard, 'covers'> {
  covers: { workflow: string; steps: string[] }[];
}

export interface CuratedStage {
  /** The map card's id. */
  id: string;
  label: string;
  short?: string;
  blurb: string;
  /** The graph stages the card stands for, by `workflow` name, in the card's order. */
  workflows: string[];
  drilldown?: { phases: { label: string; cards: CuratedDrilldownCard[] }[] };
}

export interface CuratedColumn {
  id: string;
  label: string;
  blurb: string;
  /** Its map stages, by card id. */
  stages: string[];
}

/** A map stage's drill-down: its graph stages' phases, in the card's order. */
export type FactoryDrilldown = NonNullable<CuratedStage['drilldown']>;

export interface CuratedView {
  title: string;
  summary: string;
  /** One per map card, in the file's drawing order. */
  stages: CuratedStage[];
  columns: CuratedColumn[];
  /** The card the board's Done is counted on: the file's last. */
  landed: { stage: string };
  /** Step names by graph stage and step id. */
  steps: Record<string, Record<string, string>>;
  /** Each graph stage's label, by its `workflow` name. */
  stageLabels: Record<string, string>;
  /** The file's short label for an outcome, by `stage:outcome` or `stage:*`, where it gives one. */
  outcomeLabels: Record<string, string>;
  map: {
    cards: { stage: string }[];
    /** The file's words for the arrows between two cards (`map.edges`). */
    arrows: { from: string; to: string; label: string }[];
    notes?: { text: string; near: string }[];
  };
  /** Each graph stage's `workflow` name to its name in the graph's arrows (`owner/name:workflow`). */
  runNames: Record<string, string>;
}

type MapCard = FactoryView['map']['cards'][number];

function stageOf(view: FactoryView, card: MapCard): CuratedStage {
  const [first = card.id] = card.stages;
  const one = card.stages.length === 1 ? view.stages[first] : undefined;
  const phases = card.stages.flatMap(workflow =>
    (view.stages[workflow]?.drilldown?.phases ?? []).map(phase => ({
      label: phase.label,
      cards: phase.cards.map(({ covers, ...rest }) => ({
        ...rest,
        covers: [{ workflow, steps: covers }],
      })),
    }))
  );
  const short = card.short ?? one?.short;
  return {
    id: card.id,
    label: card.label ?? one?.label ?? view.stages[first]?.label ?? card.id,
    ...(short === undefined ? {} : { short }),
    blurb: card.blurb ?? one?.blurb ?? view.stages[first]?.blurb ?? '',
    workflows: [...card.stages],
    ...(phases.length === 0 ? {} : { drilldown: { phases } }),
  };
}

/** A column id from a group's name: lowercase words joined by `-`. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The map's columns, by the rule in the header. A column holding one card takes the card's
 * words, as a one-stage card shows them; one holding several takes its group's name.
 */
function columnsFor(view: FactoryView, graph: PackGraph, stages: CuratedStage[]): CuratedColumn[] {
  const groups = graph.groups;
  const last = stages.at(-1);
  const columns: (CuratedColumn & { group: string | undefined })[] = [];
  for (const stage of stages) {
    const group =
      stage === last
        ? undefined
        : groups.find(entry => entry.stages.includes(stage.workflows[0] ?? ''))?.name;
    const held = group === undefined ? undefined : columns.find(entry => entry.group === group);
    if (held !== undefined) held.stages.push(stage.id);
    else columns.push({ id: '', label: '', blurb: '', stages: [stage.id], group });
  }
  return columns.map(({ group, stages: ids }) => {
    const [only] = ids;
    const card = stages.find(stage => stage.id === only);
    if (ids.length === 1 && card !== undefined)
      return { id: card.id, label: card.label, blurb: card.short ?? card.blurb, stages: ids };
    const name = group ?? '';
    return { id: slug(name), label: name, blurb: view.groups?.[name]?.blurb ?? '', stages: ids };
  });
}

export function curatedView(view: FactoryView, graph: PackGraph): CuratedView {
  const stages = view.map.cards.map(card => stageOf(view, card));
  const steps: Record<string, Record<string, string>> = {};
  for (const [workflow, stage] of Object.entries(view.stages))
    if (stage.steps !== undefined) steps[workflow] = stage.steps;
  return {
    title: view.title,
    summary: view.summary,
    stages,
    columns: columnsFor(view, graph, stages),
    landed: { stage: stages.at(-1)?.id ?? '' },
    steps,
    stageLabels: Object.fromEntries(
      Object.entries(view.stages).map(([workflow, stage]) => [workflow, stage.label])
    ),
    outcomeLabels: Object.fromEntries(
      Object.entries(view.outcomes ?? {}).flatMap(([key, outcome]) =>
        outcome.label === undefined ? [] : [[key, outcome.label]]
      )
    ),
    map: {
      cards: stages.map(stage => ({ stage: stage.id })),
      arrows: (view.map.edges ?? []).map(edge => ({ ...edge })),
      ...(view.map.notes === undefined ? {} : { notes: view.map.notes }),
    },
    runNames: Object.fromEntries(graph.stages.map(stage => [stage.workflow, stage.name])),
  };
}
