import type { VariantId } from '../registry';

/**
 * Keys recognised by `dagNodeBaseSchema` (mirrored from Archon at the pinned SHA).
 * If the upstream base schema gains a field, the schema-drift CI fails; update this list to match.
 */
export const BASE_FIELD_KEYS: readonly string[] = [
  'id',
  'depends_on',
  'when',
  'trigger_rule',
  'idle_timeout',
  'retry',
  'model',
  'provider',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
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
];

/**
 * Keys that are exclusive to a single variant (the variant key itself plus any keys
 * that only appear when that variant is selected). Mirrors the per-variant `extend(...)`
 * blocks in dag-node.ts.
 */
export const VARIANT_SPECIFIC_KEYS: Readonly<Record<VariantId, readonly string[]>> = {
  command: ['command'],
  prompt: ['prompt'],
  bash: ['bash', 'timeout'],
  script: ['script', 'runtime', 'deps', 'timeout'],
  loop: ['loop'],
  approval: ['approval'],
  cancel: ['cancel'],
};
