import { join } from 'node:path';
import { getArchonHome, createLogger } from '@archon/paths';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import type { WorkflowHost } from '@archon/core/workflows/host-store';

export async function createCliWorkflowHost(executesWorkflow = false): Promise<WorkflowHost> {
  let host: WorkflowHost;
  const afterOwnedExecution: NonNullable<WorkflowHost['afterOwnedExecution']> = async runId => {
    const { drainAfterResourceStart } = await import(
      '@archon/core/workflows/resource-start-completion'
    );
    try {
      await drainAfterResourceStart(host, runId, async hostId => {
        try {
          const { drainHost, spawnAdmitted } = await import('../triggers/resource-start-host');
          await drainHost(host, hostId, (requestId, id) => spawnAdmitted(host, requestId, id));
        } catch (err) {
          createLogger('cli.trigger').error(
            { err, runId, hostId },
            'resource_start.completion_drain_failed'
          );
          process.stderr.write(
            `Warning: queued work may need recovery: archon trigger drain --host ${hostId}\n`
          );
        }
      });
    } catch (err) {
      createLogger('cli.trigger').error({ err, runId }, 'resource_start.completion_lookup_failed');
      process.stderr.write(
        `Warning: could not resolve the trigger host for run ${runId}; inspect with archon trigger inspect ${runId}.\n`
      );
    }
  };
  if ((await loadStoreSelection()) === 'files') {
    if (executesWorkflow) {
      const { initializeWorkflowGitHubAppAuth } = await import(
        '@archon/core/workflows/store-adapter'
      );
      initializeWorkflowGitHubAppAuth();
    }
    const { createFileWorkflowHost } = await import('@archon/core/workflows/file-host');
    host = await createFileWorkflowHost(join(getArchonHome(), 'store'), { afterOwnedExecution });
    return host;
  }
  const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
  host = createSqlWorkflowHost(
    executesWorkflow ? (await import('./workflow-deps')).createCliWorkflowDeps() : undefined,
    { afterOwnedExecution }
  );
  return host;
}
