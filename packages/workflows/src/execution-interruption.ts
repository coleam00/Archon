import { ParentStatusReadError } from './parent-status-read';
import { TerminalStatusWriteError } from './terminal-status-write';

/** These rejections cannot authorize a compensating terminal transition. */
export function isWorkflowExecutionInterruption(
  error: unknown
): error is ParentStatusReadError | TerminalStatusWriteError {
  return error instanceof ParentStatusReadError || error instanceof TerminalStatusWriteError;
}
