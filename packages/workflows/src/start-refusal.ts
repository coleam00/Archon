import type { WorkflowDeps } from './deps';
import { unsuppliedResultInputs } from './run-result';
import { readSubrunMetadata, type ResolvedWorkflow } from './schemas';
import type { WorkflowRun } from './schemas/workflow-run';
import { requireTerminalStatusWrite } from './terminal-status-write';

type StartRefusalDeps = Pick<WorkflowDeps, 'checkRunEndedBindings' | 'store'>;

/**
 * The one place that decides the refusals readable from a pending row and its workflow:
 * a refused run is cancelled as `precondition_failed` while it is still pending, and the
 * reason is returned. Undefined when the start may proceed. A detached launcher calls this
 * on the row it created, before the fork, so its caller hears the refusal; admission calls
 * it again before the claim. A refusal that needs other state (branch reuse, the resource
 * hold) is decided where that state lives.
 */
export async function refusePendingStart(
  deps: StartRefusalDeps,
  workflow: ResolvedWorkflow,
  run: WorkflowRun
): Promise<string | undefined> {
  const reason =
    (await brokenRunEndedBinding(deps, run)) ??
    itemResultWithoutItem(workflow, run, 'asks') ??
    itemResultWithoutItem(workflow, run, 'waits') ??
    resultInputWithoutItem(workflow, run);
  if (reason === undefined) return undefined;
  await requireTerminalStatusWrite(
    // Before the claim another dispatcher may own this row: cancel it only while pending.
    deps.store.cancelWorkflowRun(
      run.id,
      { cancel_reason: 'precondition_failed' },
      { pendingOnly: true }
    ),
    { workflowRunId: run.id, site: reason.site, failure: new Error(reason.text) }
  );
  return reason.text;
}

interface Refusal {
  text: string;
  site: string;
}

/**
 * A run whose end would fire a broken run-ended binding is refused before it does any
 * work, so a binding that names a missing stage is found before the stage feeding it runs.
 */
async function brokenRunEndedBinding(
  deps: StartRefusalDeps,
  run: WorkflowRun
): Promise<Refusal | undefined> {
  if (!deps.checkRunEndedBindings) return undefined;
  try {
    await deps.checkRunEndedBindings(run);
    return undefined;
  } catch (error) {
    return {
      text: `Run-ended trigger is invalid: ${(error as Error).message}`,
      site: 'workflow.run_ended_binding_refused',
    };
  }
}

/**
 * A workflow that declares `returns.asks` or `returns.waits` leaves them on the run's item,
 * so a top-level run of it with no item is refused. A `workflow:` child carries no item and
 * opens neither, so it is not refused. A store without items refuses the item at creation,
 * so they are refused there before a run starts.
 */
function itemResultWithoutItem(
  workflow: ResolvedWorkflow,
  run: WorkflowRun,
  key: 'asks' | 'waits'
): Refusal | undefined {
  const field = workflow.result?.[key];
  if (field === undefined || run.parent_run_id !== null || run.item_id !== null) return undefined;
  return {
    text: `Workflow '${workflow.name}' declares returns.${key} '${field}', so it runs on an item: start it with --item <key>`,
    site: `workflow.${key}_without_item_refused`,
  };
}

/**
 * A `result_of` input the run was not supplied is read from its item, so a run with no item
 * is refused unless every such input is supplied. A `workflow:` child carries no item, so its
 * parent must pass such an input through `with:`. Supplied means on the row: a launcher's
 * `--input`, a parent's `with:` or a binding's mapping, and on a row the executor creates
 * itself, the complete `$INPUTS` its dispatch resolved.
 */
function resultInputWithoutItem(workflow: ResolvedWorkflow, run: WorkflowRun): Refusal | undefined {
  if (run.item_id !== null) return undefined;
  const [first] = unsuppliedResultInputs(workflow, readSubrunMetadata(run.metadata).inputs);
  if (first === undefined) return undefined;
  const [input, { workflow: source }] = first;
  return {
    text: `Workflow '${workflow.name}' reads input '${input}' from result_of '${source}', which resolves from the run's item: start it with --item <key>, or supply '${input}'`,
    site: 'workflow.result_inputs_without_item_refused',
  };
}
