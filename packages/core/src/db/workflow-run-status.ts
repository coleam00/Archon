import {
  workflowRunStatusSchema,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';

export class WorkflowStatusReadError extends Error {
  override readonly name = 'WorkflowStatusReadError';

  constructor(
    readonly workflowRunId: string,
    readonly storedStatus: string
  ) {
    super(
      `Unsupported workflow run status for run ${workflowRunId}: ${JSON.stringify(storedStatus)}`
    );
  }
}

export function readWorkflowRunStatus(id: string, storedStatus: string): WorkflowRunStatus {
  const status = workflowRunStatusSchema.safeParse(storedStatus);
  if (!status.success) throw new WorkflowStatusReadError(id, storedStatus);
  return status.data;
}
