import { ParentSnapshotReadError } from './parent-snapshot-read';
import { ParentStatusReadError } from './parent-status-read';
import { TerminalStatusWriteError } from './terminal-status-write';

/** These rejections cannot authorize a compensating terminal transition. */
export function isWorkflowExecutionInterruption(
  error: unknown
): error is ParentStatusReadError | ParentSnapshotReadError | TerminalStatusWriteError {
  return (
    error instanceof ParentStatusReadError ||
    error instanceof ParentSnapshotReadError ||
    error instanceof TerminalStatusWriteError
  );
}
