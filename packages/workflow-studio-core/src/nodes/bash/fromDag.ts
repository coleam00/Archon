import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { BashNodeData } from './data';

export function bashFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): BashNodeData {
  const bash = typeof input.variantSpecific.bash === 'string' ? input.variantSpecific.bash : '';
  const result: BashNodeData = { bash };
  if (typeof input.variantSpecific.timeout === 'number') {
    result.timeout = input.variantSpecific.timeout;
  }
  return result;
}
