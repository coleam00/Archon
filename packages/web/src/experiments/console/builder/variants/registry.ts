/**
 * Variant registry — the single source mapping each `VariantId` to its label,
 * default factory, conversion functions, and capabilities. Consumed by `model/`
 * (round-trip) and, later, PR-2's node palette.
 *
 * Two dispatch helpers (`variantDataFromDag`, `nodeDataToDag`) sit alongside the
 * registry object because a union-typed call through the registry index is not
 * type-safe for `toDag` (the data type cannot be correlated with the variant key
 * once destructured). The helpers recover that correlation without `any`.
 */
import type { BuilderNode, VariantData, VariantDataMap, VariantId, WireDagNode } from '../types';
import { VARIANT_CAPABILITIES, type VariantCapabilities } from './capabilities';
import { defaultLoopData, loopFromDag, loopToDag } from './loop';
import { approvalFromDag, approvalToDag, defaultApprovalData } from './approval';
import { cancelFromDag, cancelToDag, defaultCancelData } from './cancel';
import { defaultScriptData, scriptFromDag, scriptToDag } from './script';
import { commandFromDag, commandToDag, defaultCommandData } from './command';
import { defaultPromptData, promptFromDag, promptToDag } from './prompt';
import { bashFromDag, bashToDag, defaultBashData } from './bash';

/** Canonical variant order (three existing kinds, then the four new variants). */
export const VARIANTS: readonly VariantId[] = [
  'prompt',
  'command',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
];

/** A registry entry for one variant, typed against that variant's data shape. */
export interface VariantRegistryEntry<K extends VariantId> {
  label: string;
  defaultData: () => VariantDataMap[K];
  fromDag: (variantSpecific: Partial<WireDagNode>) => VariantDataMap[K];
  toDag: (data: VariantDataMap[K]) => Partial<WireDagNode>;
  capabilities: VariantCapabilities;
  /**
   * The wire keys this variant's converters consume from `variantSpecific`.
   * The importer warns about (and drops) any other key that lands there, so a
   * field the round-trip cannot carry is never lost silently.
   */
  wireKeys: readonly string[];
}

/** Per-variant registry. Strongly typed per key. */
export const VARIANT_REGISTRY: { [K in VariantId]: VariantRegistryEntry<K> } = {
  prompt: {
    label: 'Prompt',
    defaultData: defaultPromptData,
    fromDag: promptFromDag,
    toDag: promptToDag,
    wireKeys: ['prompt'],
    capabilities: VARIANT_CAPABILITIES.prompt,
  },
  command: {
    label: 'Command',
    defaultData: defaultCommandData,
    fromDag: commandFromDag,
    toDag: commandToDag,
    wireKeys: ['command'],
    capabilities: VARIANT_CAPABILITIES.command,
  },
  bash: {
    label: 'Bash',
    defaultData: defaultBashData,
    fromDag: bashFromDag,
    toDag: bashToDag,
    wireKeys: ['bash', 'timeout'],
    capabilities: VARIANT_CAPABILITIES.bash,
  },
  script: {
    label: 'Script',
    defaultData: defaultScriptData,
    fromDag: scriptFromDag,
    toDag: scriptToDag,
    wireKeys: ['script', 'runtime', 'deps', 'timeout'],
    capabilities: VARIANT_CAPABILITIES.script,
  },
  loop: {
    label: 'Loop',
    defaultData: defaultLoopData,
    fromDag: loopFromDag,
    toDag: loopToDag,
    wireKeys: ['loop'],
    capabilities: VARIANT_CAPABILITIES.loop,
  },
  approval: {
    label: 'Approval',
    defaultData: defaultApprovalData,
    fromDag: approvalFromDag,
    toDag: approvalToDag,
    wireKeys: ['approval'],
    capabilities: VARIANT_CAPABILITIES.approval,
  },
  cancel: {
    label: 'Cancel',
    defaultData: defaultCancelData,
    fromDag: cancelFromDag,
    toDag: cancelToDag,
    wireKeys: ['cancel'],
    capabilities: VARIANT_CAPABILITIES.cancel,
  },
};

/**
 * Build the variant-specific data for a given variant from a partitioned wire
 * node. Safe through the registry index: every `fromDag` has the same parameter
 * type, so the union call resolves cleanly.
 */
export function variantDataFromDag(
  variant: VariantId,
  variantSpecific: Partial<WireDagNode>
): VariantData {
  return VARIANT_REGISTRY[variant].fromDag(variantSpecific);
}

/**
 * Serialize a builder node's variant data to its sparse wire fragment. A switch
 * on the discriminant lets `node.data` narrow to the matching `toDag` parameter
 * type — no casts, no `any`.
 */
export function nodeDataToDag(node: BuilderNode): Partial<WireDagNode> {
  switch (node.variant) {
    case 'loop':
      return loopToDag(node.data);
    case 'approval':
      return approvalToDag(node.data);
    case 'cancel':
      return cancelToDag(node.data);
    case 'script':
      return scriptToDag(node.data);
    case 'command':
      return commandToDag(node.data);
    case 'prompt':
      return promptToDag(node.data);
    case 'bash':
      return bashToDag(node.data);
  }
}
