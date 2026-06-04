/**
 * Field partitioning: split a wire `DagNode` into `{ id, base, variantSpecific }`.
 *
 * `base` carries the fields shared by every variant; `variantSpecific` carries
 * the mode field(s) for the node's variant. The split is driven by `BASE_FIELD_KEYS`
 * so it stays mechanical and exhaustive.
 */
import type { BaseFields, VariantId } from '../types';
import type { WireDagNode } from '../types';

/**
 * The base-field keys present on a wire `DagNode`, including `id`. Everything not
 * in this set is variant-specific. Mirrors `dagNodeBaseSchema` in the engine,
 * minus `persist_session` (absent from the generated `DagNode` — see PR-1 plan
 * "Generated-type drift").
 */
export const BASE_FIELD_KEYS: readonly string[] = [
  'id',
  'depends_on',
  'when',
  'trigger_rule',
  'model',
  'provider',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
  'idle_timeout',
  'retry',
  'hooks',
  'mcp',
  'skills',
  'agents',
  'effort',
  'thinking',
  'maxBudgetUsd',
  'systemPrompt',
  'fallbackModel',
  'betas',
  'sandbox',
  'always_run',
];

const BASE_FIELD_KEY_SET = new Set<string>(BASE_FIELD_KEYS);

/**
 * The variant-specific (mode) keys per variant. Used by tooling that needs to
 * know which keys belong to which variant; partitioning itself uses the
 * complement of `BASE_FIELD_KEYS`.
 */
export const VARIANT_SPECIFIC_KEYS: Record<VariantId, string[]> = {
  loop: ['loop'],
  approval: ['approval'],
  cancel: ['cancel'],
  script: ['script', 'runtime', 'deps', 'timeout'],
  bash: ['bash', 'timeout'],
  command: ['command'],
  prompt: ['prompt'],
};

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
