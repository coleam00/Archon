/** A lifecycle check failed; execution cannot infer a node or run outcome. */
export class WorkflowStatusReadError extends Error {
  constructor(
    readonly workflowRunId: string,
    cause: unknown
  ) {
    super(
      `Could not read workflow status for run ${workflowRunId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'WorkflowStatusReadError';
  }
}

export async function readWorkflowLifecycle<T>(
  workflowRunId: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof WorkflowStatusReadError) throw error;
    throw new WorkflowStatusReadError(workflowRunId, error);
  }
}
