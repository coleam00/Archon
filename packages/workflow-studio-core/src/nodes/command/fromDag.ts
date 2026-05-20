import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { CommandNodeData } from './data';

export function commandFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): CommandNodeData {
  const command =
    typeof input.variantSpecific.command === 'string' ? input.variantSpecific.command : '';
  return { command };
}
