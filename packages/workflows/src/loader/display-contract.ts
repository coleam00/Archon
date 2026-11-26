/**
 * A workflow's `display:` checked against the workflow it describes (`schemas/display.ts`):
 * every outcome, option and step it names is one the workflow has, so a renamed or removed one
 * fails the load instead of leaving words that name nothing. Run with the result contract
 * (`contracts.ts`), on the loaded workflow and again on the flattened one: the step ids a
 * reader records (`<include>__<node>`) exist only after includes expand, so while any include
 * is still a directive the step check waits for the flattened workflow.
 */
import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import { isComposeFanOutNode, isIncludeDirective, isLoopGroupNode } from '../schemas';
import { declaredOutcome, outcomeValues } from '../completed-outcome';
import { loopBodyStepNamePrefix } from '../graph-plan';
import { OTHER_ATTENTION_OPTION } from '../schemas/wait-node';

type DisplayWorkflow = Pick<
  WorkflowDefinition,
  'name' | 'returns' | 'result' | 'observes' | 'display'
> & {
  readonly nodes: readonly (DagNode | IncludeDirective)[];
};

/**
 * The step ids the engine records a workflow's nodes under: a loop group's body nodes under
 * `loopBodyStepNamePrefix`, as the pack graph serves them (`pack-graph-nodes.ts`). Undefined
 * while an include is still a directive (a fan-out include stays one node, so it counts).
 */
export function recordedStepIds(
  nodes: readonly (DagNode | IncludeDirective)[],
  prefix = ''
): string[] | undefined {
  const ids: string[] = [];
  for (const node of nodes) {
    if (isIncludeDirective(node) && !isComposeFanOutNode(node)) return undefined;
    const id = prefix + node.id;
    ids.push(id);
    if (!isIncludeDirective(node) && isLoopGroupNode(node)) {
      const body = recordedStepIds(node.loop_group.nodes, loopBodyStepNamePrefix(id));
      if (body === undefined) return undefined;
      ids.push(...body);
    }
  }
  return ids;
}

function outcomesError(workflow: DisplayWorkflow): string | null {
  const keys = Object.keys(workflow.display?.outcomes ?? {});
  if (keys.length === 0) return null;
  if (workflow.result?.outcome === undefined)
    return 'Workflow declares display.outcomes but no returns.outcome; display.outcomes names outcomes, so it needs returns.outcome';
  const selected = workflow.nodes.find(node => node.id === workflow.returns);
  // Deferred, like the result contract, while the returns node is an include alias.
  if (selected === undefined || isIncludeDirective(selected)) return null;
  const outcome = declaredOutcome(workflow);
  if (outcome === undefined) return null;
  const values = outcomeValues(outcome.form);
  const unknown = keys.find(key => !values.includes(key));
  return unknown === undefined
    ? null
    : `Workflow display.outcomes names '${unknown}', which returns.outcome: '${outcome.field}' cannot take (it takes: ${values.join(', ')})`;
}

function answersError(workflow: DisplayWorkflow): string | null {
  const keys = Object.keys(workflow.display?.answers ?? {});
  if (keys.length === 0) return null;
  const ids = (workflow.result?.options ?? []).map(option => option.id);
  if (ids.length === 0)
    return 'Workflow declares display.answers but no returns.options; display.answers names the options of its asks';
  const known = [...ids, OTHER_ATTENTION_OPTION.id];
  const unknown = keys.find(key => !known.includes(key));
  return unknown === undefined
    ? null
    : `Workflow display.answers names '${unknown}', which is not an option it declares (it declares: ${known.join(', ')})`;
}

function stepsError(workflow: DisplayWorkflow): string | null {
  const display = workflow.display;
  if (display?.phases === undefined && display?.marks === undefined) return null;
  const steps = recordedStepIds(workflow.nodes);
  if (steps === undefined) return null;
  const named = [
    ...(display.phases ?? []).flatMap(phase =>
      phase.cards.flatMap(card =>
        card.covers.map(step => ({ step, where: `display.phases card '${card.title}'` }))
      )
    ),
    ...(display.marks ?? []).map(mark => ({ step: mark.node, where: 'display.marks' })),
  ];
  const missing = named.find(({ step }) => !steps.includes(step));
  if (missing !== undefined)
    return `Workflow ${missing.where} names step '${missing.step}', which it does not have (its steps: ${steps.join(', ')})`;
  const covered = new Map<string, string>();
  for (const card of (display.phases ?? []).flatMap(phase => phase.cards))
    for (const step of card.covers) {
      const first = covered.get(step);
      if (first !== undefined)
        return `Workflow display.phases cards '${first}' and '${card.title}' both cover step '${step}'; a step is on one card`;
      covered.set(step, card.title);
    }
  return null;
}

/** The first thing `display:` names that the workflow lacks, or null. */
export function displayContractError(workflow: DisplayWorkflow): string | null {
  if (workflow.display === undefined) return null;
  return outcomesError(workflow) ?? answersError(workflow) ?? stepsError(workflow);
}
