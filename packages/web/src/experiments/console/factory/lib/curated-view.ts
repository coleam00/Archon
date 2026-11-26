/**
 * The curated map's model: the pack's factory view file (`FactoryView`) joined with its pack
 * graph, in the shape the map, its stage modal and their libs draw. Pure, and the only place
 * the two are joined. The file gives only words; every card, row and column comes from the
 * graph.
 *
 * - A map **stage** is one in-flow stage of the graph, in the graph's order (its flow order),
 *   with its words from the file's `stages`. Its id is the stage's `workflow` name.
 * - A **column** is a group (`groupsOf`: the file's groups, else the pack document's), holding
 *   its in-flow stages in flow order. A stage no group holds is a column of its own. Columns
 *   come in the order their first stage comes in flow, which is the group order while each
 *   group is a run of neighbouring stages. With no groups at all, every stage is a column.
 *   Before any of that, the stage the file names `merged` is taken out: it is where items
 *   leave the map, a column of its own at the end, and the board's Merged column is counted
 *   on it (`map-live.ts`). The graph names no stage that items leave by; a file that names
 *   none leaves the last in-flow stage there.
 * - A stage's **drill-down** is the file's, each card covering steps of that stage.
 */
import type { PackGraph } from '../../skills/items';
import type { FactoryView } from '../api';
import { groupsOf, type GroupKind, type ViewGroup } from './view-groups';

type Drilldown = NonNullable<FactoryView['stages'][string]['drilldown']>;
type ViewDrilldownCard = Drilldown['phases'][number]['cards'][number];

/** One card of a stage's drill-down, its covered steps named with the graph stage they are of. */
export interface CuratedDrilldownCard extends Omit<ViewDrilldownCard, 'covers'> {
  covers: { workflow: string; steps: string[] }[];
}

export interface CuratedStage {
  /** The graph stage's `workflow` name. */
  id: string;
  label: string;
  short?: string;
  blurb: string;
  /** The graph stage it stands for, by `workflow` name: `[id]`. */
  workflows: string[];
  drilldown?: { phases: { label: string; cards: CuratedDrilldownCard[] }[] };
}

export interface CuratedColumn {
  id: string;
  label: string;
  blurb: string;
  /** Its map stages, by id, in flow order. */
  stages: string[];
  /** Its group's kind, which gives its colour and kind label; none for a lone stage. */
  kind?: GroupKind;
}

/** A map stage's drill-down. */
export type FactoryDrilldown = NonNullable<CuratedStage['drilldown']>;

export interface CuratedView {
  title: string;
  summary: string;
  /** One per in-flow graph stage, in flow order. */
  stages: CuratedStage[];
  columns: CuratedColumn[];
  /** The stage the board's Merged column is counted on: the file's `merged`, else the last. */
  landed: { stage: string };
  /** Step names by graph stage and step id. */
  steps: Record<string, Record<string, string>>;
  /** Each graph stage's label, by its `workflow` name. */
  stageLabels: Record<string, string>;
  /** The file's short label for an outcome, by `stage:outcome` or `stage:*`, where it gives one. */
  outcomeLabels: Record<string, string>;
  /** Each graph stage's `workflow` name to its name in the graph's arrows (`owner/name:workflow`). */
  runNames: Record<string, string>;
}

type GraphStage = PackGraph['stages'][number];

function stageOf(view: FactoryView, stage: GraphStage): CuratedStage {
  const { workflow } = stage;
  const words = view.stages[workflow];
  const phases = (words?.drilldown?.phases ?? []).map(phase => ({
    label: phase.label,
    cards: phase.cards.map(({ covers, ...rest }) => ({
      ...rest,
      covers: [{ workflow, steps: covers }],
    })),
  }));
  return {
    id: workflow,
    label: words?.label ?? workflow,
    ...(words?.short === undefined ? {} : { short: words.short }),
    blurb: words?.blurb ?? '',
    workflows: [workflow],
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
 * The map's columns, by the rule in the header. A group's column takes the group's name and
 * the file's line for it; a stage in no group is a column of its own and takes its words.
 */
function columnsFor(
  groups: readonly ViewGroup[],
  stages: readonly CuratedStage[],
  merged: string | undefined
): CuratedColumn[] {
  const columns: { group: ViewGroup | undefined; stages: CuratedStage[] }[] = [];
  for (const stage of stages) {
    if (stage.id === merged) continue;
    const group = groups.find(entry => entry.stages.includes(stage.id));
    const held = group === undefined ? undefined : columns.find(entry => entry.group === group);
    if (held !== undefined) held.stages.push(stage);
    else columns.push({ group, stages: [stage] });
  }
  const last = stages.find(stage => stage.id === merged);
  if (last !== undefined) columns.push({ group: undefined, stages: [last] });
  return columns.map(({ group, stages: held }) => {
    const [only] = held;
    if (group === undefined && only !== undefined)
      return {
        id: only.id,
        label: only.label,
        blurb: only.short ?? only.blurb,
        stages: [only.id],
      };
    const name = group?.name ?? '';
    return {
      id: slug(name),
      label: name,
      blurb: group?.blurb ?? '',
      stages: held.map(stage => stage.id),
      ...(group?.kind === undefined ? {} : { kind: group.kind }),
    };
  });
}

export function curatedView(view: FactoryView, graph: PackGraph): CuratedView {
  const stages = graph.stages.filter(stage => stage.inFlow).map(stage => stageOf(view, stage));
  const merged = stages.find(stage => stage.id === view.merged)?.id ?? stages.at(-1)?.id;
  const steps: Record<string, Record<string, string>> = {};
  for (const [workflow, stage] of Object.entries(view.stages))
    if (stage.steps !== undefined) steps[workflow] = stage.steps;
  return {
    title: view.title,
    summary: view.summary,
    stages,
    columns: columnsFor(groupsOf(view, graph), stages, merged),
    landed: { stage: merged ?? '' },
    steps,
    stageLabels: Object.fromEntries(
      Object.entries(view.stages).map(([workflow, stage]) => [workflow, stage.label])
    ),
    outcomeLabels: Object.fromEntries(
      Object.entries(view.outcomes ?? {}).flatMap(([key, outcome]) =>
        outcome.label === undefined ? [] : [[key, outcome.label]]
      )
    ),
    runNames: Object.fromEntries(graph.stages.map(stage => [stage.workflow, stage.name])),
  };
}
