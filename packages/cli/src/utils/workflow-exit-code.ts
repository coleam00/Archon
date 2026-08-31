/**
 * Reserved launcher/child status for a workflow that ran and recorded failure. A plain non-zero
 * status cannot distinguish that outcome from a child that died during the startup window.
 */
export const DETACHED_RUN_FAILED_EXIT_CODE = 90;

/** The reserved status is private to detached children; foreground workflow failures stay at 1. */
export class WorkflowRunFailedError extends Error {
  readonly exitCode: number;

  constructor(reason: string | undefined, detachedChild: boolean) {
    super(`Workflow failed: ${String(reason)}`);
    this.name = 'WorkflowRunFailedError';
    this.exitCode = detachedChild ? DETACHED_RUN_FAILED_EXIT_CODE : 1;
  }
}

/** Continuation commands wrap failures, so preserve a workflow-owned status through causes. */
export function resolveCliExitCode(error: unknown): number {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof WorkflowRunFailedError) return current.exitCode;
  }
  return 1;
}
