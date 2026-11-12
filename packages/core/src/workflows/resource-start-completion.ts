import { createLogger } from '@archon/paths';
import type { WorkflowHost } from './host-store';

/** Resolve only a recorded admission; ordinary run trees have no trigger host. */
export async function drainAfterResourceStart(
  host: Pick<WorkflowHost, 'deps'>,
  runId: string,
  requestHostDrain: (hostId: string) => Promise<void>
): Promise<void> {
  const store = host.deps.store;
  let request = await store.getResourceStartRequest(runId);
  if (!request) {
    // A resumed child can finish its blocked parent inside the same engine call.
    const root = (await store.getRunAncestry(runId)).at(-1);
    if (root) request = await store.getResourceStartRequest(root.id);
  }
  if (request?.status === 'admitted') await requestHostDrain(request.hostId);
}

/** A scheduling failure must not replace an execution's committed result. */
export async function notifyOwnedExecutionSettled(
  host: Pick<WorkflowHost, 'afterOwnedExecution'>,
  runId: string
): Promise<void> {
  try {
    await host.afterOwnedExecution?.(runId);
  } catch (err) {
    createLogger('resource-start-completion').error(
      { err, runId },
      'resource_start.completion_failed'
    );
  }
}
