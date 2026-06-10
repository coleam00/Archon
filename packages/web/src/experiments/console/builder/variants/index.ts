/** Re-exports for the variants layer. */
export { partitionNode } from './base-fields';
export { detectVariant, detectVariantOrNull } from './detect';
export { VARIANT_CAPABILITIES, type VariantCapabilities } from './capabilities';
export {
  VARIANTS,
  VARIANT_REGISTRY,
  variantDataFromDag,
  nodeDataToDag,
  type VariantRegistryEntry,
} from './registry';
export { defaultLoopData, loopFromDag, loopToDag } from './loop';
export { defaultApprovalData, approvalFromDag, approvalToDag } from './approval';
export { defaultCancelData, cancelFromDag, cancelToDag } from './cancel';
export { defaultScriptData, scriptFromDag, scriptToDag } from './script';
export { defaultCommandData, commandFromDag, commandToDag } from './command';
export { defaultPromptData, promptFromDag, promptToDag } from './prompt';
export { defaultBashData, bashFromDag, bashToDag } from './bash';
