/**
 * The rule that a node whose outcome is unknown is not run again by itself. A node failure
 * of kind `outcome_unknown` says the engine does not know whether the node's side effect
 * happened. While a run holds such a failure, nothing continues it automatically: the pass
 * fails it where the failure reaches its top level, a sibling's unreadable source fails it
 * instead of releasing it, and every automatic claim of it is refused at the claim's
 * compare-and-swap. An operator's resume by hand is the one way on.
 *
 * The fact is the stored failed-node record, folded latest-record-per-step by the fold the
 * terminal record uses, so an aggregate cannot forget it: one that does not complete over
 * the failure leaves it live. A composed fan-out whose join completed absorbed it (an
 * `all_done` join, as today). A loop group that completes over a body failure keeps it
 * live, so such a run stops more often and never runs the node again (issue 6327).
 */
import { composeFanOutJoinStep } from './fan-out-identity';
import { readRunStopReason } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import type { ResumeClaimCursor } from './store/continuation-cursors';
import { buildRunNodeStates, type TerminalRecordEvent } from './terminal-record';

/** The stored events the rule reads: node states, and the composed fan-out scopes. */
export const UNKNOWN_OUTCOME_EVENT_TYPES = [
  ...NODE_STATE_EVENT_TYPES,
  'fan_out_instances',
] as const;

/**
 * The step paths whose latest record is a failure of kind `outcome_unknown`, but for those
 * inside a composed fan-out whose join completed. Empty when nothing holds the run.
 */
export function liveUnknownOutcomes(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): string[] {
  const nodes = buildRunNodeStates(run, events);
  const states = new Map(nodes.map(node => [node.node_id, node.state]));
  const absorbed = events.flatMap(event =>
    event.event_type === 'fan_out_instances' &&
    event.step_name &&
    states.get(composeFanOutJoinStep(event.step_name)) === 'completed'
      ? [`${event.step_name}__`]
      : []
  );
  return nodes
    .filter(
      node =>
        node.state === 'failed' &&
        node.failure_kind === 'outcome_unknown' &&
        !absorbed.some(scope => node.node_id.startsWith(scope))
    )
    .map(node => node.node_id);
}

/** Failed with stop reason `outcome_unknown`: listed in attention until resumed or abandoned. */
export function isOutcomeUnknownRun(
  run: Pick<WorkflowRun, 'status'> & { metadata?: Record<string, unknown> }
): boolean {
  return run.status === 'failed' && readRunStopReason(run.metadata)?.reason === 'outcome_unknown';
}

/** `liveUnknownOutcomes` over the run's stored events. */
export async function readLiveUnknownOutcomes(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  run: Pick<WorkflowRun, 'id' | 'metadata'>
): Promise<string[]> {
  const events = (await store.listEventsForRuns([run.id], UNKNOWN_OUTCOME_EVENT_TYPES)).get(run.id);
  return liveUnknownOutcomes(run, events ?? []);
}

/**
 * Whether a claim continues the run by itself: every cursor but an operator's resume by hand
 * (no cursor, or `ownerless`, the resume of a run whose owner is gone).
 */
export function isAutomaticClaim(cursor: ResumeClaimCursor | undefined): boolean {
  return cursor !== undefined && cursor.kind !== 'ownerless';
}
