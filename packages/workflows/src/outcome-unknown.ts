/**
 * The one rule that work whose outcome is unknown is not run again by itself. A node
 * failure recording `outcome_unknown` says a side effect may or may not have happened, so
 * nothing may run that node again automatically: the run fails with stop reason
 * `outcome_unknown`, the usage-limit wait, the source release and a loop's next round
 * refuse it, and an operator resumes or abandons the run.
 *
 * The rule reads the run's persisted node records, not the node outputs of the pass, so an
 * aggregate (loop group, composed fan-out) that records `child_failed` for its inner
 * failure cannot hide it. A `workflow:` child keeps its records in its own run, which
 * records the stop reason; a parent never re-drives such a child ({@link isOutcomeUnknownRun}),
 * so the operator resumes the child itself.
 */
import type { WorkflowRun } from './schemas/workflow-run';
import { readRunStopReason } from './schemas/run-metadata';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import { buildRunNodeStates, outcomeUnknownNodes } from './terminal-record';

/**
 * The run's steps whose latest record is a failure with an unknown outcome, in record
 * order; only those under `stepPrefix` when one is given. Empty when nothing holds the run.
 */
export async function readOutcomeUnknownSteps(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  stepPrefix = ''
): Promise<string[]> {
  const events = (await store.listEventsForRuns([run.id], NODE_STATE_EVENT_TYPES)).get(run.id);
  return outcomeUnknownNodes(buildRunNodeStates(run, events ?? []))
    .map(node => node.node_id)
    .filter(step => step.startsWith(stepPrefix));
}

/** Whether `run` failed holding an unknown outcome, so only an operator may resume it. */
export function isOutcomeUnknownRun(run: Pick<WorkflowRun, 'status' | 'metadata'>): boolean {
  return run.status === 'failed' && readRunStopReason(run.metadata)?.reason === 'outcome_unknown';
}

/** The held steps as the clause a failure message carries. */
export function outcomeUnknownText(steps: readonly string[]): string {
  return `The outcome of ${steps.map(step => `node '${step}'`).join(', ')} is unknown, so the run is not continued automatically: check what it did, then resume or abandon the run.`;
}
