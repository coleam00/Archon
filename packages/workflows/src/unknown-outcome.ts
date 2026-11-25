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
import {
  composeFanOutScopeParts,
  composeFanOutScopeSegment,
  parseFanOutSnapshots,
} from './fan-out-identity';
import type { NodeInvocation } from './schemas/node-execution';
import { readRunStopReason } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from './store';
import type { ResumeClaimCursor } from './store/continuation-cursors';
import { readNodeRecordEvent } from './node-record-reader';
import { buildRunNodeStates, type TerminalRecordEvent } from './terminal-record';

/** The stored events the rule reads: node states, and the composed fan-out scopes. */
const NODE_STATE_TYPES: ReadonlySet<string> = new Set(NODE_STATE_EVENT_TYPES);

export const UNKNOWN_OUTCOME_EVENT_TYPES = [
  ...NODE_STATE_EVENT_TYPES,
  'fan_out_instances',
] as const;

/** One instance of a composed fan-out: its scope name and its identity in the scope's plan. */
export interface ComposedInstance {
  scope: string;
  identity: string;
}

/** One step whose latest record is a failure of kind `outcome_unknown`. */
export interface UnknownOutcome {
  path: string;
  /**
   * The loop frames of the invocation that recorded it (`invocation.loopPath`): which loop
   * group, if any, ran it. `undefined` for a record without node metadata.
   */
  loopPath: NodeInvocation['loopPath'] | undefined;
  /**
   * The composed fan-out instances the record ran in, outermost first: each one's fan-out
   * scope and instance identity, as that scope's stored plan names them. A step whose name
   * only looks like it is under a scope (node ids may contain `__`) is in none of its
   * instances.
   */
  instances: readonly ComposedInstance[];
  /**
   * The innermost composed fan-out scope whose own join occurrence (its loop round)
   * completed after the record: that join absorbed the failure. `undefined` when the failure
   * is live; one recorded after the join's last completion, as when a recomputed join ran
   * the instance again, is live too.
   */
  absorbedBy: string | undefined;
}

/** Every step whose latest record is a failure of kind `outcome_unknown`. */
export function unknownOutcomes(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): UnknownOutcome[] {
  // Each scope's plan: the first `fan_out_instances` stored for it owns its instance set.
  const plans = new Map<string, ReadonlySet<string>>();
  for (const { event_type, step_name, data } of events) {
    if (event_type !== 'fan_out_instances' || !step_name || plans.has(step_name)) continue;
    const instances =
      typeof data === 'object' && data !== null && 'instances' in data
        ? parseFanOutSnapshots(data.instances)
        : undefined;
    plans.set(step_name, new Set(instances?.map(instance => instance.identity)));
  }
  const scopes = [...plans.keys()].map(scope => ({ scope, ...composeFanOutScopeParts(scope) }));
  // A nested scope's name extends its outer instance's, so sorting by length puts outer first.
  const instancesOf = (path: string): ComposedInstance[] =>
    [...plans]
      .flatMap(([scope, identities]) => {
        if (!path.startsWith(`${scope}__`)) return [];
        const rest = path.slice(scope.length + 2);
        const end = rest.indexOf('__');
        const identity = end === -1 ? rest : rest.slice(0, end);
        return identities.has(identity) ? [{ scope, identity }] : [];
      })
      .sort((a, b) => a.scope.length - b.scope.length);
  const lastRecord = new Map<string, number>();
  const joinedAt = new Map<string, number>();
  const loopPathOf = (event: TerminalRecordEvent | undefined) =>
    event &&
    readNodeRecordEvent({ ...event, workflow_run_id: run.id })?.metadata?.invocation.loopPath;
  for (const [index, event] of events.entries()) {
    // Only node records order a failure against its join: an audit event on the same step
    // (a session note, say) is not one, whatever events the caller passes.
    if (!event.step_name || !NODE_STATE_TYPES.has(event.event_type)) continue;
    lastRecord.set(event.step_name, index);
    if (event.event_type !== 'node_completed') continue;
    const round = loopPathOf(event) ?? [];
    for (const { scope, prefix, nodeId } of scopes)
      if (
        prefix + nodeId === event.step_name &&
        prefix + composeFanOutScopeSegment(nodeId, round) === scope
      )
        joinedAt.set(scope, index);
  }
  return buildRunNodeStates(run, events)
    .filter(node => node.state === 'failed' && node.failure_kind === 'outcome_unknown')
    .map(node => {
      const at = lastRecord.get(node.node_id) ?? Number.POSITIVE_INFINITY;
      const instances = instancesOf(node.node_id);
      return {
        path: node.node_id,
        loopPath: loopPathOf(events[lastRecord.get(node.node_id) ?? -1]),
        instances,
        absorbedBy: instances
          .filter(({ scope }) => (joinedAt.get(scope) ?? -1) > at)
          .map(({ scope }) => scope)
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
