import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface PromptNodeData {
  /** Inline AI prompt text — the body the AI executes. */
  prompt: string;
}

export function createPromptDefault(): PromptNodeData {
  return { prompt: '' };
}

export const promptCapabilities: VariantCapabilities = {
  honorsAiFields: true,
  forbidsRetry: false,
};

export const promptLibrary: VariantLibraryMetadata = {
  label: 'Prompt',
  description: 'Inline AI prompt — no command file',
  colorToken: 'node-prompt',
  iconName: 'Sparkles',
  defaultIdHint: 'prompt',
};
