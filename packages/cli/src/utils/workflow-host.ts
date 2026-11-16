import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';

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
  // Set once the host exists: what a run's end starts runs through the whole host.
  let host: WorkflowHost | undefined;
  const wrapStore = async <S extends IWorkflowStore>(store: S): Promise<S> => {
    const { drainAfterRunEnds } = await import('@archon/core/workflows/run-end-drain');
    return drainAfterRunEnds(store, await afterRunEnded(() => host, ownTriggerHost));
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
 * After a run this process ended: start the starts its completion wrote, each on the host
 * its binding names, as `trigger fire` starts its receipt; then, when this process serves
 * a trigger host, drain that host so queued work takes the slot the run released. A
 * process that serves no host leaves every other start on a host's queue to that host.
 * Each admitted run starts in its own detached `trigger execute` process.
 */
async function afterRunEnded(
  getHost: () => WorkflowHost | undefined,
  ownTriggerHost: string | undefined
): Promise<(runId: string, caused: readonly SourceReceiptAcceptance[]) => Promise<void>> {
  const { serializedDrain } = await import('@archon/core/workflows/run-end-drain');
  // Loaded only when an end has work to start, so a process with none pays nothing.
  const starting = async () => {
    const [{ drainResourceStartHost, startReceiptBindings }, { spawnAdmitted }] = await Promise.all(
      [import('@archon/core/workflows/resource-start-host'), import('./spawn-admitted')]
    );
    const asHost = (host: WorkflowHost, hostId: string) => ({
      ...host,
      hostId,
      startAdmitted: (requestId: string) => spawnAdmitted(host, requestId, hostId),
    });
    return { drainResourceStartHost, startReceiptBindings, asHost };
  };
  const drainOwn = serializedDrain(async () => {
    const host = getHost();
    if (!host || ownTriggerHost === undefined) return;
    const { drainResourceStartHost, asHost } = await starting();
    await drainResourceStartHost(asHost(host, ownTriggerHost));
  });
  return async (runId, caused) => {
    const host = getHost();
    if (!host) return;
    createLogger('cli.run-end-drain').debug(
      { workflowRunId: runId, ownTriggerHost, caused: caused.length },
      'run_end_drain'
    );
    const byHost = new Map<string, Set<string>>();
    for (const { receipt, bindings } of caused)
      for (const binding of bindings) {
        const ids = byHost.get(binding.hostId) ?? new Set<string>();
        ids.add(receipt.id);
        byHost.set(binding.hostId, ids);
      }
    // One host's failure must not keep the others, or this host's drain, from running.
    const failures: unknown[] = [];
    if (byHost.size > 0) {
      const { startReceiptBindings, asHost } = await starting();
      for (const [hostId, receiptIds] of byHost)
        await startReceiptBindings(asHost(host, hostId), receiptIds).catch((error: unknown) => {
          failures.push(error);
        });
    }
    await drainOwn().catch((error: unknown) => {
      failures.push(error);
    });
    if (failures.length > 0)
      throw new AggregateError(failures, 'A start after the run ended failed');
  };
}
