import {
  isIncludeDirective,
  isGateNode,
  isWaitNode,
  isWorkflowNode,
  isLoopNode,
  isLoopGroupNode,
  loopGroupSoleTerminalSink,
  type DagNode,
  type IncludeDirective,
} from './dag-node';

export function canSuspend(node: DagNode | IncludeDirective): boolean {
  if (isIncludeDirective(node)) return false;
  if (isGateNode(node) || isWaitNode(node) || isWorkflowNode(node)) return true;
  if (isLoopNode(node) && node.loop.interactive) return true;
  return (
    isLoopGroupNode(node) &&
    (node.loop_group.interactive === true || node.loop_group.nodes.some(canSuspend))
  );
}

export function isInteractiveSink(node: DagNode | IncludeDirective): boolean {
  if (isIncludeDirective(node)) return false;
  if (isGateNode(node)) return true;
  if (isLoopNode(node)) return node.loop.interactive === true;
  if (!isLoopGroupNode(node)) return false;
  if (node.loop_group.interactive === true) return true;
  const sink = loopGroupSoleTerminalSink(node.loop_group.nodes);
  return sink !== undefined && isInteractiveSink(sink);
}
