/**
 * The inputs a workflow declares, and the reads a binding makes of a run's own inputs
 * (`{ input: <name> }`) that its workflow does not declare. Run-ended, asks-settled and wake
 * bindings read a run's inputs the same way, so every check of them, in a run's preflight,
 * `trigger check`, `pack bindings`, `validate workflows` and before a wake meets its wait,
 * uses these.
 */
import { packWorkflowName } from '@archon/workflows/pack-graph';
import { kindedPackBinding, type PackBinding } from '@archon/workflows/schemas/pack-bindings';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';

/** The input names a workflow declares: its own `inputs:` and its pack's settings. */
export function declaredInputNames(workflow: Pick<ResolvedWorkflow, 'inputs' | 'pack'>): string[] {
  return [...Object.keys(workflow.inputs ?? {}), ...Object.keys(workflow.pack?.settings ?? {})];
}

/**
 * Each input of a binding that reads, as `{ input }`, a name the run it reads from does not
 * declare: `workflowName`, the workflow whose run ended, left the asks or left the met wait.
 * Such a read would map nothing on every start, so each is refused where the binding is
 * checked; the caller names the binding.
 */
export function undeclaredInputReads(
  inputs: Readonly<Record<string, unknown>> | undefined,
  workflowName: string,
  declaredInputs: readonly string[]
): string[] {
  return Object.entries(inputs ?? {}).flatMap(([target, source]) =>
    typeof source === 'object' &&
    source !== null &&
    'input' in source &&
    typeof source.input === 'string' &&
    !declaredInputs.includes(source.input)
      ? [`input '${target}' reads '${source.input}', which '${workflowName}' does not declare`]
      : []
  );
}

/**
 * A pack's wake binding's undeclared reads, against `stages`, the pack's workflows as loaded,
 * with the waiting workflow's name as loaded. Undefined for any other binding, and for a
 * `wake.workflow` that is not one of `stages`, which the checks of a binding's workflow
 * names report.
 */
export function packWakeInputProblems(
  binding: PackBinding,
  stages: readonly ResolvedWorkflow[]
): { waiting: string; problems: string[] } | undefined {
  const kinded = kindedPackBinding(binding);
  const wake = kinded.kind === 'event' ? kinded.binding.wake : undefined;
  if (wake === undefined) return undefined;
  const name = packWorkflowName(
    stages.map(stage => stage.name),
    wake.workflow
  );
  const waiting = stages.find(stage => stage.name === name);
  if (waiting === undefined) return undefined;
  return {
    waiting: waiting.name,
    problems: undeclaredInputReads(binding.inputs, wake.workflow, declaredInputNames(waiting)),
  };
}
