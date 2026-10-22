import {
  isIncludeDirective,
  isGateNode,
  isWaitNode,
  isWorkflowNode,
  isLoopNode,
  isLoopGroupNode,
} from './node-guards';
import { loopGroupSoleTerminalSink } from './loop-group-body';
import { type DagNode } from './dag-node';
import { type IncludeDirective } from './include-node';

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
