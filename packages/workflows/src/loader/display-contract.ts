/**
 * A workflow's `display:` checked against the workflow it describes (`schemas/display.ts`):
 * every outcome and step it names is one the workflow has. A field naming a renamed or
 * removed one is dropped with a warning, never refusing the workflow: words never stop a run.
 * Run on the loaded workflow (`loader.ts`) and again on the flattened one (`expand-scope.ts`):
 * the step ids a reader records (`<include>__<node>`) exist only after includes expand, so
 * while any include is still a directive the step check waits for the flattened workflow.
 */
import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import type { WorkflowDisplay } from '../schemas/display';
import { isComposeFanOutNode, isIncludeDirective, isLoopGroupNode } from '../schemas';
import { declaredOutcome, outcomeValues } from '../completed-outcome';
import { loopBodyStepNamePrefix } from '../graph-plan';

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

/** A `display:` field that names what the workflow lacks, and why. */
export interface DisplayProblem {
  readonly field: 'outcomes' | 'phases' | 'marks';
  readonly message: string;
}

function outcomesProblem(workflow: DisplayWorkflow): string | null {
  const keys = Object.keys(workflow.display?.outcomes ?? {});
  if (keys.length === 0) return null;
  if (workflow.result?.outcome === undefined)
    return 'display.outcomes names outcomes, but the workflow declares no returns.outcome';
  const selected = workflow.nodes.find(node => node.id === workflow.returns);
  // Deferred, like the result contract, while the returns node is an include alias.
  if (selected === undefined || isIncludeDirective(selected)) return null;
  const outcome = declaredOutcome(workflow);
  if (outcome === undefined) return null;
  const values = outcomeValues(outcome.form);
  const unknown = keys.filter(key => !values.includes(key));
  return unknown.length === 0
    ? null
    : `display.outcomes names ${unknown.map(key => `'${key}'`).join(', ')}, which returns.outcome: '${outcome.field}' cannot take (it takes: ${values.join(', ')})`;
}

function phasesProblem(display: WorkflowDisplay, steps: readonly string[]): string | null {
  const covered = new Map<string, string>();
  for (const card of (display.phases ?? []).flatMap(phase => phase.cards))
    for (const step of card.covers) {
      if (!steps.includes(step))
        return `display.phases card '${card.title}' names step '${step}', which the workflow does not have (its steps: ${steps.join(', ')})`;
      const first = covered.get(step);
      if (first !== undefined)
        return `display.phases cards '${first}' and '${card.title}' both cover step '${step}'; a step is on one card`;
      covered.set(step, card.title);
    }
  return null;
}

function marksProblem(display: WorkflowDisplay, steps: readonly string[]): string | null {
  const missing = (display.marks ?? []).find(mark => !steps.includes(mark.node));
  return missing === undefined
    ? null
    : `display.marks names step '${missing.node}', which the workflow does not have (its steps: ${steps.join(', ')})`;
}

/** Each `display:` field that names something the workflow lacks; empty when none does. */
export function displayContractProblems(workflow: DisplayWorkflow): DisplayProblem[] {
  const display = workflow.display;
  if (display === undefined) return [];
  const problems: DisplayProblem[] = [];
  const outcomes = outcomesProblem(workflow);
  if (outcomes !== null) problems.push({ field: 'outcomes', message: outcomes });
  const steps =
    display.phases === undefined && display.marks === undefined
      ? undefined
      : recordedStepIds(workflow.nodes);
  if (steps !== undefined) {
    const phases = phasesProblem(display, steps);
    if (phases !== null) problems.push({ field: 'phases', message: phases });
    const marks = marksProblem(display, steps);
    if (marks !== null) problems.push({ field: 'marks', message: marks });
  }
  return problems;
}

/**
 * The workflow with each `display:` field that names what it lacks dropped, and one warning
 * per dropped field. The rest of the workflow, and the rest of its words, are untouched.
 */
export function withoutDisplayProblems<T extends DisplayWorkflow>(
  workflow: T
): { workflow: T; warnings: string[] } {
  const problems = displayContractProblems(workflow);
  if (problems.length === 0 || workflow.display === undefined) return { workflow, warnings: [] };
  const display: Record<string, unknown> = { ...workflow.display };
  for (const { field } of problems) delete display[field];
  return {
    workflow: { ...workflow, display: display as WorkflowDisplay },
    warnings: problems.map(
      ({ field, message }) => `Workflow '${workflow.name}': ${message}; display.${field} is ignored`
    ),
  };
}
