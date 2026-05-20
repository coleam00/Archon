import type { BaseFields, VariantSpecificFields } from '../shared/types';
import type { DagNode } from '../../schemas';
import type { ScriptNodeData } from './data';

export function scriptFromDag(input: {
  base: BaseFields;
  variantSpecific: VariantSpecificFields;
  raw: DagNode;
}): ScriptNodeData {
  const script =
    typeof input.variantSpecific.script === 'string' ? input.variantSpecific.script : '';
  const runtime = input.variantSpecific.runtime === 'uv' ? 'uv' : 'bun';
  const result: ScriptNodeData = { script, runtime };
  if (Array.isArray(input.variantSpecific.deps)) {
    result.deps = input.variantSpecific.deps;
  }
  if (typeof input.variantSpecific.timeout === 'number') {
    result.timeout = input.variantSpecific.timeout;
  }
  return result;
}
