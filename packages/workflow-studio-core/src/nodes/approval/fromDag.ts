import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { ApprovalNodeData } from './data';

export function approvalFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): ApprovalNodeData {
  const approval = (input.variantSpecific.approval ?? {}) as ApprovalNodeData['approval'];
  return { approval };
}
