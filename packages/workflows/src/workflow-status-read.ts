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
