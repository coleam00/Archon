import type { loadConfig } from '@archon/core/config/config-loader';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
import type { IWorkflowHostStore } from '@archon/core/workflows/host-store';
import type { WorkflowOperations } from '@archon/core/operations/workflow-operations';

export interface WorkflowCommandHost {
  deps: Omit<WorkflowDeps, 'loadConfig'> & { loadConfig: typeof loadConfig };
  engine: IWorkflowEngine;
  records: IWorkflowHostStore;
  operations: WorkflowOperations;
}
