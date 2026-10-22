/** An unreadable parent lifecycle cannot authorize a node or run terminal outcome. */
export class ParentStatusReadError extends Error {
  constructor(
    readonly workflowRunId: string,
    readonly nodeId: string,
    cause: unknown
  ) {
    super(`Could not verify parent status after '${nodeId}'`, { cause });
    this.name = 'ParentStatusReadError';
  }
}
