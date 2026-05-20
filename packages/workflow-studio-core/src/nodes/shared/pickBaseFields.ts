import type { VariantId } from '../registry';
import { BASE_FIELD_KEYS, VARIANT_SPECIFIC_KEYS } from './baseFieldKeys';

export interface PickedNodeFields {
  base: Record<string, unknown>;
  variantSpecific: Record<string, unknown>;
  unknown: Record<string, unknown>;
}

export function pickBaseFields(raw: Record<string, unknown>, variant: VariantId): PickedNodeFields {
  const baseSet = new Set(BASE_FIELD_KEYS);
  const variantSet = new Set(VARIANT_SPECIFIC_KEYS[variant]);

  const result: PickedNodeFields = { base: {}, variantSpecific: {}, unknown: {} };

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (variantSet.has(key)) {
      result.variantSpecific[key] = value;
    } else if (baseSet.has(key)) {
      result.base[key] = value;
    } else {
      result.unknown[key] = value;
    }
  }
  return result;
}
