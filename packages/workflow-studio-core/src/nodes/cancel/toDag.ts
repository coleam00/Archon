import type { DagNode } from '../../schemas';
import type { CancelNodeData } from './data';

export function cancelToDag(data: CancelNodeData): Partial<DagNode> {
  return { cancel: data.cancel.trim() } as Partial<DagNode>;
}
