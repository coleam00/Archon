import { resolveFanOutItems, resolveFanOutStaticInputs } from '../../dag/nodes/fan-out-shared';
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
import { completedOutput, type DryRunStubValue } from '../stubs';

export function simulateChildRunNode(
  node: WorkflowNode | ComposeFanOutNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  let emptyFanOut = false;
  if (isWorkflowNode(node) && node.fan_out !== undefined) {
    const shellContext = bindingShellContext(ctx, outputs);
    const resolvedItems = resolveFanOutItems(node, shellContext, node.fan_out);
    if ('error' in resolvedItems) throw new Error(resolvedItems.error);
    const resolvedInputs = resolveFanOutStaticInputs(node, shellContext, ctx.inputs);
    if ('error' in resolvedInputs) throw new Error(resolvedInputs.error);
    emptyFanOut = resolvedItems.items.length === 0;
  }
  // Only authored stubs can stand in for child runs; generated placeholders cannot.
  const childStub: DryRunStubValue | undefined = emptyFanOut
    ? []
    : isWorkflowNode(node) && Object.hasOwn(ctx.stubs, node.id)
      ? stubFor(node, ctx)
      : undefined;
  if (isWorkflowNode(node) && childStub !== undefined) {
    if (node.fan_out !== undefined && !Array.isArray(childStub)) {
      throw new Error(`Stub for fan-out workflow node '${node.id}' must be a JSON array`);
    }
    if (node.fan_out === undefined && node.with !== undefined) {
      resolveNodeBindings(node.id, node.with, bindingShellContext(ctx, outputs), ctx.inputs);
    }
    const hydrated = completedOutput(node, childStub);
    outputs.set(node.id, hydrated);
    ctx.trace.push({
      nodeId: node.id,
      nodeType: nodeType(node),
      state: emptyFanOut ? 'completed' : 'stubbed',
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
