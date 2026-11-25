/**
 * The rule that a node whose outcome is unknown is not run again by itself. A node failure
 * of kind `outcome_unknown` says the engine does not know whether the node's side effect
 * happened. While a run holds such a failure, nothing continues it automatically: a walk
 * whose node fails while the run holds one starts nothing more and the pass fails the run
 * at its top level, a sibling's unreadable source fails the run instead of releasing it, and every
 * automatic claim of it is refused at the claim's compare-and-swap. An operator's resume by
 * hand is the one way on.
 *
 * The fact is the stored failed-node record, folded latest-record-per-step by the fold the
 * terminal record uses, so an aggregate cannot forget it: one that does not complete over
 * the failure leaves it live. A composed fan-out whose join occurrence (its loop round)
 * completed after the failure absorbed it, an `all_done` join as today. A loop group that
 * completes over a body failure keeps it live, so such a run stops more often and never
 * runs the node again (issue 6327).
 */
import { composeFanOutScopeParts, composeFanOutScopeSegment } from './fan-out-identity';
import { readRunStopReason } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import type { ResumeClaimCursor } from './store/continuation-cursors';
import { readNodeRecordEvent } from './node-record-reader';
import { buildRunNodeStates, type TerminalRecordEvent } from './terminal-record';

/** The stored events the rule reads: node states, and the composed fan-out scopes. */
export const UNKNOWN_OUTCOME_EVENT_TYPES = [
  ...NODE_STATE_EVENT_TYPES,
  'fan_out_instances',
] as const;

/**
 * The step paths whose latest record is a failure of kind `outcome_unknown`, but for those
 * inside a composed fan-out scope whose own join occurrence (its loop round) completed after
 * that record: that join absorbed the failure. A failure recorded after the join's last
 * completion, as when a recomputed join runs the instance again, is live.
 */
export function liveUnknownOutcomes(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): string[] {
  const scopes = events.flatMap(({ event_type, step_name }) =>
    event_type === 'fan_out_instances' && step_name
      ? [{ scope: step_name, ...composeFanOutScopeParts(step_name) }]
      : []
  );
  const lastRecord = new Map<string, number>();
  const joinedAt = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (!event.step_name || event.event_type === 'fan_out_instances') continue;
    lastRecord.set(event.step_name, index);
    if (event.event_type !== 'node_completed') continue;
    const record = readNodeRecordEvent({ ...event, workflow_run_id: run.id });
    const round = record?.metadata?.invocation.loopPath ?? [];
    for (const { scope, prefix, nodeId } of scopes)
      if (
        prefix + nodeId === event.step_name &&
        prefix + composeFanOutScopeSegment(nodeId, round) === scope
      )
        joinedAt.set(scope, index);
  }
  const absorbed = (path: string): boolean =>
    scopes.some(
      ({ scope }) =>
        path.startsWith(`${scope}__`) &&
        (joinedAt.get(scope) ?? -1) > (lastRecord.get(path) ?? Number.POSITIVE_INFINITY)
    );
  return buildRunNodeStates(run, events)
    .filter(
      node =>
        node.state === 'failed' &&
        node.failure_kind === 'outcome_unknown' &&
        !absorbed(node.node_id)
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
