import { createLogger } from '@archon/paths';
import { subscribeRunSlotRelease } from '@archon/workflows/run-slot-release';
import type { WorkflowHost } from './host-store';

/** Resolve recorded admissions, coalescing released runs by their execution host. */
export function subscribeResourceStartReleases(
  host: Pick<WorkflowHost, 'deps'>,
  requestHostDrain: (hostId: string, excludedResources: readonly string[]) => Promise<void>,
  onLookupFailure?: (runId: string) => void
): () => void {
  const store = host.deps.store;
  const admissionForRun = async (runId: string) => {
    let requestId = runId;
    try {
      let request = await store.getResourceStartRequest(requestId);
      if (!request) {
        const root = (await store.getRunAncestry(runId)).at(-1);
        if (root) {
          requestId = root.id;
          request = await store.getResourceStartRequest(requestId);
        }
      }
      return request;
    } catch (err) {
      createLogger('resource-start-release').error(
        { err, runId },
        'resource_start.release_lookup_failed'
      );
      onLookupFailure?.(requestId);
      throw err;
    }
  };
  return subscribeRunSlotRelease(store, async (runIds, deferredRunIds) => {
    const hosts = new Set<string>();
    const excludedResources = new Set<string>();
    const deferred = new Set(deferredRunIds);
    for (const runId of [...deferredRunIds, ...runIds]) {
      try {
        const request = await admissionForRun(runId);
        if (request?.status === 'admitted') {
          if (deferred.has(runId)) excludedResources.add(request.resource);
          else hosts.add(request.hostId);
        }
      } catch {
        // An unresolved unsafe admission cannot be excluded from a host-wide pass.
        if (deferred.has(runId)) return;
      }
    }
    for (const hostId of hosts) await requestHostDrain(hostId, [...excludedResources]);
  });
}
