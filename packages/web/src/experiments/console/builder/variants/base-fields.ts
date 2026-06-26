/**
 * Field partitioning: split a wire `DagNode` into `{ id, base, variantSpecific }`.
 *
 * `base` carries the fields shared by every variant; `variantSpecific` carries
 * the mode field(s) for the node's variant. The split is driven by the key set
 * of `BASE_FIELD_KEY_RECORD` so it stays mechanical and exhaustive.
 */
import type { BaseFields, WireBaseKey, WireDagNode } from '../types';

/**
 * Exhaustive record over `WireBaseKey` — the single source for which wire keys
 * are base fields. Deriving the runtime set from the type-level union means a
 * key added to one side without the other is a compile error (excess property
 * or missing property), not a silent mispartition that loses data on round-trip.
 *
 * Note `timeout` is deliberately NOT a base field even though the flattened
 * wire `DagNode` type carries it top-level: the engine's transform emits
 * `timeout` only on bash and script nodes (see the BashNode/ScriptNode branches
 * of `dagNodeSchema`'s transform in packages/workflows/src/schemas/dag-node.ts),
 * so it is variant-specific by engine contract.
 */
const BASE_FIELD_KEY_RECORD: Record<WireBaseKey, true> = {
  depends_on: true,
  when: true,
  trigger_rule: true,
  model: true,
  provider: true,
  context: true,
  output_format: true,
  allowed_tools: true,
  denied_tools: true,
  idle_timeout: true,
  retry: true,
  hooks: true,
  mcp: true,
  skills: true,
  agents: true,
  effort: true,
  thinking: true,
  maxBudgetUsd: true,
  systemPrompt: true,
  fallbackModel: true,
  betas: true,
  sandbox: true,
  always_run: true,
  persist_session: true,
  output_type: true,
};

const BASE_FIELD_KEY_SET = new Set<string>(Object.keys(BASE_FIELD_KEY_RECORD));

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
