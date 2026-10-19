import { substituteNodeOutputRefs } from '../../dag/references';
import type { GateNode, NodeOutput } from '../../schemas';
import type { DryRunContext } from '../context';

export function simulateGate(
  node: GateNode,
  outputs: Map<string, NodeOutput>,
  ctx: DryRunContext,
  iteration?: number
): void {
  const resolvedText = substituteNodeOutputRefs(node.message, outputs, ctx.loopBodyScopes);
  if (ctx.pauseAtGates) {
    outputs.set(node.id, { state: 'pending', output: '' });
    ctx.trace.push({
      nodeId: node.id,
      nodeType: 'approval',
      state: 'paused',
      reason: 'approval gate',
      resolvedText,
      ...(iteration ? { iteration } : {}),
    });
    ctx.halted = 'paused';
  } else {
    outputs.set(node.id, { state: 'completed', output: 'approved' });
    ctx.trace.push({
      nodeId: node.id,
      nodeType: 'approval',
      state: 'completed',
      reason: 'auto-approved',
      resolvedText,
      output: 'approved',
      ...(iteration ? { iteration } : {}),
    });
  }
}
