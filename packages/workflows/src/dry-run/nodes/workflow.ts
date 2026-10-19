import { resolveNodeBindings } from '../../dag/references';
import {
  isWorkflowNode,
  type ComposeFanOutNode,
  type NodeOutput,
  type WorkflowNode,
} from '../../schemas';
import {
  bindingShellContext,
  nodeType,
  recordFailed,
  stubFor,
  type DryRunContext,
} from '../context';
import { completedOutput } from '../stubs';

export function simulateChildRunNode(
  node: WorkflowNode | ComposeFanOutNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  // A child run is its own governance object, so a dry run never simulates it, but
  // an authored stub can declare its terminal output like any other node's. A
  // --default-stubs placeholder cannot stand in for a whole child run, so only an
  // authored stub counts. The node's own `with:` bindings still resolve first, so a
  // binding a real launch would fail on fails here too. A fan-out has no single
  // child output to stub.
  const childStub =
    isWorkflowNode(node) && !node.fan_out && Object.hasOwn(ctx.stubs, node.id)
      ? stubFor(node, ctx)
      : undefined;
  if (isWorkflowNode(node) && childStub !== undefined) {
    if (node.with !== undefined) {
      resolveNodeBindings(node.id, node.with, bindingShellContext(ctx, outputs), ctx.inputs);
    }
    const hydrated = completedOutput(node, childStub);
    outputs.set(node.id, hydrated);
    ctx.trace.push({
      nodeId: node.id,
      nodeType: nodeType(node),
      state: 'stubbed',
      output: hydrated.output,
      ...(iteration ? { iteration } : {}),
    });
    return;
  }
  recordFailed(
    node,
    outputs,
    ctx,
    `Dry-run does not execute reachable ${nodeType(node)} nodes`,
    undefined,
    iteration
  );
}
