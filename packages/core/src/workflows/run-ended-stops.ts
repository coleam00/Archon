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
  type OnBinding,
  type OnBindingFile,
  type RunEndedStartsDependencies,
} from './run-ended';

/** An outcome after which a run's item stops: see `runEndedStops`. */
export interface RunEndedStop {
  project: string;
  workflow: string;
  outcome: string;
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
  return outcomeValues(outcome.form)
    .filter(
      value =>
        declaredItemFate(workflow, value, bound.has(stopKey(project, workflow.name, value))) ===
        'stops'
    )
    .map(value => ({ project, workflow: workflow.name, outcome: value }));
}

/**
 * The outcomes after which a run on an item would stop it, per project the bindings launch
 * in: each value a workflow's declared outcome can take that no run-ended file in the
 * project binds and that does not end the item (`returns.ends`), of a workflow that is a
 * step (not `observes: true`) and declares neither `returns.asks` nor `returns.waits`, so
 * nothing follows it. The workflows read are the ones
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

/** Each binding that can start, with its project, and every outcome a run-ended file binds. */
async function readNamedBindings(
  bindings: readonly (OnBinding | OnBindingFile)[],
  deps: Pick<RunEndedStartsDependencies, 'projectKeyOf'>
): Promise<{ read: NamedBinding[]; bound: Set<string> }> {
  const read: NamedBinding[] = [];
  const bound = new Set<string>();
  for (const candidate of bindings) {
    // A binding whose checkout is gone never starts; `runEndedTriggerCheck` reports it.
    if (!existsSync(candidate.binding.launch.cwd)) continue;
    const project = (await bindingProjectKey(candidate, deps)) ?? candidate.binding.launch.cwd;
    if ('runEnded' in candidate)
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
