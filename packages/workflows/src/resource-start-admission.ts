import { setTimeout } from 'node:timers/promises';
import type { IResourceStartStore } from './resource-start-store';
import type { PreparedWorkflowLaunch, ResourceStartDisposition } from './schemas/resource-start';
import type { WorkflowResource } from './schemas/workflow';

export async function awaitResourceStartAdmission(
  store: IResourceStartStore,
  resource: WorkflowResource,
  launch: PreparedWorkflowLaunch,
  options: {
    noWait?: boolean;
    signal?: AbortSignal;
    onWaiting?: (resource: string, requestId: string) => Promise<void>;
    wait?: (signal?: AbortSignal) => Promise<void>;
  } = {}
): Promise<Extract<ResourceStartDisposition, { status: 'admitted' | 'skipped' }>> {
  const { signal } = options;
  signal?.throwIfAborted();
  // Only the native launcher has its execution options; a trigger host cannot take over.
  const hostId = `native:${launch.run.id}`;
  const disposition = await store.admitPendingResourceStart({
    resource: resource.name,
    capacity: resource.capacity,
    hostId,
    overlap: options.noWait ? 'skip' : 'queue',
    launch,
  });
  if (disposition.status !== 'queued') return disposition;
  try {
    await options.onWaiting?.(resource.name, disposition.requestId);
    while (true) {
      signal?.throwIfAborted();
      await store.drainResourceStarts({ resource: resource.name, hostId });
      const request = await store.getResourceStartRequest(disposition.requestId);
      if (request?.status === 'admitted')
        return { status: 'admitted', requestId: request.id, runId: request.id };
      if (request?.status !== 'queued')
        throw new Error(`Resource start '${disposition.requestId}' is no longer queued`);
      await (options.wait?.(signal) ?? setTimeout(1000, undefined, { signal }));
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    return withdrawOrReadAdmission(store, disposition.requestId, error);
  }
}

async function withdrawOrReadAdmission(
  store: IResourceStartStore,
  requestId: string,
  error: unknown
): Promise<Extract<ResourceStartDisposition, { status: 'admitted' }>> {
  if (!(await store.withdrawQueuedResourceStart(requestId))) {
    const request = await store.getResourceStartRequest(requestId);
    if (request?.status === 'admitted')
      return { status: 'admitted', requestId: request.id, runId: request.id };
  }
  throw error;
}
