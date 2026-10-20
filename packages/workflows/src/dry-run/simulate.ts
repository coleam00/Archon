/** Walks a graph plan node by node: the reach checks every node shares, then its kind's simulator. */
import { checkComposedBlockBoundaries, checkTriggerRule } from '../dag/trigger-rule';
import { evaluateCondition } from '../condition-evaluator';
import { observeCheckout } from '../checkout-observation';
import { executionMetadata, newNodeInvocation, startNodeExecution } from '../node-execution';
import type { NodeExecutionMetadata } from '../schemas/node-execution';
import {
  isAgentNode,
  isExecNode,
  isLoopNode,
  type DagNode,
  type GraphPlan,
  type NodeOutput,
} from '../schemas';
import { recordFailed, recordSkipped, type DryRunContext } from './context';
import { simulateAgentOrExec } from './nodes/agent-exec';
import { simulateGate } from './nodes/gate';
import { simulateHalt } from './nodes/halt';
import { simulateLoop } from './nodes/loop';
import { simulateLoopGroup } from './nodes/loop-group';
import { simulateWait } from './nodes/wait';
import { simulateChildRunNode } from './nodes/workflow';

/** Whether the node runs at all; a node the trigger rule or its `when:` turns away is recorded here. */
function isReached(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): boolean {
  const boundaryDecision = checkComposedBlockBoundaries(node, outputs, ctx.inputs);
  if (boundaryDecision.decision === 'skip') {
    recordSkipped(node, outputs, ctx, 'trigger_rule', boundaryDecision.cause, iteration);
    return false;
  }
  const triggerDecision = checkTriggerRule(node, outputs);
  if (triggerDecision.decision === 'skip') {
    recordSkipped(node, outputs, ctx, 'trigger_rule', triggerDecision.cause, iteration);
    return false;
  }
  if (node.when) {
    try {
      // `ctx.inputs` mirrors the executor's `resolveRunInputs` (#2610): a `when:`
      // referencing `$INPUTS.<name>` branches on the same effective map a real run reads.
      const condition = evaluateCondition(node.when, outputs, ctx.inputs, {
        loopPrevOutputs: ctx.loopPrevOutputs,
      });
      if (!condition.parsed) {
        recordSkipped(
          node,
          outputs,
          ctx,
          'when_condition_parse_error',
          { kind: 'condition_parse_error', expr: node.when },
          iteration
        );
        return false;
      }
      if (!condition.result) {
        recordSkipped(
          node,
          outputs,
          ctx,
          'when_condition_false',
          { kind: 'condition', expr: node.when },
          iteration
        );
        return false;
      }
    } catch (error) {
      recordFailed(node, outputs, ctx, (error as Error).message, undefined, iteration);
      return false;
    }
  }
  return true;
}

function simulateNodeKind(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number,
  execution?: NodeExecutionMetadata
): Promise<void> | void {
  switch (node.kind) {
    case 'loop':
      return simulateLoop(node, outputs, ctx, iteration);
    case 'loop_group':
      return simulateLoopGroup(node, outputs, ctx, iteration);
    case 'wait':
      return simulateWait(node, outputs, ctx, iteration);
    case 'gate':
      return simulateGate(node, outputs, ctx, iteration);
    case 'halt':
      return simulateHalt(node, outputs, ctx, iteration);
    case 'workflow':
    case 'compose_fan_out':
      return simulateChildRunNode(node, outputs, ctx, iteration);
    case 'agent':
    case 'exec':
      return simulateAgentOrExec(node, outputs, ctx, iteration, execution);
  }
}

async function simulateNode(
  node: DagNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number,
  execution?: NodeExecutionMetadata
): Promise<void> {
  if (!isReached(node, outputs, ctx, iteration)) return;
  try {
    await simulateNodeKind(node, outputs, ctx, iteration, execution);
  } catch (error) {
    recordFailed(node, outputs, ctx, (error as Error).message, undefined, iteration);
  }
}

export async function simulateNodes(
  plan: GraphPlan,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number,
  stopBeforeLayer?: (layer: GraphPlan['layers'][number]) => boolean
): Promise<void> {
  for (const layer of plan.layers) {
    if (stopBeforeLayer?.(layer)) return;
    for (const node of layer) {
      if (ctx.halted) return;
      const execution = await simulatedExecution(node, ctx);
      await simulateNode(node, outputs, ctx, iteration, execution);
      const result = outputs.get(node.id);
      if (execution !== undefined && result !== undefined && result.state !== 'skipped') {
        outputs.set(node.id, { ...result, execution });
      }
    }
  }
}

/**
 * The execution record a real run would give this node, when anything in the simulation
 * reads it: a node another binds with `$<node>.execution.checkoutStart`, or an exec node
 * that actually executes and receives `ARCHON_NODE_EXECUTION`. The checkout it observes
 * is the one executed code runs in. Stubbed nodes change nothing, so their start is the
 * checkout as the simulation reaches them.
 */
async function simulatedExecution(
  node: DagNode,
  ctx: DryRunContext
): Promise<NodeExecutionMetadata | undefined> {
  const executes = isExecNode(node) && ctx.execCode && !Object.hasOwn(ctx.stubs, node.id);
  if (!executes && !ctx.checkoutProducers.has(node.id)) return undefined;
  if (!isExecNode(node) && !isAgentNode(node) && !isLoopNode(node)) return undefined;
  const checkoutStart = await observeCheckout(
    ctx.execWorkspace,
    { kind: 'host' },
    { runId: 'dry-run', artifactsDir: ctx.artifactsDir }
  );
  return executionMetadata(
    startNodeExecution({
      runId: 'dry-run',
      path: node.id,
      node,
      invocation: { ...newNodeInvocation(), checkoutStart },
      checkoutStart,
    })
  );
}
