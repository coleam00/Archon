import type { NodeExecutionResult } from '../../../node-record-serialization';
import type { NodeExecutionRecord } from '../../../schemas/node-execution';
import type {
  ApprovalContext,
  DagNode,
  GateNode,
  LoopGroupNode,
  NodeOutput,
  SessionCursor,
  WaitNode,
  WorkflowWaitContext,
} from '../../../schemas';
import {
  isWorkflowWaitContext,
  isGateNode,
  loopGroupOutputNodes,
  loopGroupSoleTerminalSink,
} from '../../../schemas';
import type { ModelAliasPreset, TierName } from '../../../model-validation';
import { getLog } from '../../log';
import type { RunLayersContext, SequentialSessionCursor } from '../../run-context';

export type LoopGroupBodyResult = NodeExecutionResult &
  (
    | { state: 'failed'; loopIterations: number }
    | { state: Exclude<NodeExecutionResult['state'], 'failed'> }
  ) & {
    suspensionPoint?: 'approval' | 'wait';
  };

export interface LoopGroupProgress {
  usage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'>;
  lastStartedIteration: number;
}

/**
 * Where a loop group starts. Three resume shapes are recognized:
 *  - the ORIGINAL interactive_loop gate (group.interactive + gate_message).
 *  - a body terminal gate paused under THIS group, with bodyGateId naming
 *    the leaf gate. `$LOOP_USER_INPUT` does not apply to this shape — the human's
 *    text flows via the ordinary $LOOP_PREV.<gateId>.output.text channel instead,
 *    like any other body node's output — so `loopUserInput` stays scoped to the
 *    legacy shape.
 *  - a body terminal wait this group owns.
 */
export interface LoopGroupResume {
  loopGateMeta: ApprovalContext | undefined;
  loopOwnedWaitMeta: Extract<WorkflowWaitContext, { owner: 'loop_group' }> | undefined;
  isLegacyInteractiveLoopResume: boolean;
  isEscalatedGateResume: boolean;
  isEscalatedWaitResume: boolean;
  isLoopResume: boolean;
  /** Named owner sessions of body nodes that resume a session context; undefined when none do. */
  bodySessionCursors: Map<string, SessionCursor> | undefined;
  bodySessionCursorAncestry: Map<string, Map<string, SessionCursor>>;
  /** The iteration the run paused in. */
  resumeIteration: number;
  startIteration: number;
  feedbackGiven: boolean;
  iterationLimit: number;
  loopUserInput: string;
}

/** What one loop group execution holds fixed across its iterations. */
export interface LoopGroupRun {
  ctx: RunLayersContext;
  node: LoopGroupNode;
  bodyNodes: readonly DagNode[];
  /**
   * This group's OWN persisted step_name — namespaced by any enclosing group so nested
   * loop_groups compose (e.g. `outer.inner`); '' → node.id at the top level (#2090).
   */
  stepName: string;
  /**
   * Body nodes are namespaced under THIS group's (already-namespaced) step name so the
   * prefix composes across nested loop_groups: `<enclosing>.<groupId>.<bodyNodeId>`.
   */
  bodyStepNamePrefix: string;
  /**
   * THIS group's immediate body ids: the resume snapshot is keyed by them, and until_bash
   * resolves `$LOOP_PREV` against them (#2142).
   */
  directBodyIds: Set<string>;
  msgContext: { workflowId: string; nodeName: string };
  execution: NodeExecutionRecord;
  /** Progress retained by the caller when the body throws. */
  progress: LoopGroupProgress;
  workflowProvider: string | undefined;
  workflowModel: string | undefined;
  workflowTier: TierName | undefined;
  workflowPreset: ModelAliasPreset | undefined;
  resume: LoopGroupResume;
}

/** What a loop group carries from one iteration to the next. */
export interface LoopGroupState {
  /** The previous iteration's body outputs, for $LOOP_PREV.*; undefined on iteration 1. */
  loopPrevOutputs: Map<string, NodeOutput> | undefined;
  lastOutput: string;
  /**
   * The terminal sink's structured payload for the same iteration (#2637) — tracked
   * beside the text so the group's completed NodeOutput carries the logical value
   * (sibling `loop:` has done this since #2563; the group used to discard it).
   */
  lastStructuredOutput: unknown;
  /**
   * Loop-level session cursor: threaded across iterations when fresh_context is false
   * (so a body AI node resumes the prior iteration's session), reset to undefined when
   * fresh_context is true or on iteration 1. runLayers mutates the iteration's copy in
   * place each call.
   */
  lastSequentialSession: SequentialSessionCursor | undefined;
}

/**
 * Only a sole terminal gate or wait can resume through its enclosing group.
 * The loader rejects other placements, which have no unambiguous owner.
 */
export function findLoopGroupTerminalSuspendNode(
  bodyNodes: readonly DagNode[]
): GateNode | WaitNode | undefined {
  const sink = loopGroupSoleTerminalSink(bodyNodes);
  return sink !== undefined && (isGateNode(sink) || sink.kind === 'wait') ? sink : undefined;
}

/** An iteration's output: the first completed, non-empty one among its output nodes. */
export function loopGroupIterationOutput(
  bodyNodes: readonly DagNode[],
  outputs: ReadonlyMap<string, NodeOutput>
): NodeOutput | undefined {
  return loopGroupOutputNodes(bodyNodes)
    .map(n => outputs.get(n.id))
    .find(o => o?.state === 'completed' && o.output.trim().length > 0);
}

export function logGroupIterationEventError(nodeId: string, err: Error, iteration: number): void {
  getLog().error({ err, nodeId, iteration }, 'loop_group_node.iteration_event_failed');
}

export async function ownsTerminalWait(
  run: LoopGroupRun,
  iteration: number,
  bodyWaitId: string
): Promise<boolean> {
  const boundary = run.ctx.containerPause;
  const wait =
    boundary === undefined
      ? (await run.ctx.deps.store.getWorkflowRun(run.ctx.workflowRun.id))?.metadata.wait
      : boundary.selected?.kind === 'wait'
        ? boundary.selected.context
        : undefined;
  return (
    isWorkflowWaitContext(wait) &&
    wait.owner === 'loop_group' &&
    wait.nodeId === run.node.id &&
    wait.bodyWaitId === bodyWaitId &&
    wait.iteration === iteration
  );
}

/** Whether the staged container pause is this group's terminal body gate in `iteration`. */
export function ownsStagedGate(run: LoopGroupRun, iteration: number, bodyGateId: string): boolean {
  const selected = run.ctx.containerPause?.selected;
  return (
    selected?.kind === 'gate' &&
    selected.context.nodeId === run.node.id &&
    selected.context.bodyGateId === bodyGateId &&
    selected.context.iteration === iteration
  );
}
