import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface BashNodeData {
  /** Shell script body executed via the bash runtime. */
  bash: string;
  /** Optional execution timeout in milliseconds. */
  timeout?: number;
}

export function createBashDefault(): BashNodeData {
  return { bash: '' };
}

export const bashCapabilities: VariantCapabilities = {
  honorsAiFields: false,
  forbidsRetry: false,
};

export const bashLibrary: VariantLibraryMetadata = {
  label: 'Bash',
  description: 'Shell script — no AI',
  colorToken: 'node-bash',
  iconName: 'SquareTerminal',
  defaultIdHint: 'bash',
};
