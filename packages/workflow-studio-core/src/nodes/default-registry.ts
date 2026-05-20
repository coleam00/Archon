import { buildRegistry, type VariantId, type VariantRegistry } from './registry';
import type { VariantDefinition } from './shared/types';
import { commandVariant } from './command';
import { promptVariant } from './prompt';
import { bashVariant } from './bash';
import { scriptVariant } from './script';
import { loopVariant } from './loop';
import { approvalVariant } from './approval';
import { cancelVariant } from './cancel';

export const defaultRegistry: VariantRegistry = buildRegistry({
  command: commandVariant,
  prompt: promptVariant,
  bash: bashVariant,
  script: scriptVariant,
  loop: loopVariant,
  approval: approvalVariant,
  cancel: cancelVariant,
});

export function getVariant<TData = unknown>(id: VariantId): VariantDefinition<TData> {
  return defaultRegistry[id] as VariantDefinition<TData>;
}
