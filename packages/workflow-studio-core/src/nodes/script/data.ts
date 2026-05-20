import type { VariantCapabilities, VariantLibraryMetadata } from '../shared/types';

export interface ScriptNodeData {
  /** Inline script source (TypeScript or Python). */
  script: string;
  /** Runtime that executes the script. Required. */
  runtime: 'bun' | 'uv';
  /** Optional package dependencies. */
  deps?: string[];
  /** Optional execution timeout in milliseconds. */
  timeout?: number;
}

export function createScriptDefault(): ScriptNodeData {
  return { script: '', runtime: 'bun' };
}

export const scriptCapabilities: VariantCapabilities = {
  honorsAiFields: false,
  forbidsRetry: false,
};

export const scriptLibrary: VariantLibraryMetadata = {
  label: 'Script',
  description: 'TypeScript or Python via Bun/uv',
  colorToken: 'node-script',
  iconName: 'FileCode',
  defaultIdHint: 'script',
};
