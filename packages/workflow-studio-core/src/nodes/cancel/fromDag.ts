import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { CancelNodeData } from './data';

export function cancelFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): CancelNodeData {
  const cancel =
    typeof input.variantSpecific.cancel === 'string' ? input.variantSpecific.cancel : '';
  return { cancel };
}
