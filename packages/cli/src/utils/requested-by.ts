import { createLogger } from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  readResourceStartReceiptId,
  requestingRun,
} from '@archon/workflows/schemas/resource-start';

export type RequestedBy = ReturnType<typeof requestingRun>;

/**
 * The run and node that asked for this run's start, read from the receipt that started
 * it. Provenance only: an unreadable receipt is logged and reads as no requester, so it
 * never hides the rest of a run's view.
 */
export async function requestedBy(
  host: Pick<WorkflowHost, 'deps'>,
  metadata: Readonly<Record<string, unknown>> | undefined
): Promise<RequestedBy> {
  const receiptId = readResourceStartReceiptId(metadata);
  if (receiptId === undefined) return null;
  try {
    const receipt = await host.deps.store.getStartReceipt(receiptId);
    return requestingRun(receipt?.sourceActor ?? null);
  } catch (error) {
    createLogger('cli.requested-by').warn(
      { err: error as Error, receiptId },
      'cli.requested_by_unreadable'
    );
    return null;
  }
}

/** Print the plain-view line naming the requesting run, when there is one. */
export function printRequestedBy(origin: RequestedBy | undefined): void {
  if (!origin) return;
  console.log(
    `  Requested by: run ${origin.runId}${origin.nodePath ? ` (node ${origin.nodePath})` : ''}`
  );
}
