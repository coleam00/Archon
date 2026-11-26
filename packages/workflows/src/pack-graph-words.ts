/**
 * What a pack graph leaves a reader without words for, and `display:` declarations that name
 * what the pack still has as gone (`schemas/display.ts`). `archon validate` reports each as a
 * warning: a reader shows a missing word as the id, so a pack still runs and reads.
 */
import type { PackGraph } from './pack-graph';
import { OTHER_ATTENTION_OPTION } from './schemas/wait-node';

type GraphStage = PackGraph['stages'][number];

/** The options an in-flow stage's asks-settled arrows leave on. */
function settledOptions(graph: Pick<PackGraph, 'arrows'>, stage: GraphStage): string[] {
  return [
    ...new Set(
      graph.arrows.flatMap(({ from }) =>
        'settled' in from && from.stage === stage.name && from.option !== undefined
          ? [from.option]
          : []
      )
    ),
  ];
}

/**
 * One thing a stage of the graph lacks or gets wrong, the stage by `workflow` name, and where the
 * author fixes it.
 */
export interface StageFinding {
  stage: string;
  message: string;
  hint: string;
}

type GraphNode = GraphStage['nodes'][number];

const WORKFLOW_HINT =
  "Give it words in the workflow's display: block; a reader shows the id until then.";

/**
 * Where a step's label is authored: on the node itself, or, for a node an include expanded, on
 * that node in the included workflow (the innermost include boundary names it).
 */
function stepHint(node: GraphNode): string {
  const included = node.blocks.at(-1);
  const inner = node.id.split('__').at(-1) ?? node.id;
  return included === undefined
    ? `Give the node a display: { label } in this workflow; a reader shows the id until then.`
    : `Give node '${inner}' a display: { label } in the included workflow '${included.workflow}', where it is authored; a reader shows the id until then.`;
}

/**
 * Each in-flow stage with no `display.label`, each of its steps (an included node by its
 * expanded id) with none, each value of its declared outcome with no `display.outcomes` label,
 * and each ask option an asks-settled arrow leaves it on (the reserved `other` among them) with
 * no `display.answers` label. Only in-flow stages: no item stands at the rest.
 */
export function unlabelled(graph: Pick<PackGraph, 'stages' | 'arrows'>): StageFinding[] {
  return graph.stages
    .filter(stage => stage.inFlow)
    .flatMap(stage => {
      const { workflow, display } = stage;
      const finding = (message: string, hint = WORKFLOW_HINT): StageFinding => ({
        stage: workflow,
        message,
        hint,
      });
      return [
        ...(display === undefined ? [finding(`stage '${workflow}' has no display.label`)] : []),
        ...stage.nodes
          .filter(node => node.display === undefined)
          .map(node =>
            finding(`step '${node.id}' of stage '${workflow}' has no display.label`, stepHint(node))
          ),
        ...(stage.outcome?.values ?? [])
          .filter(value => value.display?.label === undefined)
          .map(({ value }) =>
            finding(`outcome '${value}' of stage '${workflow}' has no display.outcomes label`)
          ),
        ...settledOptions(graph, stage)
          .filter(option => display?.answers?.[option] === undefined)
          .map(option =>
            finding(
              `option '${option}' of stage '${workflow}' has no display.answers label${option === OTHER_ATTENTION_OPTION.id ? ' (every ask offers it)' : ''}`
            )
          ),
      ];
    });
}

/**
 * Each `display.replaces` entry naming a workflow the pack still has as a stage: its runs are
 * that stage's own, so a reader would count them twice.
 */
export function replacedStillPresent(graph: Pick<PackGraph, 'stages'>): StageFinding[] {
  const names = new Set(graph.stages.map(stage => stage.workflow));
  return graph.stages.flatMap(stage =>
    (stage.display?.replaces ?? [])
      .filter(entry => names.has(entry.workflow))
      .map(entry => ({
        stage: stage.workflow,
        message: `stage '${stage.workflow}' display.replaces names '${entry.workflow}', which the pack still has as a stage`,
        hint: 'Name only a workflow the pack no longer has in display.replaces.',
      }))
  );
}
