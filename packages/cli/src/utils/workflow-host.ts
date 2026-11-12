import { redactedFailureReasons } from './trigger-diagnostics';
import { join } from 'node:path';
import { getArchonHome, createLogger } from '@archon/paths';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import type { WorkflowHost } from '@archon/core/workflows/host-store';

let stopReleaseSubscription: (() => void) | undefined;

export async function createCliWorkflowHost(executesWorkflow = false): Promise<WorkflowHost> {
  let host: WorkflowHost;
  if ((await loadStoreSelection()) === 'files') {
    if (executesWorkflow) {
      const { initializeWorkflowGitHubAppAuth } = await import(
        '@archon/core/workflows/store-adapter'
      );
      initializeWorkflowGitHubAppAuth();
    }
    const { createFileWorkflowHost } = await import('@archon/core/workflows/file-host');
    host = await createFileWorkflowHost(join(getArchonHome(), 'store'));
  } else {
    const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
    host = createSqlWorkflowHost(
      executesWorkflow ? (await import('./workflow-deps')).createCliWorkflowDeps() : undefined
    );
  }
  stopReleaseSubscription?.();
  const { subscribeResourceStartReleases } = await import(
    '@archon/core/workflows/resource-start-completion'
  );
  stopReleaseSubscription = subscribeResourceStartReleases(
    host,
    async (hostId, excludedResources) => {
      try {
        const { drainHost, spawnAdmitted } = await import('../triggers/resource-start-host');
        await drainHost(
          host,
          hostId,
          (requestId, id) => spawnAdmitted(host, requestId, id),
          excludedResources
        );
      } catch (err) {
        createLogger('cli.trigger').error(
          { error: redactedFailureReasons([err]), hostId },
          'resource_start.release_drain_failed'
        );
        process.stderr.write(
          `Warning: trigger host ${hostId} drain failed: ${redactedFailureReasons([err])}. ` +
            `Retry queued or pending work with archon trigger drain --host ${hostId}; ` +
            `for admitted requests, inspect ownership before retrying trigger execute.\n`
        );
      }
    },
    runId => {
      process.stderr.write(
        `Warning: could not resolve the trigger host for run ${runId}; inspect with archon workflow get ${runId}.\n`
      );
    }
  );
  return host;
}
