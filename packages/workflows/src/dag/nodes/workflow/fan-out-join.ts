import type { WorkflowDeps } from '../../../deps';
import type { FanOutConfig, WorkflowNode } from '../../../schemas';
import { readSubrunMetadata } from '../../../schemas';
import type { NodeFailureKind } from '../../../schemas/node-execution';
import type { JsonValue } from '../../../output-ref';
import { getLog } from '../../log';
import type { ChildWorkflowOutcome } from '../../child-run';
import { findFanOutChildRuns } from './fan-out-children';

/**
 * The child's terminal LOGICAL value as a fan-out aggregate element: prefer the typed
 * `structuredOutput` (#2637); fall back to parsing the text summary, and keep non-JSON
 * text as the raw string, since a string IS what the child returned.
 */
function subrunLogicalValue(outcome: ChildWorkflowOutcome): unknown {
  if (outcome.structuredOutput !== undefined) return outcome.structuredOutput;
  try {
    return JSON.parse(outcome.output ?? '') as unknown;
  } catch {
    return outcome.output ?? '';
  }
}

/**
 * A completed child's aggregate ELEMENT (#2637): its terminal LOGICAL value via
 * {@link subrunLogicalValue}, so a structured child lands single-encoded
 * (`[{"v":1}]`, never `["{\"v\":1}"]`), a text-only child whose summary happens
 * to be JSON lands parsed, and any other child stays the exact string it always was.
 * Each child certified its own element against its own `returns:` contract (#2453);
 * the aggregate is engine-owned and asserts nothing further.
 * I3: parity with the 1:1 asCompleted path — a completed child with no terminal
 * output is indistinguishable downstream from an intentional empty result, so
 * leave a trace before falling back to ''. A structured child always has text too
 * (the canonical serialization), so this warn still covers every genuinely empty
 * completion.
 */
function childElement(
  o: ChildWorkflowOutcome,
  index: number,
  parentRunId: string,
  nodeId: string
): JsonValue {
  if (o.status === 'completed' && o.output === undefined) {
    getLog().warn(
      { parentRunId, nodeId, childRunId: o.childRunId, childIndex: index },
      'workflow.subrun_completed_without_output'
    );
  }
  return o.structuredOutput !== undefined
    ? (o.structuredOutput as JsonValue)
    : (subrunLogicalValue(o) as JsonValue);
}

/** A fan-out join's verdict over every child's terminal outcome, in item order. */
export type FanOutJoinResult =
  | { status: 'completed'; elements: JsonValue[] }
  | { status: 'failed'; error: string; notice: string; failureKind: NodeFailureKind };

function joinFailure(
  error: string,
  failureKind: NodeFailureKind,
  nodeId: string
): FanOutJoinResult {
  return {
    status: 'failed',
    error,
    notice: `❌ **Fan-out failed** (node \`${nodeId}\`): ${error}`,
    failureKind,
  };
}

/**
 * Reduce the children's outcomes through the declared `join`. `all_success` fails on the
 * lowest-index non-completed child; `all_done` completes with a failure marker in each
 * failed slot, unless no child run was ever created.
 */
export async function joinFanOutOutcomes(
  store: WorkflowDeps['store'],
  parentRunId: string,
  node: WorkflowNode,
  stepName: string,
  join: FanOutConfig['join'],
  outcomes: readonly ChildWorkflowOutcome[]
): Promise<FanOutJoinResult> {
  if (join === 'all_success') {
    // Every child ran to its own terminal state, so the lowest-index non-completed outcome
    // IS the causal one — nothing here is a casualty of another child's failure.
    const firstBad = outcomes.findIndex(o => o.status !== 'completed');
    if (firstBad !== -1) {
      const bad = outcomes[firstBad];
      const ref = bad.childRunId ? ` (run ${bad.childRunId.slice(0, 8)})` : '';
      return {
        status: 'failed',
        error:
          `fan_out node '${node.id}' (join: all_success): child ${String(firstBad)}${ref} ${bad.status}` +
          (bad.error ? `: ${bad.error}` : ''),
        notice:
          `❌ **Fan-out failed** (node \`${node.id}\`): child ${String(firstBad)}${ref} ${bad.status}` +
          (bad.error ? ` — ${bad.error}` : ''),
        failureKind: 'child_failed',
      };
    }
    // All completed → aggregate the child results in item order: a LOGICAL array
    // (#2637), serialized once for the text channel.
    return {
      status: 'completed',
      elements: outcomes.map((o, i) => childElement(o, i, parentRunId, node.id)),
    };
  }

  const children = await findFanOutChildRuns(store, parentRunId, stepName);
  const anyChildStarted = children.some(child => {
    const index = readSubrunMetadata(child.metadata).childIndex;
    return index !== undefined && index >= 0 && index < outcomes.length;
  });
  if (!anyChildStarted) {
    const reason = outcomes[0].error ?? `child ${outcomes[0].status}`;
    return joinFailure(
      `fan_out node '${node.id}' refused all ${String(outcomes.length)} children at spawn: ${reason}`,
      'child_failed',
      node.id
    );
  }

  // join: all_done — node succeeds once all children are terminal; a failed/cancelled
  // entry is represented as a failure-marker object in the aggregate array (so a
  // collector can reconcile partial results). Never fails the node on a partial failure.
  //
  // `archon_failed: true` is the marker's reserved discriminator (#2637): now that a
  // completed structured child's slot is its payload OBJECT, a child whose own schema
  // happens to carry `error` + `status` fields (a natural verifier shape) would be
  // indistinguishable from a failed slot by shape alone. No key can be made literally
  // unproducible through `output_format`, but no schema grows an `archon_failed`
  // field by accident — collectors check `r?.archon_failed === true`, nothing else.
  return {
    status: 'completed',
    elements: outcomes.map((o, i) =>
      o.status === 'completed'
        ? childElement(o, i, parentRunId, node.id)
        : { archon_failed: true, error: o.error ?? `child ${o.status}`, status: o.status }
    ),
  };
}
