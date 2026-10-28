import {
  workflowRunStatusSchema,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';

import { WorkflowStatusReadError } from '@archon/workflows/workflow-status-read';
export { WorkflowStatusReadError } from '@archon/workflows/workflow-status-read';

export function readWorkflowRunStatus(id: string, storedStatus: string): WorkflowRunStatus {
  const status = workflowRunStatusSchema.safeParse(storedStatus);
  if (!status.success) throw new WorkflowStatusReadError(id, storedStatus);
  return status.data;
}
