/**
 * What a wake binding carries into the stage it starts from the run that left the met wait:
 * that run's own inputs and the item's answers (`wake.inputs`), and the checkout it recorded
 * when it completed (`wake.checkout: "waiting-run"`). A wake start is a start that happens
 * later from a completed run's record, as an asks-settled start is, so it reads with the
 * same resolver (`mappedInputs`) and the same checkout record (`recordedCheckout`). The
 * store calls it inside the transaction that accepts the receipt (`resolveWakes`).
 */
import type { WakeStart } from '../db/item-waits';
import { readSubrunMetadata } from '@archon/workflows/schemas/run-metadata';
import { recordedCheckout } from './asks-settled';
import { itemAnswers } from './item-answers';
import { mappedInputs } from './run-ended';

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
