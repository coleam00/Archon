import type { NodeFailureKind } from './schemas/node-execution';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import {
  buildRunNodeStates,
  firstFailedNodeEvent,
  outcomeUnknownNodes,
  recordedFailureKind,
} from './terminal-record';

/**
 * The `cause` of an attention `terminal` line: a node whose failure recorded
 * `outcome_unknown`, on a failed or completed run, else a failed run's first failed node and
 * its recorded kind. Only the events before the delivered terminal event count, so a
 * replayed line keeps its cause after the run resumed and ended again. A read failure fails
 * the delivery, which the follower retries.
 */
export async function terminalCause(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  event: WorkflowEventRow,
  status: 'completed' | 'failed',
  firstFailedNode: string | null
): Promise<{ node: string; errorClass: NodeFailureKind | null } | null> {
  const runId = event.workflow_run_id;
  const rows =
    (
      await store.listEventsForRuns(
        [runId],
        [...NODE_STATE_EVENT_TYPES, 'workflow_failed', 'workflow_completed']
      )
    ).get(runId) ?? [];
  const end = rows.findIndex(row => row.id === event.id);
  const before = end === -1 ? rows : rows.slice(0, end);
  const unknown = outcomeUnknownNodes(buildRunNodeStates({ id: runId, metadata: {} }, before))[0];
  if (unknown !== undefined) return { node: unknown.node_id, errorClass: 'outcome_unknown' };
  if (status !== 'failed' || firstFailedNode === null) return null;
  const failed = firstFailedNodeEvent({ first_failed_node: firstFailedNode }, before);
  return {
    node: firstFailedNode,
    errorClass: failed === undefined ? null : (recordedFailureKind(failed) ?? null),
  };
}
