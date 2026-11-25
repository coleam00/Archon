import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from '@archon/workflows/store';

const log = createLogger('resource-start-host');

/**
 * A preparation that failed in a process whose engine is no longer the installed one goes
 * back to pending instead of being rejected: the failure may be this process's old code
 * reading definitions written for the new engine, so a process on the installed engine
 * prepares it. Nothing was admitted, so the start is neither lost nor run twice. A reset
 * that finds the binding no longer owned by this preparation rethrows the original error.
 */
export async function leaveForInstalledEngine(
  store: Pick<IWorkflowStore, 'resetStartBindingPreparation'>,
  identity: { receiptId: string; bindingId: string; ownerId: string },
  failure: string,
  error: unknown
): Promise<never> {
  let reset: boolean;
  try {
    reset = await store.resetStartBindingPreparation(identity);
  } catch (resetError) {
    throw new AggregateError(
      [error, resetError],
      `Preparation ${failure} on a changed engine; leaving it pending also failed.`
    );
  }
  if (!reset) throw error;
  log.warn(
    { receiptId: identity.receiptId, bindingId: identity.bindingId, failure },
    'resource_start.left_for_installed_engine'
  );
  throw new Error(
    `Left pending for a process on the installed engine: this process's engine changed since it started, and preparation ${failure}.`,
    { cause: error }
  );
}
