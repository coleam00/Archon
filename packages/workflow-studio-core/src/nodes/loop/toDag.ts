import type { DagNode } from '../../schemas';
import type { LoopNodeData } from './data';

export function loopToDag(data: LoopNodeData): Partial<DagNode> {
  return { loop: data.loop } as Partial<DagNode>;
}
