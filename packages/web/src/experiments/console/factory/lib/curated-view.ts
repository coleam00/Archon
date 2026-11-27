/**
 * The grouped map's model: the pack graph and its words (`graphWords`), in the shape the map, its
 * stage modal and their libs draw. Pure. Every card, row, column and word comes from the graph.
 * The map draws it for a pack whose document declares groups (`PackMap`).
 *
 * - A map **stage** is one in-flow stage of the graph, in the graph's order (its flow order),
 *   with its words from its `display` (its label by `stageLabel`). Its id is the
 *   stage's `workflow` name.
 * - A **column** is a group (`groupsOf`: the pack document's, as the graph serves them), holding
 *   its in-flow stages in flow order. A stage no group holds is a column of its own. Columns
 *   come in the order their first stage comes in flow, which is the group order while each
 *   group is a run of neighbouring stages. With no groups at all, every stage is a column.
 *   Before any of that, the stage the pack's document names `exit` is taken out: it is where
 *   items leave the map, a column of its own at the end, and the board's Merged column is
 *   counted on it (`map-live.ts`). A document that names none leaves the last in-flow stage
 *   there.
 * - A stage's **drill-down** is its `display.phases`, each card covering steps of that stage.
 */
import type { PackGraph } from '../../skills/items';
import { graphWords, type FactoryWords } from './graph-view';
import { stageLabel } from './stage-words';
import type { ArrowLabels } from './graph-structure';
import { groupsOf, type GroupKind, type ViewGroup } from './view-groups';

type ViewDrilldownCard = NonNullable<
  FactoryWords['stages'][string]['drilldown']
>['phases'][number]['cards'][number];

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
  /** One per in-flow graph stage, in flow order. */
  stages: CuratedStage[];
  columns: CuratedColumn[];
  /** The stage the board's Merged column is counted on: the document's `exit`, else the last. */
  landed: { stage: string };
  /** Step names by graph stage and step id. */
  steps: Record<string, Record<string, string>>;
  /** Each graph stage's label, by its `workflow` name. */
  stageLabels: Record<string, string>;
  /** The short label for an outcome, by `stage:outcome`, where the pack gives one. */
  outcomeLabels: Record<string, string>;
  /** The short label for an ask option, by `stage:option`, where the pack gives one. */
  answerLabels: Record<string, string>;
  /** Each graph stage's `workflow` name to its name in the graph's arrows (`owner/name:workflow`). */
  runNames: Record<string, string>;
}

type GraphStage = PackGraph['stages'][number];

function stageOf(view: FactoryWords, stage: GraphStage): CuratedStage {
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
    label: stageLabel(view, workflow),
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
 * the document's line for it; a stage in no group is a column of its own and takes its words.
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

/**
 * The pack's words for outcomes and ask options, the ones it labels; none without words. The
 * curated map and the full workflow both word their arrows from these (`arrowWords`).
 */
export function arrowLabels(view: Pick<FactoryWords, 'outcomes' | 'answers'> | null): ArrowLabels {
  return {
    outcomeLabels: Object.fromEntries(
      Object.entries(view?.outcomes ?? {}).flatMap(([key, outcome]) =>
        outcome.label === undefined ? [] : [[key, outcome.label]]
      )
    ),
    answerLabels: Object.fromEntries(
      Object.entries(view?.answers ?? {}).flatMap(([key, answer]) =>
        answer.label === undefined ? [] : [[key, answer.label]]
      )
    ),
  };
}

export function curatedView(graph: PackGraph): CuratedView {
  const view = graphWords(graph);
  const stages = graph.stages.filter(stage => stage.inFlow).map(stage => stageOf(view, stage));
  const merged = stages.find(stage => stage.id === view.merged)?.id ?? stages.at(-1)?.id;
  const steps: Record<string, Record<string, string>> = {};
  for (const [workflow, stage] of Object.entries(view.stages)) steps[workflow] = stage.steps;
  return {
    stages,
    columns: columnsFor(groupsOf(graph), stages, merged),
    landed: { stage: merged ?? '' },
    steps,
    stageLabels: Object.fromEntries(
      Object.entries(view.stages).map(([workflow, stage]) => [workflow, stage.label])
    ),
    ...arrowLabels(view),
    runNames: Object.fromEntries(graph.stages.map(stage => [stage.workflow, stage.name])),
  };
}
