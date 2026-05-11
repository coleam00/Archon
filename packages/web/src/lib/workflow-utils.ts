/**
 * Check if a workflow status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
