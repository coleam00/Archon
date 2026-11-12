import { createLogger } from '@archon/paths';
import { subscribeRunSlotRelease } from '@archon/workflows/run-slot-release';
import type { WorkflowHost } from './host-store';

/** Resolve recorded admissions, coalescing released runs by their execution host. */
export function subscribeResourceStartReleases(
  host: Pick<WorkflowHost, 'deps'>,
  requestHostDrain: (hostId: string) => Promise<void>,
  onLookupFailure?: (runId: string) => void
): () => void {
  const store = host.deps.store;
  return subscribeRunSlotRelease(store, async runIds => {
    const hosts = new Set<string>();
    for (const runId of runIds) {
      try {
        let request = await store.getResourceStartRequest(runId);
        if (!request) {
          const root = (await store.getRunAncestry(runId)).at(-1);
          if (root) request = await store.getResourceStartRequest(root.id);
        }
        if (request?.status === 'admitted') hosts.add(request.hostId);
      } catch (err) {
        createLogger('resource-start-release').error(
          { err, runId },
          'resource_start.release_lookup_failed'
        );
        onLookupFailure?.(runId);
      }
    }
    for (const hostId of hosts) await requestHostDrain(hostId);
  });
}
