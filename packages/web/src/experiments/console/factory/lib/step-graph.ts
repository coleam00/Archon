import type { FactoryWorkflow } from '../../skills/factory';
import type { StepWorker } from './stage-steps';

type WorkflowStep = FactoryWorkflow['steps'][number];
type WorkflowGroup = FactoryWorkflow['groups'][number];

export interface StepGraphNode {
  key: string;
  /** The step's name as a person reads it (`stepLabel`), not the server's raw label. */
  label: string;
  kind: WorkflowStep['kind'];
  /** The innermost group it is drawn in. */
  group: string | null;
  /** The full `when:`, for the tooltip. */
  when: string | null;
  /**
   * What the graph prints for `when`: each comparison as the step it reads, by the name the
   * graph prints that step by. Null when the parser gave no comparisons; the title says it.
   */
  condition: string | null;
  /** The stage that works it: the open one, another one, or none the view names. */
  worker: StepWorker;
}

export type StepGraphGroup = Pick<
  WorkflowGroup,
  'id' | 'kind' | 'parent' | 'label' | 'maxRounds' | 'when'
> & { condition: string | null };

/** Always between two steps: a dependency on a loop group is drawn to and from its steps. */
interface StepGraphEdge {
  from: string;
  to: string;
}

export interface StepGraph {
  nodes: StepGraphNode[];
  groups: StepGraphGroup[];
  edges: StepGraphEdge[];
}

/**
 * The step graph a stage draws for one workflow. A dependency on a loop group comes
 * from the loop's last steps (those no other step of the loop waits on); the loop's own
 * dependencies go into its first steps (those that wait on nothing inside it). `stepName`
 * names each step and each loop (a loop's id is a step key); an include frame keeps the
 * server's label, which names the included workflow.
 */
export function stepGraph(
  workflow: Pick<FactoryWorkflow, 'steps' | 'groups'>,
  workerOf: (stepKey: string) => StepWorker,
  stepName: (stepKey: string) => string
): StepGraph {
  return {
    nodes: workflow.steps.map(step => ({
      key: step.key,
      label: stepName(step.key),
      kind: step.kind,
      group: step.group,
      when: step.when,
      condition: conditionText(step.whenClauses, stepName),
      worker: workerOf(step.key),
    })),
    groups: workflow.groups.map(({ id, kind, parent, label, maxRounds, when, whenClauses }) => ({
      id,
      kind,
      parent,
      label: kind === 'loop' ? stepName(id) : label,
      maxRounds,
      when,
      condition: conditionText(whenClauses, stepName),
    })),
    edges: stepEdges(workflow),
  };
}

type WhenAtom = NonNullable<WorkflowStep['whenClauses']>[number][number];

/** An operator as a person reads it; a new engine operator fails the type-check here. */
const OPERATOR_WORDS: Record<WhenAtom['operator'], string> = {
  '==': '=',
  '!=': '≠',
  '<=': '≤',
  '>=': '≥',
  '<': '<',
  '>': '>',
};

/**
 * A `when:` read at a glance on a projected screen, such as `if Verdict = return`: each
 * comparison as the step it reads (`stepName`) or the input, the operator and the value,
 * joined with `and` and `or` as written. Null without comparisons: the engine's parser did
 * not take the expression. The stage graph and the step page both print it from here, with
 * the full expression on hover.
 */
export function conditionText(
  clauses: WorkflowStep['whenClauses'],
  stepName: (stepKey: string) => string
): string | null {
  if (clauses === null || clauses.length === 0) return null;
  const atom = ({ reads, operator, value }: WhenAtom): string =>
    `${reads.kind === 'step' ? stepName(reads.key) : reads.name} ${OPERATOR_WORDS[operator]} ${
      value === '' ? 'empty' : value
    }`;
  return `if ${clauses.map(atoms => atoms.map(atom).join(' and ')).join(' or ')}`;
}

/** Each step's and each loop's waits, drawn between steps and without repeats. */
function stepEdges(workflow: Pick<FactoryWorkflow, 'steps' | 'groups'>): StepGraphEdge[] {
  const members = groupMembers(workflow);
  const keys = new Set(workflow.steps.map(step => step.key));
  const sources = (dependency: string): string[] =>
    members.has(dependency) ? lastSteps(workflow, members, dependency) : [dependency];
  const waits = [
    ...workflow.steps.map(step => ({ targets: [step.key], dependsOn: step.dependsOn })),
    ...workflow.groups.map(group => ({
      targets: firstSteps(workflow, members, group.id),
      dependsOn: group.dependsOn,
    })),
  ];
  const edges = new Map<string, StepGraphEdge>();
  for (const { targets, dependsOn } of waits) {
    const froms = dependsOn.flatMap(sources).filter(from => keys.has(from));
    for (const from of froms) for (const to of targets) edges.set(`${from}→${to}`, { from, to });
  }
  return [...edges.values()];
}

/** Each group's steps, nested groups' included. */
function groupMembers(workflow: Pick<FactoryWorkflow, 'steps' | 'groups'>): Map<string, string[]> {
  const parents = new Map(workflow.groups.map(group => [group.id, group.parent]));
  const members = new Map<string, string[]>(workflow.groups.map(group => [group.id, []]));
  for (const step of workflow.steps) {
    for (let group = step.group; group !== null; group = parents.get(group) ?? null)
      members.get(group)?.push(step.key);
  }
  return members;
}

/** What a group's steps wait on, as step keys; a wait on a nested loop names all its steps. */
function waitedOn(
  workflow: Pick<FactoryWorkflow, 'steps' | 'groups'>,
  members: Map<string, string[]>,
  inside: ReadonlySet<string>
): Set<string> {
  const waited = new Set<string>();
  for (const step of workflow.steps) {
    if (!inside.has(step.key)) continue;
    for (const dependency of step.dependsOn)
      for (const key of members.get(dependency) ?? [dependency]) waited.add(key);
  }
  return waited;
}

function lastSteps(
  workflow: Pick<FactoryWorkflow, 'steps' | 'groups'>,
  members: Map<string, string[]>,
  group: string
): string[] {
  const inside = new Set(members.get(group));
  const waited = waitedOn(workflow, members, inside);
  return [...inside].filter(key => !waited.has(key));
}

function firstSteps(
  workflow: Pick<FactoryWorkflow, 'steps' | 'groups'>,
  members: Map<string, string[]>,
  group: string
): string[] {
  const inside = new Set(members.get(group));
  return workflow.steps
    .filter(step => inside.has(step.key))
    .filter(step =>
      step.dependsOn.every(dependency =>
        (members.get(dependency) ?? [dependency]).every(key => !inside.has(key))
      )
    )
    .map(step => step.key);
}
