import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { IWorkflowStore } from '@archon/workflows/store';

/**
 * The trigger host this process serves, if any: the `--host` a `trigger execute` process
 * runs as, otherwise `ARCHON_TRIGGER_HOST`. Never guessed, because a binding names the
 * host its work executes on.
 */
export function cliOwnTriggerHost(executeHost?: string): string | undefined {
  return executeHost ?? (process.env.ARCHON_TRIGGER_HOST?.trim() || undefined);
}

export async function createCliWorkflowHost(
  executesWorkflow = false,
  ownTriggerHost = cliOwnTriggerHost()
): Promise<WorkflowHost> {
  // Set once the host exists: the drain a run's end starts runs through the whole host.
  let host: WorkflowHost | undefined;
  const wrapStore = async <S extends IWorkflowStore>(store: S): Promise<S> => {
    if (ownTriggerHost === undefined) return store;
    const { drainAfterRunEnds } = await import('@archon/core/workflows/run-end-drain');
    const drain = await ownHostDrain(() => host, ownTriggerHost);
    return drainAfterRunEnds(store, drain);
  };
  if ((await loadStoreSelection()) === 'files') {
    if (executesWorkflow) {
      const { initializeWorkflowGitHubAppAuth } = await import(
        '@archon/core/workflows/store-adapter'
      );
      initializeWorkflowGitHubAppAuth();
    }
    const { createFileWorkflowHost } = await import('@archon/core/workflows/file-host');
    host = await createFileWorkflowHost(join(getArchonHome(), 'store'), wrapStore);
    return host;
  }
  const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
  const { createWorkflowDeps } = await import('@archon/core/workflows/store-adapter');
  const deps = executesWorkflow
    ? (await import('./workflow-deps')).createCliWorkflowDeps()
    : createWorkflowDeps();
  host = createSqlWorkflowHost({ ...deps, store: await wrapStore(deps.store) });
  return host;
}

/**
 * After a run this process ended, drain its own trigger host: prepare the starts that
 * end caused and admit queued work into the slot it released. Each admitted run starts
 * in its own detached `trigger execute` process, as `trigger fire` starts them.
 */
async function ownHostDrain(
  getHost: () => WorkflowHost | undefined,
  hostId: string
): Promise<(runId: string) => Promise<void>> {
  const [{ drainResourceStartHost }, { serializedDrain }, { spawnAdmitted }] = await Promise.all([
    import('@archon/core/workflows/resource-start-host'),
    import('@archon/core/workflows/run-end-drain'),
    import('./spawn-admitted'),
  ]);
  const drain = serializedDrain(async () => {
    const host = getHost();
    if (!host) return;
    await drainResourceStartHost({
      ...host,
      hostId,
      startAdmitted: requestId => spawnAdmitted(host, requestId, hostId),
    });
  });
  return async runId => {
    createLogger('cli.run-end-drain').debug({ workflowRunId: runId, hostId }, 'run_end_drain');
    await drain();
  };
}
