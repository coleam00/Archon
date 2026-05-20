import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { LoopNodeData } from './data';

export function loopFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): LoopNodeData {
  const loop = (input.variantSpecific.loop ?? {}) as LoopNodeData['loop'];
  return { loop };
}
