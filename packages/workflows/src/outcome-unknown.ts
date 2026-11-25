/**
 * The one rule that a run whose outcome is unknown is not continued automatically. A node
 * failure recording `outcome_unknown` says a side effect may or may not have happened, so
 * nothing may run that node again by itself: the run fails with stop reason
 * `outcome_unknown`, the usage-limit wait and the source release refuse it, and an
 * operator resumes or abandons it.
 *
 * The rule reads the run's persisted node records, not the node outputs of the pass, so an
 * aggregate (loop group, composed fan-out, `workflow:` node) that records `child_failed`
 * for its inner failure cannot hide it. A child run records its own stop reason through
 * this same rule, so a parent sees it on the child's row: a parent continued by a wake
 * pass would otherwise re-drive the failed child.
 */
import type { WorkflowRun } from './schemas/workflow-run';
import { readRunStopReason } from './schemas/run-metadata';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import { buildRunNodeStates, outcomeUnknownNodes } from './terminal-record';

/** What holds a run back: its own outcome-unknown steps and its failed child runs that hold one. */
export interface OutcomeUnknownHold {
  steps: string[];
  childRunIds: string[];
}

/** The run's outcome-unknown hold, or undefined when nothing holds it. */
export async function readOutcomeUnknownHold(
  store: Pick<IWorkflowStore, 'listEventsForRuns' | 'findChildRuns'>,
  run: Pick<WorkflowRun, 'id' | 'metadata'>
): Promise<OutcomeUnknownHold | undefined> {
  const events = (await store.listEventsForRuns([run.id], NODE_STATE_EVENT_TYPES)).get(run.id);
  const steps = outcomeUnknownNodes(buildRunNodeStates(run, events ?? [])).map(
    node => node.node_id
  );
  const childRunIds = (await store.findChildRuns(run.id))
    .filter(
      child =>
        child.status === 'failed' && readRunStopReason(child.metadata)?.reason === 'outcome_unknown'
    )
    .map(child => child.id);
  return steps.length > 0 || childRunIds.length > 0 ? { steps, childRunIds } : undefined;
}

/** The hold as the clause a failure message carries. */
export function outcomeUnknownText(hold: OutcomeUnknownHold): string {
  const held = [
    ...hold.steps.map(step => `node '${step}'`),
    ...hold.childRunIds.map(id => `child run ${id}`),
  ].join(', ');
  return `The outcome of ${held} is unknown, so the run is not continued automatically: check what it did, then resume or abandon the run.`;
}
