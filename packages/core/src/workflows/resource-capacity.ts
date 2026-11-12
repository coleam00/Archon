import type { ResourceCapacityPolicy } from '@archon/workflows/resource-start-store';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveRunSourceCapture, capturedSourceRoots } from '@archon/workflows/workflow-source';
import { providerRegistry } from '@archon/providers';
import { loadResourceConcurrencyCaps } from '../config/resource-concurrency';

export const installResourceCapacityPolicy: ResourceCapacityPolicy = {
  loadCaps: loadResourceConcurrencyCaps,
  readCapturedDeclaration: async (launch, resource) => {
    const capture = await resolveRunSourceCapture(launch.run.metadata);
    if (!capture) return undefined;
    const result = await discoverWorkflowsWithConfig(
      launch.execution.cwd,
      async () => ({}),
      providerRegistry,
      capturedSourceRoots(capture.anchor)
    );
    const workflow = result.workflows.find(
      entry => entry.workflow.name === launch.run.workflow_name
    )?.workflow;
    if (!workflow)
      throw new Error(
        `Cannot recover resource declaration for '${launch.run.workflow_name}' from captured source`,
        { cause: result.errors }
      );
    return workflow.resource?.name === resource ? workflow.resource.capacity : undefined;
  },
};
