/**
 * Whether a queued start waits for the install's run limit (`concurrency.runs`), as the item
 * read and `trigger list` report it. A start waits for the limit while the limit is full, or,
 * with room left, while older starts of its own trigger host on other resources take that
 * room: admission then records the oldest of them as the start's `request` blocker. Read from
 * what admission recorded, so a reader never recomputes resource occupancy.
 */
import { z } from 'zod';
import type { IResourceStartStore, StartBindingInspection } from './resource-start-store';
import { fullRunLimit, type RunLimit } from './schemas/run-limit';
import { WorkflowStatusReadError } from './workflow-status-read';

/** The older queued start of the same host on another resource that a start waits behind. */
export const hostQueueWaitSchema = z
  .object({ requestId: z.string(), resource: z.string() })
  .nullable();
export type HostQueueWait = z.infer<typeof hostQueueWaitSchema>;

type RequestReader = Pick<IResourceStartStore, 'getResourceStartRequest'>;

/**
 * The start queued request `requestId` waits behind for the run limit's room, or null. A
 * request whose recorded blocker run has a status this binary cannot read is reported by the
 * item read as that run unreadable; here it waits behind no start, so the rest still reads.
 */
export async function hostQueueWait(
  store: RequestReader,
  requestId: string
): Promise<HostQueueWait> {
  let request: Awaited<ReturnType<RequestReader['getResourceStartRequest']>>;
  try {
    request = await store.getResourceStartRequest(requestId);
  } catch (error) {
    if (error instanceof WorkflowStatusReadError) return null;
    throw error;
  }
  if (request?.status !== 'queued' || request.blocker?.kind !== 'request') return null;
  const ahead = await store.getResourceStartRequest(request.blocker.id);
  return ahead?.status === 'queued' &&
    ahead.resource !== request.resource &&
    ahead.hostId === request.hostId
    ? { requestId: ahead.id, resource: ahead.resource }
    : null;
}

/** Whether a receipt has a queued start that waits for the run limit `limit`. */
export async function receiptWaitsForRunLimit(
  store: RequestReader,
  limit: RunLimit | null,
  bindings: readonly StartBindingInspection[]
): Promise<boolean> {
  if (limit === null) return false;
  for (const binding of bindings) {
    if (binding.requestStatus !== 'queued') continue;
    if (fullRunLimit(limit)) return true;
    if (binding.disposition && (await hostQueueWait(store, binding.disposition.requestId)))
      return true;
  }
  return false;
}
