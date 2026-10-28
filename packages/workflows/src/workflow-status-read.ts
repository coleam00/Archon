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
