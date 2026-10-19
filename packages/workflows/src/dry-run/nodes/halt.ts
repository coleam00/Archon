import { substituteNodeOutputRefs } from '../../dag/references';
import type { HaltNode, NodeOutput } from '../../schemas';
import type { DryRunContext } from '../context';

export function simulateHalt(
  node: HaltNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  const resolvedText = substituteNodeOutputRefs(node.reason, outputs, ctx.loopBodyScopes);
  outputs.set(node.id, { state: 'completed', output: resolvedText });
  ctx.trace.push({
    nodeId: node.id,
    nodeType: 'cancel',
    state: 'completed',
    reason: 'workflow cancelled',
    resolvedText,
    output: resolvedText,
    ...(iteration ? { iteration } : {}),
  });
  ctx.halted = 'cancelled';
}
