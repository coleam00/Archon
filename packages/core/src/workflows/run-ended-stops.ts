/**
 * The `stops` report of `archon trigger check`: the outcomes after which a run on an item
 * would stop the item, because nothing follows it (see `itemFate` and the `stopped`
 * attention item).
 */
import { existsSync } from 'node:fs';
import {
  declaredItemFate,
  declaredOutcome,
  outcomeValues,
} from '@archon/workflows/completed-outcome';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { discoverBindingWorkflows, type BindingDefinitionsDeps } from './definition-source';
import {
  bindingProjectKey,
  runEndedBindingCheck,
  type OnBinding,
  type OnBindingFile,
  type RunEndedStartsDependencies,
} from './run-ended';

/**
 * An outcome after which a run's item stops: see `runEndedStops`. `unless` names what the
 * workflow can leave instead (`returns.asks`, `returns.waits`); it stops only when it leaves
 * none.
 */
export interface RunEndedStop {
  project: string;
  workflow: string;
  outcome: string;
  unless: ('asks' | 'waits')[];
}

/** One binding as the report reads it: its project and the workflows it names. */
interface NamedBinding {
  project: string;
  candidate: OnBindingFile;
  named: readonly string[];
}

/** The workflows a binding names: the one it starts, and the one whose end or asks fire it. */
function namedWorkflows(candidate: OnBinding | OnBindingFile): string[] {
  const named = [candidate.binding.launch.workflowName];
  if ('runEnded' in candidate) named.push(candidate.runEnded.workflowName);
  else if ('asksSettled' in candidate) named.push(candidate.asksSettled.workflowName);
  return named;
}

const stopKey = (project: string, workflow: string, outcome: string): string =>
  JSON.stringify([project, workflow, outcome]);

/** The outcomes of `workflow` that stop its item (`declaredItemFate`), given what is bound. */
function workflowStops(
  workflow: ResolvedWorkflow,
  project: string,
  bound: ReadonlySet<string>
): RunEndedStop[] {
  const outcome = declaredOutcome(workflow);
  if (outcome === undefined) return [];
  const unless = [
    ...(workflow.result?.asks !== undefined ? (['asks'] as const) : []),
    ...(workflow.result?.waits !== undefined ? (['waits'] as const) : []),
  ];
  return outcomeValues(outcome.form)
    .filter(
      value =>
        declaredItemFate(workflow, value, bound.has(stopKey(project, workflow.name, value))) ===
        'stops'
    )
    .map(value => ({ project, workflow: workflow.name, outcome: value, unless }));
}

/**
 * The outcomes after which a run on an item would stop it, per project the bindings launch
 * in: each value a workflow's declared outcome can take that does not end the item
 * (`returns.ends`) and that no usable run-ended file in the project binds to a start on the
 * item itself, of a workflow that is a step (not `observes: true`). A file is usable when the
 * check a run gets before it starts passes, as the pack graph counts it, and a `linked` file
 * starts on other items. A workflow that declares `returns.asks` or `returns.waits` stops
 * its item only when a run leaves none, which `unless` says. The workflows read are the ones
 * the bindings name, ended, asking or started, including those a binding without `on`
 * (fire-only or timer) starts. Each binding's workflows are read from its own definitions
 * (`discoverBindingWorkflows`), as its check and its start read them; what is bound is
 * project-wide. A report, not a problem: the attention queue lists the item when it stops.
 */
export async function runEndedStops(
  bindings: readonly (OnBinding | OnBindingFile)[],
  deps: BindingDefinitionsDeps & Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<RunEndedStop[]> {
  const { read, bound } = await readNamedBindings(bindings, deps);
  const stops = new Map<string, RunEndedStop>();
  for (const named of read)
    for (const stop of await bindingStops(named, bound, deps))
      stops.set(stopKey(stop.project, stop.workflow, stop.outcome), stop);
  return [...stops.values()];
}

/** Each binding that can start, with its project, and every outcome a usable run-ended file binds on the item. */
async function readNamedBindings(
  bindings: readonly (OnBinding | OnBindingFile)[],
  deps: BindingDefinitionsDeps & Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<{ read: NamedBinding[]; bound: Set<string> }> {
  const read: NamedBinding[] = [];
  const bound = new Set<string>();
  for (const candidate of bindings) {
    // A binding whose checkout is gone never starts; `runEndedTriggerCheck` reports it.
    if (!existsSync(candidate.binding.launch.cwd)) continue;
    const project = (await bindingProjectKey(candidate, deps)) ?? candidate.binding.launch.cwd;
    if (
      'runEnded' in candidate &&
      candidate.runEnded.linked === undefined &&
      (await runEndedBindingCheck(candidate, deps)).length === 0
    )
      bound.add(stopKey(project, candidate.runEnded.workflowName, candidate.runEnded.outcome));
    read.push({ project, candidate, named: namedWorkflows(candidate) });
  }
  return { read, bound };
}

/** The stops of the workflows one binding names, read from its own definitions. */
async function bindingStops(
  { project, candidate, named }: NamedBinding,
  bound: ReadonlySet<string>,
  deps: BindingDefinitionsDeps
): Promise<RunEndedStop[]> {
  const found = await discoverBindingWorkflows(candidate.binding.launch, deps);
  // Definitions that cannot be read are reported by the binding checks.
  if ('refused' in found) return [];
  return found.discovered.workflows
    .filter(({ workflow }) => named.includes(workflow.name))
    .flatMap(({ workflow }) => workflowStops(workflow, project, bound));
}
