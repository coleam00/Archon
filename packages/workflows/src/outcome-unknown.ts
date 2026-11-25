/**
 * The rule that a node whose outcome is unknown is not run again by itself. A node failure
 * recording `outcome_unknown` says a side effect may or may not have happened. The top-level
 * walk then starts no further layer, and the run fails with stop reason `outcome_unknown`
 * through its one run-failing path; no wait, release or completion is reached. Only an
 * operator's hand resume continues it, and that resume is the operator accepting the unknown.
 *
 * The rule reads persisted `node_failed` rows, so an aggregate that records `child_failed`
 * for its inner step (a loop body, a composed instance) cannot hide it, and nothing is
 * threaded through aggregates. A failed run's resume writes `workflow_resumed`
 * (`resume-transition.ts`); a paused run's continuation does not. So "since the last
 * `workflow_resumed`" lets a hand resume clear the hold while a continuation keeps it.
 */
import type { WorkflowRun } from './schemas/workflow-run';
import { readRunStopReason } from './schemas/run-metadata';
import type { IWorkflowStore } from './store';
import { recordedFailureKind } from './terminal-record';

/** The steps that recorded an `outcome_unknown` failure since the run last resumed from failed. */
export async function readOutcomeUnknownSteps(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  runId: string
): Promise<string[]> {
  const rows =
    (await store.listEventsForRuns([runId], ['node_failed', 'workflow_resumed'])).get(runId) ?? [];
  const resumed = rows.map(row => row.event_type).lastIndexOf('workflow_resumed');
  return rows
    .slice(resumed + 1)
    .flatMap(row =>
      row.event_type === 'node_failed' &&
      row.step_name &&
      recordedFailureKind(row) === 'outcome_unknown'
        ? [row.step_name]
        : []
    );
}

/** A run that failed with an unknown outcome: listed in attention until resumed or abandoned. */
export function isOutcomeUnknownRun(run: Pick<WorkflowRun, 'status' | 'metadata'>): boolean {
  return run.status === 'failed' && readRunStopReason(run.metadata)?.reason === 'outcome_unknown';
}

/** Why the run stopped, naming the steps whose outcome is unknown. */
export function outcomeUnknownMessage(workflowName: string, steps: readonly string[]): string {
  const nodes = steps.map(step => `'${step}'`).join(', ');
  return `DAG workflow '${workflowName}' stopped: the outcome of node${steps.length > 1 ? 's' : ''} ${nodes} is unknown, so it does not continue by itself. Check what ${steps.length > 1 ? 'they' : 'it'} did, then resume or abandon the run.`;
}
