import type { DagNode } from '../../schemas';
import type { ApprovalNodeData } from './data';

export function approvalToDag(data: ApprovalNodeData): Partial<DagNode> {
  return { approval: data.approval } as Partial<DagNode>;
}
