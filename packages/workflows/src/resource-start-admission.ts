import { setTimeout } from 'node:timers/promises';
import type { IResourceStartStore } from './resource-start-store';
import type { PreparedWorkflowLaunch, ResourceStartDisposition } from './schemas/resource-start';
import type { ResolvedWorkflow, WorkflowResource } from './schemas/workflow';
import type { WorkflowRun } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';
import {
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  preparedWorkflowLaunchSchema,
} from './schemas/resource-start';

export function nativeResourceStartHostId(runId: string): string {
  return `native:${runId}`;
}

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
  const hostId = nativeResourceStartHostId(launch.run.id);
  let disposition: ResourceStartDisposition;
  try {
    disposition = await store.admitPendingResourceStart({
      resource: resource.name,
      capacity: resource.capacity,
      hostId,
      overlap: options.noWait ? 'skip' : 'queue',
      launch,
    });
  } catch (error) {
    return withdrawOrReadAdmission(store, launch.run.id, error);
  }
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
    return withdrawOrReadAdmission(store, disposition.requestId, error);
  }
}

async function withdrawOrReadAdmission(
  store: IResourceStartStore,
  requestId: string,
  error: unknown
): Promise<Extract<ResourceStartDisposition, { status: 'admitted' }>> {
  try {
    if (!(await store.withdrawQueuedResourceStart(requestId))) {
      const request = await store.getResourceStartRequest(requestId);
      if (request?.status === 'admitted')
        return { status: 'admitted', requestId: request.id, runId: request.id };
    }
  } catch (cleanupError) {
    throw uncertainResourceStartError(requestId, error, cleanupError);
  }
  throw error;
}

export async function readResourceStartAfterFailure(
  store: IResourceStartStore,
  requestId: string,
  error: unknown
): ReturnType<IResourceStartStore['getResourceStartRequest']> {
  try {
    return await store.getResourceStartRequest(requestId);
  } catch (cleanupError) {
    throw uncertainResourceStartError(requestId, error, cleanupError);
  }
}

function uncertainResourceStartError(
  requestId: string,
  error: unknown,
  cleanupError: unknown
): AggregateError {
  const message = (value: unknown): string =>
    value instanceof Error ? value.message : String(value);
  return new AggregateError(
    [error, cleanupError],
    `Resource start '${requestId}' state is uncertain after cleanup failed. Original failure: ${message(error)}. Cleanup failure: ${message(cleanupError)}. Inspect the retained request before recovery.`
  );
}

/** Preserve native execution ownership while the shared store arbitrates the start. */
export async function admitNativeResourceStart(
  store: IWorkflowStore,
  workflow: ResolvedWorkflow,
  run: WorkflowRun,
  execution: PreparedWorkflowLaunch['execution'],
  options: Parameters<typeof awaitResourceStartAdmission>[3] = {}
): ReturnType<typeof awaitResourceStartAdmission> {
  if (!workflow.resource)
    throw new Error('Native resource admission requires a resource declaration');
  const metadata = { [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: workflow.mutates_checkout !== false };
  await store.updateWorkflowRun(run.id, { metadata });
  run.metadata = { ...run.metadata, ...metadata };
  // JSON persistence removes undefined fields; attachment compares the durable invocation.
  const retained = await store.getWorkflowRun(run.id);
  if (!retained) throw new Error(`Resource start '${run.id}' lost its pending run`);
  const launch = preparedWorkflowLaunchSchema.parse({
    version: 2,
    run: {
      id: retained.id,
      workflow_name: retained.workflow_name,
      codebase_id: retained.codebase_id,
      user_message: retained.user_message,
      origin: retained.origin ?? undefined,
      metadata: retained.metadata,
      ...(execution.isolation.kind === 'in-place' ? { working_path: execution.cwd } : {}),
    },
    execution,
  });
  return awaitResourceStartAdmission(store, workflow.resource, launch, options);
}
