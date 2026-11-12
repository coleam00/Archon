import { createLogger } from '@archon/paths';
import type { WorkflowHost } from './host-store';

/** Resolve only the admission's recorded host; ordinary runs have no trigger host. */
export async function drainAfterResourceStart(
  host: Pick<WorkflowHost, 'deps'>,
  runId: string,
  requestHostDrain: (hostId: string) => Promise<void>
): Promise<void> {
  const request = await host.deps.store.getResourceStartRequest(runId);
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
