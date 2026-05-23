import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface PromptNodeData {
  /** Inline AI prompt text — the body the AI executes. */
  prompt: string;
}

export function createPromptDefault(): PromptNodeData {
  // Non-empty placeholder so a freshly-dropped node passes server-tier
  // validation (dagNodeSchema.superRefine rejects empty `prompt`), which
  // would otherwise leave Save disabled until the user types something.
  // The user is expected to overwrite this with the actual prompt body.
  return { prompt: 'TODO: describe what this prompt should do' };
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
