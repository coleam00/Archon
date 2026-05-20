import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { PromptNodeData } from './data';

export function promptFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): PromptNodeData {
  const prompt =
    typeof input.variantSpecific.prompt === 'string' ? input.variantSpecific.prompt : '';
  return { prompt };
}
