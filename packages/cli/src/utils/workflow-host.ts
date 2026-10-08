import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { loadStoreSelection } from '@archon/core/config/store-selection';
import type { WorkflowHost } from '@archon/core/workflows/host-store';

export async function createCliWorkflowHost(executesWorkflow = false): Promise<WorkflowHost> {
  if ((await loadStoreSelection()) === 'files') {
    const { assertFileStoreConfiguration } = await import('@archon/core/config/store-selection');
    await assertFileStoreConfiguration();
    if (executesWorkflow) {
      const { initializeWorkflowGitHubAppAuth } =
        await import('@archon/core/workflows/store-adapter');
      initializeWorkflowGitHubAppAuth();
    }
    const { createFileWorkflowHost } = await import('@archon/core/workflows/file-host');
    return createFileWorkflowHost(join(getArchonHome(), 'store'));
  }
  const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
  return createSqlWorkflowHost(
    executesWorkflow ? (await import('./workflow-deps')).createCliWorkflowDeps() : undefined
  );
}
