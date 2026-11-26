/**
 * What a wake binding carries into the stage it starts from the run that left the met wait:
 * that run's own inputs and the item's answers (`wake.inputs`), and the checkout it recorded
 * when it completed (`wake.checkout: "waiting-run"`). A wake start is a start that happens
 * later from a completed run's record, as an asks-settled start is, so it reads with the
 * same resolver (`mappedInputs`) and the same checkout record (`recordedCheckout`). The
 * store calls it inside the transaction that accepts the receipt (`resolveWakes`).
 *
 * Before that transaction, each `{ input }` a wake carries is checked against the inputs its
 * `wake.workflow` declares, with the check `pack bindings` and `validate workflows` run on a
 * pack's declaration (`undeclaredInputReads`). A source plugin binding is the plugin's own
 * config, so a stale or hand-edited one is first seen here; refusing it before any wait is
 * read leaves the wait open.
 */
import type { WakeMapping, WakeStart } from '../db/item-waits';
import { discoverBindingWorkflows, type BindingDefinitionsDeps } from './definition-source';
import { readSubrunMetadata } from '@archon/workflows/schemas/run-metadata';
import { recordedCheckout } from './asks-settled';
import { itemAnswers } from './item-answers';
import { declaredInputNames, mappedInputs, undeclaredInputReads } from './run-ended';

export const wakeStart: WakeStart = (wake, { runId, run, itemAsks }) => {
  const answers = itemAnswers(itemAsks);
  const mapped = mappedInputs(
    wake.inputs,
    run === null
      ? { gone: `run '${runId}', which left the wait, no longer exists`, itemAnswers: answers }
      : {
          inputs: readSubrunMetadata(run.metadata).inputs ?? {},
          // A waiting run's result is not kept; `wakeInputSourceSchema` reads none.
          result: undefined,
          itemAnswers: answers,
        }
  );
  if ('missing' in mapped)
    return { refused: { detail: mapped.missing, reason: 'inputs_unmapped' } };
  if (wake.checkout === undefined) return { inputs: mapped.inputs };
  const checkout = recordedCheckout(runId, run, wake.workflowName, 'wait');
  return 'refused' in checkout
    ? { refused: { detail: `Checkout: ${checkout.refused}`, reason: 'checkout_refused' } }
    : { inputs: mapped.inputs, handoff: checkout.handoff };
};

/**
 * The wake mapping the SQL store is given: `wakeStart`, and the input check, which reads the
 * workflows of the project the binding launches in as a start of it would.
 */
export function createWakeMapping(deps: BindingDefinitionsDeps): WakeMapping {
  return {
    start: wakeStart,
    inputProblems: async ({ launch, wake }) => {
      const read = await discoverBindingWorkflows(launch, deps);
      if ('refused' in read) return [`its workflows could not be read: ${read.refused}`];
      const waiting = read.discovered.workflows.find(
        found => found.workflow.name === wake.workflowName
      )?.workflow;
      if (waiting === undefined)
        return [`it wakes workflow '${wake.workflowName}', which is not in this project`];
      return undeclaredInputReads(wake.inputs, wake.workflowName, declaredInputNames(waiting));
    },
  };
}
