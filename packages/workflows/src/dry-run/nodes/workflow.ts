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

function resolveChildRunStub(
  node: WorkflowNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext
): { stub: DryRunStubValue; state: 'completed' | 'stubbed' } | undefined {
  let itemCount: number | undefined;
  if (node.fan_out !== undefined) {
    const shellContext = bindingShellContext(ctx, outputs);
    const resolvedItems = resolveFanOutItems(node, shellContext, node.fan_out);
    if ('error' in resolvedItems) throw new Error(resolvedItems.error);
    const resolvedInputs = resolveFanOutStaticInputs(node, shellContext, ctx.inputs);
    if ('error' in resolvedInputs) throw new Error(resolvedInputs.error);
    itemCount = resolvedItems.items.length;
    if (itemCount === 0) return { stub: [], state: 'completed' };
  }
  // Only authored stubs can stand in for child runs; generated placeholders cannot.
  if (!Object.hasOwn(ctx.stubs, node.id)) return undefined;
  const stub = stubFor(node, ctx);
  if (stub === undefined) return undefined;
  if (itemCount !== undefined && !Array.isArray(stub)) {
    throw new Error(`Stub for fan-out workflow node '${node.id}' must be a JSON array`);
  }
  if (itemCount !== undefined && Array.isArray(stub) && stub.length !== itemCount) {
    throw new Error(
      `Stub for fan-out workflow node '${node.id}' must contain one result per item (expected ${itemCount}, received ${stub.length})`
    );
  }
  if (node.fan_out === undefined && node.with !== undefined) {
    resolveNodeBindings(node.id, node.with, bindingShellContext(ctx, outputs), ctx.inputs);
  }
  return { stub, state: 'stubbed' };
}

export function simulateChildRunNode(
  node: WorkflowNode | ComposeFanOutNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  const result = isWorkflowNode(node) ? resolveChildRunStub(node, outputs, ctx) : undefined;
  if (result !== undefined) {
    const hydrated = completedOutput(node, result.stub);
    outputs.set(node.id, hydrated);
    ctx.trace.push({
      nodeId: node.id,
      nodeType: nodeType(node),
      state: result.state,
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
