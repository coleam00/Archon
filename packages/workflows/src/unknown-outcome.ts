/**
 * The rule that a node whose outcome is unknown is not run again by itself. A node failure
 * of kind `outcome_unknown` says the engine does not know whether the node's side effect
 * happened. While a run holds such a failure, nothing continues it automatically: a walk
 * whose node failed over its own unknown outcome (or one of what ran under it) starts nothing
 * more and the pass fails the run at its top level, a sibling's unreadable source fails the
 * run instead of releasing it, a parent continued by itself does not re-drive a child holding
 * one, and every automatic claim of the run is refused at the claim's compare-and-swap. An
 * operator's resume by hand is the one way on.
 *
 * The fact is the stored failed-node record, folded latest-record-per-step by the fold the
 * terminal record uses, so an aggregate cannot forget it: one that does not complete over
 * the failure leaves it live. A composed fan-out whose join occurrence (its loop round)
 * completed after the failure absorbed it, an `all_done` join as today; a recomputed join
 * replays it rather than running the instance again. A loop group that completes over a
 * body failure keeps it live (issue 6327).
 */
import { composeFanOutScopeParts, composeFanOutScopeSegment } from './fan-out-identity';
import type { NodeInvocation } from './schemas/node-execution';
import { readRunStopReason } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import type { ResumeClaimCursor } from './store/continuation-cursors';
import { readNodeRecordEvent } from './node-record-reader';
import { buildRunNodeStates, type TerminalRecordEvent } from './terminal-record';

const NODE_STATE_TYPES: ReadonlySet<string> = new Set(NODE_STATE_EVENT_TYPES);

/** The stored events the rule reads: node records, each naming the invocation that wrote it. */
export const UNKNOWN_OUTCOME_EVENT_TYPES = NODE_STATE_EVENT_TYPES;

/** One step whose latest record is a failure of kind `outcome_unknown`. */
export interface UnknownOutcome {
  path: string;
  /**
   * Where the invocation that recorded it ran: its loop frames (`loopPath`) and the composed
   * fan-out instances around it (`fanOutPath`). `undefined` for a record without node
   * metadata; `fanOutPath` is absent on a record written before that field existed.
   */
  invocation: Pick<NodeInvocation, 'loopPath' | 'fanOutPath'> | undefined;
  /**
   * The innermost composed fan-out scope of `fanOutPath` whose own join occurrence (its loop
   * round) completed after the record: that join absorbed the failure. `undefined` when the
   * failure is live; one recorded after the join's last completion, as when a recomputed
   * join ran the instance again, is live too.
   */
  absorbedBy: string | undefined;
}

/** Every step whose latest record is a failure of kind `outcome_unknown`. */
export function unknownOutcomes(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): UnknownOutcome[] {
  const invocationOf = (event: TerminalRecordEvent | undefined) =>
    event && readNodeRecordEvent({ ...event, workflow_run_id: run.id })?.metadata?.invocation;
  const lastRecord = new Map<string, number>();
  const completions = new Map<string, number[]>();
  for (const [index, event] of events.entries()) {
    // Only node records order a failure against its join: an audit event on the same step
    // (a session note, say) is not one, whatever events the caller passes.
    if (!event.step_name || !NODE_STATE_TYPES.has(event.event_type)) continue;
    lastRecord.set(event.step_name, index);
    if (event.event_type === 'node_completed')
      completions.set(event.step_name, [...(completions.get(event.step_name) ?? []), index]);
  }
  // A scope's join occurrence is its fan-out node's completion in the scope's loop round.
  const joinedAfter = (scope: string, at: number): boolean => {
    const { prefix, nodeId } = composeFanOutScopeParts(scope);
    return (completions.get(prefix + nodeId) ?? []).some(
      index =>
        index > at &&
        prefix + composeFanOutScopeSegment(nodeId, invocationOf(events[index])?.loopPath ?? []) ===
          scope
    );
  };
  return buildRunNodeStates(run, events)
    .filter(node => node.state === 'failed' && node.failure_kind === 'outcome_unknown')
    .map(node => {
      const at = lastRecord.get(node.node_id) ?? Number.POSITIVE_INFINITY;
      const invocation = invocationOf(events[at]);
      return {
        path: node.node_id,
        invocation,
        absorbedBy: (invocation?.fanOutPath ?? [])
          .map(frame => frame.scope)
          .filter(scope => joinedAfter(scope, at))
          .at(-1),
      };
    });
}

/** The step paths of `unknownOutcomes` that no join absorbed. Empty when nothing holds the run. */
export function liveUnknownOutcomes(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): string[] {
  return livePaths(unknownOutcomes(run, events));
}

const livePaths = (outcomes: readonly UnknownOutcome[]): string[] =>
  outcomes.filter(outcome => outcome.absorbedBy === undefined).map(outcome => outcome.path);

/** Failed with stop reason `outcome_unknown`: listed in attention until resumed or abandoned. */
export function isOutcomeUnknownRun(
  run: Pick<WorkflowRun, 'status'> & { metadata?: Record<string, unknown> }
): boolean {
  return run.status === 'failed' && readRunStopReason(run.metadata)?.reason === 'outcome_unknown';
}

/** `unknownOutcomes` over the run's stored events. */
export async function readUnknownOutcomes(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  run: Pick<WorkflowRun, 'id' | 'metadata'>
): Promise<UnknownOutcome[]> {
  const events = (await store.listEventsForRuns([run.id], UNKNOWN_OUTCOME_EVENT_TYPES)).get(run.id);
  return unknownOutcomes(run, events ?? []);
}

/** `liveUnknownOutcomes` over the run's stored events. */
export async function readLiveUnknownOutcomes(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  run: Pick<WorkflowRun, 'id' | 'metadata'>
): Promise<string[]> {
  return livePaths(await readUnknownOutcomes(store, run));
}

/**
 * Whether a claim continues the run by itself: every cursor but an operator's resume by hand
 * (no cursor, or `ownerless`, the resume of a run whose owner is gone).
 */
export function isAutomaticClaim(cursor: ResumeClaimCursor | undefined): boolean {
  return cursor !== undefined && cursor.kind !== 'ownerless';
}
