/**
 * Field partitioning: split a wire `DagNode` into `{ id, base, variantSpecific }`.
 *
 * `base` carries the fields shared by every variant; `variantSpecific` carries
 * the mode field(s) for the node's variant. The split is driven by the base
 * keys of `WIRE_KEY_ROLES`, which is exhaustive over the wire node's keys.
 */
import { wireKeysWithRole, type BaseFields, type WireDagNode } from '../types';

/**
 * `timeout` and `on_timeout` are deliberately NOT base fields even though the
 * flattened wire `DagNode` type carries them top-level: the engine accepts them
 * only on bash and script nodes, so `WIRE_KEY_ROLES` marks them variant keys.
 */
const BASE_FIELD_KEY_SET = new Set<string>(wireKeysWithRole('base'));

/**
 * Partition a wire node into its id, shared base fields, and variant-specific
 * fields. Only keys actually present on the node are copied, so the result stays
 * sparse (matching the engine's transform output).
 */
export function partitionNode(node: WireDagNode): {
  id: string;
  base: BaseFields;
  variantSpecific: Partial<WireDagNode>;
} {
  const base: Record<string, unknown> = {};
  const variantSpecific: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === 'id') continue;
    if (BASE_FIELD_KEY_SET.has(key)) base[key] = value;
    else variantSpecific[key] = value;
  }

  return {
    id: node.id,
    base: base as BaseFields,
    variantSpecific: variantSpecific as Partial<WireDagNode>,
  };
}
