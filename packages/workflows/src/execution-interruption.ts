import { WorkflowStatusReadError } from './workflow-status-read';
import { ParentStatusReadError } from './parent-status-read';
import { TerminalStatusWriteError } from './terminal-status-write';

/** These rejections cannot authorize a compensating terminal transition. */
export function isWorkflowExecutionInterruption(
  error: unknown
): error is ParentStatusReadError | TerminalStatusWriteError | WorkflowStatusReadError {
  return (
    error instanceof ParentStatusReadError ||
    error instanceof TerminalStatusWriteError ||
    error instanceof WorkflowStatusReadError
  );
}
